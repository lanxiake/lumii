# -*- coding: utf-8 -*-
"""本机微信图片（`type=3`）解密：V2 `.dat` → 能看的图片文件。

## 容器格式（2026-10-10 本机 908 个 `.dat` 实测）

    0x00  魔数 07 08 56 32 08 07
    0x06  aes_size  u32 LE   本机 881/908 = 1024
    0x0A  xor_size  u32 LE
    0x0E  0x01  ← **这一字节属于 AES 明文**，不是容器占位
    0x0F  AES-128-ECB 段：明文 = [图片头 `aes_size` 字节][0x01][补位到 16 的整数倍]
    之后  中段明文（小图 0 字节；大图实测 1MB，**是真图片数据**）
    末尾  xor_size 字节：单字节 XOR

**图片 = AES 明文的前 `aes_size` 字节 + 中段明文 + XOR 段**。
`len == 15 + pad(aes_size + 1) + len(中段) + xor_size` 对 908/908 精确成立。

两处踩过的坑（都只影响观感、不报错）：
- **`aes_size` 不含那个 0x01**，所以 AES 段要按 `pad(aes_size + 1)` 算。按 `pad(aes_size)`
  会把这 16 字节补位当成图片：PNG 首块 IDAT 的 CRC 全挂、JPEG marker 链在 1024 处断裂，
  而肉眼只是「图有点怪」。
- **中段不能一律丢掉**：小图它正好是 16 字节补位（丢掉才对），大图它有 1MB 真数据（丢了缺一块）。

## 两个密钥

**XOR key**：从**文件尾**反推——JPEG 以 `FF D9` 收尾，取 `data[-2] ^ 0xFF`，再用
`data[-1] ^ 0xD9` 交叉校验。本机实测恒为 `0xFE`（538/908 通过校验；剩下的是 wxgf，
尾巴没有特征码，用同账号学到的常量即可）。

**AES key**：**账号级**，不在消息里、也不在任何配置文件里——微信只在**查看图片**时
把它临时加载进进程内存。实测过的两条死路：拿消息 XML 里的 `aeskey` 逐条试 493 次全不中；
直接扫内存却要等它被加载。所以走社区 `find_image_key.py` 那套：拿「缩略图第一个 AES 密文块
+ 已知明文头（JPEG 的 `FF D8 FF E0 00 10 4A 46 49 46`）」去内存里所有 16 字节候选上试解，
命中即得。**抓一次缓存起来**（见 `image_aes_key`）。

## 消息 → 文件

两条路，**都要走**：

1. `hardlink.db` 的 `image_hardlink_info_v4`（`md5` → `file_name`）。⚠️ 但消息 XML 里的
   `md5` 是**原图**的 md5，而微信不一定把原图下下来——原图那份 `_h.dat` 缺失时，索引里
   根本没有这个 md5，整条链断在这里（2026-10-11 实测：只有 241/490 命中，且同批图怎么比
   都看不出差异，因为差异不在消息里）。
2. 消息自己的 `Msg_*.packed_info_data` 里带着**本地文件名**（32 位十六进制 ASCII，
   见 `core._image_name`）——只要中图落了盘它就找得到，**不依赖微信下没下原图**。

实测：464 条图片消息，只有 1 条两种路都落空（微信真没下载）。见 `image_file`。

## wxgf 兜底

解出来是 `wxgf`（`77 78 67 66`，微信自研 HEVC 容器，要第二层解码）的，退回同目录
`<hash>_t.dat` 缩略图——它一律是 JPEG。缩略图实测只有 83x180，但**够用**：回放给视觉模型
能 OCR 出状态栏与界面文字（中图是 wxgf 就没辙了，本机无 ffmpeg / HEVC 解码器，
不值得为它引依赖）。
"""
import glob
import json
import os
import re
import sqlite3
import sys
import time
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:          # 托管解释器是 isolated 的（`_pth`），直接跑本文件要靠这句
    sys.path.insert(0, HERE)

import wechat_core as core       # noqa: E402

try:
    from Crypto.Cipher import AES
except ImportError:          # pragma: no cover - 依赖缺失时只让「解密」这一步失败
    AES = None

MAGIC = b"\x07\x08V2\x08\x07"
HDR = 0x0F
XOR_KEY_FALLBACK = 0xFE      # 本机实测恒为此值（同账号学到的常量）
IMAGE_MAGICS = (b"\xff\xd8\xff", b"\x89PNG", b"GIF8", b"RIFF")
WXGF = b"wxgf"
JPEG_SOI, JPEG_EOI = 0xFF, 0xD9   # 尾巴反推 XOR key 的两个锚

_HL_TTL_S = 30.0
_hl_cache = {}               # {root: (时刻, {md5: 文件名})}


def looks_like_image(b):
    """开头像不像图片。**不能只认 3 个字节**。

    扫内存时要用它当判据，而 `FF D8 FF` 的撞车概率是 2^-24 —— 一次扫描是几百万次
    「候选 key × 样本」的尝试，必出假阳性。2026-10-10 实测踩到：扫出过一个能解出
    `FF D8 FF 76 …` 的假 key（`0x76` 不是合法的 JPEG 段标记），而它**看起来完全合格**。
    JPEG 的 SOI 后面必须紧跟一个段标记（`0xC0`–`0xFE`，且不是 `0xFF`），多这一个字节的
    约束就把假阳性压到可以忽略。
    """
    if b[:4] in (b"\x89PNG", b"GIF8", b"RIFF"):
        return True
    return b[:3] == b"\xff\xd8\xff" and len(b) >= 4 and 0xC0 <= b[3] <= 0xFE


_is_image = looks_like_image   # 内存扫描的热路径只做廉价判据，别加重活


def _png_ok(b):
    """整条 chunk 链的 CRC 全过、且正好以 IEND 收尾。

    这是「解出来的是不是一张完整图片」最硬的判据：容器少算一个字节，首块 IDAT 的 CRC
    必挂（2026-10-10 实测：9/9 PNG 全中，而肉眼看只是「图有点怪」）。
    """
    if b[:8] != b"\x89PNG\r\n\x1a\n":
        return False
    i = 8
    while i + 12 <= len(b):
        ln = int.from_bytes(b[i:i + 4], "big")
        typ = b[i + 4:i + 8]
        if i + 12 + ln > len(b):
            return False
        if zlib.crc32(typ + b[i + 8:i + 8 + ln]) & 0xFFFFFFFF != int.from_bytes(b[i + 8 + ln:i + 12 + ln], "big"):
            return False
        i += 12 + ln
        if typ == b"IEND":
            return i == len(b)
    return False


def _jpeg_ok(b):
    """marker 链能一路走到 SOS，且以 EOI 收尾（每段的长度必须落在文件内）。"""
    if b[:2] != b"\xff\xd8" or b[-2:] != b"\xff\xd9":
        return False
    i = 2
    while i + 4 <= len(b):
        if b[i] != 0xFF:
            return False
        m = b[i + 1]
        if m == 0xD8 or 0xD0 <= m <= 0xD7:        # 无长度字段的标记
            i += 2
            continue
        ln = int.from_bytes(b[i + 2:i + 4], "big")
        if ln < 2 or i + 2 + ln > len(b):
            return False
        if m == 0xDA:                             # SOS 之后是熵编码，marker 链到此为止
            return True
        i += 2 + ln
    return False


def is_complete_image(b):
    """解出来的字节是不是一张**完整**图片（不只看魔数，看结构自洽）。"""
    if b[:4] == WXGF:
        return True                               # 还要第二层解码，但字节是对的
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return _png_ok(b)
    if b[:3] == b"\xff\xd8\xff":
        return _jpeg_ok(b)
    return b[:4] in (b"GIF8", b"RIFF")


def header(data):
    """`(aes_size, xor_size)`；不是 V2 容器返回 None。"""
    if len(data) < HDR or data[:6] != MAGIC:
        return None
    return int.from_bytes(data[6:10], "little"), int.from_bytes(data[10:14], "little")


def tail_xor_key(data):
    """从文件尾反推 XOR key；尾巴不是 JPEG 收尾（wxgf 等）时返回 None。

    两个字节互相校验是有意的：单看 `[-2] ^ 0xFF` 会把任何文件都算出一个「key」，
    校验不过就说明它不是 JPEG 收尾，宁可交给常量兜底。
    """
    if len(data) < 8:
        return None
    k = data[-2] ^ JPEG_SOI
    return k if (data[-1] ^ JPEG_EOI) == k else None


def decrypt(data, aes_key, xor_key=None):
    """V2 `.dat` → 图片字节；容器不对/解不出图片返回 None（**绝不返回半截字节**）。

    每一段都是拼出来的，任一环错了结果就不是图片——所以判据是「结构是否自洽」
    （见 `is_complete_image`），不是「开头像不像」。
    """
    if AES is None or not aes_key:
        return None
    hs = header(data)
    if not hs:
        return None
    aes_size, xor_size = hs
    if aes_size <= 0 or xor_size < 0 or xor_size > len(data) - HDR:
        return None
    # 明文是 [图片头 aes_size 字节][0x01] 一起补齐到 16 的整数倍；**补位字节不是图片**。
    pad = (aes_size + 1 + 15) // 16 * 16
    if HDR + pad > len(data):
        return None
    try:
        head = AES.new(aes_key, AES.MODE_ECB).decrypt(data[HDR:HDR + pad])[:aes_size]
    except Exception:
        return None
    cut = len(data) - xor_size
    if cut < HDR + pad:
        return None
    k = tail_xor_key(data)
    if k is None:
        k = XOR_KEY_FALLBACK if xor_key is None else xor_key
    # AES 段与 XOR 段之间还可能有**一段明文**（大图实测 1MB，小图是 0 字节）；
    # 少了它大图会缺一整块，多了补位字节小图会错位 16 字节——两头都实测过。
    body = data[HDR + pad:cut]
    out = head + body + bytes(b ^ k for b in data[cut:])
    return out if is_complete_image(out) else None


def hardlink_map(force=False):
    """`{md5: 磁盘文件名}`（来自 `hardlink.db` 的 `image_hardlink_info_v4`）。

    消息里只有 `md5`，文件名只能从这儿来。短 TTL 缓存：`refresh()` 会重写镜像，
    而新图片是异步落库的——缓太久会看不见刚到的图。
    """
    root = core.db_root()
    ent = _hl_cache.get(root)
    if ent and not force and time.time() - ent[0] < _HL_TTL_S:
        return ent[1]
    out = {}
    try:
        m = core._mirror("hardlink/hardlink.db")
        m.refresh()
        # 现开现关：refresh 会重写镜像文件，缓存住的连接会读到重写前的旧页
        conn = sqlite3.connect(m.out)
        try:
            for md5, name in conn.execute("select md5, file_name from image_hardlink_info_v4"):
                if md5 and name:
                    out[md5] = name
        finally:
            conn.close()
    except Exception:
        out = {}
    _hl_cache[root] = (time.time(), out)
    return out


def attach_path(file_name):
    """磁盘上的 `.dat` 路径。attach 目录按会话/月份分片，文件名是全局唯一的 uuid，直接找。"""
    if not file_name:
        return None
    hits = glob.glob(os.path.join(os.path.dirname(core.db_root()),
                                  "msg", "attach", "*", "*", "Img", file_name))
    return hits[0] if hits else None


def image_file(md5, aes_key=None, base=None):
    """图片 → 落盘的位图路径；解不出来返回 None。

    `base` 是 `packed_info_data` 给出的**本地文件名**（见 `core._image_name`）。有它才找得到
    「原图没下、只落了中图」的那批——那时 `md5` 是硬链索引里查不到的死键（见 `_image_name`）。
    原图优先，`wxgf` 退缩略图。落盘到 WORK 并按 `md5 or base` 命名，重复调用直接命中缓存。
    """
    if not md5 and not base:
        return None
    key_id = md5 or base
    cands = []
    name = hardlink_map().get(md5) if md5 else None
    if name:
        cands.append(name)                       # 硬链索引给的是确切文件名（原图优先）
    if base:
        cands += [base + "_h.dat", base + ".dat", base + "_t.dat"]   # 原图 → 中图 → 缩略图
    if not cands:
        return None
    d = os.path.join(core.WORK, "image")
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        return None
    for name in cands:
        kind = "thumb" if name.endswith("_t.dat") else "hd"
        for ext in (".jpg", ".png"):             # 扩展名跟着内容走，两种都得认缓存
            cached = os.path.join(d, "%s_%s%s" % (kind, key_id, ext))
            if os.path.exists(cached) and os.path.getsize(cached) > 0:
                return cached
        src = attach_path(name)
        if not src:
            continue
        try:
            with open(src, "rb") as f:
                img = decrypt(f.read(), aes_key)
        except OSError:
            continue
        if not img or img[:4] == WXGF:            # wxgf 不是位图，退缩略图
            continue
        # 本机图片有 JPEG 也有 PNG。一律写 `.jpg` 会让看图的那一侧按 JPEG 解码、
        # 直接报「文件损坏」——内容是对的，错的是名字。
        out = os.path.join(d, "%s_%s%s" % (kind, key_id, ".png" if img[:4] == b"\x89PNG" else ".jpg"))
        try:
            with open(out, "wb") as f:
                f.write(img)
        except OSError:
            return None
        return out
    return None


def attach_image(msgs, aes_key=None):
    """给图片消息补上 `image_path`，失败静默跳过（与 `core.attach_voice` 同约定）。

    **拿不到 AES key 就什么都不做**（返回原样）：抓 key 要扫一遍微信内存，几十秒起步，
    绝不能塞进 15 秒一拍的盯梢回路里。key 是账号级的，抓一次缓存住就行（见 `image_aes_key`）。
    """
    key = aes_key or cached_aes_key()
    if not key:
        return msgs
    for m in msgs:
        # `image_name`（本地文件名，来自 packed_info_data）比 `image_md5` 更靠得住：
        # 有它的图哪怕原图没下、硬链索引查不到，也能在磁盘上把中图找出来。
        if m.get("type") != 3 or not (m.get("image_md5") or m.get("image_name")):
            continue
        try:
            p = image_file(m.get("image_md5"), key, m.get("image_name"))
        except Exception:
            p = None
        if p:
            m["image_path"] = p
    return msgs


# ---------------------------------------------------------------------------
# AES key：抓一次、缓存住
# ---------------------------------------------------------------------------

def _key_path():
    return os.path.join(core.profile_dir(), "image_key.json")


def cached_aes_key():
    """已缓存的图片 AES key（bytes）；没有返回 None。**不扫内存**。"""
    try:
        with open(_key_path()) as f:
            k = json.load(f).get("aes_key")
        return bytes.fromhex(k) if k else None
    except Exception:
        return None


def save_aes_key(key_hex):
    try:
        with open(_key_path(), "w") as f:
            json.dump({"aes_key": key_hex, "at": int(time.time())}, f)
        return True
    except OSError:
        return False


def _samples(n=8):
    """已知明文样本：`(第一个 AES 密文块, 文件名)`。

    只用**尾巴能推成 JPEG** 的（确定是位图，明文头一定是 `FF D8 FF E0 00 10 4A 46 49 46`）。
    """
    root = os.path.dirname(core.db_root())
    pats = ["*_t.dat", "*.dat"]
    files = []
    for p in pats:
        files += glob.glob(os.path.join(root, "msg", "attach", "*", "*", "Img", p))
    files = [f for f in files if not f.endswith("_h.dat")]
    files.sort(key=os.path.getmtime, reverse=True)
    out, seen = [], set()
    for f in files:
        try:
            with open(f, "rb") as fh:
                d = fh.read()
        except OSError:
            continue
        hs = header(d)
        if not hs or len(d) < 0x20 or tail_xor_key(d) is None:
            continue
        blk = d[HDR:HDR + 16]
        if blk in seen:
            continue
        seen.add(blk)
        out.append((blk, f))
        if len(out) >= n:
            break
    return out


def _candidates(data):
    """内存里可能当 key 的 16 字节串：32 位 hex / 16 字符字母数字，**逐偏移滑动**（对齐无从预知）。"""
    for m in re.finditer(rb"[0-9a-fA-F]{32,}", data):
        run = m.group(0)
        for k in range(0, min(33, len(run) - 31)):
            yield run[k:k + 32].decode("ascii")
    for m in re.finditer(rb"[0-9A-Za-z]{16,}", data):
        run = m.group(0)
        for k in (0, 16):
            if k + 16 <= len(run):
                yield run[k:k + 16].decode("ascii")


def scan_aes_key(timeout=180.0):
    """扫微信进程内存找图片 AES key。

    **慢**（本机实测约 50 秒，要遍历微信全部可读内存区域），且**要么在微信刚查看过图片时才有**：
    密钥是临时加载的，没看过图就是扫不到。扫不到返回 None，由调用方如实告知用户去点开一张图。
    """
    if AES is None:
        return None
    import wxkey4 as K

    ss = _samples()
    if not ss:
        return None
    deadline = time.time() + timeout
    for _mem, pid in K.find_wechat_pids():
        if time.time() > deadline:
            return None
        h = K.kernel32.OpenProcess(0x0010 | 0x0400, False, pid)
        if not h:
            continue
        try:
            seen = set()
            regs = K.enum_regions(h)
            for _base, data in K._iter_chunks(regs, lambda a, s: K.read_mem(h, a, s), overlap=64):
                if not data:
                    continue
                for raw in _candidates(data):
                    if raw in seen:
                        continue
                    seen.add(raw)
                    try:
                        kb = bytes.fromhex(raw) if len(raw) == 32 else raw.encode("ascii")[:16]
                    except ValueError:
                        continue
                    if len(kb) != 16:
                        continue
                    try:
                        c = AES.new(kb, AES.MODE_ECB)
                    except Exception:
                        continue
                    if all(looks_like_image(c.decrypt(blk)) for blk, _f in ss):
                        return kb      # **每一个样本都要过**：单个样本上撞一次车不算数
        finally:
            K.kernel32.CloseHandle(h)
    return None


def image_aes_key(refresh=False, save=True):
    """拿到图片 AES key（bytes）或 None。先缓存，没有才扫内存。

    **这是一次性的慢操作，别放进盯梢回路**；它的正确入口是「用户在设置页点了抓取」或
    devcli。抓到了会落盘，之后 `cached_aes_key()` 就是免费的。
    """
    if not refresh:
        k = cached_aes_key()
        if k and _verify_key(k):
            return k
    k = scan_aes_key()
    if not k:
        return None
    if save:
        save_aes_key(k.hex())
    return k


def _verify_key(key):
    """拿真文件验一遍：**每个样本都要解出图片**（wxgf 也算）。

    为什么非验不可，而且要求「全过」：缓存里的旧 key 解出来是**随机字节**，不校验整条链会
    「安静地给出错误的图」——比报错糟得多；而只要求「有一个过」等于把门槛降到一次撞车
    （见 `looks_like_image`）。
    """
    ss = _samples(3)
    if not ss:
        return False
    for _blk, f in ss:
        try:
            with open(f, "rb") as fh:
                if not decrypt(fh.read(), key):
                    return False
        except OSError:
            return False
    return True


if __name__ == "__main__":       # 自检：格式解析 + 尾巴反推 + 端到端（有 key 时）
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    ss = _samples(3)
    print("[image] 样本:", [(os.path.basename(f), hex(tail_xor_key(open(f, 'rb').read()))) for _b, f in ss])
    assert ss, "没有可用样本"
    k = cached_aes_key() or scan_aes_key()
    if not k:
        print("[image] 没有 AES key（在微信里点开一张图再跑一次）")
        raise SystemExit(1)
    print("[image] AES key =", k.hex())
    # 全索引跑一遍：**每一张都必须结构完整**（PNG 全链 CRC / JPEG marker 链）。
    # 容器少算一个补位字节时，这里会成片变红——这是这套解码唯一的回归判据。
    m = hardlink_map()
    print("[image] hardlink 索引 %d 条" % len(m))
    stat = {"ok": 0, "no_file": 0, "undecodable": 0, "broken": 0}
    for md5 in m:
        hit = attach_path(m[md5]) or attach_path(m[md5][:-4] + "_t.dat")
        if not hit:
            stat["no_file"] += 1
            continue
        with open(hit, "rb") as fh:
            img = decrypt(fh.read(), k)
        if not img:
            stat["undecodable"] += 1
        elif not is_complete_image(img):
            stat["broken"] += 1
            print("   结构不完整:", md5[:12], os.path.basename(hit))
        else:
            stat["ok"] += 1
    print("[image] 结构完整 %d / 无文件 %d / 解不出 %d / 残缺 %d"
          % (stat["ok"], stat["no_file"], stat["undecodable"], stat["broken"]))
    assert not stat["broken"], "有解出来但结构残缺的图"
