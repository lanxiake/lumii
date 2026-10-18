"""C · 客户分析 —— 核心逻辑（纯取数，不出判断）。

只端上**确定性的清单与数字**：通讯录（好友/群/公众号/企业微信）、群成员、单会话互动统计、
互动排行。"这个客户意向高不高"是 LLM + 技能包的事，不在这里。

只读：不改动任何微信数据。

⚠️ **不做标签**：实测 `contact.db` 里只有 `contact_label`（5 个标签**名**），**没有**好友↔标签
映射表，疑似埋在 `contact.extra_buffer` 的 protobuf 里 —— 需逆向，留研究项。

⚠️ **群内昵称**：走 `contact_fts.db.chatroom_member_fts_v3_content`（列定义写明是
`a_group_remark`）+ 同库 `name2id.rowid` 解 id。**但它是稀疏的**：本机 1980 行里只有 191 行
非空（9.6%），且按群差别极大（自己的办公群 27/32，外部大群 1/159）。
⇒ 有就给 `name_in_room`，没有就是空串，**别拿全局显示名冒充**（那正是这个字段要区分的东西）。
（`chat_room.ext_buffer` 那条旧线索已作废：本机 34 个群的该字段都是十几字节的短 blob，装不下名单。）
"""
import os
import sqlite3
import sys
import time
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
_SHARED = os.path.join(os.path.dirname(HERE), "wechat-mcp")   # 共享基础层（零复制）
if _SHARED not in sys.path:
    sys.path.insert(0, _SHARED)

import wechat_core as core  # noqa: E402

# 系统账号：不是人，也不该出现在"好友"清单里
SYSTEM_IDS = {
    "notifymessage", "filehelper", "floatbottle", "newsapp", "fmessage", "qmessage",
    "tmessage", "medianote", "weixin", "mphelper", "qqmail", "qqsafe", "voiceinput",
    "weixinreminder", "officialaccounts", "notification_messages", "exmail_tips",
    "weibo", "facebook", "linkedin", "weixinluckybag", "wechatsync",
}


def kind_of(username):
    """联系人种类 —— **按 username 后缀判定**（确定性），不猜 `local_type`。

    为什么不用 `local_type`：实测它语义不干净——`wxid_` 既有 1（559）也有 3（1260），
    自定义用户名同样两档都有，拿它当"好友/公众号"的判据会错。后缀是硬规则。
    """
    u = username or ""
    if u.endswith("@chatroom"):
        return "group"
    if u.endswith("@open"):
        return "open"                       # 企业微信 / 外部联系人
    if u.startswith("gh_"):
        return "official"                   # 公众号 / 服务号
    if u in SYSTEM_IDS:
        return "system"
    return "friend"


def _contact_db():
    m = core._mirror("contact/contact.db")
    m.refresh()
    return m.out


def page_of(rows, limit, offset=0):
    """切片 + 总数，返回 `{total, count, offset, contacts}`。`limit<=0` = 全部。

    **工具层默认只回 200 条**：本机好友 2500+，全量一次就是 415 KB 灌进模型上下文。
    但截断必须**报数**——`total` 与 `count` 不等才看得出"这是被截断的一页"，
    否则调用方会以为"我只有 200 个好友"。
    """
    limit = int(limit or 0)
    offset = max(0, int(offset or 0))
    page = rows[offset:] if limit <= 0 else rows[offset:offset + limit]
    return {"total": len(rows), "count": len(page), "offset": offset, "contacts": page}


def room_nicknames(room_username):
    """某个群的「群内称呼」：`{群成员username: 群里显示的那个称呼}`。

    来源是 `contact_fts.db` 的 FTS 表，列定义本身就说清了语义：

        CREATE VIRTUAL TABLE chatroom_member_fts_v3 USING fts5(
            tokenize='MMFtsTokenizer disable_pinyin enable_special_char',
            a_group_remark, room_id UNINDEXED, member_id UNINDEXED)

    两个 id 用**同库**的 `name2id.rowid → username` 解回（实测 0 个解不出）。

    ⚠️ **稀疏 + 按群差异大**（2026-10-14 实测）：1980 行里非空 191 行（9.6%）；
    自己的办公群 27/32，外部大群 `1/159`、`8/444`。**空 = 这个群里没有额外称呼**，
    不是"没查到"——所以调用方要如实显示，别退回全局名冒充。
    ⚠️ 本机数据**分不清**它是"我设的群备注"还是"TA 自己设的群昵称"，只作**展示**用，
    别拿它当身份判据（认人请用 username）。
    ⚠️ 读不到这张表（换版本/库结构变了）就返回 `{}` —— 于是所有成员都是空串。这个"静默变空"
    由**真机冒烟测试**兜（断言本机至少有一个群能取到称呼），不做运行期协议。
    """
    try:
        m = core._mirror("contact/contact_fts.db")
        m.refresh()
        path = m.out
    except Exception:                                               # noqa: BLE001
        return {}
    con = sqlite3.connect(path)
    try:
        id2name = dict(con.execute("select rowid, username from name2id"))
        rid = next((i for i, u in id2name.items() if u == room_username), None)
        if rid is None:
            return {}
        out = {}
        for c0, c2 in con.execute(
                "select c0, c2 from chatroom_member_fts_v3_content where c1=?", (rid,)):
            who, name = id2name.get(c2), (c0 or "").strip()
            if who and name:
                out[who] = name
        return out
    finally:
        con.close()


def list_contacts(scope="friend", room=None, keyword="", include_deleted=False, limit=0, offset=0):
    """通讯录清单。

    `room` 给了就返回**该群成员**（此时忽略 scope）；否则按 `scope` 筛种类。
    `scope` ∈ friend / group / official / open / system / all。
    显示名取「备注 > 昵称 > username」。

    P1 修复：添加分页支持
    - `limit`: 最多返回条数，0=返回全部（默认 0，保持向后兼容）
    - `offset`: 从第几条开始（默认 0）

    ⚠️ **必须先把所有会触发镜像刷新的调用做完，再开 sqlite 连接**：Windows 上无法替换一个
    仍被打开的文件，而 `core.resolve_talker/self_wxid` 会刷新 contact 镜像——持着连接去调
    会让 `os.replace` 抛 PermissionError（实测踩到）。
    """
    if room is not None:
        resolved = core.talker_of(room)      # 解析不出唯一目标就抛（→ target_not_found）
        me = core.self_wxid()
        nick = room_nicknames(resolved)      # ⚠️ 也必须排在开连接之前（它会刷新另一个镜像）
        con = sqlite3.connect(_contact_db())
        try:
            return _room_members(con, resolved, me, nick)
        finally:
            con.close()

    con = sqlite3.connect(_contact_db())
    try:
        rows = list(con.execute(
            "select username, remark, nick_name, alias, local_type, delete_flag"
            " from contact"))
    finally:
        con.close()
    kw = (keyword or "").strip().lower()
    out = []
    for username, remark, nick, alias, lt, deleted in rows:
        k = kind_of(username)
        if scope and scope != "all" and k != scope:
            continue
        if deleted and not include_deleted:
            continue
        name = remark or nick or username
        if kw and kw not in (name or "").lower() and kw not in (username or "").lower():
            continue
        out.append({"username": username, "name": name, "remark": remark or "",
                    "nick_name": nick or "", "alias": alias or "", "kind": k,
                    "local_type": lt, "deleted": bool(deleted)})
    out.sort(key=lambda d: d["name"])

    # P1 修复：应用分页
    limit = int(limit or 0)
    offset = int(offset or 0)
    if limit > 0:
        out = out[offset:offset + limit]
    elif offset > 0:
        out = out[offset:]

    return out


def _room_members(con, resolved, me, nick=None):
    """群成员（`name` = 全局显示名；`name_in_room` = 群里的称呼，**可能为空串**）。

    「群里的称呼」是本组要的东西，但**稀疏**（本机 9.6%）——空串就是"这个群里没给它设过"，
    不要用 `name` 顶上去（那正是要区分的两件事）。调用方报数用 `sum(bool(x["name_in_room"]))`。

    **包含自己**（`is_me=true`）：微信的成员列表里本来就有你，漏掉的话"这个群几个人"与
    微信里对不上（原来是自己被 `continue` 掉、`is_me` 硬编码 False —— 那个字段是死的）。
    """
    cid = con.execute("select id from contact where username=?", (resolved,)).fetchone()
    if not cid:
        return []
    nick = nick or {}
    disp = {u: (r or n or u) for u, r, n in
            con.execute("select username, remark, nick_name from contact")}
    out = []
    for (mid,) in con.execute("select member_id from chatroom_member where room_id=?", (cid[0],)):
        u = con.execute("select username from contact where id=?", (mid,)).fetchone()
        if not u:
            continue
        out.append({"username": u[0], "name": disp.get(u[0], u[0]),
                    "name_in_room": nick.get(u[0], ""),
                    "kind": kind_of(u[0]), "is_me": u[0] == me})
    out.sort(key=lambda d: d["name"])
    return out


def _iter_rows(talker, since=0, until=0):
    """跨所有分片取 `(create_time, local_type, sender_username)`，时间正序。"""
    core._refresh()
    tbl = core.tbl_of(talker)
    rows = []
    for shard in core._cache["msg"]:
        if tbl not in core._cache["tables"].get(shard, ()):
            continue
        smap = core._cache["senders"].get(shard, {})
        conds, params = [], []
        if since:
            conds.append("create_time >= ?")
            params.append(int(since))
        if until:
            conds.append("create_time <= ?")
            params.append(int(until))
        where = (" where " + " and ".join(conds)) if conds else ""
        con = sqlite3.connect(shard)
        try:
            for ct, sid in con.execute(
                    f"select create_time, real_sender_id from [{tbl}]" + where, params):
                rows.append((ct, smap.get(sid, "")))
        finally:
            con.close()
    rows.sort(key=lambda r: r[0])
    return rows


def contact_stats(talker, since=0, until=0):
    """单会话互动统计（**只给数字**，不做"关系好不好"之类的判断）。

    返回：首末时间、总条数、我发/对方发、活跃小时分布、活跃天 Top、连续沉默天数、跨度天数。

    `talker` 走 `core.talker_of`：解析不出唯一目标就抛 `UnknownTalker`（→ `target_not_found`）。
    原先 server 里那句 `resolve_talker(x) or x` 会把歧义名（本机真有多个 `loop`）与不存在的名字
    一起降级成"0 条"，看起来就像"你俩没聊过"。
    """
    talker = core.talker_of(talker)
    rows = _iter_rows(talker, since, until)
    names, me = core.names(), core.self_wxid()
    now = int(time.time())
    if not rows:
        return {"talker": talker, "name": names.get(talker, talker), "count": 0}
    mine = sum(1 for _ct, s in rows if s == me)
    hours = Counter(time.localtime(ct).tm_hour for ct, _s in rows)
    days = Counter(time.strftime("%Y-%m-%d", time.localtime(ct)) for ct, _s in rows)
    first, last = rows[0][0], rows[-1][0]
    return {
        "talker": talker, "name": names.get(talker, talker),
        "count": len(rows), "from_me": mine, "from_other": len(rows) - mine,
        "first_ts": first, "first": core._ts(first),
        "last_ts": last, "last": core._ts(last),
        "span_days": round((last - first) / 86400, 1) if last > first else 0,
        "silent_days": round((now - last) / 86400, 1),
        "active_hours": {str(h): hours[h] for h in sorted(hours, key=lambda x: -hours[x])[:6]},
        "top_days": [{"date": d, "count": days[d]}
                     for d in sorted(days, key=lambda x: -days[x])[:10]],
    }


def _last_by_sender():
    """`({username: 最后一次发言时间}, {username: 条数})` —— **跨全部会话（含群）**。

    `real_sender_id` 在群里就是"谁说的"，所以这个聚合正好回答"这个人最后一次露面是什么时候"，
    与"我们私聊的最后一条"（`interaction_rank` 那个口径）**是两个不同的数**。
    实测本机全库 5032 条、71 个会话表，全量聚合 0.0s —— 不需要缓存。
    `ponytail:` 大账号（十万级）会是全表扫，真慢了再按会话分片缓存。
    """
    core._refresh()
    last, cnt = {}, {}
    for shard in core._cache["msg"]:
        smap = core._cache["senders"].get(shard, {})
        con = sqlite3.connect(shard)
        try:
            for tbl in core._cache["tables"].get(shard, ()):
                for sid, mx, n in con.execute(
                        "select real_sender_id, max(create_time), count(*) from [%s] "
                        "group by real_sender_id" % tbl):
                    u = smap.get(sid, "")
                    if not u:
                        continue
                    last[u] = max(last.get(u, 0), mx or 0)
                    cnt[u] = cnt.get(u, 0) + n
        finally:
            con.close()
    return last, cnt


def _bucket_labels(days):
    """`[(标签, 下界开, 上界闭)]` —— 分层边界的**唯一一份定义**（测试直接读它，不另抄一遍）。

    `hi=None` = 开区间（最后一桶）。半开半闭是刻意的：`lo < d <= hi`，
    否则边界那天的归属会随实现漂移，而"一个人算哪一桶"是会被拿去对外的数。

    `lo=None` 只在**第一桶**：它没有下界（`sd <= 30` 全都算，含 0）。
    这不是洁癖——`silent_days` 是 `round(x, 1)`，刚说过话的人取整后就是 `0.0`，
    拿 `0 <` 当门就等于把"最近一小时内说过话的人"**从所有桶里漏掉**（真机漏了 10 个人，
    是测试 `各桶 + never == total` 逐条对账逮出来的）。负数（消息时间在未来，时钟偏差）
    同样归第一桶，比丢进虚空强。
    """
    out, lo = [], 0
    for d in tuple(days) + (None,):
        label = (f"{d} 天内有互动" if lo == 0 else
                 f"{lo + 1}-{d} 天没互动" if d else f"{lo} 天以上没互动")
        out.append((label, None if lo == 0 else lo, d))
        if d is not None:
            lo = d
    return out


def silence_ladder(scope="friend", days=(30, 60, 90), top=20):
    """沉默分层：按"最后一次可能算互动的时间"分层。**只给原始时间戳与条数，不打分。**

    为什么不用现成的 `interaction_rank(sort="recent")`：那个只看**会话**，于是
    **好友 2520 人里只有 45 个有 1:1 会话**，另外 2475 人（本机实测）在它眼里根本不存在——
    而"从没聊过的好友"恰恰是最该被看见的一批。这里改成**人**的视角。

    两个口径都报，**别混**（它们的差值本身就是信息）：
    - `last_msg_*`：**我们私聊**里最后一条（可能是我发的）；
    - `last_spoke_*`：TA **在任何会话（含群）**里最后一次发言。
    分层用两者里较大的那个（`last_ts`），因为那是"最近一次有来有往"的最好证据。

    `scope` 同 `list_contacts`（默认 friend）。`never` 桶 = 通讯录里有、全库一句都没说过的人。
    """
    now = int(time.time())
    rows = list_contacts(scope=scope)
    per_session = {r["talker"]: r for r in interaction_rank(top=10 ** 9)}
    spoken_last, spoken_cnt = _last_by_sender()

    people = []
    for c in rows:
        u = c["username"]
        s = per_session.get(u)
        m_ts = (s or {}).get("last_ts", 0)
        s_ts = spoken_last.get(u, 0)
        last_ts = max(m_ts, s_ts)
        people.append({
            **c,
            "msgs": (s or {}).get("count", 0), "last_msg_ts": m_ts,
            "last_msg": core._ts(m_ts) if m_ts else "",
            "spoken_msgs": spoken_cnt.get(u, 0), "last_spoke_ts": s_ts,
            "last_spoke": core._ts(s_ts) if s_ts else "",
            "last_ts": last_ts,
            "silent_days": round((now - last_ts) / 86400, 1) if last_ts else None,
        })

    # 构建分层结果 - 扁平化结构便于调用方使用
    buckets = []
    result = {
        "scope": scope, "now": now, "days": list(days), "total": len(people),
    }

    for label, lo, hi in _bucket_labels(days):
        hit = [p for p in people
               if p["last_ts"] and (lo is None or lo < p["silent_days"])
               and (hi is None or p["silent_days"] <= hi)]
        hit.sort(key=lambda p: -p["silent_days"])            # 越久没出现越靠前

        # 同时存入 buckets 数组（向后兼容）和扁平化键（易用性优化）
        bucket_data = {"label": label, "count": len(hit), "contacts": hit[:top]}
        buckets.append(bucket_data)

        # 扁平化键：within_30, 31_60, 61_90 等
        if lo == 0 or lo is None:
            key = f"within_{hi}"
        elif hi is None:
            key = f"{lo}_plus"
        else:
            key = f"{lo + 1}_{hi}"
        result[key] = bucket_data

    never = [p for p in people if not p["last_ts"]]
    never.sort(key=lambda p: p["name"])
    never_data = {"label": "通讯录里有、全库没有一句发言", "count": len(never),
                  "contacts": never[:top]}

    result.update({
        "buckets": buckets,  # 保留原有结构（向后兼容）
        "never": never_data,
        "note": ("每桶只列前 %d 人（看 count 总量）；每条给的是**原始时间戳**："
                 "`last_msg_*` 是我们私聊的最后一条、`last_spoke_*` 是 TA 在任何会话（含群）里"
                 "最后一次发言，两者不同属正常。本服务**不打分、不判意向**。" % top),
    })
    return result


def interaction_rank(since=0, until=0, top=20, sort="count"):
    """互动排行（只统计**本会话已有消息**的条数与最近时间）。

    `sort`：`count`（按条数）/ `recent`（按最近时间，久未联系的排前头）。
    """
    core._refresh()
    names = core.names()
    per = {}
    for shard in core._cache["msg"]:
        tables = core._cache["tables"].get(shard, ())
        if not tables:
            continue
        con = sqlite3.connect(shard)
        try:
            for tbl in tables:
                conds, params = [], []
                if since:
                    conds.append("create_time >= ?")
                    params.append(int(since))
                if until:
                    conds.append("create_time <= ?")
                    params.append(int(until))
                where = (" where " + " and ".join(conds)) if conds else ""
                row = con.execute(
                    f"select count(*), max(create_time) from [{tbl}]" + where, params).fetchone()
                if not row or not row[0]:
                    continue
                cur = per.get(tbl)
                cnt, last = row[0], row[1] or 0
                if cur is None:
                    per[tbl] = [cnt, last]
                else:
                    cur[0] += cnt
                    cur[1] = max(cur[1], last)
        finally:
            con.close()

    by_tbl = {tbl: tk for tbl, tk in core.talkers()}   # 复用共享层的表名↔会话约定，别自己再算一遍
    out = []
    for tbl, (cnt, last) in per.items():
        tk = by_tbl.get(tbl, tbl)
        out.append({"talker": tk, "name": names.get(tk, tk), "count": cnt,
                    "last_ts": last, "last": core._ts(last) if last else ""})
    key = (lambda d: d["last_ts"]) if sort == "recent" else (lambda d: d["count"])
    out.sort(key=key, reverse=(sort != "recent"))
    return out[:top]
