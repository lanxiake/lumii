"""wechat_core —— 微信 4.x 本地数据只读读取（发现数据目录 / 取密钥 / 解密 / 查询）。

只用只读方式：进程内存只读扫描取密钥 + SQLCipher4 直读，不改动任何微信文件。
数据目录自动发现：`~/xwechat_files/<wxid>_<4hex>/db_storage`（可被环境变量 LUMII_WECHAT_DB 覆盖）。
"""
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import wxkey4  # noqa: E402
import wxread4  # noqa: E402

try:
    import zstandard as zstd
except Exception:  # pragma: no cover
    zstd = None

WORK = os.path.join(tempfile.gettempdir(), "lumii-wechat-mcp")
os.makedirs(WORK, exist_ok=True)

_cache = {"mtime": None, "msg": None, "contact": None, "root": None}


def deps():
    """依赖自检：报告关键第三方库是否就绪（不导入，避免副作用）。

    - `pycryptodome`（`Crypto`）：解密的硬依赖，缺失则**读取/发送全线不可用**。
    - `zstandard`：**可选**，缺失时压缩消息无法解码（会显示为乱码/二进制）。
    """
    import importlib.util as _iu
    found = {m: _iu.find_spec(m) is not None for m in ("Crypto", "zstandard")}
    return {"pycryptodome": found["Crypto"], "zstandard": found["zstandard"],
            "ok": found["Crypto"]}


def list_accounts():
    """枚举本机微信 4.x 账号数据目录：`[{wxid, dir, root, mtime}]`（按最近修改倒序）。

    多路径探测策略（按优先级）：
    1. ~/xwechat_files（默认）
    2. ~/Documents/xwechat_files（常见重定向）
    3. 注册表/微信进程探测（终极兜底）
    """
    out = []
    # 候选路径：优先用户目录，再 Documents，最后全盘扫描（限 Windows）
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, "xwechat_files"),
        os.path.join(home, "Documents", "xwechat_files"),
    ]
    # Windows 下额外探测：从注册表/进程取微信数据路径
    if os.name == "nt":
        try:
            import winreg
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Tencent\WeChat", 0, winreg.KEY_READ)
            val, _ = winreg.QueryValueEx(key, "FileSavePath")
            winreg.CloseKey(key)
            if val and os.path.isdir(val):
                candidates.append(os.path.join(val, "xwechat_files"))
        except Exception:
            pass

    for base in candidates:
        if not os.path.isdir(base):
            continue
        for name in os.listdir(base):
            d = os.path.join(base, name, "db_storage")
            msg = os.path.join(d, "message", "message_0.db")
            if os.path.isfile(msg):
                out.append({"wxid": name.rsplit("_", 1)[0], "dir": name, "root": d,
                            "mtime": os.path.getmtime(msg)})
    out.sort(key=lambda r: r["mtime"], reverse=True)
    return out


def db_root():
    """定位微信 4.x 数据目录（含 message/message_0.db）。

    选择优先级：`LUMII_WECHAT_DB`（显式路径）> `LUMII_WECHAT_ACCOUNT`（指定 wxid/目录名）>
    最近修改的账号（多账号并存时取活跃度最高的那个）。

    **改进点**：探测失败时给出可操作的错误提示（含候选路径、修复建议）。
    """
    env = os.environ.get("LUMII_WECHAT_DB")
    if env and os.path.isfile(os.path.join(env, "message", "message_0.db")):
        return env
    accts = list_accounts()
    want = os.environ.get("LUMII_WECHAT_ACCOUNT")
    if want:
        for a in accts:
            if a["wxid"] == want or a["dir"] == want:
                return a["root"]
        avail = "、".join(a["wxid"] for a in accts) if accts else "（无）"
        raise RuntimeError(f"LUMII_WECHAT_ACCOUNT={want} 未匹配到账号数据目录。可选账号：{avail}")
    if not accts:
        # 给出可操作的错误提示
        home = os.path.expanduser("~")
        hint = f"未找到微信 4.x 数据目录。已扫描路径：\n  - {home}/xwechat_files\n  - {home}/Documents/xwechat_files"
        if os.name == "nt":
            hint += "\n\n修复建议：\n1. 确认微信已登录并有聊天记录\n2. 若数据在其他位置，设置环境变量：\n   LUMII_WECHAT_DB=D:\\path\\to\\xwechat_files\\wxid_xxx\\db_storage"
        raise RuntimeError(hint)
    return accts[0]["root"]


def self_wxid(root=None):
    """从数据目录名 `<wxid>_<4hex>` 推出本人 wxid。"""
    root = root or db_root()
    return os.path.basename(os.path.dirname(root)).rsplit("_", 1)[0]


def keys(root=None):
    root = root or db_root()
    files, s2d = wxkey4.collect_db_files(root)
    km, rem = {}, set(s2d)
    for _m, pid in wxkey4.find_wechat_pids():
        if not rem:
            break
        wxkey4.scan_pid(pid, files, s2d, km, rem)
    return km


def _sqlite_ok(path):
    """quick_check 通过才算可用（WAL 重放可能产出坏库，必须回退）。"""
    try:
        c = sqlite3.connect(path)
        row = c.execute("pragma quick_check").fetchone()
        c.close()
        return bool(row) and row[0] == "ok"
    except Exception:
        return False


def _plain(km, root, rel):
    """解密并尽力重放 WAL —— 微信新消息常先落在 `-wal` 里，只读主库会读到旧数据。"""
    key = next(k for s, (k, r) in km.items() if r.replace("\\", "/").lower() == rel.lower())
    enc = bytes.fromhex(key)
    src = os.path.join(root, rel.replace("/", os.sep))
    dst = os.path.join(WORK, os.path.basename(rel) + ".copy")
    for sfx in ("", "-wal", "-shm"):          # WAL 必须连 -wal/-shm 一起复制
        if os.path.exists(src + sfx):
            shutil.copy2(src + sfx, dst + sfx)
    salt = open(dst, "rb").read(16)
    mac = wxread4.derive_mac_key(enc, salt)
    pages, _ = wxread4.read_main(dst, enc, mac)
    best = pages
    try:
        if os.path.exists(dst + "-wal") and os.path.getsize(dst + "-wal") > 32:
            wal_pages = list(pages)
            applied, _failed, dbsize = wxread4.apply_wal(dst + "-wal", wal_pages, enc, mac)
            # ⚠️ 双重护栏：
            # ① 陈旧 WAL 会把库**读旧**（实测：重放后群行消失/改名回退）——WAL 提交后的页数
            #    小于主库页数即判陈旧，弃用（对齐 chatlog v4 的 dbsize 判据）；
            # ② 重放结果必须过 quick_check。
            fresh = dbsize is not None and dbsize >= len(pages)
            if applied and fresh:
                try_path = os.path.join(WORK, "try_" + os.path.basename(rel))
                open(try_path, "wb").write(b"".join(wal_pages))
                if _sqlite_ok(try_path):
                    best = wal_pages
    except Exception:
        pass
    out = os.path.join(WORK, "plain_" + os.path.basename(rel))
    open(out, "wb").write(b"".join(best))
    return out


def _msg_shard_rels():
    """message_N.db 分片（**时间滚动**：0=最新、数字越大越旧）；按 N 升序。

    微信 4.x 会把消息按时间滚进多个分片（实测新号：0=2026、1=2025、2=2024~25初），
    只读 message_0.db 会漏掉绝大部分历史 —— 完整历史/语料必须**合并所有分片**。
    """
    root = db_root()
    d = os.path.join(root, "message")
    rels = [f"message/{n}" for n in os.listdir(d) if re.match(r"^message_\d+\.db$", n)]
    rels.sort(key=lambda r: int(re.search(r"(\d+)", os.path.basename(r)).group(1)))
    return rels


def _tables_in(path):
    """某分片里的 Msg_* 会话表名。"""
    c = sqlite3.connect(path)
    try:
        return [r[0] for r in c.execute(
            "select name from sqlite_master where type='table' and name like 'Msg_%'")]
    finally:
        c.close()


def _sender_map(path):
    """某分片的 `real_sender_id → user_name` 映射（`Msg_*.real_sender_id` 指向 `Name2Id.rowid`）。"""
    try:
        c = sqlite3.connect(path)
        m = {rowid: u for rowid, u in c.execute("select rowid, user_name from Name2Id")}
        c.close()
        return m
    except Exception:
        return {}


def _refresh():
    root = db_root()
    rels = _msg_shard_rels()
    key = (root,) + tuple(os.path.getmtime(os.path.join(root, r.replace("/", os.sep))) for r in rels)
    if _cache["mtime"] == key and _cache["msg"] and _cache["root"] == root:
        return
    km = keys(root)
    _cache["msg"] = [_plain(km, root, r) for r in rels]   # 各分片的明文副本（列表）
    _cache["tables"] = {p: set(_tables_in(p)) for p in _cache["msg"]}
    _cache["senders"] = {p: _sender_map(p) for p in _cache["msg"]}
    _cache["contact"] = _plain(km, root, "contact/contact.db")
    _cache["mtime"] = key
    _cache["root"] = root


def names():
    """{wxid/群号/filehelper: 显示名}（备注 > 昵称 > 原始 id）。
    未命名群（contact 里没存名字）用「成员显示名以、连接（排除自己）」还原成微信 UI 的显示名。"""
    _refresh()
    me = self_wxid()
    m = {me: "我"}
    id_disp = {}          # contact.id -> (username, 显示名)
    room_cid = {}         # 群 username -> contact.id
    try:
        c = sqlite3.connect(_cache["contact"])
        for cid, username, nick, remark in c.execute("select id, username, nick_name, remark from contact"):
            disp = remark or nick or username
            m[username] = disp
            id_disp[cid] = (username, remark or nick)
            room_cid[username] = cid
        members = {}
        for rid, mid in c.execute("select room_id, member_id from chatroom_member"):
            members.setdefault(rid, []).append(mid)
        c.close()
        for username, disp in list(m.items()):
            if username.endswith("@chatroom") and disp == username:  # 未命名群
                parts = []
                for mid in members.get(room_cid.get(username), []):
                    u, d = id_disp.get(mid, (None, None))
                    if u and u != me and d:
                        parts.append(d)
                if parts:
                    m[username] = "、".join(parts)
    except Exception:
        pass
    return m


def group_members(talker):
    """群成员的**显示名**列表（不含自己）；非群或读取失败返回 []。

    用途：P2-4 群/单聊结构判别——群里「某人发言」会在消息上方出现**其昵称独立行**；
    用成员显示名去聊天区 OCR 里找这种独立行，可判断「打开的确实是这个群」。
    """
    if not str(talker).endswith("@chatroom"):
        return []
    _refresh()
    me = self_wxid()
    try:
        c = sqlite3.connect(_cache["contact"])
        rows = list(c.execute("select id, username, nick_name, remark from contact"))
        c.close()
    except Exception:
        return []
    cid_of = {u: cid for cid, u, _n, _r in rows}
    user_of = {cid: u for cid, u, _n, _r in rows}
    disp_of = {cid: (r or n or u) for cid, u, n, r in rows}
    rid = cid_of.get(talker)
    if rid is None:
        return []
    out = []
    try:
        c = sqlite3.connect(_cache["contact"])
        for (mid,) in c.execute("select member_id from chatroom_member where room_id=?", (rid,)):
            u = user_of.get(mid)
            if u and u != me and disp_of.get(mid):
                out.append(disp_of[mid])
        c.close()
    except Exception:
        pass
    return out


def tbl_of(talker):
    return "Msg_" + hashlib.md5(talker.encode()).hexdigest()

def talkers():
    """[(表名, talker)]，**所有分片**里出现过的会话（去重保序）。"""
    _refresh()
    nm = names()
    by_tbl = {tbl_of(u): u for u in nm}
    seen = {}
    for p in _cache["msg"]:
        for t in _cache["tables"].get(p, ()):
            seen.setdefault(t, None)
    return [(t, by_tbl.get(t, t)) for t in seen]


def decode(b):
    raw = b if isinstance(b, bytes) else str(b).encode()
    if zstd and raw[:4] == b"\x28\xb5\x2f\xfd":
        try:
            raw = zstd.ZstdDecompressor().decompress(raw, max_output_size=1 << 20)
        except Exception:
            pass
    return raw.decode("utf-8", "replace")


def _rows(tbl, limit, since=0, before=0):
    """**跨分片**取会话消息：各分片同条件查询后按时间倒序合并，取前 limit 条。"""
    _refresh()
    conds, params = [], []
    if since:
        conds.append("create_time > ?")
        params.append(since)
    if before:
        conds.append("create_time < ?")
        params.append(before)
    where = (" where " + " and ".join(conds)) if conds else ""
    q = (f"select create_time, local_type, message_content from [{tbl}]"
         + where + " order by create_time desc limit ?")
    rows = []
    for p in _cache["msg"]:
        if tbl not in _cache["tables"].get(p, ()):
            continue
        c = sqlite3.connect(p)
        try:
            rows.extend(c.execute(q, params + [limit]))
        except Exception:
            pass
        finally:
            c.close()
    rows.sort(key=lambda r: r[0], reverse=True)
    return rows[:limit]


def msg_dict(ct, lt, content, nm, talker=None, name=None, sender=None, me=None):
    t = decode(content).replace("\n", " ").strip()
    if t.startswith("<"):
        t = "[非文本消息]"
    d = {"time": _ts(ct), "ts": ct, "type": lt & 0xFFFFFFFF, "text": t[:400]}
    if talker is not None:
        d["talker"] = talker
        d["name"] = name
    if sender is not None:                    # 发送者（real_sender_id 判定）；用于蒸馏分辨双方
        d["from_me"] = (sender == me) if sender else False
        d["sender"] = ("我" if sender == me else nm.get(sender, sender)) if sender else "(未知)"
    return d


def _ts(ct):
    import time as _t
    return _t.strftime("%Y-%m-%d %H:%M:%S", _t.localtime(ct))


def sessions():
    nm = names()
    out = []
    for tbl, talker in talkers():
        rows = _rows(tbl, 1)
        last = decode(rows[0][2]).replace("\n", " ").strip()[:80] if rows else ""
        out.append({"talker": talker, "name": nm.get(talker, talker), "last": last})
    out.sort(key=lambda r: r["name"])
    return out


def history(talker, limit=20, before_ts=0):
    """读历史（时间正序）。`before_ts` 取更早一页：只返回 create_time 严格小于它的消息。

    返回带 `cursor`（本页最老一条的 ts）与 `has_more`，Agent 可用 `before_ts=cursor` 翻更早的页。
    """
    nm = names()
    me = self_wxid()
    rows = _rows_full(tbl_of(talker), limit, before=before_ts)
    msgs = [msg_dict(ct, lt, c, nm, sender=s, me=me) for ct, lt, c, s in reversed(rows)]
    out = {"talker": talker, "name": nm.get(talker, talker), "count": len(msgs), "messages": msgs}
    if msgs:
        out["cursor"] = msgs[0]["ts"]          # 本页最老一条，供取更早一页
        out["has_more"] = len(rows) >= limit
    return out


def poll(since_ts, per=20):
    nm = names()
    out = []
    for tbl, talker in talkers():
        for ct, lt, c in _rows(tbl, per, since=int(since_ts or 0)):
            out.append(msg_dict(ct, lt, c, nm, talker=talker, name=nm.get(talker, talker)))
    out.sort(key=lambda d: d["ts"])
    return {"count": len(out), "messages": out}


def resolve_talker(query):
    """把显示名 / wxid / 群号解析成 talker。**严格**：只有唯一确定才返回，否则 None。

    安全要点（踩过事故）：**绝不做「短名嵌在长查询里」的宽松匹配**——
    查询「TOOLAN、韩玉」含子串「TOOLAN」，宽松匹配会命中好友 TOOLAN，导致**发错人**。
    所以：精确匹配 → 唯一候选的「查询是名字的子串」→ 否则一律 None（宁可不发，由上层报错让 Agent 重问）。
    """
    if not query:
        return None
    q = str(query).strip()
    nm = names()
    talks = {t for _, t in talkers()}
    if q in nm or q in talks:
        return q
    exact = [u for u, d in nm.items() if d == q]
    if len(exact) == 1:
        return exact[0]
    # 模糊：仅当「查询是名字的子串」（用户只打了名字的一部分）且**候选唯一**时才采用
    cands = set()
    if len(q) >= 2:
        cands |= {u for u, d in nm.items() if d and q in d}
    if len(q) >= 5:
        cands |= {t for t in talks if q in t}
    if len(cands) == 1:
        return next(iter(cands))
    return None


# ---------- P1：消息检索 / 未读 ----------
_sess_cache = {"mtime": None, "path": None}


def _session_plain():
    root = db_root()
    src = os.path.join(root, "session", "session.db")
    mt = os.path.getmtime(src)
    if _sess_cache["mtime"] != mt or not _sess_cache["path"]:
        _sess_cache["path"] = _plain(keys(root), root, "session/session.db")
        _sess_cache["mtime"] = mt
    return _sess_cache["path"]


def search_messages(keyword, talker=None, since=0, until=0, limit=50, scan=3000):
    """按关键词检索消息（跨会话或指定会话；支持时间范围，**跨全部分片**）。逐条解码匹配。"""
    _refresh()
    nm = names()
    me = self_wxid()
    pairs = [(talker, tbl_of(talker))] if talker else [(t, tbl) for tbl, t in talkers()]
    hits = []
    for t, tbl in pairs:
        try:
            rows = _rows_full(tbl, scan)
        except Exception:
            continue
        for ct, lt, content, s in rows:
            if since and ct <= since:
                continue
            if until and ct >= until:
                continue
            if keyword in decode(content):
                hits.append(msg_dict(ct, lt, content, nm, talker=t, name=nm.get(t, t), sender=s, me=me))
    hits.sort(key=lambda d: d["ts"], reverse=True)
    return {"keyword": keyword, "count": len(hits), "scanned_per_talker": scan, "messages": hits[:limit]}


def unread():
    """未读会话（读 session.db 的 unread_count），附最近一条预览。"""
    nm = names()
    try:
        c = sqlite3.connect(_session_plain())
        users = [r[0] for r in c.execute("select username from SessionTable where unread_count > 0")]
        c.close()
    except Exception as e:
        return {"count": 0, "sessions": [], "error": f"session.db 读取失败: {e}"}
    out = []
    for u in users:
        try:                      # session.db 里的会话未必在 message_0.db 有消息表
            msgs = history(u, 1).get("messages") or []
            last = msgs[-1]["text"][:80] if msgs else ""
        except Exception:
            last = ""
        out.append({"talker": u, "name": nm.get(u, u), "last": last})
    return {"count": len(out), "sessions": out}


# ---------- P0：用户/好友知识与行为蒸馏（确定性、只读、本地）----------
_STOP = {"的", "了", "是", "我", "你", "他", "她", "它", "在", "就", "都", "和", "也", "这", "那",
         "不", "有", "要", "会", "吗", "呢", "啊", "吧", "嗯", "一个", "我们", "你们", "他们",
         "the", "a", "an", "and", "to", "of", "is", "in", "it", "for", "on", "you", "that",
         "this", "with", "at", "be", "are", "was", "s", "t", "re", "ve", "ll", "don"}


def _rows_full(tbl, limit, since=0, before=0):
    """跨分片取会话消息（带发送者 user_name）：[(create_time, local_type, content, sender)]。"""
    _refresh()
    conds, params = [], []
    if since:
        conds.append("create_time > ?")
        params.append(since)
    if before:
        conds.append("create_time < ?")
        params.append(before)
    where = (" where " + " and ".join(conds)) if conds else ""
    q = (f"select create_time, local_type, message_content, real_sender_id from [{tbl}]"
         + where + " order by create_time desc limit ?")
    out = []
    for p in _cache["msg"]:
        if tbl not in _cache["tables"].get(p, ()):
            continue
        smap = _cache["senders"].get(p, {})
        c = sqlite3.connect(p)
        try:
            for ct, lt, content, sid in c.execute(q, params + [limit]):
                out.append((ct, lt, content, smap.get(sid, "")))
        except Exception:
            pass
        finally:
            c.close()
    out.sort(key=lambda r: r[0], reverse=True)
    return out[:limit]


def _tokens(t):
    return [w for w in re.findall(r"[A-Za-z]{2,}|[一-鿿]{2,}", t) if w.lower() not in _STOP]


def digest(talker=None, limit=500, samples=6, top=15, since=0):
    """蒸馏「行为与语料」：全局（`talker` 为空）或指定会话；`since` 只统计该 Unix 秒之后的（**增量蒸馏**）。

    **确定性**：只用本地库统计（**不调用 LLM、不外传**），返回结构化 digest（统计 + 代表性样本），
    供上层（LLM 或模板）提炼成「用户画像 / 好友画像」。发送者判定用 `real_sender_id`（精确）。
    """
    _refresh()
    me = self_wxid()
    nm = names()
    pairs = [(talker, tbl_of(talker))] if talker else [(t, tbl) for tbl, t in talkers()]
    hour = [0] * 24
    by_type, words = {}, {}
    my_lens, my_samples = [], []
    per_contact = {}
    total = from_me = 0
    for t, tbl in pairs:
        rows = _rows_full(tbl, limit, since=since)
        tot = fm = ft = 0
        first = last = 0
        sm_me, sm_them = [], []
        for ct, lt, content, sender in rows:
            body = decode(content).strip()
            is_me = (sender == me)
            tot += 1
            total += 1
            fm += 1 if is_me else 0
            ft += 0 if is_me else 1
            from_me += 1 if is_me else 0
            if ct:
                first = ct if not first else min(first, ct)
                last = max(last, ct)
            ty = lt & 0xFFFFFFFF
            by_type[ty] = by_type.get(ty, 0) + 1
            if ty == 1 and body and not body.startswith("<"):     # 纯文本
                if is_me:
                    my_lens.append(len(body))
                    hour[time.localtime(ct).tm_hour] += 1
                    if len(sm_me) < samples:
                        sm_me.append(body[:80])
                    if len(my_samples) < samples * 4:
                        my_samples.append(body[:80])
                    for w in _tokens(body):
                        words[w] = words.get(w, 0) + 1
                elif len(sm_them) < samples:
                    sm_them.append(body[:80])
        if tot:
            per_contact[t] = {"talker": t, "name": nm.get(t, t), "total": tot,
                              "from_me": fm, "from_them": ft, "first_ts": first, "last_ts": last,
                              "sample_from_me": sm_me, "sample_from_them": sm_them}
    top_words = sorted(words.items(), key=lambda kv: -kv[1])[:top]
    top_contacts = sorted(({"talker": k, "name": v["name"], "sent": v["from_me"]}
                           for k, v in per_contact.items()), key=lambda d: -d["sent"])[:top]
    return {
        "scope": talker or "all",
        "generated_at": int(time.time()),
        "shards": len(_cache["msg"]),
        "scanned_per_talker": limit,
        "since": since,
        "self": {"total": total, "from_me": from_me, "from_others": total - from_me,
                 "by_type": by_type, "hour_hist": hour,
                 "avg_len": round(sum(my_lens) / len(my_lens), 1) if my_lens else 0,
                 "top_contacts": top_contacts},
        "top_words": [{"word": w, "n": n} for w, n in top_words],
        "contacts": sorted(per_contact.values(), key=lambda d: -d["total"])[:top],
        "contacts_total": len(per_contact),
        "samples_from_me": my_samples,
    }


# ---------- P1：画像落盘 / 读取（白盒 Markdown，本地，可一键删）----------
DISTILL_DIR = os.path.join(os.path.expanduser("~"), ".lumii", "wechat-distill")


def _safe_name(s):
    return re.sub(r"[^0-9A-Za-z_@.\-]", "_", str(s))[:80] or "scope"


def profile_dir():
    """画像/状态目录。可用 `LUMII_WECHAT_DISTILL` 覆盖（测试用它指向临时目录，**别动用户真实数据**）。"""
    d = os.environ.get("LUMII_WECHAT_DISTILL") or DISTILL_DIR
    os.makedirs(os.path.join(d, "contacts"), exist_ok=True)
    return d


def _profile_path(scope):
    if not scope or scope in ("self", "me", "我"):
        return os.path.join(profile_dir(), "self.md")
    return os.path.join(profile_dir(), "contacts", _safe_name(scope) + ".md")


def profile_save(scope, content):
    """写入画像 Markdown（`scope` 空/self → **用户画像**；否则该会话的**好友/群画像**）。返回路径。

    文件头写 `updated=`（供"定期重合成/过期"判断）；正文由上层（Agent/LLM）产出、**白盒可编辑**。
    """
    p = _profile_path(scope)
    if os.path.isfile(p):                 # 稳定性：留上一版（`<name>.md.prev`），防误覆盖、可回滚比对
        try:
            shutil.copy2(p, p + ".prev")
        except Exception:
            pass
    head = f"<!-- wechat-distill scope={scope or 'self'} updated={_ts(int(time.time()))} -->\n"
    open(p, "w", encoding="utf-8").write(head + (content or "").rstrip() + "\n")
    return p


def profile_get(scope=None):
    """读画像：给 `scope` 返回该画像内容 + `updated`/`age_days`/`stale`（**过期提示**）；否则列出已产出的画像文件。"""
    d = profile_dir()
    if scope:
        p = _profile_path(scope)
        ok = os.path.isfile(p)
        content = open(p, encoding="utf-8").read() if ok else ""
        m = re.search(r"updated=(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})", content)
        age = None
        if m:
            try:
                age = round((time.time() - time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S"))) / 86400, 1)
            except Exception:
                age = None
        return {"scope": scope, "path": p, "exists": ok, "content": content,
                "updated": m.group(1) if m else None, "age_days": age,
                "stale": bool(age is not None and age >= 30)}     # ≥30 天提示 Agent 重新蒸馏
    files = []
    for root, _dirs, fs in os.walk(d):
        for f in fs:
            if f.endswith(".md"):
                files.append(os.path.relpath(os.path.join(root, f), d).replace("\\", "/"))
    return {"dir": d, "files": sorted(files)}


def _state_path():
    return os.path.join(profile_dir(), "state.json")


def distill_state(scope=None):
    """读蒸馏**水位**（`state.json`）：给 `scope` 返回其水位 ts（下次增量只处理该 ts 之后的消息）；不给则返回全部。"""
    p = _state_path()
    data = {}
    try:
        if os.path.isfile(p):
            data = json.loads(open(p, encoding="utf-8").read())
    except Exception:
        data = {}
    key = scope or "self"
    return {"state_path": p, "scope": key, "since": int(data.get(key, 0) or 0), "all": data}


def set_distill_state(scope, ts):
    """写蒸馏水位（供**增量蒸馏**：下次只处理该 ts 之后的新消息）。"""
    p = _state_path()
    data = {}
    try:
        if os.path.isfile(p):
            data = json.loads(open(p, encoding="utf-8").read())
    except Exception:
        data = {}
    data[scope or "self"] = int(ts)
    open(p, "w", encoding="utf-8").write(json.dumps(data, ensure_ascii=False, indent=2))
    return {"ok": True, "state_path": p, "scope": scope or "self", "since": int(ts)}


def distill_clear(scope=None, everything=False):
    """**一键清除**蒸馏产物（隐私硬约束）。给 `scope` 清该画像（含 `.prev` 备份与该 scope 水位）；
    `everything=True` 才清空整个产出目录。两者都不给 → 拒绝（避免误清）。"""
    d = profile_dir()
    removed = []
    if scope:
        p = _profile_path(scope)
        for f in (p, p + ".prev"):
            if os.path.isfile(f):
                os.remove(f)
                removed.append(os.path.relpath(f, d))
        sp = _state_path()
        try:
            data = json.loads(open(sp, encoding="utf-8").read()) if os.path.isfile(sp) else {}
        except Exception:
            data = {}
        if scope in data:
            data.pop(scope)
            open(sp, "w", encoding="utf-8").write(json.dumps(data, ensure_ascii=False, indent=2))
            removed.append("state.json:" + scope)
    elif everything:
        shutil.rmtree(d, ignore_errors=True)
        removed.append("(整个 " + d + ")")
    else:
        return {"ok": False, "error_code": "bad_args",
                "error": "需给 scope 清除单个画像，或显式 everything=true 清空全部（防误清）"}
    return {"ok": True, "removed": removed, "dir": d}
