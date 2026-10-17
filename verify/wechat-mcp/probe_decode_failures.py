"""量 `decode()` 的 zstd 兜底会不会真被踩到（只读）。

`decode` 里 `Except: pass` ⇒ 解压失败（含超过 `max_output_size=1<<20`）就把**压缩字节**按
utf-8("replace") 解出来当正文 —— 乱码冒充内容，比截断更难发现（它看起来像数据）。
先量：本机到底有没有踩到这个分支、content 最大多大。
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "apps", "windows", "resources", "wechat-mcp"))
import wechat_core as C  # noqa: E402

try:
    import zstandard as zstd
except Exception:
    zstd = None

n = zrows = fail = 0
mx = (0, "")
for tbl, talker in C.talkers():
    for r in C._rows(tbl, 100000):
        n += 1
        raw = r[2] if isinstance(r[2], bytes) else str(r[2]).encode()
        if zstd and raw[:4] == b"\x28\xb5\x2f\xfd":
            zrows += 1
            try:
                out = zstd.ZstdDecompressor().decompress(raw, max_output_size=1 << 20)
            except Exception as e:
                fail += 1
                if fail <= 3:
                    print(f"  解压失败 {tbl}#{r[4]}: {type(e).__name__}: {e}；压缩 {len(raw)}B")
                continue
            if len(out) > mx[0]:
                mx = (len(out), f"{talker[:20]} lt={r[1] & 0xFFFFFFFF}")

print(f"消息 {n}；zstd 压缩过的 {zrows}；解压失败 {fail}；解压后最大 {mx[0]}B ({mx[1]})")
if zstd:
    print(f"上限 max_output_size = {1 << 20}B ⇒ "
          f"{'没踩到' if fail == 0 else '踩到了'}")
