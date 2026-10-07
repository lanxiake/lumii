"""wechat_core —— 微信 4.x 本地数据只读读取（发现数据目录 / 取密钥 / 解密 / 查询）。

只用只读方式：进程内存只读扫描取密钥 + SQLCipher4 直读，不改动任何微信文件。
数据目录自动发现：`~/xwechat_files/<wxid>_<4hex>/db_storage`（可被环境变量 LUMII_WECHAT_DB 覆盖）。
"""
import hashlib
import os
import shutil
import sqlite3
import sys
import tempfile

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
    """枚举本机微信 4.x 账号数据目录：`[{wxid, dir, root, mtime}]`（按最近修改倒序）。"""
    base = os.path.join(os.path.expanduser("~"), "xwechat_files")
    out = []
    if os.path.isdir(base):
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
        raise RuntimeError(f"LUMII_WECHAT_ACCOUNT={want} 未匹配到账号数据目录（可选："
                           + "、".join(a["wxid"] for a in accts) + "）")
    if not accts:
        raise RuntimeError("未找到微信 4.x 数据目录（~/xwechat_files/*/db_storage；"
                           "微信 3.x 的 `WeChat Files` 布局暂不支持）")
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


def _refresh():
    root = db_root()
    mt = os.path.getmtime(os.path.join(root, "message", "message_0.db"))
    if _cache["mtime"] == mt and _cache["root"] == root and _cache["msg"]:
        return
    km = keys(root)
    _cache["msg"] = _plain(km, root, "message/message_0.db")
    _cache["contact"] = _plain(km, root, "contact/contact.db")
    _cache["mtime"] = mt
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
    """[(表名, talker)]，本次库里出现过的会话。"""
    _refresh()
    c = sqlite3.connect(_cache["msg"])
    tables = [r[0] for r in c.execute(
        "select name from sqlite_master where type='table' and name like 'Msg_%'")]
    c.close()
    nm = names()
    by_tbl = {tbl_of(u): u for u in nm}
    return [(t, by_tbl.get(t, t)) for t in tables]


def decode(b):
    raw = b if isinstance(b, bytes) else str(b).encode()
    if zstd and raw[:4] == b"\x28\xb5\x2f\xfd":
        try:
            raw = zstd.ZstdDecompressor().decompress(raw, max_output_size=1 << 20)
        except Exception:
            pass
    return raw.decode("utf-8", "replace")


def _rows(tbl, limit, since=0, before=0):
    _refresh()
    c = sqlite3.connect(_cache["msg"])
    try:
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
        params.append(limit)
        return list(c.execute(q, params))
    finally:
        c.close()


def msg_dict(ct, lt, content, nm, talker=None, name=None):
    t = decode(content).replace("\n", " ").strip()
    if t.startswith("<"):
        t = "[非文本消息]"
    d = {"time": _ts(ct), "ts": ct, "type": lt & 0xFFFFFFFF, "text": t[:400]}
    if talker is not None:
        d["talker"] = talker
        d["name"] = name
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
    rows = _rows(tbl_of(talker), limit, before=before_ts)
    msgs = [msg_dict(ct, lt, c, nm) for ct, lt, c in reversed(rows)]
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
    """按关键词检索消息（跨会话或指定会话；支持时间范围）。逐条解码匹配，兼容压缩内容。"""
    _refresh()
    nm = names()
    pairs = [(talker, tbl_of(talker))] if talker else [(t, tbl) for tbl, t in talkers()]
    hits = []
    c = sqlite3.connect(_cache["msg"])
    try:
        for t, tbl in pairs:
            try:
                rows = c.execute(
                    f"select create_time, local_type, message_content from [{tbl}] "
                    "order by create_time desc limit ?", (scan,))
            except Exception:
                continue
            for ct, lt, content in rows:
                if since and ct <= since:
                    continue
                if until and ct >= until:
                    continue
                if keyword in decode(content):
                    hits.append(msg_dict(ct, lt, content, nm, talker=t, name=nm.get(t, t)))
    finally:
        c.close()
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
