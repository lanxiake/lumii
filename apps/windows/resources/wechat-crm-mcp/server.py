# /// script
# requires-python = ">=3.10"
# dependencies = ["pycryptodome>=3.20", "zstandard>=0.22"]
# ///
"""微信客户分析 MCP Server（MCP stdio 传输，JSON-RPC 2.0）。

**只出取数与统计，不出判断**：通讯录（好友/群/公众号/企业微信）、群成员、
单会话互动统计、互动排行。"这个客户意向高不高"交给接入方的 LLM + 技能包。

**只读**——不改动任何微信数据。

工具：`list_contacts` / `contact_stats` / `interaction_rank`。

共享基础层：读取层直接复用同目录 `../wechat-mcp/` 的模块（经 `contactscore.py`），本包不复制。
"""
import json
import os
import sys

SERVER_NAME = "wechat-crm"
SERVER_VERSION = "0.1.0"
SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")

PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS = -32700, -32600, -32601, -32602

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import contactscore as S  # noqa: E402


def log(*a):
    print("[wechat-crm]", *a, file=sys.stderr, flush=True)


def force_utf8_stdio():
    for stream in (sys.stdout, sys.stderr, sys.stdin):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


TOOLS = [
    {
        "name": "list_contacts",
        "description": (
            "【何时用】列**通讯录**：好友 / 群 / 公众号 / 企业微信，或**某个群的成员**。"
            "【分类】按 username 后缀判定（group/open/official/system/friend）——**不是**按 "
            "`local_type`（实测它语义不干净）。"
            "【返回】每条含 `username` / `name`(备注>昵称) / `remark` / `nick_name` / `alias`(微信号) / `kind`。"
            "【注意】群成员只给**全局显示名**；群内昵称需逆向，暂不支持。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "scope": {"type": "string",
                          "enum": ["friend", "group", "official", "open", "system", "all"],
                          "description": "种类过滤，默认 friend"},
                "room": {"type": "string", "description": "给了就列**该群成员**（群名或群号），忽略 scope"},
                "keyword": {"type": "string", "description": "名字/username 关键词（子串）"},
                "include_deleted": {"type": "boolean", "description": "是否包含已删除的联系人（默认否）"},
            },
        },
    },
    {
        "name": "contact_stats",
        "description": (
            "【何时用】看某个会话的**互动数字**：总条数、我发/对方发、活跃小时、活跃天 Top、"
            "首末时间、跨度、连续沉默天数。"
            "【别用】要判断「关系好不好 / 客户意向」——本服务**只给数字**，判断交给你的模型。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "talker": {"type": "string", "description": "会话名或 wxid/群号"},
                "since": {"type": "integer", "description": "起始时间（Unix 秒，含）"},
                "until": {"type": "integer", "description": "结束时间（Unix 秒，含）"},
            },
            "required": ["talker"],
        },
    },
    {
        "name": "interaction_rank",
        "description": (
            "【何时用】列**互动排行**——哪些会话最活跃，或哪些最久没联系。"
            "`sort=count` 按条数（默认）；`sort=recent` 按最近时间（久未联系的排前头，即"
            "\"久未联系提醒\"）。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "since": {"type": "integer", "description": "起始时间（Unix 秒，含）"},
                "until": {"type": "integer", "description": "结束时间（Unix 秒，含）"},
                "top": {"type": "integer", "description": "返回条数，默认 20"},
                "sort": {"type": "string", "enum": ["count", "recent"], "description": "默认 count"},
            },
        },
    },
]

INSTRUCTIONS = """\
本服务提供本机微信的**通讯录与会话统计**（只读）。**它只给清单和数字，不做任何判断**。

典型用法：
- 「我有哪些客户群」→ `list_contacts(scope="group", keyword="客户")`
- 「这个群里都有谁」→ `list_contacts(room="群名")`
- 「我和某某聊得多不多」→ `contact_stats(talker="某某")`
- 「谁最久没联系了」→ `interaction_rank(sort="recent")`

要点：
- 联系人分类按 username 后缀（确定性），**别**依赖 `local_type`（实测语义不干净）。
- 群成员只有**全局显示名**；群内昵称需要逆向 `chat_room.ext_buffer`，暂不支持，**别编**。
- **不做标签**：本地库没有好友↔标签映射表（需逆向），所以没有按标签筛选的工具。
- 数据含他人隐私：只读、本地处理、不外传。
"""

DISPATCH = {
    "list_contacts": lambda a: _tool_contacts(a),
    "contact_stats": lambda a: _tool_stats(a),
    "interaction_rank": lambda a: _tool_rank(a),
}


def _tool_contacts(args):
    rows = S.list_contacts(scope=args.get("scope") or "friend",
                           room=args.get("room"),
                           keyword=args.get("keyword") or "",
                           include_deleted=bool(args.get("include_deleted")))
    return {"count": len(rows), "contacts": rows}


def _tool_stats(args):
    talker = args.get("talker")
    if not talker:
        return {"error": "talker 必填"}
    resolved = S.core.resolve_talker(talker) or talker
    return S.contact_stats(resolved, since=int(args.get("since") or 0),
                           until=int(args.get("until") or 0))


def _tool_rank(args):
    rows = S.interaction_rank(since=int(args.get("since") or 0),
                              until=int(args.get("until") or 0),
                              top=int(args.get("top") or 20),
                              sort=args.get("sort") or "count")
    return {"count": len(rows), "ranking": rows}


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
        "serverInfo": {"name": SERVER_NAME, "title": "微信客户分析", "version": SERVER_VERSION},
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
    force_utf8_stdio()
    if "--version" in sys.argv[1:]:
        print(SERVER_VERSION)
        sys.exit(0)
    main()
