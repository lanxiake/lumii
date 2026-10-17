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
from wechat_core import EnvError, UnknownTalker

TOOLS = [{"name": "ok_tool", "description": "demo", "inputSchema": {"type": "object"}},
         {"name": "boom", "description": "demo", "inputSchema": {"type": "object"}},
         {"name": "unknown_talker", "description": "demo", "inputSchema": {"type": "object"}},
         {"name": "ambiguous", "description": "demo", "inputSchema": {"type": "object"}},
         {"name": "no_wechat", "description": "demo", "inputSchema": {"type": "object"}},
         {"name": "slow_tool", "description": "demo", "inputSchema": {"type": "object"}}]


def _slow(_args):
    """模拟批量任务：分阶段 + 显式计数（含一次**回退**的 n，验协议层的单调兜底）。"""
    M.progress("阶段一：开始")
    M.progress("阶段二：过半", total=2, n=2)
    M.progress("计数回退也不许倒退", total=2, n=1)     # 单调性由 protocol 层兜底
    return {"done": True}


DISPATCH = {
    "ok_tool": lambda a: {"echo": a.get("x")},
    "boom": lambda a: 1 / 0,
    "slow_tool": _slow,
    "unknown_talker": lambda a: (_ for _ in ()).throw(UnknownTalker(a.get("talker", ""))),
    # 歧义：本机真有三个 loop —— 报错必须带上候选，否则用户只能干瞪眼
    "ambiguous": lambda a: (_ for _ in ()).throw(UnknownTalker("loop", [
        {"talker": "wxid_s6piy", "name": "Loop", "has_history": True},
        {"talker": "wxid_s7vhn", "name": "loop", "has_history": False},
    ])),
    "no_wechat": lambda a: (_ for _ in ()).throw(
        EnvError("读不到微信的数据库密钥（进程内存里没扫到）", hint="打开微信并登录后再试")),
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


def _call_all(s, buf, method, params=None, mid=1):
    """喂一条请求，取回它写出的**全部**消息（进度通知会先于结果发出好几条，`_call` 只看得了一条）。"""
    buf.seek(0)
    buf.truncate(0)
    s.handle({"jsonrpc": "2.0", "id": mid, "method": method, **({"params": params} if params else {})})
    return [json.loads(line) for line in buf.getvalue().strip().split("\n") if line.strip()]


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
    assert [t["name"] for t in tools] == [t["name"] for t in TOOLS]
    data, is_err = _tool(s, buf, "ok_tool", {"x": 7})
    assert data == {"echo": 7} and is_err is False, (data, is_err)
    print("ok tools_list_and_ok_call")


def test_unknown_talker_becomes_target_not_found():
    """会话参数解析不出唯一目标 → 固定错误码（**不是**"0 条"这种静默空结果）。"""
    s, buf = _server()
    data, is_err = _tool(s, buf, "unknown_talker", {"talker": "张三"})
    assert data["error_code"] == "target_not_found", data
    assert "张三" in data["detail"] and is_err is False, (data, is_err)
    print("ok unknown_talker_becomes_target_not_found")


def test_error_envelope_shape():
    """**统一信封**：任何失败都长成 `{ok:false, detail, error_code, stage, suggestion}`。

    为什么专门测形状：四件套最初 A/C/D 静默返回 0 条、B 报错，同一份提示词覆盖不了不同形状。
    收敛成一种之后，这条断言就是防它再漂回去的哨位——**五个键缺一个就等于漂了**。
    """
    s, buf = _server()
    for tool, args in (("unknown_talker", {"talker": "张三"}),
                       ("no_wechat", {}),
                       ("boom", {})):
        data, _ = _tool(s, buf, tool, args)
        missing = {"ok", "detail", "error_code", "stage", "suggestion"} - set(data)
        assert not missing, f"{tool} 的结果少了 {missing}：{data}"
        assert data["ok"] is False and data["detail"], (tool, data)
        assert data["suggestion"], (tool, data)
    # stage 要能区分"环境的锅 / 参数的锅 / 会话名的锅"——这正是它存在的理由
    env, _ = _tool(s, buf, "no_wechat")
    tgt, _ = _tool(s, buf, "unknown_talker", {"talker": "张三"})
    assert (env["stage"], tgt["stage"]) == ("env", "target"), (env["stage"], tgt["stage"])
    print("ok error_envelope_shape")


def test_env_error_carries_hint():
    """环境没就绪 → `env_not_ready` + 给用户的动手步骤；**不置 isError**。

    不置 isError 是有意的：这类失败是"要你读并转告用户"的结构化结果，不是协议层故障。
    客户端的引导词就是这么教的（`TOOL_CONVENTIONS`），两边必须一致。
    """
    s, buf = _server()
    data, is_err = _tool(s, buf, "no_wechat")
    assert data["error_code"] == "env_not_ready", data
    assert "打开微信" in data["hint"], data
    assert is_err is False, data
    assert "env_not_ready" in M.TOOL_CONVENTIONS      # 引导词里得教过这个码
    print("ok env_error_carries_hint")


def test_ambiguous_talker_lists_candidates():
    """歧义时报错要带**候选**——"找不到"不可操作，把人名/ID 列出来才可操作。"""
    s, buf = _server()
    data, _ = _tool(s, buf, "ambiguous")
    assert data["error_code"] == "target_not_found", data
    assert len(data["candidates"]) == 2, data
    assert "Loop" in data["detail"] and "wxid_s7vhn" in data["detail"], data["detail"]
    print("ok ambiguous_talker_lists_candidates")


def test_tool_exception_is_iserror():
    """工具内部炸了 → isError=true 的一等结果，服务本身不退出。"""
    s, buf = _server()
    data, is_err = _tool(s, buf, "boom")
    assert is_err is True, data
    assert data["error_code"] == "internal_error", data
    assert "ZeroDivisionError" in data["detail"], data
    data2, _ = _tool(s, buf, "ok_tool", {"x": 1})       # 炸过之后服务还得活着
    assert data2 == {"echo": 1}
    print("ok tool_exception_is_iserror")


def test_progress_notifications():
    """进度通知的三条判据（与主产品 `test_watch.py` M 层同一套）。

    ① 客户端**带了** `_meta.progressToken` ⇒ 逐条发 `notifications/progress`、token 原样回传、
       `progress` 严格递增（规范要求，客户端拿它算比例）；
    ② 没带 ⇒ **一条都不发**（无主的上报，规范不允许）；
    ③ 调用结束必须**还原槽位**——不还原就会把上一条请求的 token 泄漏给下一次调用。
    """
    s, buf = _server()
    msgs = _call_all(s, buf, "tools/call",
                     {"name": "slow_tool", "arguments": {}, "_meta": {"progressToken": "tk-1"}})
    notifs = [m for m in msgs if m.get("method") == "notifications/progress"]
    assert len(notifs) == 3, msgs
    assert all(n["params"]["progressToken"] == "tk-1" for n in notifs), notifs
    seq = [n["params"]["progress"] for n in notifs]
    assert seq == sorted(set(seq)), f"progress 必须严格递增，实际 {seq}"
    assert msgs[-1]["id"] == 1 and "result" in msgs[-1], msgs[-1]   # 结果跟在通知后面
    assert M._PROGRESS["cb"] is None, "调用结束必须还原进度槽"

    none_msgs = _call_all(s, buf, "tools/call", {"name": "slow_tool", "arguments": {}})
    assert not [m for m in none_msgs if m.get("method") == "notifications/progress"], none_msgs
    print("ok progress_notifications")


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
    test_error_envelope_shape()
    test_env_error_carries_hint()
    test_ambiguous_talker_lists_candidates()
    test_tool_exception_is_iserror()
    test_progress_notifications()
    test_bad_requests()
    print("ALL PASS")
