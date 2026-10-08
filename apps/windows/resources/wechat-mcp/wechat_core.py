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
# 明文镜像**按进程隔离**：App 里的 MCP 子进程和命令行（devcli/测试）会同时读同一台机器，
# 共用一份镜像文件就会出现「一个进程正在重写、另一个正在读」的窗口。UI 锁/截图仍在 WORK
#（那个锁本来就该跨进程共享），只有镜像与解密副本挪进各自的子目录。
MIRROR_DIR = os.path.join(WORK, f"mirror-{os.getpid()}")
os.makedirs(MIRROR_DIR, exist_ok=True)

_cache = {"rels": None, "msg": None, "contact": None, "root": None}


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


KEY_TTL_S = 600
_key_cache = {}          # root -> (km, at)：取密钥要扫微信进程内存（实测本机 ~1.9s），
                         # 而密钥在微信重启前不变——不缓存的话每次全量重建都要白等两秒。


def keys(root=None, refresh=False):
    """取各库的 SQLCipher 密钥（只读扫描微信进程内存）。

    实测：本机一次约 1.9s，是整个「全量重建」里的绝对大头（解密 908 页才 30ms）。
    密钥在微信重启前不变 → 按 root 缓存 10 分钟；解密出现 HMAC 失败时会 `refresh=True`
    重取一次（微信重启换了密钥的情形）。
    """
    root = root or db_root()
    ent = _key_cache.get(root)
    if ent and not refresh and time.time() - ent[1] < KEY_TTL_S:
        return ent[0]
    files, s2d = wxkey4.collect_db_files(root)
    km, rem = {}, set(s2d)
    for _m, pid in wxkey4.find_wechat_pids():
        if not rem:
            break
        wxkey4.scan_pid(pid, files, s2d, km, rem)
    if not km:
        raise RuntimeError("未能从微信进程内存取到数据库密钥：微信可能没在运行、或刚重启。"
                           "请确认微信已登录并打开过聊天窗口后重试。")
    _key_cache[root] = (km, time.time())
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


def _plain(km, root, rel, _retry=True):
    """解密并尽力重放 WAL —— 微信新消息常先落在 `-wal` 里，只读主库会读到旧数据。

    ⚠️ 只保留给「全量重建」路径用；实时路径走 `_ShardMirror`（增量重放，见下）。
    """
    key = next(k for s, (k, r) in km.items() if r.replace("\\", "/").lower() == rel.lower())
    enc = bytes.fromhex(key)
    src = os.path.join(root, rel.replace("/", os.sep))
    dst = os.path.join(MIRROR_DIR, os.path.basename(rel) + ".copy")
    for sfx in ("", "-wal", "-shm"):          # WAL 必须连 -wal/-shm 一起复制
        if os.path.exists(src + sfx):
            shutil.copy2(src + sfx, dst + sfx)
        elif os.path.exists(dst + sfx):
            # ⚠️ 源里已经没有的（checkpoint 后 SQLite 会**删掉** -wal）必须把上一轮的旧副本清掉，
            # 否则会拿**过期副本**当这次的 WAL 重放——实测症状就是「群行消失/改名回退」（读旧）。
            os.remove(dst + sfx)
    salt = open(dst, "rb").read(16)
    mac = wxread4.derive_mac_key(enc, salt)
    pages, bad = wxread4.read_main(dst, enc, mac)
    if bad and _retry:
        # 整页 HMAC 不过 ⇒ 密钥大概率变了（微信重启后换了密钥）→ 重取一次密钥再来
        return _plain(keys(root, refresh=True), root, rel, _retry=False)
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
                try_path = os.path.join(MIRROR_DIR, "try_" + os.path.basename(rel))
                open(try_path, "wb").write(b"".join(wal_pages))
                if _sqlite_ok(try_path):
                    best = wal_pages
    except Exception:
        pass
    out = os.path.join(MIRROR_DIR, "plain_" + os.path.basename(rel))
    tmp = out + ".tmp"
    open(tmp, "wb").write(b"".join(best))
    os.replace(tmp, out)          # 写完再换名：任何时刻读到的都是完整的一份镜像
    return out


# ---------- 明文镜像（增量刷新）：把「读旧 / 读贵」两件事一起解决 ----------
# 微信是 WAL 模式：新消息**先落 `-wal`，主库文件常常不动**（只在 checkpoint 时才写）。
# 所以旧实现「只按主库 mtime 判缓存新鲜」有两个问题：
#   ① 静默读旧——两次 checkpoint 之间的新消息在这个键上完全不可见（轮询永远轮不到）；
#   ② 全量重解密——500MB 库一次要几十秒，做不了「盯着看」的实时轮询。
# `_ShardMirror`：主库或 -wal 任一变化都刷新；-wal 只解密**新增的提交帧**、原地打进明文镜像
#（一条新消息通常几帧 → 毫秒级）。任何异常（帧 HMAC 不过 / WAL 被重置截断 / quick_check 失败）
# 都退回全量重建——宁可慢一次，不可读错一次。
class _ShardMirror:
    """一个分片（`message/message_0.db`、`session/session.db`、`contact/contact.db`…）的明文镜像。"""

    def __init__(self, root, rel):
        self.root = root
        self.rel = rel
        self.src = os.path.join(root, rel.replace("/", os.sep))
        self.out = os.path.join(MIRROR_DIR, "plain_" + os.path.basename(self.src))  # 与 _plain 同约定
        self.st = None            # {"key", "wal_off", "salt", "pages"}
        self.version = 0          # 内容版本号：变了才需要上层重建 tables/senders
        self._tables, self._tables_v = set(), -1
        self._senders, self._senders_v = {}, -1
        self._keys = None

    # -- 新鲜度键：主库与 -wal 的 (mtime, size) 都要 --
    @staticmethod
    def _stat(p):
        try:
            s = os.stat(p)
            return (round(s.st_mtime, 6), s.st_size)
        except OSError:
            return None

    def key(self):
        return (self._stat(self.src), self._stat(self.src + "-wal"))

    # -- 对外：确保镜像最新；返回「内容是否变化」--
    def refresh(self):
        key = self.key()
        if self.st and self.st["key"] == key:
            return False
        # 主库没变、只有 -wal 变 → 走增量；主库变了（checkpoint）→ 必须全量
        if self.st and self.st["key"][0] == key[0]:
            ok, changed = self._incr(key)
            if ok:
                if changed:
                    self.version += 1
                return changed
        self._full(key)
        return True

    # -- 分片里的会话表 / 发送者映射（随版本缓存）--
    def tables(self):
        if self._tables_v != self.version:
            self._tables, self._tables_v = set(_tables_in(self.out)), self.version
        return self._tables

    def senders(self):
        if self._senders_v != self.version:
            self._senders, self._senders_v = _sender_map(self.out), self.version
        return self._senders

    # -- 密钥（enc, mac）：按需取、缓存；失败下次重建时会重取 --
    def _kmac(self):
        if self._keys is None:
            km = keys(self.root)
            k = next(k for s, (k, r) in km.items()
                     if r.replace("\\", "/").lower() == self.rel.lower())
            enc = bytes.fromhex(k)
            salt = open(self.src, "rb").read(16)
            self._keys = (enc, wxread4.derive_mac_key(enc, salt))
        return self._keys

    # -- 全量重建 --
    def _full(self, key):
        km = keys(self.root)
        self.out = _plain(km, self.root, self.rel)          # 复用带双重护栏的全量路径
        self.st = {"key": key, "wal_off": None, "salt": None, "pages": None}
        # 记录「当前 WAL 会话已消费到哪」，供之后的增量续读。
        # 关键：这里记的是**当前会话**（salt 一致）已提交到的偏移；没有提交帧就从 32 起
        #（WAL 刚被 checkpoint 重置时正是「新 salt + 0 帧」，此时 wal_off=32 表示
        # 「这条会话我一个还没消费」——对方接下来追加的第一帧就能被增量接上）。
        try:
            dst = os.path.join(MIRROR_DIR, os.path.basename(self.rel) + ".copy")
            w = open(dst + "-wal", "rb").read()
            if wxread4.wal_header_ok(w):
                frames, _off = wxread4.parse_wal_frames(w)
                last = wxread4.last_commit_index(frames)
                frame_bytes = wxread4.FRAME_HDR + wxread4.PAGE
                self.st["salt"] = wxread4.wal_salt(w)
                self.st["wal_off"] = 32 + (last + 1) * frame_bytes
                if last >= 0:
                    self.st["pages"] = frames[last][1]
        except Exception:
            pass
        self._keys = None
        self.version += 1

    # -- 增量：续读 -wal 里新出现的提交帧，原地打进明文镜像 --
    def _incr(self, key):
        st = self.st
        if not st or st.get("wal_off") is None or not st.get("salt"):
            return False, False
        try:
            w = open(self.src + "-wal", "rb").read()
        except OSError:
            return False, False
        if not wxread4.wal_header_ok(w) or wxread4.wal_salt(w) != st["salt"] \
                or len(w) < st["wal_off"]:
            return False, False                    # WAL 被重置 / 截断 → 退回全量
        frames, _off = wxread4.parse_wal_frames(w, start=st["wal_off"])
        last = wxread4.last_commit_index(frames)
        if last < 0:
            # 只有未提交的尾帧（对方正写到一半）：不动镜像，但记住新 stat 免得每次重读
            st["key"] = key
            return True, False
        dbsize = frames[last][1]
        # ⚠️ 陈旧 WAL 护栏（与 _plain 同一条规则）：末次提交的页数比镜像还小，说明这条 WAL
        # 比库旧（真实里会出现：reset 前后残留 + 库已前进）——宁可退回全量，不可读旧。
        if dbsize < os.path.getsize(self.out) // wxread4.PAGE:
            return False, False
        try:
            enc, mac = self._kmac()
        except Exception:
            return False, False
        try:
            f = open(self.out, "r+b")
            try:
                for pageno, _c, pgdata in frames[:last + 1]:
                    if not any(pgdata):
                        continue
                    dec = wxread4.decrypt_page(pgdata, enc, mac, pageno - 1,
                                               has_salt=(pageno == 1))
                    if dec is None:                # 页 HMAC 不过：这一版 WAL 不能信
                        return False, False
                    f.seek((pageno - 1) * wxread4.PAGE)
                    f.write(dec)
                f.truncate(dbsize * wxread4.PAGE)  # 提交后的库大小（不足补零、超出截断）
            finally:
                f.close()
        except Exception:
            return False, False
        if not _sqlite_ok(self.out):               # 护栏：增量结果必须还是个好库
            return False, False
        st.update({"key": key, "pages": dbsize,
                   "wal_off": st["wal_off"] + (last + 1) * (wxread4.FRAME_HDR + wxread4.PAGE)})
        return True, True


_mirrors = {}          # rel -> _ShardMirror（同 root 内复用）
# poll 的复用缓存：{table: {"ids": 各分片高水位, "since": 上次窗口, "rows": 上次结果, "complete"}}
# 语义：高水位没动 + 这次窗口不比上次宽 + 上次没被 per 截断 → 结果必然一样，直接复用。
_poll_memo = {}


def _mirror(rel):
    root = db_root()
    m = _mirrors.get(rel)
    if m is None or m.root != root:
        m = _ShardMirror(root, rel)
        _mirrors[rel] = m
    return m


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
    """确保各分片镜像与 contact 镜像最新（增量；只有真变化才做解密工作）。"""
    root = db_root()
    rels = _msg_shard_rels()
    if _cache["root"] != root or _cache.get("rels") != rels:
        _mirrors.clear()
        _cache["root"], _cache["rels"] = root, rels
    ms = [_mirror(r) for r in rels]
    for m in ms:
        m.refresh()
    _cache["msg"] = [m.out for m in ms]                   # 各分片的明文镜像（列表）
    _cache["tables"] = {m.out: m.tables() for m in ms}
    _cache["senders"] = {m.out: m.senders() for m in ms}
    contact = _mirror("contact/contact.db")
    contact.refresh()
    _cache["contact"] = contact.out


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
    """增量新消息（实时监控用）。返回 `create_time > since_ts` 的消息，按时间正序。

    性能关键：`Msg_*` 表**没有 create_time 索引**，`create_time > ?` 是全表扫描 + 临时排序
    （实测：68 张表一轮 266ms，用户库越大越慢，且要区分「有变化」才能跳过）。这里用
    `local_id`（INTEGER PRIMARY KEY，AUTOINCREMENT，插入即单调增）做**高水位探测**：
    表的高水位没动、且上次已按不更窄的窗口查过、还留了完整结果 → 直接复用，一次索引探测即可跳过；
    只有真变了的表才做那次扫描。`per` 是每会话上限（达到上限的表标记为不完整，不复用）。

    返回带 `from_me`/`sender`（自己发的也返回——用户可能自己在手机上回过了，Agent 应当知道）。
    """
    since_ts = int(since_ts or 0)
    _refresh()
    nm = names()
    me = self_wxid()
    out = []
    stats = {"tables": 0, "scanned": 0, "reused": 0}
    conns = {}
    try:
        for tbl, talker in talkers():
            rels = [p for p in _cache["msg"] if tbl in _cache["tables"].get(p, ())]
            if not rels:
                continue
            stats["tables"] += 1
            ids = tuple(_max_local_id(conns, p, tbl) for p in rels)
            ent = _poll_memo.get(tbl)
            rows = None
            if (ent and None not in ids and ent["ids"] == ids
                    and since_ts >= ent["since"] and ent["complete"]):
                rows = [r for r in ent["rows"] if r[0] > since_ts]
                stats["reused"] += 1
            if rows is None:
                rows = _rows_full_conn(conns, rels, tbl, per, since=since_ts)
                _poll_memo[tbl] = {"ids": ids, "since": since_ts, "rows": rows,
                                   "complete": len(rows) < per}
                stats["scanned"] += 1
            for ct, lt, content, sender in rows:
                out.append(msg_dict(ct, lt, content, nm, talker=talker,
                                    name=nm.get(talker, talker), sender=sender, me=me))
    finally:
        for c in conns.values():
            try:
                c.close()
            except Exception:
                pass
    out.sort(key=lambda d: d["ts"])
    return {"count": len(out), "messages": out, "since_ts": since_ts,
            "next_since_ts": (out[-1]["ts"] if out else since_ts), "stats": stats}


def _max_local_id(conns, path, tbl):
    """某分片某表的高水位（`local_id` 是主键 → 走索引，成本 ~0）。读不了返回 None（绝不复用）。"""
    try:
        c = conns.get(path)
        if c is None:
            c = conns[path] = sqlite3.connect(path)
        row = c.execute(f"select max(local_id) from [{tbl}]").fetchone()
        return row[0] or 0
    except Exception:
        return None


def _rows_full_conn(conns, rels, tbl, limit, since=0):
    """跨分片取 `[(create_time, local_type, content, sender)]`（复用调用方的连接）。"""
    q = ("select create_time, local_type, message_content, real_sender_id"
         f" from [{tbl}] where create_time > ? order by create_time desc limit ?")
    out = []
    for p in rels:
        smap = _cache["senders"].get(p, {})
        try:
            c = conns.get(p)
            if c is None:
                c = conns[p] = sqlite3.connect(p)
            rows = list(c.execute(q, (since, limit)))
        except Exception:
            continue
        for ct, lt, content, sid in rows:
            out.append((ct, lt, content, smap.get(sid, "")))
    out.sort(key=lambda r: r[0], reverse=True)
    return out[:limit]


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
def _session_plain():
    """session.db 的明文镜像路径（同样走增量刷新：未读数/会话列表也要实时）。"""
    m = _mirror("session/session.db")
    m.refresh()
    return m.out


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
