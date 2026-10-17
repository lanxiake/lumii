"""只读探针：`appmsg type=1` 是不是**全都**是引用（带 refermsg）？—— 它是本机最高频子类型（305 条）。"""
import collections
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.abspath(os.path.join(HERE, "..", "..", "apps", "windows", "resources"))
for p in (os.path.join(RES, "wechat-mcp"), os.path.join(RES, "wechat-export-mcp")):
    sys.path.insert(0, p)
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import exportcore as X  # noqa: E402
import wechat_core as core  # noqa: E402

WATCH = (1, 2000, 2001, 2002, 2003, 44, 51, 63, 33, 36, 4, 8, 0)
core._refresh()
stat = collections.Counter()
norefer = None
for s in core.sessions():
    tk = s.get("talker")
    if not tk:
        continue
    try:
        rows = X.iter_rows(tk, 0, 0)[-900:]
    except Exception:  # noqa: BLE001
        continue
    for ct, lt, content, _sd, lid in rows:
        if (lt & 0xFFFFFFFF) != 49:
            continue
        raw = core.decode(content)
        t = core._num(raw, "type")
        if t not in WATCH:
            continue
        stat[(t, "refermsg" in raw, "wcpayinfo" in raw, "finderFeed" in raw,
              "finderLive" in raw)] += 1
        if t == 1 and "refermsg" not in raw and norefer is None:
            norefer = raw[:400]
print("(type, refermsg, wcpayinfo, finderFeed, finderLive) → 条数")
for k, n in sorted(stat.items()):
    print("  %-32s %d" % (k, n))
print("\ntype=1 但没有 refermsg 的样本：")
print(norefer or "（没有：本机 type=1 全都是引用）")
