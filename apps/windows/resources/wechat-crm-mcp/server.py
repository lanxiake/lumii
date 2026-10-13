# /// script
# requires-python = ">=3.10"
# dependencies = ["pycryptodome>=3.20", "zstandard>=0.22"]
# ///
"""微信客户分析 MCP Server（MCP stdio 传输，JSON-RPC 2.0）。

**只出取数与统计，不出判断**：通讯录（好友/群/公众号/企业微信）、群成员、
单会话互动统计、互动排行。"这个客户意向高不高"交给接入方的 LLM + 技能包。

**只读**——不改动任何微信数据。

工具：`list_contacts` / `contact_stats` / `interaction_rank`。

协议层与工具边界约定在共享层 `../wechat-mcp/mcp_stdio.py`；读取层复用 `../wechat-mcp/wechat_core.py`。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = os.path.join(os.path.dirname(HERE), "wechat-mcp")   # 共享基础层（零复制）
for _p in (HERE, SHARED):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import contactscore as S      # noqa: E402
import mcp_stdio              # noqa: E402

SERVER_NAME = "wechat-crm"
SERVER_VERSION = "0.9.0"
TITLE = "微信客户分析"
DEFAULT_LIMIT = 200           # 通讯录默认一次回多少条（本机好友 2500+，不掐就是几百 KB 灌进模型）

TOOLS = [
    {
        "name": "list_contacts",
        "description": (
            "【何时用】列**通讯录**：好友 / 群 / 公众号 / 企业微信，或**某个群的成员**。"
            "【分类】按 username 后缀判定（group/open/official/system/friend）——**不是**按 "
            "`local_type`（实测它语义不干净）。"
            "【返回】`total` 命中总数 / `count` 本次条数；每条含 `username` / `name`(备注>昵称) / "
            "`remark` / `nick_name` / `alias`(微信号) / `kind`。"
            f"默认只回 {DEFAULT_LIMIT} 条（按名字排序），要接着看传 `offset`，要全量传 `limit=0`。"
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
                "limit": {"type": "integer", "description": f"最多返回条数，默认 {DEFAULT_LIMIT}；0=全部"},
                "offset": {"type": "integer", "description": "从第几条开始（翻页用，默认 0）"},
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
- 通讯录默认只回 200 条：看 `total`，不够就用 `offset` 接着翻，别以为只有 200 个人。
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
    limit = int(args["limit"]) if args.get("limit") is not None else DEFAULT_LIMIT
    return S.page_of(rows, limit, args.get("offset"))


def _tool_stats(args):
    talker = args.get("talker")
    if not talker:
        return mcp_stdio.tool_error(
            "bad_args", "talker 必填（会话名或 wxid/群号）")
    return S.contact_stats(talker, since=int(args.get("since") or 0),
                           until=int(args.get("until") or 0))


def _tool_rank(args):
    rows = S.interaction_rank(since=int(args.get("since") or 0),
                              until=int(args.get("until") or 0),
                              top=int(args.get("top") or 20),
                              sort=args.get("sort") or "count")
    return {"count": len(rows), "ranking": rows}


# 一键安装的规格（`--install` / `--uninstall` / `--install-status`，实现见共享层 mcp_install.py）。
INSTALL_SPEC = {
    "name": SERVER_NAME,
    "product": "wechat-crm-mcp",
    "skill": os.path.join(HERE, "skills", SERVER_NAME),
    "label": TITLE,
}

if __name__ == "__main__":
    raise SystemExit(mcp_stdio.serve(SERVER_NAME, TITLE, SERVER_VERSION, TOOLS, INSTRUCTIONS, DISPATCH,
                                     install=INSTALL_SPEC))
