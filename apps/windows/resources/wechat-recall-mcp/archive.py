"""D · 撤回防护 —— 归档库（SQLite）与撤回判定。

**为什么需要归档**：实测（2026-10-12）撤回后原消息行**从微信库里消失**，且 revokemsg 里
**没有 `newmsgid`**——连"撤回的是哪条"都指不出来。所以撤回查看**只能靠事前留存**：
守护进程持续把新消息灌进本地归档库，撤回后再拿归档与当前库对差。

**判定规则**（对两种撤回机制都成立——删行 / 原地改写）：
按 `(talker, local_id)` 分组，比较归档与当前库的**内容变体集合**：
- 归档有、当前完全没有该 local_id → 被删/撤回（`deleted`）
- 变体集合不同，且当前变体是系统消息 → `recalled`
- 变体集合不同，其它 → `changed`

`INSERT OR IGNORE` + `(talker, local_id, create_time)` 主键：**归档只写一次、永不覆盖**，
所以撤回发生后归档里留着的仍是**原文**。`create_time` 进主键是为了容错——
同一 `local_id` 在跨分片时理论上可能属于不同消息，进主键后是两条互不干扰的行。
"""
import hashlib
import os
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
_SHARED = os.path.join(os.path.dirname(HERE), "wechat-mcp")   # 共享基础层（零复制）
if _SHARED not in sys.path:
    sys.path.insert(0, _SHARED)

import wechat_core as core  # noqa: E402

SYSTEM_LT = 10000

_SCHEMA = """
CREATE TABLE IF NOT EXISTS msg (
  talker       TEXT    NOT NULL,
  local_id     INTEGER NOT NULL,
  create_time  INTEGER NOT NULL,
  local_type   INTEGER NOT NULL,
  sender       TEXT,
  content      BLOB,
  first_seen   INTEGER NOT NULL,
  PRIMARY KEY (talker, local_id, create_time)
);
CREATE INDEX IF NOT EXISTS idx_msg_ct ON msg(create_time);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS gap (start_ts INTEGER, end_ts INTEGER);
"""


def db_path():
    return os.environ.get("LUMII_WECHAT_RECALL_DB") or os.path.join(
        os.path.expanduser("~"), ".lumii", "wechat-recall", "archive.db")


def connect(path=None):
    path = path or db_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    con = sqlite3.connect(path, timeout=15)
    con.executescript(_SCHEMA)
    return con


# ---- meta（水位 / 心跳 / 打底标记）----

def meta_get(con, key, default=None):
    row = con.execute("select v from meta where k=?", (key,)).fetchone()
    return row[0] if row else default


def meta_set(con, key, value):
    con.execute("insert into meta(k,v) values(?,?) on conflict(k) do update set v=excluded.v",
                (key, str(value)))
    con.commit()


# ---- 写入 ----

def capture(con, rows, seen_ts=None):
    """把 `(talker, local_id, create_time, local_type, sender, content)` 灌进归档库。

    `INSERT OR IGNORE`：**已归档的行永不覆盖**——这是撤回能还原的前提（撤回后归档里留的仍是原文）。
    返回实际新增条数。
    """
    seen_ts = int(seen_ts or time.time())
    before = con.total_changes
    con.executemany(
        "insert or ignore into msg(talker, local_id, create_time, local_type, sender, content, first_seen)"
        " values(?,?,?,?,?,?,?)",
        [(t, int(lid), int(ct), int(lt), s, c, seen_ts) for t, lid, ct, lt, s, c in rows])
    con.commit()
    return con.total_changes - before


def watermark(con):
    """归档里最新的 create_time（增量扫描起点）。空库返回 0。"""
    row = con.execute("select max(create_time) from msg").fetchone()
    return int(row[0]) if row and row[0] else 0


# ---- 从微信库取行 ----

def live_rows(since=0, talker=None):
    """当前微信库里**所有分片**的消息行（只读）。

    生成 `(talker, local_id, create_time, local_type, sender, content)`。
    `local_id` 实测在每个会话内唯一（70 个表零重复），跨分片理论可撞——所以下游按内容变体
    集合比对，而不是简单按 local_id 覆盖。
    """
    core._refresh()
    targets = {core.tbl_of(talker): talker} if talker else {t: tk for t, tk in core.talkers()}
    for shard in core._cache["msg"]:
        smap = core._cache["senders"].get(shard, {})
        tables = [t for t in core._cache["tables"].get(shard, ()) if t in targets]
        if not tables:
            continue
        con = sqlite3.connect(shard)
        try:
            for tbl in tables:
                where, params = "", []
                if since:
                    where, params = " where create_time > ?", [int(since)]
                sql = ("select local_id, create_time, local_type, real_sender_id, message_content"
                       f" from [{tbl}]" + where)
                for lid, ct, lt, sid, content in con.execute(sql, params):
                    yield (targets[tbl], lid, ct, lt & 0xFFFFFFFF, smap.get(sid, ""), content)
        finally:
            con.close()


def _hash(content):
    if content is None:
        return ""
    raw = content if isinstance(content, (bytes, bytearray)) else str(content).encode()
    return hashlib.md5(raw).hexdigest()


def _variants(rows):
    """`{(talker, local_id): {(create_time, hash, local_type)}}`。"""
    out = {}
    for talker, lid, ct, lt, _sender, content in rows:
        out.setdefault((talker, lid), set()).add((int(ct), _hash(content), int(lt)))
    return out


def _safe_names():
    """会话显示名；**读不到也不影响判定**（单测/无库环境下退回 talker 原值）。"""
    try:
        return core.names()
    except Exception:
        return {}


def find_recalls(con, talker=None, since=0, until=0, limit=500):
    """归档 ∩ 当前库 的**差集** = 被撤回/删除的消息。

    ⚠️ ponytail: 当前库侧**全量拉进内存**比对（几万条量级没问题）。到十万级再改成
    按 `(talker, local_id)` 分块流式比对 + 只拉窗口内的 talker。
    """
    conds, params = [], []
    if talker:
        conds.append("talker = ?")
        params.append(talker)
    if since:
        conds.append("create_time >= ?")
        params.append(int(since))
    if until:
        conds.append("create_time <= ?")
        params.append(int(until))
    where = (" where " + " and ".join(conds)) if conds else ""
    sql = ("select talker, local_id, create_time, local_type, sender, content from msg"
           + where + " order by create_time desc")
    archived = list(con.execute(sql, params))
    if not archived:
        return []

    # 只拉归档涉及到的 talker 的当前库行（给定 talker 时更窄）
    involved = {a[0] for a in archived}
    live = _variants([r for r in live_rows() if r[0] in involved])

    names = _safe_names()
    out = []
    for atalk, lid, act, alt, asender, acontent in archived:
        cur = live.get((atalk, lid))
        if cur is None:
            reason = "deleted"
        else:
            if (int(act), _hash(acontent), int(alt)) in cur:
                continue                                   # 原文仍在 → 没被撤
            reason = "recalled" if all(v[2] == SYSTEM_LT for v in cur) else "changed"
        out.append({"talker": atalk, "name": names.get(atalk, atalk), "local_id": lid,
                    "create_time": act, "time": core._ts(act), "sender": asender,
                    "type": alt, "reason": reason,
                    "text": _render(alt, acontent)})
        if len(out) >= limit:
            break
    return out


def _render(lt, content):
    try:
        return core._render(int(lt), content)
    except Exception:
        return ""


def read_recall(con, talker, local_id):
    """取一条归档消息的**完整原文**（用于看被撤回的内容）。取不到返回 None。"""
    row = con.execute(
        "select create_time, local_type, sender, content from msg"
        " where talker=? and local_id=? order by create_time desc limit 1",
        (talker, int(local_id))).fetchone()
    if not row:
        return None
    ct, lt, sender, content = row
    return {"talker": talker, "name": _safe_names().get(talker, talker), "local_id": int(local_id),
            "create_time": ct, "time": core._ts(ct), "sender": sender, "type": lt,
            "text": _render(lt, content)}


def gaps(con):
    return [{"start_ts": s, "end_ts": e, "start": core._ts(s), "end": core._ts(e)}
            for s, e in con.execute("select start_ts, end_ts from gap order by start_ts")]


def stats(con):
    total = con.execute("select count(*) from msg").fetchone()[0]
    talkers = con.execute("select count(distinct talker) from msg").fetchone()[0]
    return {"archived": total, "talkers": talkers,
            "first_seen": meta_get(con, "first_seen"), "last_tick": meta_get(con, "last_tick"),
            "watermark": watermark(con), "backfilled": meta_get(con, "backfilled") == "1"}
