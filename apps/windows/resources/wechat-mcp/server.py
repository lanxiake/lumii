"""微信 MCP Server（stdio JSON-RPC）—— 给 Lumii Agent 用。

工具：
- wechat_sessions()                        列出会话（name + talker）
- wechat_history(talker, limit)            读历史
- wechat_poll(since_ts)                    读增量新消息
- wechat_status()                          检查自动化环境（进程/窗口/可见/最小化/前台/尺寸·DPI）
- wechat_send(talker, text, dry_run=true)  发消息（默认 dry-run，需显式 dry_run=false 才真发）
- wechat_send_file(talker, path, dry_run=true)  发图片/文件/视频/音频（同上默认 dry-run）

发送前依次校验：环境 → 目标会话（数据库锚点）→ 输入落地 → 发送生效；任一不过即中止（fail-closed）。
只读部分不改动任何微信文件；发送走「OCR 定位 + SendInput」（零注入）。
`initialize` 返回 `instructions`（引导词），帮助 Agent 正确使用；stdout 仅输出 JSON-RPC 单行，日志走 stderr。
"""
import json
import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import wechat_core as core  # noqa: E402


def log(*a):
    print("[wechat-mcp]", *a, file=sys.stderr, flush=True)


def _resolve(talker):
    if not talker:
        return None
    return core.resolve_talker(talker)


def _resolve_or_error(talker):
    """解析会话；失败时给出**可选清单**（避免宽松匹配发错人）。返回 (talker|None, error|None)。"""
    t = _resolve(talker)
    if t:
        return t, None
    try:
        opts = "；".join(f"{s['name']}({s['talker']})" for s in core.sessions())
    except Exception:
        opts = "（会话列表读取失败）"
    return None, (f"未找到会话「{talker}」——本工具**严格匹配**（需与显示名或 wxid/群号完全一致），"
                  f"歧义或部分匹配一律拒绝以免发错人。可选会话：{opts}")


def _code_of(detail):
    """把发送层的中文 detail 归一到**稳定错误码**（Agent 据此决策，不必字符串匹配）。"""
    d = detail or ""
    if "环境前置检查" in d or "窗口前置检查" in d:
        return "env_not_ready"
    if "未找到要引用的消息" in d:
        return "quote_not_found"
    if "菜单里未找到" in d:
        return "menu_not_found"
    if "未找到" in d:
        return "target_not_found"
    if "目标会话未确认" in d:
        return "target_unconfirmed"
    if "输入未落地" in d:
        return "input_not_landed"
    if "附件未落地" in d:
        return "attachment_not_landed"
    if "文件不存在" in d:
        return "attachment_missing"
    if "未见新消息" in d or "发送未生效" in d:
        return "send_not_confirmed"
    return "unknown"


def tool_sessions(args):
    """列出会话；带 query 时按关键词过滤（让 Agent 在发送前就能拿到**确切名字/talker**）。"""
    rows = core.sessions()
    q = str((args or {}).get("query") or "").strip()
    if q:
        rows = [r for r in rows if q in r["name"] or q in r["talker"] or q in (r.get("last") or "")]
    return rows


def tool_history(args):
    talker, err = _resolve_or_error(args.get("talker"))
    if err:
        return {"error": err}
    return core.history(talker, int(args.get("limit") or 20), int(args.get("before_ts") or 0))


def tool_poll(args):
    return core.poll(int(args.get("since_ts") or 0))


def tool_send(args):
    talker, err = _resolve_or_error(args.get("talker"))
    if err:
        return {"ok": False, "error_code": "target_not_found", "error": err}
    text = args.get("text") or ""
    if not text:
        return {"ok": False, "error_code": "bad_args", "error": "text 为空"}
    dry = args.get("dry_run")
    dry = True if dry is None else bool(dry)
    import wechat_sender
    ok, detail = wechat_sender.send_text(text, talker, dry_run=dry)
    out = {"ok": ok, "detail": detail, "talker": talker, "name": core.names().get(talker, talker),
           "dry_run": dry, "text": text[:120]}
    if not ok:
        out["error_code"] = _code_of(detail)
        out["shot"] = wechat_sender.last_shot()
    return out


def tool_send_file(args):
    talker, err = _resolve_or_error(args.get("talker"))
    if err:
        return {"ok": False, "error_code": "target_not_found", "error": err}
    path = args.get("path") or ""
    if not path:
        return {"ok": False, "error_code": "bad_args", "error": "path 为空"}
    dry = args.get("dry_run")
    dry = True if dry is None else bool(dry)
    import wechat_sender
    ok, detail = wechat_sender.send_attachment(path, talker, dry_run=dry)
    out = {"ok": ok, "detail": detail, "talker": talker, "name": core.names().get(talker, talker),
           "dry_run": dry, "path": path}
    if not ok:
        out["error_code"] = _code_of(detail)
        out["shot"] = wechat_sender.last_shot()
    return out


def tool_send_batch(args):
    """批量发送：对多个目标**逐条独立**解析 / 校验 / 发送，互不影响（一个失败不拖累其余）。

    默认 dry_run=true。每个目标都走 send_text 的完整闸门（环境 → 目标会话 → 输入落地 → 读库确认）。
    """
    items = args.get("messages") or []
    dry = args.get("dry_run")
    dry = True if dry is None else bool(dry)
    if not isinstance(items, list) or not items:
        return {"ok": False, "error_code": "bad_args", "error": "messages 为空（需 [{talker, text}, ...]）"}
    import wechat_sender
    results = []
    for it in items:
        it = it or {}
        raw, text = it.get("talker"), (it.get("text") or "")
        talker, err = _resolve_or_error(raw)
        if err:
            results.append({"ok": False, "error_code": "target_not_found", "error": err, "talker": raw})
            continue
        if not text:
            results.append({"ok": False, "error_code": "bad_args", "error": "text 为空", "talker": talker})
            continue
        ok, detail = wechat_sender.send_text(text, talker, dry_run=dry)
        r = {"ok": ok, "detail": detail, "talker": talker,
             "name": core.names().get(talker, talker), "dry_run": dry, "text": text[:120]}
        if not ok:
            r["error_code"] = _code_of(detail)
            r["shot"] = wechat_sender.last_shot()
        results.append(r)
    sent = sum(1 for r in results if r["ok"])
    return {"ok": sent == len(results), "total": len(results), "sent": sent,
            "dry_run": dry, "results": results}


def tool_reply(args):
    """引用回复：引用聊天区里含 `quote` 的那条消息，再发出 `text`。"""
    talker, err = _resolve_or_error(args.get("talker"))
    if err:
        return {"ok": False, "error_code": "target_not_found", "error": err}
    quote = args.get("quote") or ""
    text = args.get("text") or ""
    if not text:
        return {"ok": False, "error_code": "bad_args", "error": "text 为空"}
    if not quote:
        return {"ok": False, "error_code": "bad_args", "error": "quote 为空（要引用那条消息的文字，用于定位）"}
    dry = args.get("dry_run")
    dry = True if dry is None else bool(dry)
    import wechat_sender
    ok, detail = wechat_sender.reply_text(quote, text, talker, dry_run=dry)
    out = {"ok": ok, "detail": detail, "talker": talker, "name": core.names().get(talker, talker),
           "dry_run": dry, "quote": quote[:60], "text": text[:120]}
    if not ok:
        out["error_code"] = _code_of(detail)
        out["shot"] = wechat_sender.last_shot()
    return out


def tool_search(args):
    talker = args.get("talker")
    if talker:
        talker, err = _resolve_or_error(talker)
        if err:
            return {"error_code": "target_not_found", "error": err}
    return core.search_messages(str(args.get("keyword") or ""), talker,
                                int(args.get("since") or 0), int(args.get("until") or 0),
                                int(args.get("limit") or 50))


def tool_unread(_args):
    return core.unread()


def tool_digest(args):
    """用户/好友知识与行为蒸馏（确定性、只读、本地）：返回统计 + 代表性样本。"""
    talker = args.get("talker")
    if talker:
        talker, err = _resolve_or_error(talker)
        if err:
            return {"error_code": "target_not_found", "error": err}
    return core.digest(talker, int(args.get("limit") or 500), since=int(args.get("since") or 0))


def tool_distill_state(args):
    """蒸馏水位（增量蒸馏用）：`action=set` 传 `ts` 写入；默认读取。"""
    if (args.get("action") or "get") == "set":
        return core.set_distill_state(args.get("scope") or "self", int(args.get("ts") or 0))
    return core.distill_state(args.get("scope") or None)


def _resolve_scope(scope):
    """画像 scope：空/self/me/我 → 用户本人（None）；否则解析成会话 talker。返回 (talker|None, err|None)。"""
    if not scope or scope in ("self", "me", "我", "本人"):
        return None, None
    t = _resolve(scope)
    if t:
        return t, None
    return None, f"未找到会话「{scope}」"


def tool_profile_save(args):
    """把提炼好的画像落本地（用户画像 / 某会话画像）。"""
    scope, err = _resolve_scope(args.get("scope"))
    if err:
        return {"ok": False, "error_code": "target_not_found", "error": err}
    content = args.get("content") or ""
    if not content.strip():
        return {"ok": False, "error_code": "bad_args", "error": "content 为空（画像正文）"}
    p = core.profile_save(scope, content)
    return {"ok": True, "scope": scope or "self", "path": p}


def tool_profile_get(args):
    """读回已蒸馏的画像（给 scope）或列出已产出的画像文件（不给）。"""
    scope, err = _resolve_scope(args.get("scope"))
    if err:
        return {"error_code": "target_not_found", "error": err}
    return core.profile_get(scope)


def tool_status(_args):
    import wechat_sender
    st = wechat_sender.check_env()
    st["can_send"] = bool(st["ok"])
    st["hint"] = ("可以发送" if st["ok"] else
                  "发送功能不可用：" + (st.get("reason") or "") +
                  "。请先把微信主窗口调到可见且在前台（不要最小化），再重试。")
    return st


# 服务级引导：客户端把这段注入给 Agent，帮助它正确使用这些工具。
INSTRUCTIONS = """\
本服务让 Agent 以【用户本人】身份读微信、并按需发消息（零注入：截图 OCR 定位 + 模拟键鼠；不改微信数据）。

工具选择：
- 只读（不需要微信窗口）：wechat_sessions 列会话 / wechat_history 读历史 / wechat_poll 读增量新消息。
- 发送（需要微信窗口可见且在前台）：wechat_send 发**文本**；wechat_send_file 发**图片/文件/视频/音频**；wechat_send_batch 把消息**群发给多个目标**（逐目标独立校验）；wechat_reply 发**带引用的回复**（quote 传被引用消息的文字用于定位）。
- 发送前可先调 wechat_status 确认环境（微信是否运行、窗口是否可见/最小化/在前台）。

附件说明（wechat_send_file）：
- path 传本地绝对路径；图片按内联图片发，其余按文件发，视频一般按视频消息发。
- 微信「语音消息」是按住录音、**无法自动化**——语音只能把音频文件当附件发。
- 用户说「发给我」但没给路径时，先问清文件路径，不要猜。

发送纪律（重要）：
1. 默认 dry_run=true —— 只校验、不发送。**只有用户明确要求真发时才传 dry_run=false**。
2. 内容以用户本人身份发出、且**不可撤回**。含义模糊或有风险的内容，先草拟给用户确认。
3. 需要微信窗口可见且在前台：若 wechat_status 返回 ok=false，先请用户把微信窗口调出来（别自己去点）。
   最小化/后台/锁屏时发送会失败（这是设计使然，不是 bug）。
4. talker 用 wechat_sessions 返回的 name（如「文件传输助手」「TOOLAN」「TOOLAN、韩玉」）或 wxid/群号最稳。
5. 一次发一条；失败会在 detail 里说明卡在哪一道校验，可据此调整或提示用户。

读取建议：先用 wechat_sessions 找目标会话名，再用 wechat_history 拉上下文，然后据此起草回复。

蒸馏（用户/好友知识与行为）：要提炼「我的表达习惯 / 与谁联系最多 / 活跃时段 / 某会话里对方是谁」时，用 wechat_digest——
它做**本地确定性统计 + 代表性样本**（覆盖微信全部时间分片，**不外传**），你再据此写成画像；
用 wechat_profile_save 存成画像（scope 留空=用户本人），wechat_profile_get 读回。画像存本地白盒 Markdown，可编辑可删。
**增量**：蒸馏完用 wechat_distill_state(action=set) 记水位，下次 wechat_digest(since=水位) 只处理新消息。
**回答与微信/某联系人相关的问题前，先 wechat_profile_get 看有没有现成画像**（有就用，别重复蒸馏）。
"""

TOOLS = [
    {"name": "list_sessions",
     "description": "【何时用】用户要看你**本机微信**有哪些会话、或找某个好友/群（拿到它的 talker/name）时。【别用】别人通过 Bot 找这个助手时；——那是渠道(`weixin`)的 Bot 收件箱，与本工具无关。列出**用户本人微信**的会话（显示名 + talker 标识 + 最新消息预览），先用它确定目标会话。",
     "inputSchema": {"type": "object", "properties": {
         "query": {"type": "string", "description": "可选：按名字/talker/最新消息关键词过滤，用来快速定位目标会话"}},
         "required": []}},
    {"name": "read_history",
     "description": ("【何时用】要读**用户本人微信**里某个好友/群的聊天记录、或据此起草回复时。【别用】想读渠道(Bot)会话时；——那是渠道(`weixin`)的 Bot 收件箱，与本工具无关。读取**用户本人微信**指定会话的历史消息（按时间正序）。"
                     "talker 可传 wechat_sessions 返回的 name 或 wxid/群号/filehelper。"
                     "消息多时可**翻页**：返回带 `cursor`（本页最老一条 ts）与 `has_more`；要读更早的一页再调一次并传 `before_ts=cursor`。"),
     "inputSchema": {"type": "object", "properties": {
         "talker": {"type": "string", "description": "会话显示名或 wxid/群号/filehelper"},
         "limit": {"type": "integer", "description": "条数，默认 20"},
         "before_ts": {"type": "integer", "description": "可选：只返回该 Unix 秒**之前**的消息（翻页用，传上一页返回的 cursor）"}},
         "required": ["talker"]}},
    {"name": "poll_new",
     "description": "【何时用】要**实时/增量**盯用户本人微信的新消息时（配 wechat-local 的轮询）。【别用】渠道收件；那是渠道的事。读取某 Unix 秒时间戳之后的新消息。",
     "inputSchema": {"type": "object", "properties": {
         "since_ts": {"type": "integer", "description": "Unix 秒；返回 create_time 大于它的消息"}},
         "required": ["since_ts"]}},
    {"name": "check_env",
     "description": ("【何时用】**发消息前**先自检本机微信自动化环境（是否运行/窗口可见/最小化/在前台/尺寸·DPI）。【别用】与渠道无关。"
                     "发送前先调它；返回 ok=false 时把 hint 转告用户（通常是让用户把微信窗口调出来）。"),
     "inputSchema": {"type": "object", "properties": {}, "required": []}},
    {"name": "send_text",
     "description": ("【何时用】用户说「给我微信里的某人/某群发条消息」时（**以用户本人身份**，不可撤回）。【别用】回渠道(Bot)消息；那走渠道回执。"
                     "**默认 dry_run=true 只校验不发送**；仅当用户明确要求真发时才传 dry_run=false。"
                     "发送前依次校验：环境（窗口可见在前台）→ 目标会话（数据库锚点匹配）→ 输入落地 → 发送生效；"
                     "任一不通过即中止，绝不盲发。失败时 detail 会说明卡在哪一步。"),
     "inputSchema": {"type": "object", "properties": {
         "talker": {"type": "string", "description": "会话显示名或 wxid/群号/filehelper"},
         "text": {"type": "string", "description": "要发送的文本"},
         "dry_run": {"type": "boolean", "description": "默认 true（只校验不发送）；真发传 false"}},
         "required": ["talker", "text"]}},
    {"name": "send_file",
     "description": ("【何时用】用户说「把这个文件/图片发给微信里的某人/某群」时（**以用户本人身份**，不可撤回）。【别用】渠道附件。"
                     "path 传本地文件**绝对路径**；按扩展名自动区分：图片(png/jpg/jpeg/gif/bmp/webp/tiff)内联发送，"
                     "其余(pdf/docx/xlsx/pptx/txt/mp4/mov/mp3/wav/zip…)作为**文件**发送；视频一般按视频消息发出。"
                     "**默认 dry_run=true 只校验不发送**；仅当用户明确要求真发时才传 dry_run=false。"
                     "注意：微信「语音消息」是按住录音、无法自动化——语音只能把音频**当文件**发。"
                     "需要微信窗口可见且在前台；失败时 detail 会说明卡在哪一步。"),
     "inputSchema": {"type": "object", "properties": {
         "talker": {"type": "string", "description": "会话显示名或 wxid/群号/filehelper"},
         "path": {"type": "string", "description": "本地文件的绝对路径"},
         "dry_run": {"type": "boolean", "description": "默认 true（只校验不发送）；真发传 false"}},
         "required": ["talker", "path"]}},
    {"name": "send_batch",
     "description": ("【何时用】用户要**把消息发给多个好友/群**（群发、通知、逐个转发同一条）时（**以用户本人身份**，不可撤回）。"
                     "【别用】只发一个目标时——直接用 send_text 更清晰。**默认 dry_run=true 只校验不发送**；"
                     "仅当用户明确要求真发时才传 dry_run=false。对**每个目标独立**走完整校验（环境 → 目标会话 → 输入落地 → 读库确认），"
                     "一个目标失败**不拖累**其余；逐个返回结果与 error_code，便于你向用户汇报哪些成功、哪些没发。"),
     "inputSchema": {"type": "object", "properties": {
         "messages": {"type": "array", "description": "要逐条发送的项，每项 {talker, text}",
                      "items": {"type": "object", "properties": {
                          "talker": {"type": "string", "description": "会话显示名或 wxid/群号/filehelper"},
                          "text": {"type": "string"}}, "required": ["talker", "text"]}},
         "dry_run": {"type": "boolean", "description": "默认 true（只校验不发送）；真发传 false"}},
         "required": ["messages"]}},
    {"name": "reply_to",
     "description": ("【何时用】用户说「**引用/回复某条消息**」（带引用的回复）时（**以用户本人身份**，不可撤回）。"
                     "【别用】普通发一条新消息——用 send_text。"
                     "quote 传**要引用那条消息的文字**（在聊天区定位它）；text 是要发的正文。"
                     "**默认 dry_run=true 只校验不发送**；仅当用户明确要求真发时才传 dry_run=false。"
                     "流程：定位该消息 → 右键 → 菜单「引用」→ 输入正文 → 发送；失败会说明卡在哪一步。"),
     "inputSchema": {"type": "object", "properties": {
         "talker": {"type": "string", "description": "会话显示名或 wxid/群号/filehelper"},
         "quote": {"type": "string", "description": "要引用那条消息的文字（用于在聊天区定位它）"},
         "text": {"type": "string", "description": "要发送的正文"},
         "dry_run": {"type": "boolean", "description": "默认 true（只校验不发送）；真发传 false"}},
         "required": ["talker", "quote", "text"]}},
    {"name": "search_messages",
     "description": ("【何时用】要在**用户本人微信**里按**关键词/时间**找旧消息时（「上周谁提过 X」「张三说过什么」）。"
                     "【别用】渠道(Bot)会话。跨会话检索；给 talker 则只搜该会话。"),
     "inputSchema": {"type": "object", "properties": {
         "keyword": {"type": "string"}, "talker": {"type": "string", "description": "可选：限定会话"},
         "since": {"type": "integer", "description": "可选：Unix 秒下界"}, "until": {"type": "integer"},
         "limit": {"type": "integer"}}, "required": ["keyword"]}},
    {"name": "list_unread",
     "description": "【何时用】用户问「有哪些没回/没看」、要**批量处理未读**时（返回未读会话 + 最近一条预览）。【别用】渠道(Bot)。",
     "inputSchema": {"type": "object", "properties": {}, "required": []}},
    {"name": "wechat_digest",
     "description": ("【何时用】要**蒸馏用户/好友的画像与行为**时（「我平常怎么说话」「我和谁联系最多」「这个群/这个人大概是谁」「什么时段我活跃」）："
                     "返回**本地确定性统计**（消息量、我发的/对方发的、消息类型分布、活跃时段、最常联系的人、高频词）"
                     "＋**代表性样本**，你再据此提炼画像。【别用】只想读几条消息（用 read_history）。"
                     "**全本地、只读、不外传**；覆盖微信**所有时间分片**。talker 可选（限定某会话），不给则全局。"),
     "inputSchema": {"type": "object", "properties": {
         "talker": {"type": "string", "description": "可选：限定某个会话（name 或 wxid/群号）"},
         "limit": {"type": "integer", "description": "每个会话最多扫描条数，默认 500"},
         "since": {"type": "integer", "description": "可选：只统计该 Unix 秒之后的消息（增量蒸馏用）"}},
         "required": []}},
    {"name": "wechat_distill_state",
     "description": ("【何时用】做**增量蒸馏**时：蒸馏完把水位（处理到的最新 ts）用 `action=set` 记下；"
                     "下次先默认读回水位，再用 `wechat_digest(since=水位)` 只处理新消息。【别用】一次全量蒸馏（不需要水位）。"
                     "`scope`：self(默认) / all / 会话名。"),
     "inputSchema": {"type": "object", "properties": {
         "action": {"type": "string", "description": "get（默认）读取 | set 写入"},
         "scope": {"type": "string", "description": "水位键：self（默认）/ all / 会话名"},
         "ts": {"type": "integer", "description": "action=set 时的水位（Unix 秒）"}}, "required": []}},
    {"name": "wechat_profile_save",
     "description": ("【何时用】**把你从 wechat_digest + read_history 提炼出的画像存下来**，供以后复用（「我平常怎么说话」「某人/某群是谁」）。"
                     "content 传 **Markdown 画像正文**（结构建议：身份/关系 · 常聊话题 · 沟通风格 · 关键事实（尽量带时间））。"
                     "scope 留空=**用户本人画像**；给出会话名/wxid 则是**该好友/群的画像**。"
                     "**全本地**写入 `~/.lumii/wechat-distill/`（白盒、可编辑、可删）。【别用】存原始聊天记录。"),
     "inputSchema": {"type": "object", "properties": {
         "scope": {"type": "string", "description": "留空=用户本人；或会话名/wxid/群号（对该会话画像）"},
         "content": {"type": "string", "description": "Markdown 画像正文"}},
         "required": ["content"]}},
    {"name": "wechat_profile_get",
     "description": ("【何时用】要**读回已蒸馏的画像**（「我是谁」「某个好友是谁」）时。"
                     "【别用】还没有画像时——应先 wechat_digest + 提炼，再 wechat_profile_save。"
                     "scope 留空则**列出**已产出的画像文件。"),
     "inputSchema": {"type": "object", "properties": {
         "scope": {"type": "string", "description": "可选：留空列出全部"}}, "required": []}},
]
DISPATCH = {"list_sessions": tool_sessions, "read_history": tool_history,
            "poll_new": tool_poll, "check_env": tool_status,
            "send_text": tool_send, "send_file": tool_send_file,
            "send_batch": tool_send_batch, "reply_to": tool_reply,
            "search_messages": tool_search, "list_unread": tool_unread,
            "wechat_digest": tool_digest,
            "wechat_distill_state": tool_distill_state,
            "wechat_profile_save": tool_profile_save, "wechat_profile_get": tool_profile_get}


def reply(mid, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": mid, "result": result}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        mid, method = msg.get("id"), msg.get("method")
        if method == "initialize":
            reply(mid, {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                        "serverInfo": {"name": "wechat-local", "version": "0.3.0"},
                        "instructions": INSTRUCTIONS})
        elif method == "tools/list":
            reply(mid, {"tools": TOOLS})
        elif method == "tools/call":
            p = msg.get("params") or {}
            name, args = p.get("name"), (p.get("arguments") or {})
            log("call", name)
            try:
                data = DISPATCH[name](args)
                reply(mid, {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}], "isError": False})
            except Exception as e:
                log("error", name, repr(e))
                reply(mid, {"content": [{"type": "text", "text": f"ERROR: {e}"}], "isError": True})
        elif mid is not None:
            reply(mid, {})


if __name__ == "__main__":
    main()
