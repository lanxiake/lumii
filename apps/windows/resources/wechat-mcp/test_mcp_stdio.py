"""mcp_stdio 单测（纯内存，不碰微信、不碰 stdio）。运行：python test_mcp_stdio.py

这套是四件套**协议层**的回归。它存在的理由很具体：协议循环原先在四个 server.py 里各写一份，
已经踩过两次「手搓对不上 SDK」（`serverInfo`→`server_info`、`isError` 缺省）——收敛成一份之后，
这里就是唯一需要盯的地方。
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:                                # Windows 控制台常是 GBK
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import mcp_stdio as M
from wechat_core import UnknownTalker

TOOLS = [{"name": "ok_tool", "description": "demo", "inputSchema": {"type": "object"}},
         {"name": "boom", "description": "demo", "inputSchema": {"type": "object"}},
         {"name": "unknown_talker", "description": "demo", "inputSchema": {"type": "object"}}]
DISPATCH = {
    "ok_tool": lambda a: {"echo": a.get("x")},
    "boom": lambda a: 1 / 0,
    "unknown_talker": lambda a: (_ for _ in ()).throw(UnknownTalker(a.get("talker", ""))),
}


def _server():
    """造一个 server 并把协议流接进内存缓冲（不碰真 stdout）。"""
    s = M.StdioServer("demo", "演示", "9.9.9", TOOLS, "原始说明", DISPATCH)
    buf = io.StringIO()
    s._out = buf
    return s, buf


def _call(s, buf, method, params=None, mid=1):
    """喂一条请求，取回它写出的那一条响应（通知不产生响应）。"""
    buf.seek(0)
    buf.truncate(0)
    s.handle({"jsonrpc": "2.0", "id": mid, "method": method, **({"params": params} if params else {})})
    line = buf.getvalue().strip()
    return json.loads(line) if line else None


def _tool(s, buf, name, args=None):
    """调一个工具 → `(结果, isError)`；结果能解析成 JSON 就解析，否则原样返回文本。"""
    res = _call(s, buf, "tools/call", {"name": name, "arguments": args or {}})
    body = res["result"]["content"][0]["text"]
    data = json.loads(body) if body.lstrip().startswith(("{", "[")) else body
    return data, res["result"].get("isError", False)


def test_initialize_negotiates_protocol():
    s, buf = _server()
    r = _call(s, buf, "initialize", {"protocolVersion": "2025-06-18"})["result"]
    assert r["protocolVersion"] == "2025-06-18"
    assert r["serverInfo"] == {"name": "demo", "title": "演示", "version": "9.9.9"}, r["serverInfo"]
    assert r["capabilities"]["tools"]["listChanged"] is False
    # 客户端报的版本不认识 → 回落到自己支持的最新
    r2 = _call(s, buf, "initialize", {"protocolVersion": "1999-01-01"})["result"]
    assert r2["protocolVersion"] == M.SUPPORTED_PROTOCOL_VERSIONS[0]
    r3 = _call(s, buf, "initialize")["result"]
    assert r3["protocolVersion"] == M.SUPPORTED_PROTOCOL_VERSIONS[0]
    # 工具约定必须**自动挂在每个产品的说明后面**，不然四个产品各自会忘
    assert "target_not_found" in r["instructions"] and "原始说明" in r["instructions"]
    print("ok initialize_negotiates_protocol")


def test_tools_list_and_ok_call():
    s, buf = _server()
    tools = _call(s, buf, "tools/list")["result"]["tools"]
    assert [t["name"] for t in tools] == ["ok_tool", "boom", "unknown_talker"]
    data, is_err = _tool(s, buf, "ok_tool", {"x": 7})
    assert data == {"echo": 7} and is_err is False, (data, is_err)
    print("ok tools_list_and_ok_call")


def test_unknown_talker_becomes_target_not_found():
    """会话参数解析不出唯一目标 → 固定错误码（**不是**"0 条"这种静默空结果）。"""
    s, buf = _server()
    data, is_err = _tool(s, buf, "unknown_talker", {"talker": "张三"})
    assert data["error_code"] == "target_not_found", data
    assert "张三" in data["error"] and is_err is False, (data, is_err)
    print("ok unknown_talker_becomes_target_not_found")


def test_tool_exception_is_iserror():
    """工具内部炸了 → isError=true 的一等结果，服务本身不退出。"""
    s, buf = _server()
    data, is_err = _tool(s, buf, "boom")
    assert is_err is True, data
    assert data.startswith("ERROR: "), data
    data2, _ = _tool(s, buf, "ok_tool", {"x": 1})       # 炸过之后服务还得活着
    assert data2 == {"echo": 1}
    print("ok tool_exception_is_iserror")


def test_bad_requests():
    s, buf = _server()
    assert _call(s, buf, "tools/call", {"name": "nope"})["error"]["code"] == M.INVALID_PARAMS
    assert _call(s, buf, "tools/call", {"name": "ok_tool", "arguments": [1]})["error"]["code"] \
        == M.INVALID_PARAMS
    assert _call(s, buf, "no/such/method")["error"]["code"] == M.METHOD_NOT_FOUND
    assert _call(s, buf, "ping")["result"] == {}
    # 通知（无 id）一律不回应
    buf.seek(0); buf.truncate(0)
    s.handle({"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert buf.getvalue() == ""
    # 坏帧 / 非 2.0 → Invalid Request，且不能让循环挂掉
    buf.seek(0); buf.truncate(0)
    s.handle({"id": 5, "method": "ping"})
    assert json.loads(buf.getvalue())["error"]["code"] == M.INVALID_REQUEST
    print("ok bad_requests")


if __name__ == "__main__":
    test_initialize_negotiates_protocol()
    test_tools_list_and_ok_call()
    test_unknown_talker_becomes_target_not_found()
    test_tool_exception_is_iserror()
    test_bad_requests()
    print("ALL PASS")
