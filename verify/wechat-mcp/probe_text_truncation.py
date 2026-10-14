"""量一下 `msg_dict` 的 400 字硬截断在本机真库里到底会不会触发（只读）。

`msg_dict` 里 `d["text"] = text[:400]`，截了**不留任何痕迹**——读的人（Agent）无从知道
手上这句是全文还是半句。这类"静默窗口"是本轮反复扫的东西，先量再决定值不值得修。

跑法：PYTHONIOENCODING=utf-8 python.exe probe_text_truncation.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "apps", "windows", "resources", "wechat-mcp"))
import wechat_core as C  # noqa: E402

CAP = 400
n = over = 0
top = []
for tbl, talker in C.talkers():
    for r in C._rows(tbl, 100000):
        n += 1
        text = C.split_agent_mark(C._render(r[1], r[2]))[0]
        if len(text) > CAP:
            over += 1
            top.append((len(text), talker, r[1] & 0xFFFFFFFF, text[:60]))

top.sort(reverse=True)
print(f"消息总数 {n}；渲染后超 {CAP} 字的 {over} 条 ({over * 100.0 / max(n, 1):.3f}%)")
for ln, talker, lt, head in top[:10]:
    print(f"  {ln:>6} 字  lt={lt:<4} {talker[:24]:<24} {head!r}")
