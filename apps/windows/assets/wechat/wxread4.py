"""WeChat 4.1+ (Windows) SQLCipher 直读 —— 含 WAL 重放。
参数（对齐 chatlog windows/v4.go）：page=4096, reserve=80(IV16+HMAC-SHA512×64), HMAC-SHA512。
与 v3 不同：内存里取到的 key 就是最终 AES key（直接用）；mac_key = PBKDF2-HMAC-SHA512(encKey, salt^0x3a, 2, 32)。
用法: python wxread4.py <db文件> <hexkey> <输出sqlite路径>
"""
import hashlib
import hmac
import os
import struct
import sys

# pycryptodome 缺失时仍要让 MCP Server 能启动、完成握手并通过 check_env 报告依赖，
# 只在真正解密时才报错
try:
    from Crypto.Cipher import AES
except ImportError:  # pragma: no cover
    AES = None

MISSING_CRYPTO_HINT = ("缺少依赖 pycryptodome，无法解密微信数据库。"
                       "请执行：python -m pip install pycryptodome zstandard"
                       "（或用 `uv run server.py` 启动，依赖会自动安装）")

PAGE = 4096
RESERVE = 80
HMAC_SIZE = 64
IV_SIZE = 16
SALT_SIZE = 16
SQLITE_HDR = b"SQLite format 3\x00"


def derive_mac_key(enc_key: bytes, salt: bytes) -> bytes:
    mac_salt = bytes(b ^ 0x3A for b in salt)
    return hashlib.pbkdf2_hmac("sha512", enc_key, mac_salt, 2, dklen=32)


def _mac(page: bytes, mac_key: bytes, pageno: int, offset: int) -> bytes:
    m = hmac.new(mac_key, page[offset:PAGE - RESERVE + IV_SIZE], hashlib.sha512)
    m.update((pageno + 1).to_bytes(4, "little"))
    return m.digest()


def decrypt_page(page, enc_key, mac_key, pageno, has_salt):
    offset = SALT_SIZE if (pageno == 0 and has_salt) else 0
    stored = page[PAGE - RESERVE + IV_SIZE:PAGE - RESERVE + IV_SIZE + HMAC_SIZE]
    if _mac(page, mac_key, pageno, offset) != stored:
        return None
    iv = page[PAGE - RESERVE:PAGE - RESERVE + IV_SIZE]
    ct = page[offset:PAGE - RESERVE]
    if len(ct) % 16:
        return None
    if AES is None:
        raise RuntimeError(MISSING_CRYPTO_HINT)
    pt = AES.new(enc_key, AES.MODE_CBC, iv).decrypt(ct)
    body = pt + page[PAGE - RESERVE:PAGE]
    if pageno == 0 and has_salt:
        body = SQLITE_HDR + body
    return body


def read_main(path, enc_key, mac_key):
    data = open(path, "rb").read()
    n = len(data) // PAGE
    pages, bad = [], 0
    for i in range(n):
        raw = data[i * PAGE:(i + 1) * PAGE]
        if not any(raw):
            pages.append(raw)
            continue
        p = decrypt_page(raw, enc_key, mac_key, i, has_salt=(i == 0))
        if p is None:
            bad += 1
            pages.append(raw)
        else:
            pages.append(p)
    return pages, bad


FRAME_HDR = 24          # 帧头：pageno(4) + commit_size(4) + salt(8) + checksum(8)


def wal_header_ok(w):
    """WAL 头部校验（魔数 + 页大小）。`w` 为整段文件内容。"""
    if len(w) < 32:
        return False
    magic = struct.unpack(">I", w[0:4])[0]
    if magic not in (0x377F0682, 0x377F0683):
        return False
    return struct.unpack(">I", w[8:12])[0] == PAGE


def wal_salt(w):
    """WAL 头部的 salt（16..24）——WAL 被 checkpoint 重置后 salt 会变，用它判「换了新 WAL」。"""
    return w[16:24] if len(w) >= 24 else None


def parse_wal_frames(w, start=32):
    """解析 WAL 帧序列：`[(pageno, commit_size, pagedata)], 停止偏移`。

    **只认属于当前 WAL 会话的帧**：每一帧头部都带 salt（[8:16]），必须与 WAL 头部的
    salt（[16:24]）一致；一旦不一致就停下。

    为什么必须这么判（实测，2026-10-08）：`-wal` 文件是**不截断复用**的——每次 checkpoint
    重置时只把新 salt 写进 32 字节的头，随后从偏移 32 起追加新帧；上一轮的老帧还**物理留在
    后面**。实测本机 message_0.db 的 WAL：689 帧里 683 帧的 salt 与头不符（是历史残留），
    真正属于当前会话的只有开头那几帧。机械地把全文件当一段来重放，会把**多个时代的页**
    混着贴上去（现场症状就是「群行消失 / 群名回退」这类读旧）。salt 就是 SQLite 自己的
    有效性判据，按它截断即可。
    """
    salt = wal_salt(w)
    frames, off = [], start
    while off + FRAME_HDR + PAGE <= len(w):
        pageno, commit_size = struct.unpack(">II", w[off:off + 8])
        if pageno == 0:
            break
        if salt is not None and w[off + 8:off + 16] != salt:
            break                                # 上一轮残留的帧：到此为止
        frames.append((pageno, commit_size, w[off + FRAME_HDR:off + FRAME_HDR + PAGE]))
        off += FRAME_HDR + PAGE
    return frames, off


def last_commit_index(frames):
    """最后一次提交的帧下标（-1 = 没有任何提交帧）。"""
    last = -1
    for i, (_p, c, _d) in enumerate(frames):
        if c:
            last = i
    return last


def apply_wal(wal_path, pages, enc_key, mac_key):
    """重放 WAL：**只应用到最后一次提交**（提交后的未完成帧必须丢弃，否则会破坏库）。"""
    if not os.path.exists(wal_path):
        return 0, 0, None
    w = open(wal_path, "rb").read()
    if not wal_header_ok(w):
        return 0, 0, None

    frames, _off = parse_wal_frames(w)
    last_commit = last_commit_index(frames)
    if last_commit < 0:
        return 0, 0, None

    dbsize = frames[last_commit][1]
    applied = failed = 0
    for pageno, _c, pgdata in frames[:last_commit + 1]:
        if not any(pgdata):
            continue
        dec = decrypt_page(pgdata, enc_key, mac_key, pageno - 1, has_salt=(pageno == 1))
        if dec is None:
            failed += 1
            continue
        while len(pages) < pageno:
            pages.append(b"\x00" * PAGE)
        pages[pageno - 1] = dec
        applied += 1
    return applied, failed, dbsize


def main():
    db, hexkey, out = sys.argv[1], sys.argv[2], sys.argv[3]
    enc_key = bytes.fromhex(hexkey)
    salt = open(db, "rb").read(SALT_SIZE)
    mac_key = derive_mac_key(enc_key, salt)
    pages, bad = read_main(db, enc_key, mac_key)
    print(f"[wxread4] salt={salt.hex()} 页数={len(pages)} 解密失败={bad}")
    applied, failed, dbsize = apply_wal(db + "-wal", pages, enc_key, mac_key)
    print(f"[wxread4] WAL 应用帧={applied} 失败={failed} 末次提交={dbsize}")
    if dbsize:
        pages = pages[:dbsize]
    with open(out, "wb") as f:
        for p in pages:
            f.write(p)
    print(f"[wxread4] 已写出 {out}")


if __name__ == "__main__":
    main()
