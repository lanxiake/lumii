"""只读探针：找 `_render` 结果里仍带 XML 痕迹的**引用**消息，逐段打印中间值。

来自 test_automation.py 的全类型扫描（589 条里 2 条漏）。不猜，把 raw / refer_text 的输入输出都摊开。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "apps", "windows", "resources", "wechat-mcp"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import wechat_core as core  # noqa: E402

core._refresh()
tbl = core.tbl_of(core.resolve_talker("49227618224@chatroom"))
hits = 0
for row in core._rows_full(tbl, 400):
    ct, lt, c, s = row[0], row[1], row[2], row[3]
    t = core._render(lt, c)
    if not ("aeskey=" in t or "<msg>" in t[:40] or t.lstrip().startswith("<")):
        continue
    hits += 1
    raw = core._PREFIX_RE.sub("", core.decode(c)).replace("\n", " ").strip()
    print("=" * 70)
    print("local_type=%s → _render 用的 lt&0xFFFFFFFF=%s" % (lt, lt & 0xFFFFFFFF))
    print("渲染=%s" % t[:150])
    print("raw[:200]=%r" % raw[:200])
    print("refer_text → %r" % (core.refer_text(raw),))
    inner = core._unxml(core._tag(
        __import__("re").search(r"<refermsg>(.*?)</refermsg>", raw, __import__("re").S).group(1),
        "content"))
    print("被引 content 前 200：%r" % inner[:200])
print("命中 %d 条" % hits)
