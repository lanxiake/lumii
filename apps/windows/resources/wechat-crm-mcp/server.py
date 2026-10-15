# /// script
# requires-python = ">=3.10"
# dependencies = ["pycryptodome>=3.20", "zstandard>=0.22"]
# ///
"""微信客户分析 MCP Server（MCP stdio 传输，JSON-RPC 2.0）。

**只出取数与统计，不出判断**：通讯录（好友/群/公众号/企业微信）、群成员、
单会话互动统计、互动排行、**会话正文的读/搜/汇总**。
"这个客户意向高不高"交给接入方的 LLM + 技能包。

**只读**——不改动任何微信数据。

工具：`list_contacts` / `list_labels` / `contact_stats` / `interaction_rank` / `silence_ladder`（通讯录面）
\+ `read_messages` / `search_messages` / `customer_brief`（**消息面**）。
两面合起来才有闭环：光有数字看不出客户在说什么，光有正文又不知道这人多久没来了。

协议层与工具边界约定在共享层 `../wechat-mcp/mcp_stdio.py`；读取层复用 `../wechat-mcp/wechat_core.py`。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = os.path.join(os.path.dirname(HERE), "wechat-mcp")   # 共享基础层（零复制）
for _p in (HERE, SHARED):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import chatlog as L           # noqa: E402
import contactscore as S      # noqa: E402
import mcp_stdio              # noqa: E402

SERVER_NAME = "wechat-crm"
SERVER_VERSION = "0.15.0"
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
            "`remark` / `nick_name` / `alias`(微信号) / `kind` / `labels`(标签名列表)。"
            "【分页】`limit`=0 返回全部（默认），`limit`>0 配合 `offset` 实现分页。"
            "【按标签筛】`label=\"客户\"`（标签名精确匹配；不知道有哪些标签先调 `list_labels`）。"
            "【导出表格】给 `out_dir` 就把**全部命中**（不受 limit 限制）写成 `通讯录*.csv`，"
            "Excel/WPS 双击即开；返回 `csv_path` 与 `total`，**不再把清单灌回上下文**。"
            "适合「离职前导出客户名单」「把某标签/某群的人导成表」。"
            "【群成员】`room=` 时返回 `contacts` + `name_in_room_with`：`name` 是**全局显示名**，"
            "`name_in_room` 是**群里的称呼**（可能为空串）。⚠️ 群里称呼是**稀疏的**（本机 9.6%，"
            "自己的办公群多、外部大群少）：**空串 = 这个群里没给它设过**，不是查询失败，"
            "别退回全局名冒充。它也不能用来认人（认人用 `username`）。"
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
                "label": {"type": "string", "description": "只列带这个标签的人（标签名，精确匹配）"},
                "out_dir": {"type": "string",
                            "description": "给了就把全部命中导出成 CSV 到这个目录（Excel 可直接打开）"},
                "limit": {"type": "integer", "description": "最多返回条数，0=全部（默认0，保持向后兼容）"},
                "offset": {"type": "integer", "description": "从第几条开始（翻页用，默认 0）"},
            },
        },
    },
    {
        "name": "list_labels",
        "description": (
            "【何时用】看用户在微信里给好友打了哪些**标签**、每个标签下几个人——"
            "「我的客户标签下有谁」先调它拿准确的标签名，再 `list_contacts(label=…)`。"
            "【返回】`labels`：`label_id` / `name` / `count`（好友人数，不含已删除）。"
        ),
        "inputSchema": {"type": "object", "properties": {}},
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
        "name": "silence_ladder",
        "description": (
            "【何时用】找**久未联系的人**，或看**从没聊过的人**。按沉默时长分层"
            "（默认 30/60/90 天），每层给前 N 人的**原始时间戳**与条数——**不打分、不判断意向**。"
            "【与 interaction_rank 的区别】那个按**会话**排（只看有你俩消息的会话），"
            "本工具按**人**排：私聊没说过话、但在群里冒过泡的人也**看得见**；"
            "通讯录里有、全库一句没说的单独进 `never` 桶（本机 2475/2520 —— 那批人别当成不存在）。"
            "【两个口径别混】`last_msg_*` = 你俩**私聊**最后一条；`last_spoke_*` = TA 在"
            "**任何会话（含群）**里最后一次发言。差别大是正常的。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "scope": {"type": "string",
                          "enum": ["friend", "group", "official", "open", "all"],
                          "description": "对哪一类人分层，默认 friend"},
                "days": {"type": "array", "items": {"type": "integer"},
                         "description": "分层边界（天），默认 [30, 60, 90]"},
                "top": {"type": "integer", "description": "每层最多列几人，默认 20"},
            },
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
    {
        "name": "read_messages",
        "description": (
            "【何时用】读某个会话的**聊天正文**（就是屏幕上那些气泡），按**时间正序**返回。"
            "非文本消息给一行摘要（`[图片 12KB]` / `[引用] …` / `[语音 11.3 秒]`）。"
            "【范围】`since`/`until` 圈时间段，`limit` 取其中**最近**的若干条——"
            "和往上翻聊天记录的手感一致。`truncated=true` 表示还有更早的没给完，"
            "**别把「最后一条」和「被截断」当同一件事**（拿 `since` 往前接着读）。"
            "【每条返回】`ts`/`time`/`type`/`text`/`from_me`/`sender`；"
            "图片带 `image_md5`、视频带 `video_path`、语音带 `local_id`。"
            "⚠️ `text` 超过 400 字会被截断，带上 `text_len`（全文长度）与 `text_more`——"
            "**看到 `text_len` 就得知道手上不是全文**。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "talker": {"type": "string", "description": "会话名或 wxid/群号"},
                "since": {"type": "integer", "description": "起始时间（Unix 秒，含）"},
                "until": {"type": "integer", "description": "结束时间（Unix 秒，含）"},
                "limit": {"type": "integer", "description": "最多返回条数，默认 200"},
            },
            "required": ["talker"],
        },
    },
    {
        "name": "search_messages",
        "description": (
            "【何时用】在**指定范围**里按关键词找聊天内容——"
            "「这个人提过报价吗」「哪个群里说过 XX」。"
            "【范围】`talker` 给了就只搜那个会话，**不给就是整个微信**；"
            "再叠加 `since`/`until` 圈时间段。三者自由组合，这就是「指定范围」的全部含义。"
            "⚠️ **全库搜索性能**：不指定 `talker` 时会扫描整个微信数据库，大数据量场景下"
            "可能耗时较长（数千条以上可能 10s+）。建议优先使用单会话搜索或缩小时间范围。"
            "【返回】`count` 命中数 / `truncated`（撞到扫描上限，**没扫完**，别当成"
            "\"就这么多\"） / 每条带 `talker`/`name`/`sender`/`from_me`/`time`/`text`。"
            "【注意】搜的是**渲染后的文本**，所以「图片」「语音」「撤回」这些词也搜得到。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "keyword": {"type": "string", "description": "关键词（子串匹配）"},
                "talker": {"type": "string", "description": "限定会话；不传=全库"},
                "since": {"type": "integer", "description": "起始时间（Unix 秒，含）"},
                "until": {"type": "integer", "description": "结束时间（Unix 秒，含）"},
                "limit": {"type": "integer", "description": "最多返回条数，默认 50"},
            },
            "required": ["keyword"],
        },
    },
    {
        "name": "customer_brief",
        "description": (
            "【何时用】**一次调用看清一个客户/一个群的状况**——不用先读几百条原文。"
            "它把正文汇总成可核对的数与原文，是「客户分析」最省事的第一站。"
            "【给什么】条数与我/对方占比、\n"
            "- `segments` 来过几趟 + `opened_by_*` **谁主动开场**（段 = 间隔超 30 分钟算新的一段）；\n"
            "- `my_reply_s`/`their_reply_s` 双方回复间隔**中位数**（只算同一段内的换手）；\n"
            "- `types` 消息类型分布（文本/图片/文件/引用…）；\n"
            "- `hot_pairs` 对方正文的高频二字组合——**线索不是词表**；\n"
            "- `unanswered` **对方提问后 24 小时内我没发过任何消息**的那几句（最近 N 条）。\n"
            "⚠️ `unanswered` 是**形态判定**（看句尾和疑问词），不等于「他在催你」；"
            "本服务**不给意向分、不打分**。`truncated=true` = 只扫了最近 `scan` 条。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "talker": {"type": "string", "description": "会话名或 wxid/群号"},
                "since": {"type": "integer", "description": "起始时间（Unix 秒，含）"},
                "until": {"type": "integer", "description": "结束时间（Unix 秒，含）"},
                "top": {"type": "integer",
                        "description": "高频组合与未答问句各列几条，默认 15"},
            },
            "required": ["talker"],
        },
    },
]

INSTRUCTIONS = """\
本服务提供本机微信的**通讯录、互动统计与聊天正文**（只读）。
**它只给清单、数字和原文，不做任何判断**——"这个客户值不值得跟"是你的活。

**两面工具**：
- **通讯录面**（不读正文）：`list_contacts` / `list_labels` / `contact_stats` / `interaction_rank` / `silence_ladder`
- **消息面**（读正文）：`read_messages` / `search_messages` / `customer_brief`

**做一次客户分析，按这个顺序走**（这就是本产品的闭环，不需要别的工具）：
1. **找**客户 → `list_contacts(scope="group", keyword="客户")`，或
   `silence_ladder()` 看谁久没联系 / 谁从没聊过
2. **看量** → `contact_stats(talker)`：多少条、活跃时段、沉默多少天
3. **看一眼摘要** → `customer_brief(talker)`：谁主动开场、回复速度、对方在聊什么词、
   **有没有没接的问句**（`unanswered`）——多数情况到这一步就够了
4. **要细节再读原文** → `read_messages(talker, since, until)`；要找某个话题 →
   `search_messages(keyword, talker=…)`
5. **最后才是判断** —— 由你根据前四步的事实下结论，**工具不替你下**

典型用法：
- 「我有哪些客户群」→ `list_contacts(scope="group", keyword="客户")`
- 「这个群里都有谁」→ `list_contacts(room="群名")`
- 「我和某某聊得多不多」→ `contact_stats(talker="某某")`
- 「谁最久没联系了 / 哪些人从没聊过」→ `silence_ladder()`（按**人**；`interaction_rank`
  按**会话**，私聊没说过话但在群里冒过泡的人它看不见）
- 「XXX 最近什么情况 / 我漏了什么」→ `customer_brief(talker="XXX")`
- 「他提过报价吗 / 哪个群说过 XX」→ `search_messages(keyword="报价", talker=…)`

要点：
- 联系人分类按 username 后缀（确定性），**别**依赖 `local_type`（实测语义不干净）。
- 通讯录默认只回 200 条：看 `total`，不够就用 `offset` 接着翻，别以为只有 200 个人。
- 群成员：`name` 是全局显示名，`name_in_room` 是**群里的称呼**（稀疏，本机 9.6%）。
  **空串就是没设过**，别拿全局名顶上、也别当成查询失败。
- **`truncated=true` 是红灯**：读正文/检索/简报都有扫描上限，撞上了说明**没扫完**，
  **别把"就这些"讲给用户听**——往前挪 `since` 或者收窄范围再来一次。
- `read_messages` 的 `text` 是**400 字硬截断**：带 `text_len` 就是说后面还有
  （`text_more` 是补的那截），**拿 400 字当全文去总结就是"看不到就编"**。
- `customer_brief.unanswered` 是**形态判定**（句尾问号/疑问词 + 24 小时内我没说话），
  不等于"他在催你"，别替用户发明语气。
- **标签**：`list_labels()` 看有哪些标签，`list_contacts(label="标签名")` 按标签筛；
  每个联系人都带 `labels`。标签名要**精确**，拿不准先 `list_labels`。
- **导出成表格**：`list_contacts(..., out_dir="D:\\\\导出")` 把全部命中写成 CSV（Excel 直接打开），
  返回文件路径——用户要「导出客户名单 / 离职交接」时用它，别把几千行塞进对话。
- 数据含他人隐私：只读、本地处理、不外传。
"""

DISPATCH = {
    "list_contacts": lambda a: _tool_contacts(a),
    "list_labels": lambda a: {"labels": S.list_labels()},
    "contact_stats": lambda a: _tool_stats(a),
    "interaction_rank": lambda a: _tool_rank(a),
    "silence_ladder": lambda a: _tool_ladder(a),
    "read_messages": lambda a: _tool_read(a),
    "search_messages": lambda a: _tool_search(a),
    "customer_brief": lambda a: _tool_brief(a),
}


def _tool_contacts(args):
    """列通讯录 / 群成员；给 `label` 先校验标签名，给 `out_dir` 就整份落 CSV 只回路径。"""
    label = (args.get("label") or "").strip()
    if label and args.get("room") is None:
        known = list(S.labels().values())
        if label not in known:
            # 标签名打错 ≠ 这个标签下没人：前者给候选让模型去问，后者才是 total=0
            return mcp_stdio.tool_error(
                "target_not_found", f"没有叫「{label}」的标签", candidates=known,
                suggestion="从 candidates 里挑一个确切的标签名重试，或调 list_labels 看全部标签。")
    rows = S.list_contacts(scope=args.get("scope") or "friend",
                           room=args.get("room"),
                           keyword=args.get("keyword") or "",
                           include_deleted=bool(args.get("include_deleted")),
                           limit=int(args.get("limit") or 0),
                           offset=int(args.get("offset") or 0),
                           label=label)
    if args.get("out_dir"):
        tag = "_".join(x for x in (args.get("room"), label, args.get("keyword")) if x) or \
            (args.get("scope") or "friend")
        fname = "通讯录_%s.csv" % "".join(c if c not in '\\/:*?"<>|' else "_" for c in tag)[:60]
        return {"total": len(rows), "csv_path": S.write_contacts_csv(rows, args["out_dir"], fname)}
    if args.get("room") is not None:
        # 群成员**不分页**（一个群撑死几百人，切片反而会让"这个群里都有谁"缺人），
        # 但要按同一套字段名报数，并额外报"有几个人的群内称呼是真的"。
        return {"total": len(rows), "count": len(rows), "contacts": rows,
                "name_in_room_with": sum(1 for r in rows if r["name_in_room"])}
    # 通讯录列表返回总数和实际条数
    # 注意：list_contacts 现在已经应用了分页，所以这里不再需要 page_of
    total_before_paging = len(S.list_contacts(scope=args.get("scope") or "friend",
                                              keyword=args.get("keyword") or "",
                                              include_deleted=bool(args.get("include_deleted")),
                                              label=label))
    return {"total": total_before_paging, "count": len(rows), "offset": int(args.get("offset") or 0),
            "contacts": rows}


def _tool_stats(args):
    talker = args.get("talker")
    if not talker:
        return mcp_stdio.tool_error(
            "bad_args", "talker 必填（会话名或 wxid/群号）")
    return S.contact_stats(talker, since=int(args.get("since") or 0),
                           until=int(args.get("until") or 0))


def _tool_ladder(args):
    days = args.get("days")
    if days is not None and (not isinstance(days, list) or
                             not all(isinstance(d, int) and d > 0 for d in days)):
        return mcp_stdio.tool_error("bad_args", "days 必须是正整数数组，如 [30, 60, 90]")
    return S.silence_ladder(scope=args.get("scope") or "friend",
                            days=tuple(days or (30, 60, 90)),
                            top=int(args.get("top") or 20))


def _tool_rank(args):
    rows = S.interaction_rank(since=int(args.get("since") or 0),
                              until=int(args.get("until") or 0),
                              top=int(args.get("top") or 20),
                              sort=args.get("sort") or "count")
    return {"count": len(rows), "ranking": rows}


def _tool_read(args):
    talker = args.get("talker")
    if not talker:
        return mcp_stdio.tool_error("bad_args", "talker 必填（会话名或 wxid/群号）")
    return L.read_messages(talker, since=int(args.get("since") or 0),
                           until=int(args.get("until") or 0),
                           limit=int(args["limit"]) if args.get("limit") is not None else 200)


def _tool_search(args):
    keyword = args.get("keyword")
    # P0 修复：参数校验前置（在数据库操作前）
    if not keyword or not str(keyword).strip():
        return mcp_stdio.tool_error("bad_args", "keyword 必填且不能为空字符串")
    return L.search_messages(keyword, talker=args.get("talker"),
                             since=int(args.get("since") or 0),
                             until=int(args.get("until") or 0),
                             limit=int(args["limit"]) if args.get("limit") is not None else 50)


def _tool_brief(args):
    talker = args.get("talker")
    if not talker:
        return mcp_stdio.tool_error("bad_args", "talker 必填（会话名或 wxid/群号）")
    return L.customer_brief(talker, since=int(args.get("since") or 0),
                            until=int(args.get("until") or 0),
                            top=int(args.get("top") or 15))


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
