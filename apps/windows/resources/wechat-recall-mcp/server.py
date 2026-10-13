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

**单文件双身份**：不带参数 = MCP（stdio），带 `--daemon` / `--once` / `--status` /
`--install-autostart` = 守护侧命令。协议层与工具边界约定在共享层 `../wechat-mcp/mcp_stdio.py`。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = os.path.join(os.path.dirname(HERE), "wechat-mcp")   # 共享基础层（零复制）
for _p in (HERE, SHARED):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import archive                # noqa: E402
import mcp_stdio              # noqa: E402

SERVER_NAME = "wechat-recall"
SERVER_VERSION = "0.3.0"
TITLE = "微信撤回防护"
DEFAULT_LIMIT = 200           # 工具默认一次回多少条撤回（`limit=0` = 全部）

DAEMON_FLAGS = ("--daemon", "--once", "--install-autostart", "--uninstall-autostart", "--status")

TOOLS = [
    {
        "name": "daemon_status",
        "description": (
            "【何时用】先看守护在不在跑、归档了多少、有没有停机缺口——**撤回能不能看到全看它**。"
            "【返回】`alive`（守护是否在跑）/ `archived`（归档条数）/ `oldest`·`newest`（最早/最新"
            "一条的时间）/ `db_bytes`（归档库体积）/ `backfilled` / `last_tick` / `gaps`（停机缺口数）/ "
            "`autostart`（是否已开机自启）/ `db_path`。"
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_recalls",
        "description": (
            "【何时用】看某会话（或全部）**被撤回/删除**的消息。"
            "【判定】归档里有、当前微信库里已没有或已被改写成系统消息。"
            "`reason`：`deleted` 整条消失 / `recalled` 被改写 / `changed` 其它变动。"
            "【返回】`total` 命中总数 / `count` 本次条数（不等说明被 `limit` 截断了，别当成"
            "\"就这么多\"）；每条含时间、发送者、原**文本**、`local_id`（可据此 read_recall 取完整原文）。"
            "【前提】守护必须**在撤回发生之前**就已在跑；守护启动前的撤回看不到。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "talker": {"type": "string", "description": "会话名或 wxid/群号；省略=全部会话"},
                "since": {"type": "integer", "description": "起始时间（Unix 秒，含）"},
                "until": {"type": "integer", "description": "结束时间（Unix 秒，含）"},
                "limit": {"type": "integer", "description": f"最多返回条数（默认 {DEFAULT_LIMIT}，0=全部）"},
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
        "description": "【何时用】确认归档有没有**漏记的时间段**（关机/休眠/守护没跑的时候）。"
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
- 归档只写一次、永不覆盖，所以撤回前的**原文**留得住；但**关机/休眠期间漏的补不回来**（看 `archive_gap`）。
- 归档库是**全量原文、只增不减**（`daemon_status` 的 `db_bytes` 会涨）；要控体积给守护加
  `--retain-days N`，代价是**那段之后发生的撤回就查不到了**——这个取舍交给用户，别自行修剪。
- 数据含他人隐私：只读、本地处理、不外传。
"""

DISPATCH = {
    "daemon_status": lambda a: _tool_status(a),
    "list_recalls": lambda a: _tool_list(a),
    "read_recall": lambda a: _tool_read(a),
    "archive_gap": lambda a: _tool_gap(a),
}


def _tool_status(_args):
    import daemon
    return daemon.status()


def _resolve(talker):
    """会话参数在**工具边界**解析：解析不出唯一目标就抛 `UnknownTalker`（→ target_not_found）。

    放在这里而不是 `archive.py`：那边要用**合成库**离线跑判定单测，一解析就得读真库的会话名，
    合成单测在 CI 上就全跑了。原先这里是 `resolve_talker(x) or x`——解析不出的名字会降级成
    "拿这个名字去比"，`list_recalls` 静默回 0 条，看着就像"这个会话没有撤回"。
    """
    return archive.core.talker_of(talker)


def _tool_list(args):
    talker = _resolve(args.get("talker"))            # 先解析（错就别去碰归档库了）
    con = archive.connect()
    try:
        recs = archive.find_recalls(con, talker=talker,
                                    since=int(args.get("since") or 0),
                                    until=int(args.get("until") or 0))
    finally:
        con.close()
    limit = int(args["limit"]) if args.get("limit") is not None else DEFAULT_LIMIT
    shown = recs if limit <= 0 else recs[:limit]      # 取**最近**的（`find_recalls` 返回时间倒序）
    return {"total": len(recs), "count": len(shown), "recalls": shown}


def _tool_read(args):
    talker, lid = args.get("talker"), args.get("local_id")
    if not talker or lid is None:
        return mcp_stdio.tool_error("bad_args", "talker 与 local_id 都必填")
    con = archive.connect()
    try:
        rec = archive.read_recall(con, _resolve(talker), int(lid))
    finally:
        con.close()
    if rec is None:
        return mcp_stdio.tool_error("not_archived", "归档里没有这条消息（可能守护当时没在跑）")
    return rec


def _tool_gap(_args):
    con = archive.connect()
    try:
        gaps = archive.gaps(con)
    finally:
        con.close()
    return {"count": len(gaps), "gaps": gaps}


if __name__ == "__main__":
    mcp_stdio.force_utf8_stdio()
    argv = sys.argv[1:]
    if any(f in argv for f in DAEMON_FLAGS):
        import daemon
        daemon.main()                                    # 直接吃 sys.argv[1:]
        sys.exit(0)
    raise SystemExit(mcp_stdio.serve(SERVER_NAME, TITLE, SERVER_VERSION, TOOLS, INSTRUCTIONS, DISPATCH))
