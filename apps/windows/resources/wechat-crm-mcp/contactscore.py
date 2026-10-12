"""C · 客户分析 —— 核心逻辑（纯取数，不出判断）。

只端上**确定性的清单与数字**：通讯录（好友/群/公众号/企业微信）、群成员、单会话互动统计、
互动排行。"这个客户意向高不高"是 LLM + 技能包的事，不在这里。

只读：不改动任何微信数据。

⚠️ **不做标签**：实测 `contact.db` 里只有 `contact_label`（5 个标签**名**），**没有**好友↔标签
映射表，疑似埋在 `contact.extra_buffer` 的 protobuf 里 —— 需逆向，留研究项。

⚠️ **群内昵称**：实测**在** `chat_room.ext_buffer` 里（能看到 `何建辰`/`魏雷` 这类群里称呼），
但字段语义未知；猜错会张冠李戴，所以本服务只给**全局显示名**（备注 > 昵称），留研究项。
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


def list_contacts(scope="friend", room=None, keyword="", include_deleted=False):
    """通讯录清单。

    `room` 给了就返回**该群成员**（此时忽略 scope）；否则按 `scope` 筛种类。
    `scope` ∈ friend / group / official / open / system / all。
    显示名取「备注 > 昵称 > username」。

    ⚠️ **必须先把所有会触发镜像刷新的调用做完，再开 sqlite 连接**：Windows 上无法替换一个
    仍被打开的文件，而 `core.resolve_talker/self_wxid` 会刷新 contact 镜像——持着连接去调
    会让 `os.replace` 抛 PermissionError（实测踩到）。
    """
    if room is not None:
        resolved = core.resolve_talker(room) or room
        me = core.self_wxid()
        con = sqlite3.connect(_contact_db())
        try:
            return _room_members(con, resolved, me)
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
    return out


def _room_members(con, resolved, me):
    """群成员（**全局显示名**；群内昵称需逆向，见模块头）。`resolved` 已是群 username。"""
    cid = con.execute("select id from contact where username=?", (resolved,)).fetchone()
    if not cid:
        return []
    disp = {u: (r or n or u) for u, r, n in
            con.execute("select username, remark, nick_name from contact")}
    out = []
    for (mid,) in con.execute("select member_id from chatroom_member where room_id=?", (cid[0],)):
        u = con.execute("select username from contact where id=?", (mid,)).fetchone()
        if not u or u[0] == me:
            continue
        out.append({"username": u[0], "name": disp.get(u[0], u[0]),
                    "kind": kind_of(u[0]), "is_me": False})
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
    """
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

    by_tbl = {core.tbl_of(u): u for u in names}
    out = []
    for tbl, (cnt, last) in per.items():
        tk = by_tbl.get(tbl, tbl)
        out.append({"talker": tk, "name": names.get(tk, tk), "count": cnt,
                    "last_ts": last, "last": core._ts(last) if last else ""})
    key = (lambda d: d["last_ts"]) if sort == "recent" else (lambda d: d["count"])
    out.sort(key=key, reverse=(sort != "recent"))
    return out[:top]
