# /// script
# requires-python = ">=3.10"
# dependencies = ["pycryptodome>=3.20", "zstandard>=0.22"]
# ///
"""微信记录导出 MCP Server（MCP stdio 传输，JSON-RPC 2.0）。

把某个会话的聊天记录导出成**能读、能分享、能归档**的文件：md / html / json，
可选连图片（已解密）与语音（SILK→wav）、可选语音转写。

**只读**——不改动任何微信数据。

工具：`export_chat`（+ 只读的 `list_sessions` 帮用户挑会话）。

协议层与工具边界约定在共享层 `../wechat-mcp/mcp_stdio.py`；读取层复用 `../wechat-mcp/wechat_core.py`。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = os.path.join(os.path.dirname(HERE), "wechat-mcp")   # 共享基础层（零复制）
for _p in (HERE, SHARED):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import exportcore as E        # noqa: E402
import mcp_stdio              # noqa: E402

SERVER_NAME = "wechat-export"
SERVER_VERSION = "0.4.0"
TITLE = "微信记录导出"

# 合法值只有一份来源（exportcore），工具 schema 与校验都读它——别在这里再抄一遍
FORMATS, MEDIA, SPLIT = tuple(E._RENDER), E._MEDIA, E._SPLIT

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
            "`format`/`media`/`split` 传非法值会被**拒**（`bad_args`），不会静默降级。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "talker": {"type": "string", "description": "会话名（如「文件传输助手」）或 wxid/群号"},
                "out_dir": {"type": "string", "description": "导出目标目录（绝对路径）"},
                "format": {"type": "string", "enum": list(FORMATS), "description": "默认 md"},
                "since": {"type": "integer", "description": "起始时间（Unix 秒，含）"},
                "until": {"type": "integer", "description": "结束时间（Unix 秒，含）"},
                "media": {"type": "string", "enum": list(MEDIA),
                          "description": "none(默认) / images / all(图片+语音wav)"},
                "transcribe_voice": {"type": "boolean", "description": "追加语音转写（需模型，默认 false）"},
                "split": {"type": "string", "enum": list(SPLIT),
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
- 会话名解析不出唯一目标 → `target_not_found`（**不是**"这个会话没记录"）。
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
        return mcp_stdio.tool_error(
            "bad_args", "talker 必填（会话名或 wxid/群号；可先用 list_sessions 查）")
    if not out_dir:
        return mcp_stdio.tool_error("bad_args", "out_dir 必填（导出目标目录的绝对路径）")
    bad = E.bad_args(args)
    if bad:
        return mcp_stdio.tool_error("bad_args", "参数不合法：" + "；".join(bad), invalid=bad)
    return E.export_chat(
        talker=talker, out_dir=out_dir,
        format=args.get("format") or "md",
        since=int(args.get("since") or 0),
        until=int(args.get("until") or 0),
        media=args.get("media") or "none",
        transcribe_voice=bool(args.get("transcribe_voice")),
        split=args.get("split") or "none",
    )


if __name__ == "__main__":
    raise SystemExit(mcp_stdio.serve(SERVER_NAME, TITLE, SERVER_VERSION, TOOLS, INSTRUCTIONS, DISPATCH))
