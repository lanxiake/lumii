# /// script
# requires-python = ">=3.10"
# dependencies = ["pycryptodome>=3.20", "zstandard>=0.22"]
# ///
"""微信文件归档 MCP Server（MCP stdio 传输，JSON-RPC 2.0）。

把本机微信里收发的**文件**（`msg/file/<月>/`）收出来：列清单、按会话归档到本地目录、报告
已过期/未下载的文件。**只读**——不修改任何微信数据，归档只做拷贝。

两个工具：`list_files`（列 + 定位）与 `archive_files`（拷贝归档，默认 dry_run）。

共享基础层：读取层（密钥扫描 / SQLCipher 解密 / 多分片镜像 / 路径发现）直接复用同目录
`../wechat-mcp/` 的模块，本包不复制。
"""
import json
import os
import sys

SERVER_NAME = "wechat-file"
SERVER_VERSION = "0.1.0"
SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")

PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS = -32700, -32600, -32601, -32602

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import filecore as F  # noqa: E402


def log(*a):
    print("[wechat-file]", *a, file=sys.stderr, flush=True)


def force_utf8_stdio():
    """钉住三个标准流编码为 UTF-8（Windows 重定向时默认是 ANSI 代码页）。"""
    for stream in (sys.stdout, sys.stderr, sys.stdin):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


TOOLS = [
    {
        "name": "list_files",
        "description": (
            "【何时用】想知道微信里收发的**文件**有哪些、在不在本地磁盘上（文件会过期下不动）。"
            "可按会话/时间/扩展名/关键词过滤。"
            "【返回】每条文件的文件名、大小、时间、发送者、会话，以及磁盘定位结果 "
            "`status`：`ok` 可归档 / `size_mismatch` 同名但大小不同（可能是另一版本）/ "
            "`missing` 未下载或已过期（**服务器端拿不到，只能报告**）。"
            "【别用】要读图片内容用别的工具；这里只管文件消息。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "talker": {"type": "string", "description": "会话名（如「文件传输助手」）或 wxid/群号；省略=全部会话"},
                "since": {"type": "integer", "description": "起始时间（Unix 秒，含）"},
                "until": {"type": "integer", "description": "结束时间（Unix 秒，含）"},
                "types": {"type": "array", "items": {"type": "string"},
                          "description": "扩展名过滤，如 [\"pdf\",\"zip\"]（不区分大小写）"},
                "keyword": {"type": "string", "description": "文件名关键词（子串匹配）"},
                "only_missing": {"type": "boolean", "description": "只列已过期/未下载的文件（过期预警）"},
            },
        },
    },
    {
        "name": "archive_files",
        "description": (
            "【何时用】把微信里的文件**归档到本地目录**（防过期、做整理）。以用户本人身份、只读微信。"
            "【行为】**拷贝**（不动微信原文件）；同一磁盘文件多处引用只拷一次；"
            "重名加时间戳后缀；`dry_run=true`（默认）只出计划不落盘。"
            "【落点】`layout=by_session`（默认，每会话一个子目录）/ `by_type` / `flat`。"
            "【返回】copied / dedup / missing 计数与逐条计划。`missing` 的文件**无法归档**（已过期）。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "out_dir": {"type": "string", "description": "归档目标目录（绝对路径）"},
                "talker": {"type": "string", "description": "只归档该会话；省略=全部会话"},
                "since": {"type": "integer", "description": "起始时间（Unix 秒，含）"},
                "until": {"type": "integer", "description": "结束时间（Unix 秒，含）"},
                "types": {"type": "array", "items": {"type": "string"}, "description": "扩展名过滤"},
                "layout": {"type": "string", "enum": ["by_session", "by_type", "flat"],
                           "description": "子目录组织方式，默认 by_session"},
                "dry_run": {"type": "boolean", "description": "默认 true 只出计划；要真归档传 false"},
            },
            "required": ["out_dir"],
        },
    },
]

INSTRUCTIONS = """\
本服务把本机微信里的**文件**收出来（只读；不修改微信数据）。

典型用法：
1. `list_files()` 先看有哪些文件、哪些已经下不动了（`status=missing` 即过期/未下载）。
2. `archive_files(out_dir=..., dry_run=true)` 出归档计划给用户确认。
3. 确认后 `dry_run=false` 真拷贝。

要点：
- 归档**只做拷贝**，微信原文件不受影响（不会让微信里的「打开文件」失效）。
- `missing` 的文件是**服务器端已拿不到**的，无法归档——如实告诉用户，别承诺能救回来。
- 文件本体在 `msg/file/<月>/`，当归档目标与源在同一磁盘时是拷贝（不移动）。
- 群里发的文件会标发送者；同名不同版本靠大小区分。
"""

DISPATCH = {
    "list_files": lambda a: _tool_list(a),
    "archive_files": lambda a: _tool_archive(a),
}


def _tool_list(args):
    recs = F.list_files(
        talker=args.get("talker") or None,
        since=int(args.get("since") or 0),
        until=int(args.get("until") or 0),
        types=args.get("types"),
        keyword=args.get("keyword") or "",
        only_missing=bool(args.get("only_missing")),
    )
    return {
        "count": len(recs),
        "ok": sum(1 for r in recs if r["status"] == "ok"),
        "missing": sum(1 for r in recs if r["status"] == "missing"),
        "size_mismatch": sum(1 for r in recs if r["status"] == "size_mismatch"),
        "files": recs,
    }


def _tool_archive(args):
    out_dir = args.get("out_dir")
    if not out_dir:
        return {"error": "out_dir 必填（归档目标目录的绝对路径）"}
    return F.archive_files(
        out_dir=out_dir,
        talker=args.get("talker") or None,
        since=int(args.get("since") or 0),
        until=int(args.get("until") or 0),
        types=args.get("types"),
        layout=args.get("layout") or "by_session",
        dry_run=bool(args.get("dry_run", True)),
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
        "serverInfo": {"name": SERVER_NAME, "title": "微信文件归档", "version": SERVER_VERSION},
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
    except Exception as e:  # 工具内部失败以 isError 结果返回，不拖垮服务
        log("error", name, repr(e))
        reply(mid, {"content": [{"type": "text", "text": f"ERROR: {e}"}], "isError": True})


def handle_message(msg):
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        reply_error(msg.get("id") if isinstance(msg, dict) else None, INVALID_REQUEST, "Invalid Request")
        return
    method = msg.get("method")
    if not isinstance(method, str) or "id" not in msg:
        return                                    # 通知不回应
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
    sys.stdout = sys.stderr                        # 业务 print 一律走 stderr，别污染协议流
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
