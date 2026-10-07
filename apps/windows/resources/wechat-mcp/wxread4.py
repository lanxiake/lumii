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
from Crypto.Cipher import AES

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


def apply_wal(wal_path, pages, enc_key, mac_key):
    """重放 WAL：**只应用到最后一次提交**（提交后的未完成帧必须丢弃，否则会破坏库）。"""
    if not os.path.exists(wal_path):
        return 0, 0, None
    w = open(wal_path, "rb").read()
    if len(w) < 32:
        return 0, 0, None
    magic = struct.unpack(">I", w[0:4])[0]
    if magic not in (0x377F0682, 0x377F0683):
        return 0, 0, None

    frames = []
    off = 32
    while off + 24 + PAGE <= len(w):
        f = w[off:off + 24 + PAGE]
        pageno = struct.unpack(">I", f[0:4])[0]
        commit_size = struct.unpack(">I", f[4:8])[0]
        if pageno == 0:
            break
        frames.append((pageno, commit_size, f[24:24 + PAGE]))
        off += 24 + PAGE

    last_commit = -1
    for i, (_p, c, _d) in enumerate(frames):
        if c:
            last_commit = i
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
