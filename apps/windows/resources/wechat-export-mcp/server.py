# /// script
# requires-python = ">=3.10"
# dependencies = ["pycryptodome>=3.20", "zstandard>=0.22"]
# ///
"""微信导出 MCP Server（MCP stdio 传输，JSON-RPC 2.0）。

本机微信的**记录与文件**都从这里出：聊天记录导出成 md / html / json（可带图片、语音、
文件附件），文件消息列清单 / 算占用 / 归档到本地目录。**只读**——不改动任何微信数据，
归档只做拷贝。

五个工具：`list_sessions`、`export_chat`（记录面，可整段导也可按关键词只导命中）；
`list_files`、`archive_files`、`disk_usage`（文件面）。

**目录结构只有一套**（`exportcore.session_subdir` 定）：`<out_dir>/<会话名>/` 下
`chat.<格式>` + `stats.json` + `assets/`（图片）+ `files/`（文件）——归档与导出写进同一棵树。

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
import filecore as F          # noqa: E402
import mcp_stdio              # noqa: E402

SERVER_NAME = "wechat-export"
SERVER_VERSION = "0.15.0"
TITLE = "微信导出与文件归档"
DEFAULT_LIMIT = 500           # `list_files` 默认最多返回多少条（`limit=0` = 全部）

# 合法值只有一份来源（exportcore），工具 schema 与校验都读它——别在这里再抄一遍
FORMATS, MEDIA, SPLIT = E._FORMATS, E._MEDIA, E._SPLIT

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
            "【何时用】(a) 把某个会话的聊天记录**导出成文件**；(b) **按关键词只导出命中的那些消息**"
            "（给 `keyword`；连 `talker` 一起省掉就是**全库搜**）。只读，不改微信。"
            "【落点】`<out_dir>/<会话名>/`：正文 `chat.<格式>`、报表 `stats.json`、"
            "图片 `assets/`、文件附件 `files/`；按关键词导出多一层 `q-<关键词>/`，"
            "`split=month` 再按月拆；多会话导出另出 `index.md` 清单。"
            "**【给分析用】选 `format=json`**：带 `stats` 统计报表"
            "（条数/双方占比/按月/按小时/按星期/类型/发言人/最忙的几天）；"
            "`stats.json` 是同一份报表的独立落点（**任何格式都落**），喂脚本/模型直接读它。"
            "**【媒体】**默认 `media=none` 只出文字；`images` 连图片（已解密）；`files` 收文件附件到 "
            "`files/`（微信里没下载/已过期的定位不到，会计数；**只列清单用 `list_files`**）；"
            "`all` = 图片+文件+语音 wav。"
            "`transcribe_voice=true` 追加语音转写（**需本机装了语音识别模型**，较慢，默认关）。"
            "【分享】`format=html` 时媒体**内嵌进 HTML**（自包含，单文件发给别人也能看；"
            "其它格式仍是 assets/ 相对路径）。超 `inline_max_mb` 的部分退回落盘并如实报告。"
            "【返回】导出条数 / 落盘文件 / 体积 / 媒体计数 / `stats` 报表；"
            "`truncated=true` 表示命中被 `limit` 切过（**别当成「就这么多」**）。"
            "`format`/`media`/`split` 传非法值会被**拒**（`bad_args`），不会静默降级。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "talker": {"type": "string",
                           "description": "会话名（如「文件传输助手」）或 wxid/群号；给了 keyword 时可省（= 全库搜）"},
                "out_dir": {"type": "string", "description": "导出目标目录（绝对路径）"},
                "format": {"type": "string", "enum": list(FORMATS),
                           "description": "默认 md；分析用 json（带统计报表）"},
                "keyword": {"type": "string",
                            "description": "只导出正文/附件名含此关键词的消息（给了它才能省 talker）"},
                "limit": {"type": "integer",
                          "description": "按关键词导出时每个会话最多导多少条命中（默认 500，0 = 不限）"},
                "since": {"type": "integer", "description": "起始时间（Unix 秒，含）"},
                "until": {"type": "integer", "description": "结束时间（Unix 秒，含）"},
                "media": {"type": "string", "enum": list(MEDIA),
                          "description": "none(默认) / images / files / all(图片+文件+语音wav)"},
                "transcribe_voice": {"type": "boolean", "description": "追加语音转写（需模型，默认 false）"},
                "split": {"type": "string", "enum": list(SPLIT),
                          "description": "none(默认单文件) / month 按月分段成目录"},
                "inline_max_mb": {"type": "number",
                                  "description": "html 内嵌媒体的体积上限（MB，默认 20，0 = 不限）"},
                "max_sessions": {"type": "integer",
                                 "description": "全库搜时最多导出多少个会话（默认 20，按命中条数取前 N）"},
            },
            "required": ["out_dir"],
        },
    },
    {
        "name": "list_files",
        "description": (
            "【何时用】想知道微信里收发的**文件**有哪些、在不在本地磁盘上（文件会过期下不动）。"
            "可按会话/时间/扩展名/关键词过滤。**只列清单、不落盘**；要真拿出来用 `archive_files`。"
            "【返回】`total` 命中总数、`count` 本次条数——不等就说明被 `limit` 截断了；"
            "每条含文件名、大小、时间、发送者、会话，以及磁盘定位 `status`："
            "`ok` 可归档 / `size_mismatch` 同名但大小不同（可能是另一版本）/ "
            "`missing` 未下载或已过期（**服务器端拿不到，只能报告**）。"
            "默认只回**最近 500 条**（仍按时间正序），`limit=0` 回全部。"
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
                "limit": {"type": "integer", "description": f"最多返回条数，默认 {DEFAULT_LIMIT}；0=全部"},
            },
        },
    },
    {
        "name": "archive_files",
        "description": (
            "【何时用】把微信里的文件**归档到本地目录**（防过期、做整理）。以用户本人身份、只读微信。"
            "【行为】**拷贝**（不动微信原文件）；同一磁盘文件多处引用只拷一次；"
            "目标已存在且是同一份**不重拷**（`exists`，重跑幂等）；同名不同版本另存带时间戳的名字，"
            "**绝不覆盖**已归档的文件；`dry_run=true`（默认）只出计划不落盘。"
            "【落点】`layout=by_session`（默认）落在 `<out_dir>/<会话名>/files/`——"
            "**与导出时 `media` 传 `files` 收附件是同一棵树，同一份文件只存一份**；"
            "`by_type`（按扩展名）/ `flat`（不分目录）是旁路形态。"
            "【返回】copied / dedup / exists / missing 计数与逐条计划。`missing` 的文件**无法归档**"
            "（已过期），如实告诉用户，别承诺能救回来。"
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
                           "description": "子目录组织方式，默认 by_session（与导出同构）"},
                "dry_run": {"type": "boolean", "description": "默认 true 只出计划；要真归档传 false"},
            },
            "required": ["out_dir"],
        },
    },
    {
        "name": "disk_usage",
        "description": (
            "【何时用】用户问「微信怎么这么占地方 / 哪个会话最占空间 / 空间都花在哪了」。"
            "【返回】**磁盘的硬事实**（账号目录下各子树、`msg/` 下 file/video/attach 的字节数与文件数）"
            "+ **按会话排行**（只对 `msg/file` 能归属的那部分）。"
            "看 `sessions[].own_bytes`（**只此一处**引用，删了确实能省）与 `shared_bytes`"
            "（多个会话都在用的，删除不一定省）——两者**不能相加后当成能省的空间**。"
            "`file_unattributed` 是没被任何消息引用到的磁盘文件（本机 26%），归属不了；"
            "`msg/video`、`msg/attach` 只报小计。**别把这些数字说成「可以清理 XX」**，本工具只读不删。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_limit": {"type": "integer",
                                  "description": "会话排行返回前几名，默认 20；0=全部"},
            },
        },
    },
]

INSTRUCTIONS = """\
本服务把本机微信的**记录与文件**都导出来（只读，不改微信数据）：聊天记录可整段导、也可
**按关键词只导命中的那部分**；文件可列清单、算占用、归档到本地目录。

典型用法：
1. 不确定会话名 → `list_sessions(query="关键词")` 拿到确切的 `talker`。
2. 整段导：`export_chat(talker=..., out_dir=..., format="md")`，默认只出文字、单文件。
3. **给分析用**：`format="json"` —— 带 `stats` **统计报表**；同一份报表另落 `stats.json`。
4. **只导命中**：给 `keyword`（可再省掉 `talker` = 全库搜）。
   命中过多时 `limit` 截断，返回里 `truncated=true` ——**别当成"就这么多"**。
5. 要带图片/文件/语音传 `media="images"` / `"files"` / `"all"`；记录很多传 `split="month"` 分段。
6. **文件面**：`list_files()` 先看有哪些、哪些已经下不动了（`status=missing` 即过期/未下载）；
   要收出来用 `archive_files(out_dir=..., dry_run=true)` 出计划、确认后 `dry_run=false` 真拷贝。
   问"占地方"用 `disk_usage()`（只读，只报告，**不删任何东西**）。

落点（**一套目录结构**，记录与文件写进同一棵树）：
`<out_dir>/<会话名>/` → 按关键词导则多一层 `q-<关键词>/` → `split=month` 再一层 `<YYYY-MM>/`；
正文是 `chat.<格式>`，报表是 `stats.json`，图片在 `assets/`，**文件在 `files/`（归档也落这里）**；
一次导多个会话还会在 `<out_dir>/index.md` 留一份清单。

要点：
- 导出与归档都**只读**，不发送、不修改任何微信内容；归档只做拷贝，微信里的「打开文件」不受影响。
- 会话名解析不出唯一目标 → `target_not_found`（**不是**"这个会话没记录"）。
- `out_dir` 由用户指定；会话名/关键词/文件名会做净化，避免非法字符。
- 归档**不会覆盖**已经归档过的东西：同一份跳过（`exists`），另一个版本另存带时间戳的名字。
- `missing` 的文件是**服务器端已拿不到**的，无法归档——如实告诉用户，别承诺能救回来。
- `disk_usage` 的 `own_bytes`（只此一处引用的）与 `shared_bytes`（多处共用的）**不能相加**
  当成"能省的空间"；`file_unattributed` 归属不了，如实说。
- `stats` 只有**计数**，没有任何意向/情绪判断——结论由你（或用户）下，工具不下。
- 记录含他人隐私：**本地导出**，别把内容送去云端（是否外传由用户的客户端决定，如实告知）。
"""

DISPATCH = {
    "list_sessions": lambda a: _tool_sessions(a),
    "export_chat": lambda a: _tool_export(a),
    "list_files": lambda a: _tool_list(a),
    "archive_files": lambda a: _tool_archive(a),
    "disk_usage": lambda a: _tool_disk(a),
}


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
    keyword = (args.get("keyword") or "").strip()
    if not out_dir:
        return mcp_stdio.tool_error("bad_args", "out_dir 必填（导出目标目录的绝对路径）")
    if not talker and not keyword:
        return mcp_stdio.tool_error(
            "bad_args", "talker 必填（会话名或 wxid/群号；可先用 list_sessions 查）"
                        "——要全库按关键词搜就传 keyword")
    bad = E.bad_args(args)
    if bad:
        return mcp_stdio.tool_error("bad_args", "参数不合法：" + "；".join(bad), invalid=bad)
    # 按关键词导出时**默认给上限**：不给我就取 `_SCAN_LIMIT`，而不是"不限"——一个常见词
    # 命中几万条、写成几百兆的文件，用户既不会预期也没法打开。截断了会如实报 `truncated`。
    limit = int(args["limit"]) if args.get("limit") is not None else E._SCAN_LIMIT
    kw = dict(
        out_dir=out_dir, format=args.get("format") or "md",
        since=int(args.get("since") or 0), until=int(args.get("until") or 0),
        media=args.get("media") or "none",
        transcribe_voice=bool(args.get("transcribe_voice")),
        split=args.get("split") or "none",
        inline_max_mb=(args.get("inline_max_mb")
                       if args.get("inline_max_mb") is not None else E._INLINE_BUDGET_MB),
    )
    if not talker:                       # 全库搜：每个命中的会话一个子目录
        return E.export_many(keyword=keyword, limit=limit,
                             max_sessions=int(args.get("max_sessions") or E._MAX_SESSIONS), **kw)
    return E.export_chat(talker=talker, keyword=keyword, limit=limit, **kw)


def _tool_list(args):
    recs = F.list_files(
        talker=args.get("talker") or None,
        since=int(args.get("since") or 0),
        until=int(args.get("until") or 0),
        types=args.get("types"),
        keyword=args.get("keyword") or "",
        only_missing=bool(args.get("only_missing")),
    )
    limit = int(args["limit"]) if args.get("limit") is not None else DEFAULT_LIMIT
    shown = recs if limit <= 0 else recs[-limit:]      # 保留**最近**的 limit 条（子列表仍是时间正序）
    return {
        "total": len(recs),
        "count": len(shown),
        "ok": sum(1 for r in shown if r["status"] == "ok"),
        "missing": sum(1 for r in shown if r["status"] == "missing"),
        "size_mismatch": sum(1 for r in shown if r["status"] == "size_mismatch"),
        "files": shown,
    }


def _tool_disk(args):
    limit = args.get("session_limit")
    return F.disk_usage(session_limit=20 if limit is None else int(limit))


def _tool_archive(args):
    out_dir = args.get("out_dir")
    if not out_dir:
        return mcp_stdio.tool_error("bad_args", "out_dir 必填（归档目标目录的绝对路径）")
    return F.archive_files(
        out_dir=out_dir,
        talker=args.get("talker") or None,
        since=int(args.get("since") or 0),
        until=int(args.get("until") or 0),
        types=args.get("types"),
        layout=args.get("layout") or "by_session",
        dry_run=bool(args.get("dry_run", True)),
    )


# 一键安装的规格（`--install` / `--uninstall` / `--install-status`，实现见共享层 mcp_install.py）。
INSTALL_SPEC = {
    "name": SERVER_NAME,
    "product": "wechat-export-mcp",
    "skill": os.path.join(HERE, "skills", SERVER_NAME),
    "label": TITLE,
}

if __name__ == "__main__":
    raise SystemExit(mcp_stdio.serve(SERVER_NAME, TITLE, SERVER_VERSION, TOOLS, INSTRUCTIONS, DISPATCH,
                                     install=INSTALL_SPEC))
