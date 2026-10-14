"""只读探针（B8）：全库扫 lt=49 的 appmsg 子类型，看每种类型除了 title 之外有多少可抽的字段。

不猜：视频号的 title 实测是「当前版本不支持展示该内容，请升级至最新版本。」这种微信自己的
升级提示——导出里每条视频号都长这样，是**误导**。这里先看清真正的字段在哪。
"""
import collections
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "..", "..", "apps", "windows", "resources")
for p in (os.path.join(RES, "wechat-mcp"), os.path.join(RES, "wechat-export-mcp")):
    sys.path.insert(0, os.path.abspath(p))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
print("sys.path[0:3] =", sys.path[:3], flush=True)

import exportcore as X  # noqa: E402
import wechat_core as core  # noqa: E402

PER = 900
WANT = (6, 44, 51, 63, 2000, 2001, 2002, 2003, 42, 48, 4, 17, 87)
core._refresh()
count = collections.Counter()
sample = {}
sessions = core.sessions()
for s in sessions:
    tk = s.get("talker")
    if not tk:
        continue
    try:
        rows = X.iter_rows(tk, 0, 0)[-PER:]
    except Exception:  # noqa: BLE001
        continue
    for ct, lt, content, _sd, lid in rows:
        if (lt & 0xFFFFFFFF) != 49:
            continue
        raw = core._PREFIX_RE.sub("", core.decode(content))
        t = core._num(raw, "type")
        count[t] += 1
        if t in WANT and t not in sample:
            sample[t] = (raw, s.get("name"))

print("扫 %d 个会话 × 最近 %d 条" % (len(sessions), PER))
print("全部 appmsg 子类型计数：", dict(count.most_common()))
for t in WANT:
    if t not in sample:
        continue
    raw, sname = sample[t]
    print("=" * 78)
    print("[%s]  会话 %s   现在渲染成：%s" % (t, sname, core.describe_nontext(49, raw)[:90]))
    print(raw.replace("\t", " ")[:700])
