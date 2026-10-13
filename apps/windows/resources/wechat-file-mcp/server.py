# /// script
# requires-python = ">=3.10"
# dependencies = ["pycryptodome>=3.20", "zstandard>=0.22"]
# ///
"""微信文件归档 MCP Server（MCP stdio 传输，JSON-RPC 2.0）。

把本机微信里收发的**文件**（`msg/file/<月>/`）收出来：列清单、按会话归档到本地目录、报告
已过期/未下载的文件。**只读**——不修改任何微信数据，归档只做拷贝。

两个工具：`list_files`（列 + 定位）与 `archive_files`（拷贝归档，默认 dry_run）。

协议层与工具边界约定在共享层 `../wechat-mcp/mcp_stdio.py`（四件套共用一份，别在这里再写一遍）；
读取层（密钥扫描 / SQLCipher 解密 / 多分片镜像 / 路径发现）复用 `../wechat-mcp/wechat_core.py`。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = os.path.join(os.path.dirname(HERE), "wechat-mcp")   # 共享基础层（零复制）
for _p in (HERE, SHARED):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import filecore as F          # noqa: E402
import mcp_stdio              # noqa: E402

SERVER_NAME = "wechat-file"
SERVER_VERSION = "0.7.0"
TITLE = "微信文件归档"
DEFAULT_LIMIT = 500           # 默认最多返回多少条（`limit=0` = 全部）

TOOLS = [
    {
        "name": "list_files",
        "description": (
            "【何时用】想知道微信里收发的**文件**有哪些、在不在本地磁盘上（文件会过期下不动）。"
            "可按会话/时间/扩展名/关键词过滤。"
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
            "【落点】`layout=by_session`（默认，每会话一个子目录）/ `by_type` / `flat`。"
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
- 归档**不会覆盖**已经归档过的东西：同一份跳过（`exists`），另一个版本另存带时间戳的名字。
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
# `product` 是部署目录名与 exe 名；`skill` 是源码模式下的技能包源（冻结后技能包打进 exe，
# 由 mcp_install.skill_source 从 `sys._MEIPASS` 取，不依赖这个路径）。
INSTALL_SPEC = {
    "name": SERVER_NAME,
    "product": "wechat-file-mcp",
    "skill": os.path.join(HERE, "skills", SERVER_NAME),
    "label": TITLE,
}

if __name__ == "__main__":
    raise SystemExit(mcp_stdio.serve(SERVER_NAME, TITLE, SERVER_VERSION, TOOLS, INSTRUCTIONS, DISPATCH,
                                     install=INSTALL_SPEC))
