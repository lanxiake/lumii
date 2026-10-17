"""只读探针（切片 3 第一步）：**先量**——一个 500 条带图的会话，导出自包含 HTML 会有多大。

不写任何导出文件：直接 stat 已解密的图片路径，按 base64 的 4/3 折算内嵌体积。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "..", "..", "apps", "windows", "resources")
for p in (os.path.join(RES, "wechat-mcp"), os.path.join(RES, "wechat-export-mcp")):
    sys.path.insert(0, p)
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import exportcore as X  # noqa: E402
import wechat_core as core  # noqa: E402

N = 500
core._refresh()
try:
    import wechat_image
    print("AES key 已缓存：", bool(wechat_image.cached_aes_key()))
except Exception as e:  # noqa: BLE001
    print("wechat_image 不可用：", e)

print("会话数：", len(core.sessions()))
rows_report = []
for s in core.sessions():
    talker = s.get("talker")
    if not talker:
        continue
    try:
        rows = X.iter_rows(talker, 0, 0)[-N:]
    except Exception as e:  # noqa: BLE001
        continue
    imgs = [r for r in rows if (r[1] & 0xFFFFFFFF) == 3]
    if not imgs:
        continue
    sizes, miss = [], 0
    for ct, lt, content, _sender, lid in imgs:
        try:
            m = core.image_message(talker, lid)
        except Exception:
            m = None
        p = (m or {}).get("image_path")
        if p and os.path.isfile(p):
            sizes.append((os.path.getsize(p), os.path.splitext(p)[1]))
        else:
            miss += 1
    text_bytes = sum(len(X.render_text(r[1], r[2])[0].encode("utf-8")) for r in rows)
    rows_report.append((sum(x[0] for x in sizes), len(rows), len(imgs), len(sizes), miss,
                        text_bytes, s.get("name"), sorted(set(x[1] for x in sizes))))

rows_report.sort(reverse=True)
print(f"\n{'图(原图)MB':>10} {'条数':>6} {'图':>4} {'解出':>4} {'缺':>4} {'纯文字KB':>8}  {'自包含MB':>8}  会话")
for tot, nr, ni, ok, miss, tb, name, exts in rows_report[:12]:
    print(f"{tot/1e6:>10.1f} {nr:>6} {ni:>4} {ok:>4} {miss:>4} {tb/1024:>8.0f} "
          f"{tot*4/3/1e6:>8.1f}  {(name or '')[:24]} {exts}")
print(f"\n共 {len(rows_report)} 个会话有图")
