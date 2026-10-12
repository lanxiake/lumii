# /// script
# requires-python = ">=3.10"
# dependencies = ["pycryptodome>=3.20", "zstandard>=0.22"]
# ///
"""微信记录导出 MCP Server（MCP stdio 传输，JSON-RPC 2.0）。

把某个会话的聊天记录导出成**能读、能分享、能归档**的文件：md / html / json，
可选连图片（已解密）与语音（SILK→wav）、可选语音转写。

**只读**——不改动任何微信数据。

工具：`export_chat`（+ 只读的 `list_sessions` 帮用户挑会话）。

共享基础层：读取层直接复用同目录 `../wechat-mcp/` 的模块，本包不复制。
"""
import json
import os
import sys

SERVER_NAME = "wechat-export"
SERVER_VERSION = "0.1.0"
SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")

PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS = -32700, -32600, -32601, -32602

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import exportcore as E  # noqa: E402


def log(*a):
    print("[wechat-export]", *a, file=sys.stderr, flush=True)


def force_utf8_stdio():
    for stream in (sys.stdout, sys.stderr, sys.stdin):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


TOOLS = [
    {
        "name": "list_sessions",
        "description": ("【何时用】用户说「导出我和某某的聊天记录」但你没把握会话名时，先列会话拿到确切名字/talker。"
                        "【返回】每个会话的显示名、talker、最新一条预览。`query` 可按关键词过滤。"),
        "inputSchema": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "按关键词过滤会话名"}},
        },
    },
    {
        "name": "export_chat",
        "description": (
            "【何时用】把某个会话的聊天记录**导出成文件**（md / html / json）。只读，不改微信。"
            "【落点】`<out_dir>/<会话名>/chat.<格式>`；`split=month` 时按月拆子目录（防单文件过大）。"
            "【媒体】默认 `media=none` 只出文字；`images` 连图片（已解密）；`all` 再加语音 wav。"
            "`transcribe_voice=true` 追加语音转写（**需本机装了语音识别模型**，较慢，默认关）。"
            "【返回】导出条数 / 落盘文件 / 体积 / 媒体成功与跳过计数。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "talker": {"type": "string", "description": "会话名（如「文件传输助手」）或 wxid/群号"},
                "out_dir": {"type": "string", "description": "导出目标目录（绝对路径）"},
                "format": {"type": "string", "enum": ["md", "html", "json"], "description": "默认 md"},
                "since": {"type": "integer", "description": "起始时间（Unix 秒，含）"},
                "until": {"type": "integer", "description": "结束时间（Unix 秒，含）"},
                "media": {"type": "string", "enum": ["none", "images", "all"],
                          "description": "none(默认) / images / all(图片+语音wav)"},
                "transcribe_voice": {"type": "boolean", "description": "追加语音转写（需模型，默认 false）"},
                "split": {"type": "string", "enum": ["none", "month"],
                          "description": "none(默认单文件) / month 按月分段成目录"},
            },
            "required": ["talker", "out_dir"],
        },
    },
]

INSTRUCTIONS = """\
本服务把本机微信某个会话的聊天记录**导出成文件**（只读，不改微信数据）。

典型用法：
1. 不确定会话名 → `list_sessions(query="关键词")` 拿到确切的 `talker`。
2. `export_chat(talker=..., out_dir=..., format="md")` 默认只出文字、单文件。
3. 要带图片/语音传 `media="images"` / `media="all"`；记录很多传 `split="month"` 分段。
4. **语音转写**（`transcribe_voice=true`）需要本机装了识别模型，没装会逐条失败并计数，不会中断导出。

要点：
- 导出**只读**，不发送、不修改任何微信内容。
- `out_dir` 由用户指定；会话名会做文件名净化，避免非法字符。
- 记录含他人隐私：**本地导出**，别把内容送去云端（是否外传由用户的客户端决定，如实告知）。
"""

DISPATCH = {"list_sessions": lambda a: _tool_sessions(a), "export_chat": lambda a: _tool_export(a)}


def _tool_sessions(args):
    query = (args.get("query") or "").strip()
    out = []
    for s in E.core.sessions():
        if query and query not in (s.get("name") or "") and query not in (s.get("talker") or ""):
            continue
        out.append({"name": s.get("name"), "talker": s.get("talker"), "last": s.get("last")})
    return {"count": len(out), "sessions": out}


def _tool_export(args):
    talker = args.get("talker")
    out_dir = args.get("out_dir")
    if not talker:
        return {"error": "talker 必填（会话名或 wxid/群号；可先用 list_sessions 查）"}
    if not out_dir:
        return {"error": "out_dir 必填（导出目标目录的绝对路径）"}
    resolved = E.core.resolve_talker(talker)
    if resolved is None:
        return {"error": f"找不到唯一确定的会话「{talker}」，请用 list_sessions 取确切名字",
                "error_code": "target_not_found"}
    return E.export_chat(
        talker=resolved, out_dir=out_dir,
        format=args.get("format") or "md",
        since=int(args.get("since") or 0),
        until=int(args.get("until") or 0),
        media=args.get("media") or "none",
        transcribe_voice=bool(args.get("transcribe_voice")),
        split=args.get("split") or "none",
    )


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
        "serverInfo": {"name": SERVER_NAME, "title": "微信记录导出", "version": SERVER_VERSION},
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
