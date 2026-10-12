# /// script
# requires-python = ">=3.10"
# dependencies = ["pycryptodome>=3.20", "zstandard>=0.22"]
# ///
"""微信撤回防护 MCP Server（MCP stdio 传输，JSON-RPC 2.0）。

查看**被撤回 / 被删除**的微信消息。前提是**事前留存**：一个独立守护进程持续把新消息
灌进本地归档库（`~/.lumii/wechat-recall/archive.db`），本 MCP 只**只读**这个库并与当前
微信库对差，找出"归档里有、现在没了"的消息。

**只读**——不改动任何微信数据。守护进程见 `daemon.py`（`--daemon` / `--install-autostart`）。

工具：`daemon_status` / `list_recalls` / `read_recall` / `archive_gap`。

共享基础层：读取层直接复用同目录 `../wechat-mcp/` 的模块（经 `archive.py`），本包不复制。
"""
import json
import os
import sys

SERVER_NAME = "wechat-recall"
SERVER_VERSION = "0.1.0"
SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")

PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS = -32700, -32600, -32601, -32602

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import archive  # noqa: E402


def log(*a):
    print("[wechat-recall]", *a, file=sys.stderr, flush=True)


def force_utf8_stdio():
    for stream in (sys.stdout, sys.stderr, sys.stdin):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


TOOLS = [
    {
        "name": "daemon_status",
        "description": (
            "【何时用】先看守护在不在跑、归档了多少、有没有停机缺口——**撤回能不能看到全看它**。"
            "【返回】`alive`（守护是否在跑）/ `archived`（归档条数）/ `backfilled` / `last_tick` / "
            "`gaps`（停机缺口数）/ `autostart`（是否已开机自启）/ `db_path`。"
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_recalls",
        "description": (
            "【何时用】看某会话（或全部）**被撤回/删除**的消息。"
            "【判定】归档里有、当前微信库里已没有或已被改写成系统消息。"
            "`reason`：`deleted` 整条消失 / `recalled` 被改写 / `changed` 其它变动。"
            "【返回】每条含时间、发送者、原**文本**、`local_id`（可据此 read_recall 取完整原文）。"
            "【前提】守护必须**在撤回发生之前**就已在跑；守护启动前的撤回看不到。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "talker": {"type": "string", "description": "会话名或 wxid/群号；省略=全部会话"},
                "since": {"type": "integer", "description": "起始时间（Unix 秒，含）"},
                "until": {"type": "integer", "description": "结束时间（Unix 秒，含）"},
                "limit": {"type": "integer", "description": "最多返回条数（默认 200）"},
            },
        },
    },
    {
        "name": "read_recall",
        "description": "【何时用】取一条被撤回消息的**完整原文**（`list_recalls` 给的是摘要）。"
                       "【参数】talker + list_recalls 返回的 `local_id`。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "talker": {"type": "string", "description": "会话名或 wxid/群号"},
                "local_id": {"type": "integer", "description": "消息在会话内的序号（list_recalls 返回）"},
            },
            "required": ["talker", "local_id"],
        },
    },
    {
        "name": "archive_gap",
        "description": "【何时用】确认归档有没有**漏记的时间段**（关机/守护没跑的时候）。"
                       "有缺口就说明那段期间的撤回看不了——**如实告诉用户，别假装全覆盖**。",
        "inputSchema": {"type": "object", "properties": {}},
    },
]

INSTRUCTIONS = """\
本服务查**被撤回/被删除**的微信消息（只读）。

**前提**：必须先有一个常驻守护把消息留档——不然撤回发生后就无从查起。
1. 先 `daemon_status()` 看守护在不在跑、归档了多少、有没有缺口。
2. 守护没在跑 → 告诉用户需要启动它（`wechat-recall-mcp.exe --daemon`，或 `--install-autostart` 开机自启）；
   **守护启动之前的撤回是查不到的**，如实说明。
3. `list_recalls(talker=...)` 看被撤回的消息，`read_recall` 取完整原文。

硬约束：
- 归档只写一次、永不覆盖，所以撤回前的**原文**留得住；但**关机期间漏的补不回来**（看 `archive_gap`）。
- 数据含他人隐私：只读、本地处理、不外传。
"""

DISPATCH = {
    "daemon_status": lambda a: _tool_status(a),
    "list_recalls": lambda a: _tool_list(a),
    "read_recall": lambda a: _tool_read(a),
    "archive_gap": lambda a: _tool_gap(a),
}


def _con():
    return archive.connect()


def _resolve(talker):
    if not talker:
        return None
    got = archive.core.resolve_talker(talker)
    return got if got else talker          # 解析不出就按原样当 talker（可能是 wxid）


def _tool_status(_args):
    import daemon
    return daemon.status()


def _tool_list(args):
    con = _con()
    try:
        recs = archive.find_recalls(con, talker=_resolve(args.get("talker")),
                                    since=int(args.get("since") or 0),
                                    until=int(args.get("until") or 0),
                                    limit=int(args.get("limit") or 200))
    finally:
        con.close()
    return {"count": len(recs), "recalls": recs}


def _tool_read(args):
    talker, lid = args.get("talker"), args.get("local_id")
    if not talker or lid is None:
        return {"error": "talker 与 local_id 都必填"}
    con = _con()
    try:
        rec = archive.read_recall(con, _resolve(talker), int(lid))
    finally:
        con.close()
    if rec is None:
        return {"error": "归档里没有这条消息（可能守护当时没在跑）", "error_code": "not_archived"}
    return rec


def _tool_gap(_args):
    con = _con()
    try:
        gaps = archive.gaps(con)
    finally:
        con.close()
    return {"count": len(gaps), "gaps": gaps}


# ---- 协议层（stdio JSON-RPC）----
_PROTOCOL_OUT = sys.stdout


def _send(message):
    _PROTOCOL_OUT.write(json.dumps(message, ensure_ascii=False) + "\n")
    _PROTOCOL_OUT.flush()


def reply(mid, result):
    _send({"jsonrpc": "2.0", "id": mid, "result": result})


def reply_error(mid, code, message):
    _send({"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}})


def handle_initialize(params):
    req = params.get("protocolVersion")
    return {
        "protocolVersion": req if req in SUPPORTED_PROTOCOL_VERSIONS else SUPPORTED_PROTOCOL_VERSIONS[0],
        "capabilities": {"tools": {"listChanged": False}},
        "serverInfo": {"name": SERVER_NAME, "title": "微信撤回防护", "version": SERVER_VERSION},
        "instructions": INSTRUCTIONS,
    }


def handle_tools_call(mid, params):
    name = params.get("name")
    args = params.get("arguments") or {}
    handler = DISPATCH.get(name)
    if handler is None:
        reply_error(mid, INVALID_PARAMS, f"Unknown tool: {name}")
        return
    if not isinstance(args, dict):
        reply_error(mid, INVALID_PARAMS, "arguments 必须是对象")
        return
    log("call", name)
    try:
        data = handler(args)
        reply(mid, {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}],
                    "isError": False})
    except Exception as e:
        log("error", name, repr(e))
        reply(mid, {"content": [{"type": "text", "text": f"ERROR: {e}"}], "isError": True})


def handle_message(msg):
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        reply_error(msg.get("id") if isinstance(msg, dict) else None, INVALID_REQUEST, "Invalid Request")
        return
    method = msg.get("method")
    if not isinstance(method, str) or "id" not in msg:
        return
    mid, params = msg.get("id"), msg.get("params")
    if not isinstance(params, dict):
        params = {}
    if method == "initialize":
        reply(mid, handle_initialize(params))
    elif method == "ping":
        reply(mid, {})
    elif method == "tools/list":
        reply(mid, {"tools": TOOLS})
    elif method == "tools/call":
        handle_tools_call(mid, params)
    else:
        reply_error(mid, METHOD_NOT_FOUND, f"Method not found: {method}")


def main():
    global _PROTOCOL_OUT
    force_utf8_stdio()
    _PROTOCOL_OUT = sys.stdout
    sys.stdout = sys.stderr
    log(f"started v{SERVER_VERSION} (python {sys.version.split()[0]})")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            reply_error(None, PARSE_ERROR, "Parse error")
            continue
        try:
            handle_message(msg)
        except Exception as e:
            log("internal error", repr(e))


if __name__ == "__main__":
    # 守护/自启/状态 三个开关先把编码钉住，再走各自分支
    force_utf8_stdio()
    argv = sys.argv[1:]
    if "--version" in argv:
        print(SERVER_VERSION)
        sys.exit(0)
    if any(f in argv for f in ("--daemon", "--once", "--install-autostart",
                               "--uninstall-autostart", "--status")):
        import daemon
        daemon.main()                                    # 直接吃 sys.argv[1:]，即上面的 argv
        sys.exit(0)
    main()
