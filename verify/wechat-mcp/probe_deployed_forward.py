# -*- coding: utf-8 -*-
"""**已部署的 exe** 里到底有没有那条合并转发修复。

为什么不能只看构建成功：源码改了、测试过了、exe 也 build 出来了，但**部署路径上那份
可能是旧的**（本项目踩过：只重启不换 exe）。判据必须打在客户端真正拉起的那个进程上。

跑法：PYTHONIOENCODING=utf-8 ~/.lumii/runtimes/python-embed/python.exe probe_deployed_forward.py
只读：只调读类工具（search/list_sessions），不发送任何消息。
"""
import json
import os
import sys

HERE = r"C:\myself\projects\my\open-source\lumii\apps\windows\resources\wechat-mcp"
sys.path.insert(0, HERE)

from test_mcp_client import DEPLOYED, McpClient                    # noqa: E402

# 只出现在**合并转发内部**的串（实测：修复前全库 0 命中，修复后 1 命中）
INNER = ["自助服务终端", "你刚才说的移动端"]


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                               # noqa: BLE001
        pass
    print("被测 exe：%s  (%d 字节)" % (DEPLOYED, os.path.getsize(DEPLOYED)))
    c = McpClient([DEPLOYED])
    info = c.start()
    print("握手：%s" % json.dumps(info.get("serverInfo", {}), ensure_ascii=False))

    bad = []
    for kw in INNER:
        p, _raw = c.call_tool("search_messages", {"keyword": kw, "limit": 5})
        n = p.get("count", 0)
        print("  搜「%s」→ %d 条  %s" % (kw, n, [m.get("text", "")[:50] for m in p.get("messages", [])[:1]]))
        if not n:
            bad.append(kw)

    # 会话列表预览是**单行**字段（`last`）：修复后也必须还是一行
    # （`_render` 会展开成多行，会话列表里不切首行就会多出一截转发正文）
    p, _raw = c.call_tool("list_sessions", {})
    rows = p if isinstance(p, list) else p.get("sessions", [])   # 这个工具**直接返回列表**
    if not rows:
        print("FAIL：list_sessions 一条都没返回 ⇒ 预览那条检查是空转的，不能算通过")
        return 1
    multi = [s for s in rows if "\n" in (s.get("last") or "")]
    print("会话 %d 个；预览含换行的 %d 个" % (len(rows), len(multi)))
    if multi:
        bad.append("会话预览串行")

    c.proc.kill()
    if bad:
        print("FAIL：已部署的 exe 缺这块能力 → %s" % bad)
        return 1
    print("PASS：部署路径上的 exe 含合并转发展开（转发正文可检索、预览不串行）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
