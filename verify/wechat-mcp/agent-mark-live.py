# -*- coding: utf-8 -*-
"""活体探针：**部署的** wechat-mcp.exe 有没有把「代聊代发」挡在蒸馏语料之外。

和 `test_agent_mark.py`（纯内存，毫秒级）的分工：那边查逻辑，这边查**接线**——
exe 是不是落后于源码、`send_text` 有没有真把标记落进微信库、`digest` 有没有真把它剔掉。
改完 py 重新打包 + 覆盖部署后跑一次，全绿才算这次部署有效。

跑法（托管解释器，PATH 里的 python 是 Store 占位）：
    ~/.lumii/runtimes/python-embed/python.exe verify/wechat-mcp/agent-mark-live.py

副作用：往 **filehelper**（文件传输助手，自己跟自己）发一条探针，**故意不加** `【自检】`
前缀——要验的是零宽标记这条路，加了前缀就分不清是哪条规则在起作用。
"""
import os
import sys
import time

MCP_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "apps", "windows", "resources", "wechat-mcp",
)
sys.path.insert(0, MCP_DIR)

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from test_mcp_client import McpClient, Runner, pick_command  # noqa: E402

AGENT_MARK = "​‌​"     # 与 wechat_core.AGENT_MARK 逐码位一致，只用来查残留
TALKER = "filehelper"
PROBE = f"（接线探针 {int(time.time())}）"


def main():
    cmd = pick_command()
    print(f"server: {' '.join(cmd)}")
    r = Runner()
    client = McpClient(cmd)
    try:
        client.start()

        # `dry_run` 默认 true（server.py:382）——不显式关掉的话这条探针**根本没发出去**，
        # 后面「读得回来」必然红，看着像标记坏了，其实是压根没发。第一版就这么被骗过一次。
        sent, raw = client.call_tool("send_text", {"talker": TALKER, "text": PROBE, "dry_run": False})
        r.check("send_text 成功", sent.get("ok") is not False, str(raw)[:200])
        time.sleep(2)  # 微信落库有一拍；读太快会看不到刚发的那条

        hist, _ = client.call_tool("read_history", {"talker": TALKER, "limit": 5})
        msgs = hist.get("messages") or []
        hit = [m for m in msgs if PROBE in (m.get("text") or "")]
        r.check("探针读得回来", bool(hit), str([(m.get("text") or "")[:24] for m in msgs]))
        if hit:
            # 只打「有没有」和「剥没剥」，不打正文——filehelper 里有用户的敏感内容
            r.check("带 agent_sent 标记", hit[0].get("agent_sent") is True,
                    f"agent_sent={hit[0].get('agent_sent')!r}")
            r.check("正文里不残留零宽标记", AGENT_MARK not in (hit[0].get("text") or ""),
                    f"len={len(hit[0].get('text') or '')}")

        dig, raw = client.call_tool("wechat_digest", {"talker": TALKER})
        r.check("wechat_digest 成功", dig.get("ok") is not False, str(raw)[:200])
        # 一条判据就够：探针那条只要在 digest 的任何一栏里露面，就是没剔干净
        r.check("代发探针不进蒸馏语料", PROBE not in str(dig))
    finally:
        client.stop()
    return r.summary()


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
