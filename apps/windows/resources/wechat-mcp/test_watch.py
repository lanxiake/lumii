#!/usr/bin/env python3
"""增量读取路径的**离线**回归测试（不需要微信、不碰真实数据）。

分两层，各自的断言边界不一样：

**A 层（真加密，逐字节）**——夹具是「微信格式」的加密分片（AES-CBC + reserve 80 +
HMAC-SHA512，参数与 wxread4 一致），用来测**重放/护栏逻辑**：
  1. 陈旧 WAL 护栏：主库比 WAL 新时，宁可读主库也不重放（不许读旧）；
  2. 增量重放结果 == 全量重建（逐字节）；
  3. 只动 WAL 的新消息 → 会刷新、wal_off 前移、镜像内容确实变了；
  4. WAL 被重置（salt 变）→ 退回全量，不炸；
  5. WAL 尾部只有未提交帧 → 不动内容，也不重复解密。
  ⚠️ A 层不查 SQLite 语义：本夹具的主库是普通 SQLite 写的，页尾 64 字节被数据占用，
     而重建出的明文页把那 64 字节放的是 HMAC——真实微信库有 reserve 语义（页尾不用），
     普通库没有。所以 A 层只比字节、不查表。

**B 层（真 SQLite 语义）**——夹具是**普通**的 WAL 模式 SQLite 库，只把 wxread4 的
  解密/重放换成「恒等」实现（`decrypt_page` 原样返回、`apply_wal` 不解密地贴帧），
  **wechat_core 的镜像/新鲜度/水位逻辑一行不改地跑**。用来测**语义**：
  6. 主库 + WAL 都读到、`from_me` 判定；
  7. **只动 WAL 的新消息必须可见**（旧实现按主库 mtime 判缓存 → 静默读旧，这组是回归锁）；
  8. poll 快路径：没变化复用、窗口变宽仍正确、有新消息不漏、`next_since_ts` 不重不漏。

**C 层（纯逻辑）**：`server._code_of` 与 `wechat_sender.py` 实际文案对账 + 重试安全边界。

用法：python test_watch.py
"""
import hashlib
import hmac
import io
import os
import sqlite3
import struct
import sys
import tempfile
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

PAGE = 4096
IV_AT = PAGE - 80
HMAC_AT = IV_AT + 16
TALKER = "wxid_testfriend"
ME_WXID = "wxid_me"          # 目录名 <wxid>_<4hex>，self_wxid() 从目录名反推本人 wxid


# ============================================================================
# 通用：造库 / 迷你运行器
# ============================================================================
def _schema(tbl):
    # `source` 是**真库有、必须有的列**（`msgsource` XML 住在那儿，群消息的 @我 判据就是它）。
    # 合成库少了它，读到的就是退化路（没有 at_me）——那会让"真库能读"这件事测不到。
    return f"""CREATE TABLE [{tbl}](local_id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER,
 local_type INTEGER, sort_seq INTEGER, real_sender_id INTEGER, create_time INTEGER, status INTEGER,
 message_content TEXT, source TEXT);
CREATE TABLE Name2Id(user_name TEXT);
CREATE INDEX [{tbl}_SORTSEQ] ON [{tbl}](sort_seq);"""


def _new_db(path, tbl, seed=(), me_id=1, friend_id=2):
    c = sqlite3.connect(path)
    c.executescript(_schema(tbl))
    c.execute("insert into Name2Id(rowid, user_name) values (?, ?)", (me_id, ME_WXID))
    c.execute("insert into Name2Id(rowid, user_name) values (?, ?)", (friend_id, TALKER))
    for sender, ts, text in seed:
        c.execute(f"insert into [{tbl}](real_sender_id, create_time, local_type, message_content)"
                  " values (?, ?, 1, ?)", (sender, ts, text))
    c.commit()
    c.close()


def _insert(conn, tbl, rows):
    for sender, ts, text in rows:
        conn.execute(f"insert into [{tbl}](real_sender_id, create_time, local_type, message_content)"
                     " values (?, ?, 1, ?)", (sender, ts, text))
    conn.commit()


def _wal_mode(conn):
    conn.execute("pragma journal_mode=wal")
    conn.execute("pragma wal_autocheckpoint=0")


def _stat(p):
    try:
        s = os.stat(p)
        return (round(s.st_mtime, 6), s.st_size)
    except OSError:
        return None


class R:
    def __init__(self, title):
        self.title, self.passed, self.failed = title, 0, 0

    def case(self, name, fn):
        try:
            fn()
            print(f"  ✅ {name}")
            self.passed += 1
        except Exception as e:
            import traceback
            print(f"  ❌ {name}: {type(e).__name__}: {e}")
            traceback.print_exc()
            self.failed += 1

    def done(self):
        return self.passed, self.failed


def _bind_core(root, work, key_hex="00" * 32, identity=False, trust_pages=False):
    """把 wechat_core 指向夹具：隔离 WORK、假 keys()、清缓存。

    identity=True → 把 wxread4 的解密/重放换成恒等（B 层用普通 SQLite 语义测逻辑）。
    trust_pages=True → 把 `_sqlite_ok` 换成恒真（A 层用；见 suite_A 的说明）。
    """
    import wechat_core as core
    import wxread4
    core.WORK = work                      # ← 关键：不碰真实 App 的临时目录
    core.MIRROR_DIR = os.path.join(work, "mirror")
    os.makedirs(core.MIRROR_DIR, exist_ok=True)
    core.db_root = lambda: root
    rels = ["message/message_0.db", "contact/contact.db", "session/session.db"]
    core.keys = lambda root=None: {f"k{i}": (key_hex, r) for i, r in enumerate(rels)}
    if trust_pages:
        core._sqlite_ok = lambda path: True
    if identity:
        def read_main(path, enc, mac):
            data = open(path, "rb").read()
            return [data[i:i + PAGE] for i in range(0, len(data), PAGE)], 0

        def apply_wal(wal_path, pages, enc, mac):
            if not os.path.exists(wal_path):
                return 0, 0, None
            frames, _ = wxread4.parse_wal_frames(open(wal_path, "rb").read())
            last = wxread4.last_commit_index(frames)
            if last < 0:
                return 0, 0, None
            for pageno, _c, pg in frames[:last + 1]:
                while len(pages) < pageno:
                    pages.append(b"\x00" * PAGE)
                pages[pageno - 1] = pg
            return last + 1, 0, frames[last][1]

        wxread4.read_main = read_main
        wxread4.apply_wal = apply_wal
        wxread4.decrypt_page = lambda pg, enc, mac, pageno, has_salt: pg
    core._mirrors.clear()
    core._poll_memo.clear()
    core._cache.update({"rels": None, "msg": None, "contact": None, "root": None})
    return core


def _msgs(core, since):
    return [(m["ts"], m["text"], m["from_me"]) for m in core.poll(since)["messages"]]


# ============================================================================
# B 层夹具：普通 WAL 模式 SQLite（真语义）
# ============================================================================
class PlainFixture:
    def __init__(self):
        self.tbl = "Msg_" + hashlib.md5(TALKER.encode()).hexdigest()
        self.dir = tempfile.mkdtemp(prefix="wxplain-")
        self.root = os.path.join(self.dir, f"{ME_WXID}_9c2d", "db_storage")
        for sub in ("message", "contact", "session"):
            os.makedirs(os.path.join(self.root, sub))
        self.work = os.path.join(self.dir, "work")
        os.makedirs(self.work, exist_ok=True)
        self.db = os.path.join(self.root, "message", "message_0.db")
        _new_db(self.db, self.tbl, seed=[(2, 1000, "seed-0"), (2, 1001, "seed-1")])
        # contact.db（names() 用）
        c = sqlite3.connect(os.path.join(self.root, "contact", "contact.db"))
        c.executescript("CREATE TABLE contact(id INTEGER PRIMARY KEY, username TEXT, nick_name TEXT, remark TEXT);"
                        "CREATE TABLE chatroom_member(room_id INTEGER, member_id INTEGER);")
        c.execute("insert into contact(id, username, nick_name) values (1, ?, '测试好友')", (TALKER,))
        c.commit()
        c.close()
        c = sqlite3.connect(os.path.join(self.root, "session", "session.db"))
        c.execute("create table SessionTable(username TEXT, unread_count INTEGER)")
        c.commit()
        c.close()

    def write_via_wal(self, rows):
        """只写 -wal（主库文件一个字节都不动）。返回主库 stat 是否变了。"""
        before = _stat(self.db)
        conn = sqlite3.connect(self.db)
        _wal_mode(conn)
        _insert(conn, self.tbl, rows)
        conn.close()                       # 关连接会 checkpoint——但我们的断言只看写入瞬间
        return before != _stat(self.db)

    def write_via_wal_keep(self, rows):
        """只写 -wal 且**保持连接打开**（不 checkpoint），供「写完立刻读」的用例。"""
        conn = sqlite3.connect(self.db)
        _wal_mode(conn)
        _insert(conn, self.tbl, rows)
        return conn


# ============================================================================
# A 层夹具：真加密分片（逐字节重放逻辑）
# ============================================================================
def _enc_page(plain, enc_key, mac_key, pageno, prefix=b""):
    from Crypto.Cipher import AES
    off = len(prefix)
    iv = plain[IV_AT:HMAC_AT]
    ct = AES.new(enc_key, AES.MODE_CBC, iv).encrypt(plain[off:PAGE - 80])
    mac = hmac.new(mac_key, ct + iv + (pageno + 1).to_bytes(4, "little"),
                   hashlib.sha512).digest()
    return prefix + ct + iv + mac


class EncFixture:
    """加密分片的 A 层夹具：`message_0.db`（+ 可注入的 `-wal`）。"""

    def __init__(self):
        self.tbl = "Msg_" + hashlib.md5(TALKER.encode()).hexdigest()
        self.dir = tempfile.mkdtemp(prefix="wxenc-")
        self.root = os.path.join(self.dir, f"{ME_WXID}_9c2d", "db_storage")
        os.makedirs(os.path.join(self.root, "message"))
        self.work = os.path.join(self.dir, "work")
        os.makedirs(self.work, exist_ok=True)
        self.enc_key = bytes(range(32))
        self.salt = bytes(range(16, 32))
        self.key_hex = self.enc_key.hex()
        self.plain = os.path.join(self.dir, "plain.db")
        self.enc = os.path.join(self.root, "message", "message_0.db")
        self.enc_wal = self.enc + "-wal"
        self.mac_key = None

    def connect(self):
        """打开明文库的 WAL 连接（写新消息用），返回连接。"""
        if not os.path.exists(self.plain):
            _new_db(self.plain, self.tbl, seed=[(2, 1000, "seed-0"), (2, 1001, "seed-1")])
        conn = sqlite3.connect(self.plain)
        _wal_mode(conn)
        return conn

    def seal_wal(self, plain_wal, salt=None, extra_tail=b""):
        """把一份普通 WAL 加密成微信格式的 `-wal`（帧头原样，帧页加密；页 1 带 salt）。

        salt 默认每次随机——真实里 checkpoint 后 SQLite 会重置 WAL（salt 变），
        只有**同一个 WAL 会话继续长**时 salt 才不变（那种情况要显式传同一个 salt）。
        """
        import struct as _s

        import wxread4
        if self.mac_key is None:
            self.mac_key = wxread4.derive_mac_key(self.enc_key, self.salt)
        salt = (salt or os.urandom(8))[:8]   # WAL 头的 salt 是 8 字节（salt1+salt2），不是主库那种 16
        w = open(plain_wal, "rb").read()
        hdr, off, frames = w[:32], 32, []
        while off + 24 + PAGE <= len(w):
            pageno = _s.unpack(">I", w[off:off + 4])[0]
            if pageno == 0:
                break
            frames.append((w[off:off + 24], pageno, w[off + 24:off + 24 + PAGE]))
            off += 24 + PAGE
        with open(self.enc_wal, "wb") as f:
            f.write(hdr[:16] + salt + hdr[24:])
            for fh, pageno, pg in frames:
                # 帧头里的 salt 必须与 WAL 头一致（SQLite 就是这么写的；解析器按它判「这一帧
                # 属不属于当前会话」）
                f.write(fh[:8] + salt + fh[16:])
                f.write(_enc_page(pg, self.enc_key, self.mac_key, pageno - 1,
                                  prefix=(salt if pageno == 1 else b"")))
            if extra_tail:
                f.write(extra_tail)
        return len(frames)

    def seal(self, with_wal=True, wal_salt=None):
        """把明文库（+其 -wal）加密封成微信格式。返回 (帧数, salt)。"""
        import wxread4
        if self.mac_key is None:
            self.mac_key = wxread4.derive_mac_key(self.enc_key, self.salt)
        if not os.path.exists(self.plain):
            _new_db(self.plain, self.tbl, seed=[(2, 1000, "seed-0"), (2, 1001, "seed-1")])
        data = open(self.plain, "rb").read()
        with open(self.enc, "wb") as f:
            for i in range(0, len(data), PAGE):
                f.write(_enc_page(data[i:i + PAGE], self.enc_key, self.mac_key, i // PAGE,
                                  prefix=(self.salt if i == 0 else b"")))
        n = 0
        if with_wal and os.path.exists(self.plain + "-wal"):
            n = self.seal_wal(self.plain + "-wal", salt=wal_salt)
        elif not with_wal and os.path.exists(self.enc_wal):
            os.remove(self.enc_wal)
        return n, self.salt


# ============================================================================
# 各层测试
# ============================================================================
def suite_A():
    r = R("A 层：真加密 · 重放与护栏（逐字节）")

    def img(core, fx):
        return open(os.path.join(core.MIRROR_DIR, "plain_message_0.db"), "rb").read()

    def a1_stale_wal():
        """陈旧 WAL（dbsize < 主库页数）必须被丢弃——宁可读主库，不可读旧。"""
        fx = EncFixture()
        fx.seal(with_wal=False)
        core = _bind_core(fx.root, fx.work, fx.key_hex, trust_pages=True)
        m = core._mirror("message/message_0.db")
        m.refresh()
        clean = img(core, fx)
        # 塞一个来自「更小的库」的陈旧 WAL：它的末次提交页数 < 主库页数（真实里就是这个形状：
        # 实测一条陈旧 WAL 的 dbsize=900 而主库已 907 页）
        small = os.path.join(fx.dir, "small.db")
        c = sqlite3.connect(small)
        c.executescript(f"CREATE TABLE [{fx.tbl}]"
                        "(local_id INTEGER PRIMARY KEY AUTOINCREMENT, message_content TEXT);")
        c.commit()
        c.close()
        conn = sqlite3.connect(small)
        _wal_mode(conn)
        conn.execute(f"insert into [{fx.tbl}](message_content) values ('stale-row')")
        conn.commit()
        fx.seal_wal(small + "-wal")
        conn.close()
        core._mirrors.clear()
        m = core._mirror("message/message_0.db")
        m.refresh()
        assert img(core, fx) == clean, "陈旧 WAL 被重放了（把库读旧了）"
    r.case("陈旧 WAL 护栏：不许读旧", a1_stale_wal)

    def a2_incremental_eq_full():
        """增量重放 == 全量重建（逐字节）：同一个 WAL 会话**继续长**时走真增量。"""
        fx = EncFixture()
        conn = fx.connect()
        _insert(conn, fx.tbl, [(2, 2000, "wal-a"), (1, 2001, "wal-b")])
        salt = os.urandom(8)
        fx.seal(with_wal=True, wal_salt=salt)      # 注意：seal 必须在 conn 关掉之前
        core = _bind_core(fx.root, fx.work, fx.key_hex, trust_pages=True)
        m = core._mirror("message/message_0.db")
        m.refresh()
        assert m.st["wal_off"] is not None, "夹具前置：首轮应已建立增量偏移"
        inc = img(core, fx)
        m._full(m.key())
        assert img(core, fx) == inc, "增量与全量不一致（首轮）"

        # 同一个 WAL 继续长（salt 不变、主库文件不动）→ 必须走续读（增量）
        for i, (ts, text) in enumerate([(3000, "wal-c"), (4000, "wal-d")], start=1):
            _insert(conn, fx.tbl, [(2, ts, text)])
            fx.seal_wal(fx.plain + "-wal", salt=salt)     # 只重写加密 WAL，主库不动
            assert m.refresh() is True, f"第 {i} 轮：WAL 长了却没刷新"
            inc2 = img(core, fx)
            assert inc2 != inc, f"第 {i} 轮：新帧没有打进镜像"
            m2 = core._mirror("message/message_0.db")
            m2._full(m2.key())
            assert img(core, fx) == inc2, f"第 {i} 轮：续读后的增量与全量不一致"
            inc = inc2
        conn.close()
    r.case("增量重放 == 全量重建（同一 WAL 会话续读）", a2_incremental_eq_full)

    def a3_wal_reset():
        """WAL 被 checkpoint 重置（salt 变）→ 不许续读，退回全量且不炸。"""
        fx = EncFixture()
        conn = fx.connect()
        _insert(conn, fx.tbl, [(2, 2000, "wal-a")])
        fx.seal(with_wal=True)
        core = _bind_core(fx.root, fx.work, fx.key_hex, trust_pages=True)
        m = core._mirror("message/message_0.db")
        m.refresh()
        assert m.st["wal_off"] is not None, "夹具前置：应已建立增量偏移"
        fx.seal_wal(fx.plain + "-wal", salt=os.urandom(8))    # 换 salt = 换了新 WAL 会话
        assert m.refresh() is True, "salt 变了必须退回全量（不能续读）"
        assert m.refresh() is False
        conn.close()
    r.case("WAL 重置（salt 变）：退回全量", a3_wal_reset)

    def a4_uncommitted_tail():
        """WAL 尾部只有未提交帧：不动内容，也不反复重解密。"""
        fx = EncFixture()
        conn = fx.connect()
        _insert(conn, fx.tbl, [(2, 2000, "wal-a")])
        fx.seal(with_wal=True)
        core = _bind_core(fx.root, fx.work, fx.key_hex, trust_pages=True)
        m = core._mirror("message/message_0.db")
        m.refresh()
        before = img(core, fx)
        off_before = m.st["wal_off"]
        with open(fx.enc_wal, "ab") as f:                 # 只有帧头、没有页数据
            f.write(struct.pack(">II", 3, 0) + b"\x00" * 8)
        assert m.refresh() is False, "未提交帧不该算内容变化"
        assert m.st["wal_off"] == off_before, "未提交帧不该推进偏移"
        assert img(core, fx) == before
        conn.close()
    r.case("未提交尾帧：不动内容、不推进偏移", a4_uncommitted_tail)

    return r


def suite_B():
    r = R("B 层：真 SQLite 语义 · 新鲜度与 poll 快路径")
    fx = PlainFixture()
    core = _bind_core(fx.root, fx.work, identity=True)

    def b1_full_read():
        conn = fx.write_via_wal_keep([(2, 2000, "wal-1"), (1, 2001, "wal-2")])
        try:
            got = _msgs(core, 0)
            texts = [t for _ts, t, _fm in got]
            assert "seed-0" in texts and "wal-1" in texts, f"主库+WAL 没读全：{texts}"
            assert [fm for _ts, t, fm in got if t == "wal-1"] == [False]
            assert [fm for _ts, t, fm in got if t == "wal-2"] == [True]
        finally:
            conn.close()
    r.case("主库 + WAL 都读到、from_me 正确", b1_full_read)

    def b2_wal_only_visible():
        """回归锁：**只动 WAL**（主库 mtime/size 都不变）的新消息必须可见。"""
        conn = fx.write_via_wal_keep([(2, 2500, "pre-warm")])
        conn.close()
        core.poll(1000)                                  # 建立缓存与水位
        db_before = _stat(fx.db)
        conn = fx.write_via_wal_keep([(2, 3000, "wal-only-visible")])
        try:
            assert _stat(fx.db) == db_before, "前置：只写 WAL 不该动主库"
            res = core.poll(2500)
            got = [(m["ts"], m["text"], m["from_me"]) for m in res["messages"]]
            assert [t for _ts, t, _fm in got] == ["wal-only-visible"], \
                f"只动 WAL 的新消息没读到（旧实现就会这样漏）：{got}"
            assert res["stats"]["scanned"] >= 1, f"有新消息的表必须重新扫描：{res['stats']}"
        finally:
            conn.close()
    r.case("只动 WAL 的新消息可见（回归锁）", b2_wal_only_visible)

    def b3_memo():
        core.poll(3000)                                  # 建立 memo
        s1 = core.poll(3000)["stats"]
        s2 = core.poll(3000)["stats"]
        assert s2["reused"] > 0, f"没走复用快路径：{s2}"
        # 窗口变宽：必须仍能拿到老消息
        wide = _msgs(core, 0)
        assert any(t == "seed-0" for _ts, t, _fm in wide), "窗口变宽后老消息丢了"
        # 又来一条：不许漏
        conn = fx.write_via_wal_keep([(2, 4000, "wal-new")])
        try:
            again = _msgs(core, 3000)
            assert [t for _ts, t, _fm in again] == ["wal-new"], f"新消息漏了：{again}"
        finally:
            conn.close()
        rr = core.poll(4000)
        assert rr["next_since_ts"] == 4000, f"next_since_ts 语义错：{rr['next_since_ts']}"
        assert core.poll(rr["next_since_ts"])["count"] == 0, "按 next_since_ts 续读不该重复"
    r.case("poll 快路径：复用 / 变宽 / 不漏 / next_since_ts", b3_memo)

    def b4_main_change_rebuild():
        """主库变化（checkpoint）后仍读到全部内容（全量路径 + 护栏）。"""
        conn = fx.write_via_wal_keep([(2, 5000, "after-checkpoint")])
        before = _stat(fx.db)
        busy, _log, _ckpt = conn.execute("pragma wal_checkpoint(TRUNCATE)").fetchone()
        conn.close()
        assert busy == 0, "夹具前置：checkpoint 没做成（有别的读连接占着）"
        assert _stat(fx.db) != before, "夹具前置：checkpoint 应当写主库"
        got = _msgs(core, 4000)
        assert [t for _ts, t, _fm in got] == ["after-checkpoint"], f"checkpoint 后读不到：{got}"
    r.case("主库变化（checkpoint）后内容不丢", b4_main_change_rebuild)

    def b5_burst_not_lost():
        """满量的会话**一拍读全**：旧实现给"最新 `per` 条"、水位直接推到最新 ⇒ 中间那些永久丢。

        为什么值得锁：`next_since_ts` 是**全局**水位而 `per` 是**每会话**上限，水位一旦越过
        本会话没返回的消息，它们**再也不会被取到**（`create_time > 水位` 永远为假）。
        实测本机 71 张表里 **39 张满量**（per=20）——群里刷屏就是这个量级，不是罕见分支。
        这里用 per=3 逼出满量：修好后一拍就把 12 条全带走；旧实现只带回最后 3 条。
        """
        conn = fx.write_via_wal_keep([(2, 6000 + i, f"burst-{i}") for i in range(12)])
        try:
            got, since = [], 5500          # 5500：跳过 b4 那条 5000 的，只盯本用例这批
            for _ in range(10):
                res = core.poll(since, per=3)
                got += [m["text"] for m in res["messages"]]
                nxt = res["next_since_ts"]
                if not res["messages"] or nxt <= since:
                    break
                since = nxt
            assert sorted(set(got)) == sorted(f"burst-{i}" for i in range(12)), \
                f"满了 per 就丢中间的：{sorted(set(got))}"
        finally:
            conn.close()
    r.case("满量的会话一拍读全（per 不吃掉中间那些）", b5_burst_not_lost)

    def b6_same_second_tail_not_lost():
        """**同一秒**里晚到的那批不能丢——水位是秒级的，`create_time > 水位` 会把它们永久关在门外。

        为什么值得锁：`create_time` **只到秒**，而水位取"本拍见过的最大 ts"。轮询只要**落在某个
        活跃秒的中间**，水位就已经是那一秒；同一秒后面到达的消息（群聊一个爆发秒里几十条就是这个
        形态）**再也不会被取到**，且毫无迹象。轮询节奏 ~2s 时，约一半的活跃秒会挨这一刀。
        这是 `b5`（满量截断）的**时间版**：同一个根因——水位越过了还没送达的消息。
        文档里那句"别传墙上时钟的 now，同秒会漏"只堵了一半：`next_since_ts` 自己就可能是**当前**
        这一秒的 ts，于是"照文档说的做"照样漏。

        夹具**故意让两批用同一个 create_time**（真机同一秒的消息 create_time 完全相同），
        中间夹一次 poll——那一拍之后写进去的那批就是被吞掉的那批。
        """
        conn = fx.write_via_wal_keep([(2, 7000, f"same-{i}") for i in range(4)])
        try:
            res = core.poll(6500, per=20)
            got = [m["text"] for m in res["messages"]]
            since = res["next_since_ts"]
            assert since == 7000, f"夹具前置：水位应推到 7000，实际 {since}"
            # 同一秒的后半批（真机：轮询已跑过、这一秒还没结束时的那些）
            _insert(conn, fx.tbl, [(2, 7000, f"same-{i}") for i in range(4, 10)])
            # **固定轮数、不提前 break**：这一秒的 ts 不会再变（全是 7000），水位也就不再前进，
            # 于是"补边界那一秒"的实现在此**必须自己停下来**——多投一次就会在这里被抓到。
            for _ in range(5):
                res = core.poll(since, per=20)
                got += [m["text"] for m in res["messages"]]
                since = res["next_since_ts"]
            want = sorted(f"same-{i}" for i in range(10))
            assert sorted(set(got)) == want, f"同一秒的后半批被吞了：{sorted(set(got))}"
            assert sorted(got) == want, f"有重复投递：{sorted(got)}"
        finally:
            conn.close()
    r.case("同一秒里晚到的那批不丢（水位秒级，会整批关在门外）", b6_same_second_tail_not_lost)

    def b7_voice_wait_is_per_batch_not_per_message():
        """一批语音**共用**一个等待额度——一条一条各给 6s 会累乘成 N×6s。

        为什么值得锁：SILK 是异步下载的，所以刚到的语音要等一拍（这条不能删）；但等的是
        **同一批同时在下载**的那些，等第一条就把整批都等到了。逐条给额度的话，实测真机全库
        合并流任一 180s 窗口里最多 6 条语音 ⇒ 一趟 `poll_new` 最坏 36s，把 15s 那一拍拖穿。
        老语音要**只看一眼**（它的数据是永久缺失的，等再久也没有）。
        """
        orig = core.voice_file
        seen = []

        def fake(talker, ct, local_id=None, deadline=None):
            seen.append(deadline)
            return None

        core.voice_file = fake
        try:
            now = int(time.time())
            fresh = now - 5                       # 刚到的（SILK 还在路上）
            old = now - 3600                      # 老语音
            core.attach_voice([{"type": 34, "ts": fresh, "local_id": 1},
                               {"type": 34, "ts": fresh, "local_id": 2},
                               {"type": 34, "ts": fresh, "local_id": 3},
                               {"type": 34, "ts": old, "local_id": 4},
                               {"type": 1, "ts": fresh, "local_id": 5}], TALKER)
        finally:
            core.voice_file = orig
        assert len(seen) == 4, f"只该对 4 条语音取名，实际 {len(seen)}"
        assert seen[0] is not None and seen[0] == seen[1] == seen[2], \
            f"3 条新鲜语音没共用额度：{seen}"
        assert seen[3] == 0, f"老语音不该等（该看一眼就走）：{seen[3]}"
        left = seen[0] - time.time()
        assert 0 < left <= core._VOICE_WAIT_S, f"额度不是一次性的：还剩 {left:.1f}s"
        # 顺带把 `deadline=0` 的语义**端到端**钉住（不是只钉桩）：真调用一次，必须立刻回
        t0 = time.time()
        assert core.voice_file(TALKER, old, 4, deadline=0) is None
        assert time.time() - t0 < core._VOICE_POLL_S, "deadline=0 还在睡"



    r.case("一批语音共用一个等待额度（逐条给会累成 N×6s 拖穿一拍）", b7_voice_wait_is_per_batch_not_per_message)

    return r


def suite_C():
    import re
    import server
    r = R("C 层：错误码与重试边界")

    def c1_code_map():
        src = open(os.path.join(HERE, "wechat_sender.py"), encoding="utf-8").read()
        lits = [s for s in re.findall(r'return False, "([^"]+)"', src) if s != "-"]
        # ^ "-" 是 verify_target 的内部哨兵（不通过、但由上层转成「目标会话未确认」），不是对外的错误文案。
        # preflight 用 `return False, "proc", "详情…", info` 四元组，正则会把 stage 标签（全小写）也捞进来，
        # 那是指路标不是文案 —— 过滤掉（面向用户的失败文案都含中文）。
        lits = [s for s in lits if not re.fullmatch(r"[a-z_]+", s)]
        assert len(lits) >= 10, f"从 wechat_sender.py 抽到的文案太少（{len(lits)}），正则可能失效"
        bad = [s for s in lits if server._code_of(s) == "unknown"]
        assert not bad, f"这些文案没有错误码（改了文案要同步 _code_of）：{bad}"
        assert server._code_of("输入未落地（fail-closed）") == "input_not_landed"
        assert server._code_of("发送未生效（输入框未清空）") == "send_unconfirmed"
        assert server._code_of("已回车但目标会话未见新消息（可能发到了别处或未生效）") == "send_not_confirmed"
        assert server._code_of("另一个微信操作正在进行，请稍后重试（busy）") == "busy"
        assert server._code_of("附件未落地（输入区未见文件名，fail-closed）") == "attachment_not_landed"
        assert server._code_of("剪贴板写入失败（fail-closed）") == "clipboard_failed"
    r.case("错误码对账：发送层文案全都认得", c1_code_map)

    def c2_retry_safety():
        calls = []

        def flaky():
            calls.append(1)
            return (False, "输入未落地（fail-closed）") if len(calls) == 1 else (True, "已发送")

        ok, detail, n = server._send_with_retry(flaky, max_retries=2, retry_delay=0.01)
        assert ok and n == 2 and "第 2 次尝试成功" in detail, (ok, detail, n)

        def ambiguous():
            calls.append(1)
            return False, "已回车但目标会话未见新消息（可能发到了别处或未生效）"

        n0 = len(calls)
        ok2, d2, n2 = server._send_with_retry(ambiguous, max_retries=2, retry_delay=0.01)
        assert not ok2 and n2 == 1 and len(calls) == n0 + 1, f"语义存疑的失败被重试了（会发两遍）：{d2}"

        def env_fail():
            calls.append(1)
            return False, "环境前置检查未通过：窗口不在前台（微信运行=True，可见=True，最小化=False）"

        n1 = len(calls)
        _ok, _d, n3 = server._send_with_retry(env_fail, max_retries=2, retry_delay=0.01)
        assert n3 == 1 and len(calls) == n1 + 1, "环境错误不该重试"
    r.case("重试边界：可重试真重试 / 存疑与环境的都不重试", c2_retry_safety)

    return r


def suite_D():
    """会话名解析：大小写放开，但**防错人的铁律不许动**（唯一候选才采信）。"""
    import wechat_core as core
    r = R('D 层：resolve_talker 的名字解析')

    # 夹具：两个会话，其中一个名字里嵌着另一个（历史事故的形状）
    NAMES = {'wxid_loop': 'Loop', 'wxid_toolan': 'TOOLAN', 'wxid_toolan_han': 'TOOLAN、韩玉',
             '123@chatroom': '两河10组村民群'}
    TALKS = [(core.tbl_of(t), t) for t in NAMES]

    def patch():
        core.names = lambda: dict(NAMES)
        core.talkers = lambda: list(TALKS)

    def d1_case_insensitive():
        patch()
        assert core.resolve_talker('loop') == 'wxid_loop', '小写 loop 必须解析到 Loop'
        assert core.resolve_talker('LOOP') == 'wxid_loop'
        assert core.resolve_talker('toolan') is None or True
    r.case('大小写不敏感（loop → Loop）', d1_case_insensitive)

    def d2_no_mis_send():
        patch()
        # 全名精确命中（历史事故的形状：短名嵌在长名里，靠"精确优先"避开）
        assert core.resolve_talker('TOOLAN、韩玉') == 'wxid_toolan_han', '全名应精确命中'
        # 大小写不敏感后，仍是**唯一精确**才采信
        assert core.resolve_talker('toolan') == 'wxid_toolan', '唯一精确匹配（忽略大小写）应采信'
        # 子串命中多个 → 必须拒绝（宁可不发，让上层问人）
        NAMES['wxid_abc1'] = 'ABC组'
        NAMES['wxid_abc2'] = 'ABC组2'
        TALKS.extend([(core.tbl_of('wxid_abc1'), 'wxid_abc1'), (core.tbl_of('wxid_abc2'), 'wxid_abc2')])
        assert core.resolve_talker('abc') is None, '子串命中两个会话，必须拒绝而不是猜一个'
    r.case('防错人铁律不变：歧义一律拒绝', d2_no_mis_send)

    def d3_find_session_exact_over_embedded():
        import wechat_sender as snd
        lines = [
            (126, 100, 250, 115, '严子云。、杨冬'),
            (126, 160, 250, 175, '杨冬'),
        ]
        hit = snd.find_session(lines, '杨冬', 1280, 820)
        assert hit and hit[3] == '杨冬', f'应点单聊而非群：{hit}'
    r.case('find_session：精确名压过群名嵌短名', d3_find_session_exact_over_embedded)

    def d4_uia_read_and_target():
        """UIA 读数器：**格式契约**（.ps1 的制表符行 ↔ read_uia 的结构）与目标判据。

        为什么值得离线钉住：`uia_read.ps1` 与 `wechat_sender.read_uia` 靠一个手写的文本协议
        对接，字段错位**不会报错**，只会静默把预览/时间当成会话名——那正好是「发错人」的形状。
        样本取自真机 dump（最小化态，坐标是 UIA 给的还原位）。
        """
        sample = "\r\n".join([
            "WIN\t537\t269\t1264\t788",
            "ITEM\tsession_item_杨冬\t597\t999\t240\t65\t0\t杨冬 人呢？ 13:30",
            "ITEM\tsession_item_文件传输助手\t597\t869\t240\t65\t0\t文件传输助手 最小化还原实测 13:43",
            "ITEM\t\t597\t934\t240\t65\t1\t腾讯新闻 白应苍 13:34",
            "HEADER\t成都市龙泉驿区妇幼保健院",
            "EDIT\t\t635\t315\t126\t20\t搜索",
            "INPUT\t上一轮留下的草稿",
            "MLIST\t837\t349\t960\t643",
            "BTN\t\t1729\t1010\t48\t26\t发送",
            # -All 才输出的形状（驱动文件对话框用）：controlType / aid / NativeWindowHandle / rect / name
            "CTL\tListItem\t1\t99\t700\t500\t200\t30\tFinalShell",
            "CTL\tPane\t1148\t1148\t737\t907\t775\t26\t",
        ])
        import wechat_sender as snd
        old_ps, old_click = snd._run_ps, snd.post_click
        clicks = []
        snd._run_ps = lambda script, args, sta=False: open(args[3], "w", encoding="utf-8").write(sample)
        snd.post_click = lambda h, x, y: clicks.append((x, y)) or True
        try:
            d = snd.read_uia(1, "t")
            assert d and d["win"] == (537, 269, 1264, 788), d
            assert d["header"] == "成都市龙泉驿区妇幼保健院", d["header"]
            assert d["mlist"] == (837, 349, 960, 643), d["mlist"]
            assert len(d["items"]) == 3 and d["items"][0]["aid"] == "session_item_杨冬", d["items"]
            # 会话定位：AutomationId 精确命中（不受预览文字影响）
            it = snd.uia_find_session(d, "文件传输助手")
            assert it and it["aid"] == "session_item_文件传输助手", it
            # aid 缺失（微信改 id 规则）时退回显示名匹配：行文本是「名字 预览 时间」
            assert snd.uia_find_session(d, "腾讯新闻")["rect"][1] == 934
            assert snd.uia_find_session(d, "韩玉") is None, "不在列表里必须返回 None，不能猜一个"
            # 目标校验：表头就是当前开会话，精确比
            assert snd.uia_header_is(d, "成都市龙泉驿区妇幼保健院")
            assert not snd.uia_header_is(d, "杨冬") and not snd.uia_header_is(d, "")
            # 点击坐标 = 屏幕坐标 − 客户区原点；行滚出窗口外一律不点
            assert snd.uia_click_item(1, d, it) and clicks[-1] == (717 - 537, 901 - 269), clicks
            far = {"win": None, "items": [], "edits": [], "mlist": None, "btns": [], "header": None}
            assert not snd.uia_click_item(1, far, it), "参考系拿不到就不能点"
            outside = dict(far, win=d["win"])
            assert not snd.uia_click_item(1, outside, {"rect": (597, 1300, 240, 65), "aid": "x"}), "滚出可视区不能点"
            # 输入框：不在 UIA 树里，用同棵树里的「发送」按钮反推（按钮中心上方 101px）。
            # 实测 (1729,1010,48,26) → 客户区中心 x、y=1010+13-101=922。
            assert snd.uia_input_pt(1, d) == (537 + 1264 // 2 - 537, 922 - 269), snd.uia_input_pt(1, d)
            assert snd.uia_input_pt(1, {"win": None, "btns": d["btns"]}) is None
            assert snd.uia_input_pt(1, dict(d, btns=[])) is None, "没有「发送」按钮可锚就不能猜"
            # 输入框当前内容（INPUT 行）：发送前"框里是什么"的唯一来源，缺字段=读不到≠空
            assert d["input"] == "上一轮留下的草稿", d["input"]
            # -All 的 CTL 行：原生句柄必须落在 nwh 上（错位了就会去驱动别的控件，且不报错）
            assert [c["nwh"] for c in d["ctls"]] == [99, 1148], d["ctls"]
            assert d["ctls"][0]["type"] == "ListItem" and d["ctls"][1]["aid"] == "1148", d["ctls"]
        finally:
            snd._run_ps, snd.post_click = old_ps, old_click

    def d4b_uia_blank_tree_is_unavailable():
        """微信没暴露控件树（只剩 WIN 行）时 read_uia 必须返回 None，让发送退回帧判据。

        2026-10-09 20:33 真机：树里只有窗口外框，表头恒空，被当成「有效 UIA」后直接判
        「不是目标会话」⇒ `target_unconfirmed`，帧判据一次都没跑。
        """
        import wechat_sender as snd
        old_ps, old_metric = snd._run_ps, snd._metric
        noted = []
        snd._metric = lambda op, ms, ok, extra=None: noted.append(op)
        snd._UIA_BLANK_NOTED = False
        snd._UIA_BLANK_HWNDS.clear()
        samples = {
            "blank": "WIN\t623\t270\t1241\t928\r\nHEADER\t",
            # 文件对话框：没有会话列表/表头，但有编辑框和按钮——不是空树
            "dialog": "WIN\t10\t10\t600\t400\r\nHEADER\t\r\nEDIT\t1148\t20\t300\t200\t20\t文件名\r\n"
                      "BTN\t1\t400\t350\t80\t26\t打开",
        }
        try:
            # ⚠️ 空树是**按窗口**记的，所以两个样本必须用**不同的 hwnd**（真实文件对话框有自己的
            # 句柄、树也正常）。拿同一个 hwnd 测，等于把"别把对话框判死"这条性质悄悄绕过去——
            # 2026-10-14 一度就是这样，于是 `read_uia` 的按窗口短路把附件路径一起掐了。
            for key, body in samples.items():
                snd._run_ps = lambda script, args, sta=False, b=body: open(args[3], "w", encoding="utf-8").write(b)
                d = snd.read_uia(1 if key == "blank" else 2, "blank_" + key)
                if key == "blank":
                    assert d is None, f"空树必须当成读不到：{d}"
                else:
                    assert d and d["btns"] and d["edits"], f"对话框树不能被误判成空树：{d}"
            snd._run_ps = lambda script, args, sta=False: open(args[3], "w", encoding="utf-8").write(samples["blank"])
            assert snd.read_uia(1, "blank_again") is None
            # 空树已记在 hwnd=1 上：同一窗口不必再 spawn PowerShell（每次省 1.0s），
            # 但**别的窗口照样要读**——文件对话框正是靠这一条活着。
            snd._run_ps = lambda script, args, sta=False: open(args[3], "w", encoding="utf-8").write(samples["dialog"])
            d = snd.read_uia(2, "dialog_again")
            assert d and d["edits"], f"空树判据只作用于那个窗口，不能波及别的窗口：{d}"
            assert noted == ["uia_blank"], f"空树指标按进程只记一次：{noted}"
        finally:
            snd._run_ps, snd._metric = old_ps, old_metric
            snd._UIA_BLANK_NOTED = False
            snd._UIA_BLANK_HWNDS.clear()
    r.case('UIA：格式契约 + 会话定位 + 表头校验 + 活几何点击', d4_uia_read_and_target)
    r.case('UIA：空树（微信未暴露控件）= 读不到，退回帧判据', d4b_uia_blank_tree_is_unavailable)

    def d5_file_dialog():
        """附件后台化：驱动文件对话框时的**认控件判据**（写没写进去、点的是不是「打开」）。

        为什么值得离线钉住：这条路全凭控件 id/名字认控件，认错了不报错、只是静默走偏——
        实测误点过文件列表项（它的 aid 也是 "1"），对话框不关，看起来像"点了没反应"。
        样本取自真机 dump（微信弹的 `#32770 '选择文件'`）。
        """
        import wechat_sender as snd
        BOX, OPEN_BTN, CANCEL = 1148, 331, 332
        base = [
            {"type": "Pane", "aid": "1148", "nwh": BOX, "rect": (737, 907, 775, 26), "name": ""},
            {"type": "ListItem", "aid": "1", "nwh": 99, "rect": (700, 500, 200, 30), "name": "FinalShell"},
            {"type": "Pane", "aid": "1", "nwh": OPEN_BTN, "rect": (1524, 938, 88, 26), "name": "打开(O)"},
            {"type": "Pane", "aid": "2", "nwh": CANCEL, "rect": (1620, 938, 88, 26), "name": "取消"},
        ]

        class FakeU32:
            @staticmethod
            def SendMessageW(hwnd, msg, _w, _l):
                if msg == snd.BM_CLICK:
                    clicked.append(getattr(hwnd, "value", hwnd))
                return 0

        def run(ctls, echo=True):
            del box[:], clicked[:]
            snd.read_uia = lambda h, tag, all_ctls=False: {"win": (1, 2, 3, 4), "ctls": ctls}
            snd._dlg_get_text = lambda hwnd, n=1024: box[0][1] if (box and echo) else ""
            return snd._dlg_fill_and_open(1, r"C:\tmp\报表 8月.xlsx")

        box, clicked = [], []
        old = snd.read_uia, snd._dlg_set_text, snd._dlg_get_text, snd._u32, snd.u.IsWindow
        snd._dlg_set_text = lambda hwnd, text: box.append((hwnd, text))
        snd._u32 = FakeU32
        snd.u.IsWindow = lambda h: 0            # 点完「打开」对话框就消失
        try:
            ok, why = run(base)
            assert ok and why, (ok, why)
            assert box == [(BOX, r"C:\tmp\报表 8月.xlsx")], box
            assert clicked == [OPEN_BTN], f"必须点「打开」而不是 aid 同为 1 的列表项：{clicked}"
            # 写不进文件名框（回读为空）就不许点「打开」——否则发出的是上一个文件/空文件名
            assert not run(base, echo=False)[0], "回读不匹配必须 fail-closed"
            # 认不出「打开」（只剩同名 aid 的列表项）时不许乱点
            assert not run([c for c in base if c["nwh"] != OPEN_BTN])[0], "认不出按钮必须 fail-closed"
            # 对话框树读不到
            snd.read_uia = lambda h, tag, all_ctls=False: None
            assert not snd._dlg_fill_and_open(1, r"C:\tmp\a.txt")[0]
        finally:
            snd.read_uia, snd._dlg_set_text, snd._dlg_get_text, snd._u32, snd.u.IsWindow = old
    r.case('附件：文件对话框的控件认领与回读校验', d5_file_dialog)

    def d6_input_gate():
        """发送前的「读—清—回读」闸门。为什么值得离线钉住：`post_text` 只看 PostMessage 的
        返回值，而它基本恒真；框里剩什么全靠这两处读回。2026-10-09 实测踩过——探测留下的
        'ZQ1aaccaaaacc' 跟着附件一起发了出去（用户可撤回，但那是实打实的错发）。
        """
        import wechat_sender as snd
        sent, old_pb, old_read = [], snd.post_backspaces, snd.read_uia
        snd.post_backspaces = lambda h, n, dt=0.004: sent.append(n)
        try:
            # 空框：一个退格都不发（别把用户的正常路径拖慢）
            snd.read_uia = lambda h, tag="uia", all_ctls=False: {"input": ""}
            assert snd.clear_input(1, "") == (True, "输入框本来就是空的")
            assert sent == [], sent
            # 有 6 字残留：退格数按**实际长度**算（不是固定值），回读空了才算过
            ok, why = snd.clear_input(1, "ZQ1aac")
            assert ok and sent == [26], (ok, why, sent)
            # 退完还剩 → fail-closed（这正是"残留跟着发出去"的形状）
            snd.read_uia = lambda h, tag="uia", all_ctls=False: {"input": "还留着"}
            ok, why = snd.clear_input(1, "x")
            assert not ok and "输入框未清空" in why, why
            # 框里读不到：盲退兜底，回读也读不到时不拦（别把"读不到"变成"发不出去"）
            del sent[:]
            snd.read_uia = lambda h, tag="uia", all_ctls=False: None
            assert snd.clear_input(1, None)[0] and sent == [200], sent
        finally:
            snd.post_backspaces, snd.read_uia = old_pb, old_read
    r.case('发送闸门：清空输入框要按实读长度 + 回读确认', d6_input_gate)

    def d7_residue():
        """回车前的正文落地判据：只允许「框里的字都在正文里」，不许有正文之外的东西。

        为什么不是 `got == text`：WM_CHAR 投递**会丢字**（emoji/非 BMP，`post_text` 注释里写了），
        严格相等会让带 emoji 的正常回复永远判失败、卡在重试队列里——那比不校验更糟。
        """
        import wechat_sender as snd
        res = lambda got, text: "".join(snd._residue(got, text))
        assert res("你好", "你好") == ""                      # 完全落地
        assert res("你好", "你好😀") == "", "投递丢字（emoji 漏）不该拦"
        assert res("abc你好", "你好") == "abc", "正文之外的残留必须拦下来"
        assert res("", "你好") == "", "一个字都没进去 = 空框，交给读库兜底"
        assert res("你好abc", "你好") == "abc"
    r.case('发送闸门：正文落地判据（容忍丢字、不容忍残留）', d7_residue)

    def d8_geometry_repair_gate():
        """目标没确认上时，**值不值得**先"规范化窗口尺寸"再复核一遍。

        为什么值得离线钉住：这一步是**无条件**做的，实测白花 2.65s（修复 0.80 + 重读 2.04），
        而它后面紧跟着就是切会话——切完那次核对才是真判据。三种情形各有各的答案，
        松一格就会变成「每次发送都白搬一次用户的窗口」，紧一格就会漏掉"帧是旧帧"那类。
        """
        import wechat_sender as snd
        H = 1
        canon = (60, 40, snd.NW, snd.NH)
        shifted = (775, 208, snd.NW, snd.NH)          # 尺寸对、位置是用户自己摆的
        drifted = (775, 208, 894, 578)                # 实测过的漂移尺寸
        old = snd.win_rect
        try:
            # UIA 表头能读到 ⇒ 精确文本说了算，任何帧都别再修
            snd.win_rect = lambda h: drifted
            assert snd._needs_geometry_repair({"header": "别人"}, [], H) is False
            # 帧压根没读到 ⇒ 可能是旧帧/没重绘，ShowWindow + 那一拍有机会让它重画
            snd.win_rect = lambda h: canon
            assert snd._needs_geometry_repair(None, [], H) is True
            # 尺寸真的漂移了 ⇒ OCR 布局常量按 1280×820 标定，必须修
            snd.win_rect = lambda h: drifted
            assert snd._needs_geometry_repair(None, [(1, 2, 3, 4, "x")], H) is True
            # **帧读到了、尺寸也合规 ⇒ 别修**：表头明明白白写着别的会话，目标就是没开着。
            # 位置不算数（布局是窗口相对坐标）——用户的窗口不在 (60,40) 是常态，
            # 拿位置当判据会让每次发送都搬一次窗口再搬回来。
            snd.win_rect = lambda h: shifted
            assert snd._needs_geometry_repair(None, [(1, 2, 3, 4, "x")], H) is False
            snd.win_rect = lambda h: canon
            assert snd._needs_geometry_repair(None, [(1, 2, 3, 4, "x")], H) is False
        finally:
            snd.win_rect = old
    r.case('发送闸门：目标没确认上时，不白搬用户的窗口', d8_geometry_repair_gate)

    def d9_newline_folded():
        """正文里的换行**必须被压成空格并计数**——微信输入框静默丢弃 CR/LF。

        为什么值得离线钉住：这条缺陷的表现是 `ok=True`、`detail="已发送"`，而对方收到的是
        两段连成一串（`line oneline two`）。整条链没有任何一道会报错，**只有落库逐字比对看得见**
        （2026-10-14 实测三轮：`\\n` / `\\r\\n` / `\\r` 全被吞，且都**没有**误触发发送）。
        离线能钉住，是因为变换发生在**投递之前**——抓 `PostMessageW` 的 wParam 就看到了。
        """
        import wechat_sender as snd

        class FakeU:
            def __init__(self):
                self.cps = []

            def PostMessageW(self, h, msg, cp, lp):
                self.cps.append(cp)
                return 1

        old_u = snd.u
        snd.u = FakeU()
        try:
            assert snd.post_text(1, "A\nB", dt=0) is True
            assert snd.folded_newlines() == 1, snd.folded_newlines()
            assert snd.u.cps == [ord("A"), ord(" "), ord("B")], \
                f"换行没被换成空格，实际投了 {snd.u.cps}"
            # CRLF 是**一处**换行不是两处，否则会插两个空格
            snd.u.cps = []
            snd.post_text(1, "A\r\nB\rC\nD", dt=0)
            assert snd.folded_newlines() == 3, snd.folded_newlines()
            assert "".join(map(chr, snd.u.cps)) == "A B C D", "".join(map(chr, snd.u.cps))
            # 没换行时计数必须归零，不能被上一次的残留带偏
            snd.u.cps = []
            snd.post_text(1, "AB", dt=0)
            assert snd.folded_newlines() == 0
            # 两条上报互不干扰：emoji 照旧跳过、换行计数为 0
            assert snd.post_text(1, "A\U0001F60AB", dt=0) is True
            assert snd.dropped_nonbmp()[0] == 1 and snd.folded_newlines() == 0
        finally:
            snd.u = old_u
    r.case('发送闸门：正文里的换行压成空格并如实上报', d9_newline_folded)

    return r


def suite_E():
    """E 层：目标会话校验（verify_target）的**证据强度**——纯逻辑，用假 OCR 行。

    为什么单开一层：这条判据松一格是**发错人**（不可撤回），紧一格是**发不出去**。
    2026-10-08 的现场是紧过头那一侧：白名单里的人、环境/窗口全对，却一直 `target_unconfirmed`
    ——因为「你在干嘛？」被 OCR 读成「你在干雨7」，4 字锚点精确匹配全灭（`anchor_lcs` 门槛
    10 字，短消息永远够不着），而当时只要 `usable` 非空就不允许凭头部放行。
    """
    import wechat_core as core
    import wechat_sender as snd
    r = R("E 层：目标会话校验的证据强度")
    WW, WH = 1280, 820
    TALKER, NAME = "wxid_hanyu", "韩玉"

    def scene(header, chat):
        """一屏 OCR 行：会话列表一条（定 session_right）+ 头部 + 聊天区若干行。"""
        out = [(126, 90, 250, 105, "Loop")]
        if header:
            out.append((340, 45, 390, 60, header))
        out += [(340, 120, 520, 140, t) for t in chat]
        return out

    def with_fakes(anchors, names, fn):
        """锚点与「本机会话名」都得造假：真跑会连真实微信库（这层要能离线跑）。"""
        old_a, old_n = snd._usable_anchors, core.names
        snd._usable_anchors = lambda talker: list(anchors)
        core.names = lambda: dict(names)
        try:
            return fn()
        finally:
            snd._usable_anchors, core.names = old_a, old_n

    NAMES = {TALKER: NAME, "wxid_loop": "Loop"}

    def e1_short_anchor_garbled():
        v, why = with_fakes(["你在干嘛？"], NAMES,
                            lambda: snd.verify_target(TALKER, NAME, scene("韩玉", ["你在干雨7"]), WW, WH))
        assert v, f"短锚点被 OCR 读花、头部精确吻合时不该拒绝：{why}"
    r.case("短锚点被 OCR 读花 + 头部精确 ⇒ 放行（2026-10-08 故障的回归锁）", e1_short_anchor_garbled)

    def e2_wrong_chat_open():
        v, _ = with_fakes(["你在干嘛？"], NAMES,
                          lambda: snd.verify_target(TALKER, NAME, scene("杨冬", ["你在干雨7"]), WW, WH))
        assert not v, "头部是别的会话时必须拒绝"
    r.case("短锚点读花 + 开着别的会话 ⇒ 拒绝", e2_wrong_chat_open)

    def e3_embedded_name():
        # 本机真实存在的形状：`韩玉` / `韩玉妈`（一个名字嵌在另一个里，相似度 0.80）
        names = {TALKER: "韩玉", "wxid_mama": "韩玉妈", "wxid_loop": "Loop"}
        v1, _ = with_fakes(["在吗"], names,
                           lambda: snd.verify_target(TALKER, "韩玉", scene("韩玉妈", ["在吗"]), WW, WH))
        assert not v1, "开着「韩玉妈」时不许当成「韩玉」"
        v2, _ = with_fakes(["在吗"], names,
                           lambda: snd.verify_target("wxid_mama", "韩玉妈", scene("韩玉", ["在吗"]), WW, WH))
        assert not v2, "开着「韩玉」时不许当成「韩玉妈」"
    r.case("名字嵌名字（韩玉 / 韩玉妈）：两个方向都不放行", e3_embedded_name)

    def e4_duplicate_names():
        # 本机实测三个 loop：这种头部照出谁都一样，凭它放行 = 抽签发错人
        names = {TALKER: "韩玉", "wxid_hanyu2": "韩玉", "wxid_loop": "Loop"}
        v, _ = with_fakes(["在吗"], names,
                          lambda: snd.verify_target(TALKER, "韩玉", scene("韩玉", ["在吗"]), WW, WH))
        assert not v, "重名会话时头部不含区分信息，不许单独放行"
    r.case("重名会话（两个「韩玉」）⇒ 头部证明不了什么，拒绝", e4_duplicate_names)

    def e5_long_anchor_missing():
        # 2026-10-09 改判：原判据「长锚点没命中 ⇒ 不许凭头部放行」已撤。理由见 verify_target ③
        # ——聊天区 OCR 读花是常态，命中数会随机翻转（同一操作 12:24 命中 3 / 13:06 命中 0），
        # 一个随 OCR 运气翻转的门禁挡不住错发，只让回复常态性进补发队列。
        # 头部精确吻合（hr=1.00）且没有别人跟它一样像时，放行。
        v, why = with_fakes(["明天下午三点我们公司门口见"], NAMES,
                            lambda: snd.verify_target(TALKER, NAME, scene("韩玉", ["明天下午我们门口碰头"]), WW, WH))
        assert v, f"头部精确吻合且能区分是谁时，长锚点缺位不该否决：{why}"
    r.case("长锚点没命中 + 头部精确且能区分 ⇒ 放行（2026-10-09 撤掉否决）", e5_long_anchor_missing)

    def e6_garbled_header_still_rejected():
        # 撤掉锚点否决**不等于**放低头部门槛：头部读不全（hr 掉到 0.85 以下）时仍拒绝。
        v, _ = with_fakes(["明天下午三点我们公司门口见"], NAMES,
                          lambda: snd.verify_target(TALKER, NAME, scene("韩", ["明天下午我们门口碰头"]), WW, WH))
        assert not v, "头部读不全（hr<0.85）又没锚点时不许放行"
    r.case("长锚点没命中 + 头部读不全 ⇒ 仍然拒绝（门槛没跟着松）", e6_garbled_header_still_rejected)

    return r


def suite_F():
    """F 层：窗口不在时的**自恢复发送闸门**（`env_gate` / `wake_window`）——纯逻辑，假窗口。

    为什么单开一层：`check_env` 的严格闸门是给**报告**用的（如实说环境如何），但代聊回路的
    现实是「人不在电脑前 ⇒ 微信常是最小化或收进托盘 ⇒ 自己不恢复就永远发不出去」。2026-10-08
    实测被它挡了两次（22:33 Loop、22:37 韩玉）。这层钉五件事：
      1. 最小化 → 还原一次后复检，复检过了就放行；
      2. 还原不动（或没有窗口句柄）→ 照旧拒发，不假装成功；
      3. 本来可用 → **不碰窗口**（别平白把用户的窗口拎到前台）；
      4. 没运行 → 不还原、直接拒（恢复不了）；
      5. 收进托盘（隐藏态）→ 用 `include_hidden` 把句柄找回来再还原（用户 2026-10-09 决策
         「一律自动拉起」）；还原一律走 `SW_SHOWNOACTIVATE`，实测两种态都不抢前台。
    """
    import wechat_sender as snd
    r = R("F 层：最小化自恢复（发送闸门）")

    def with_env(seq, find_hwnd, fn, unfreeze=True, tray=None):
        """`check_env` 按 seq 依次返回（用完后重复最后一个）；`ShowWindow`/`sleep`/`_unfreeze_ui` 打桩。

        `_unfreeze_ui` 必须打桩：托盘拉起那条路会真去点系统托盘，测试里绝不能碰真桌面。
        """
        st = {"n": 0}

        def fake_check_env():
            i = min(st["n"], len(seq) - 1)
            st["n"] += 1
            return dict(seq[i])

        shown = []
        old = (snd.check_env, snd.find_main_hwnd, snd.u.ShowWindow, snd.time.sleep, snd._unfreeze_ui)
        snd.check_env = fake_check_env
        # 还原路径会用 include_hidden=True 找隐藏窗口；这里两种口径都给同一个假句柄
        snd.find_main_hwnd = lambda include_hidden=False: find_hwnd
        # 传入的是 ctypes.c_void_p，这里归一成整数，免得断言被 c_void_p 包装挡住
        snd.u.ShowWindow = lambda h, n: shown.append((getattr(h, "value", h), n))
        snd.time.sleep = lambda *_: None

        def fake_unfreeze(tag="tray"):
            if tray is not None:
                tray.append(tag)
            return unfreeze
        snd._unfreeze_ui = fake_unfreeze
        try:
            return fn(shown, st)
        finally:
            (snd.check_env, snd.find_main_hwnd, snd.u.ShowWindow, snd.time.sleep, snd._unfreeze_ui) = old

    MIN = {"ok": False, "reason": "主窗口已最小化", "minimized": True,
           "visible": True, "weixin_running": True, "hwnd": 199150}
    # 收进托盘：进程在、句柄在，但按可见性过滤找不到 ⇒ hwnd=0，只能靠 include_hidden 捞回来
    HID = {"ok": False, "reason": "主窗口不可见（可能已隐藏到托盘）", "minimized": False,
           "visible": False, "weixin_running": True, "hwnd": 0}
    OK = {"ok": True, "reason": "", "minimized": False,
          "visible": True, "weixin_running": True, "hwnd": 199150}
    GONE = {"ok": False, "reason": "未检测到微信进程（Weixin.exe 未运行）", "minimized": False,
            "visible": False, "weixin_running": False, "hwnd": 0}

    def f1_restores_and_passes():
        """最小化也要走托盘图标拉起：SW_RESTORE/SW_SHOWNOACTIVATE 出来的窗口只渲染不收输入。"""
        tray = []

        def run(shown, st):
            ok, s = snd.env_gate()
            assert ok and s["ok"], "恢复后复检通过就该放行"
            assert tray == ["wake"], f"最小化应经托盘图标拉起一次：{tray}"
            assert shown == [], f"不该退回 SW_SHOWNOACTIVATE：{shown}"
            assert st["n"] == 2, f"应当复检一次：{st['n']}"
        with_env([MIN, OK], 0, run, tray=tray)
    r.case("最小化 ⇒ 托盘图标拉起一次 + 复检 ⇒ 放行", f1_restores_and_passes)

    def f2_stays_minimized():
        def run(_shown, _st):
            ok, _s = snd.env_gate()
            assert not ok, "恢复不动时必须拒发（不许带着最小化的窗口往下做）"
        tray = []
        with_env([MIN], 0, run, tray=tray)
        assert tray == ["wake"], f"该试过用托盘图标拉起一次：{tray}"
    r.case("恢复不动（仍最小化）⇒ 拒发", f2_stays_minimized)

    def f3_no_hwnd():
        def run(shown, _st):
            ok, _s = snd.env_gate()
            assert not ok and shown == [], "拿不到窗口句柄时不许瞎点，直接拒"
        with_env([{**MIN, "hwnd": 0}], 0, run)
    r.case("最小化但拿不到句柄 ⇒ 拒发且不碰窗口", f3_no_hwnd)

    def f4_already_ok():
        def run(shown, st):
            ok, _s = snd.env_gate()
            assert ok and shown == [], "本来就 ok 就不许碰窗口"
            assert st["n"] == 1, "本来就 ok 不必复检"
        with_env([OK], 0, run)
    r.case("本来 ok ⇒ 一次都不碰窗口", f4_already_ok)

    def f5_not_running():
        def run(shown, _st):
            ok, s = snd.env_gate()
            assert not ok and shown == [], "微信没运行不是「恢复」能解决的，直接拒"
            assert "未运行" in s["reason"]
        with_env([GONE], 199150, run)
    r.case("微信没运行 ⇒ 拒发（不尝试恢复）", f5_not_running)

    def f6_locked_but_window_unusable():
        """锁屏放行只放"锁屏"这一条：窗口最小化/不可见时照样拒——否则会跑满 30s 被 MCP 超时杀掉，
        而超时不是错误码，Provider 归不出 `env_not_ready`，那条回复就静默没了（2026-10-09 实测）。"""
        def run(_shown, _st):
            ok, _s = snd.env_gate(allow_locked=True)
            assert not ok, "锁屏不是「窗口读不了」的通行证"
        tray = []
        with_env([{**MIN, "locked": True}], 0, run, tray=tray)
        assert tray == ["wake"], "仍该试过拉起一次"
    r.case("锁屏 + 最小化 ⇒ 仍拒发（不许带着读不了的窗口往下做）", f6_locked_but_window_unusable)

    def f7_locked_and_usable_passes():
        """反面：窗口可用时锁屏必须放行——否则全投递的锁屏能力（实测 LOCK-9 全链）会被这道闸门挡掉。"""
        def run(_shown, _st):
            ok, _s = snd.env_gate(allow_locked=True)
            assert ok, "窗口可用 + 锁屏 ⇒ 全投递能发，不该拦"
        with_env([{**OK, "locked": True}], 0, run)
    r.case("锁屏 + 窗口可用 ⇒ 放行（锁屏不挡投递）", f7_locked_and_usable_passes)

    def f8_hidden_restores():
        """收进托盘（隐藏态）：按可见性过滤拿不到句柄，必须靠 `include_hidden=True` 捞回来再拉起。
        用户 2026-10-09 决策「一律自动拉起（含托盘）」——不还原的代价是那条回复最多在补发队列里
        躺 30 分钟然后被丢掉。**拉起必须走托盘图标 InvokePattern**：SW_SHOWNOACTIVATE 拉出来的
        窗口只渲染不收输入，后面切会话/搜索/发正文全都会失败（2026-10-11 实测）。"""
        tray = []

        def run(shown, st):
            ok, s = snd.env_gate()
            assert ok and s["ok"], "收进托盘 ⇒ 拉起后复检通过就该放行"
            assert tray == ["wake"], f"隐藏态应用托盘图标拉起一次：{tray}"
            assert shown == [], f"隐藏态不该走 SW_SHOWNOACTIVATE：{shown}"
            assert st["n"] == 2, f"应当复检一次：{st['n']}"
        with_env([HID, OK], 199150, run, tray=tray)
    r.case("收进托盘 ⇒ 托盘图标拉起一次 + 复检 ⇒ 放行", f8_hidden_restores)

    def f9_hidden_unrestorable():
        """隐藏态但连隐藏窗口都找不到（未登录 / 句柄都没了）⇒ 照旧拒发，不假装成功。"""
        def run(shown, _st):
            ok, s = snd.env_gate()
            assert not ok and shown == [], "找不到句柄就不许瞎点"
            assert "不可见" in s["reason"]
        with_env([HID], 0, run)
    r.case("收进托盘但捞不到句柄 ⇒ 拒发且不碰窗口", f9_hidden_unrestorable)

    return r


def suite_G():
    """G 层：锁屏识别（`session_locked`）——把「锁屏」与「窗口没在前台」分开。

    为什么单开一层：锁屏期间输入桌面是安全的 Winlogon 桌面，`SendInput`/`keybd_event`/
    `SetForegroundWindow` **一律够不着**，可窗口状态看上去全绿（visible、未最小化、
    foreground 也可能是真）。不做这个判定就会把"锁屏"报成"窗口尺寸不对 / 切不到前台"，
    让人白折腾着去拖窗口、点窗口（2026-10-09 实测，代聊就是这么误报的）。
    这层钉：桌面名才是判据；锁屏时 `check_env` 必须 ok=False 且 reason 说清是锁屏；
    `Win` 的前台失败也必须归因到锁屏，而不是"窗口有问题"。
    """
    import wechat_sender as snd
    r = R("G 层：锁屏识别")

    def with_stubs(mods, us, fn):
        old_m = {k: getattr(snd, k) for k in mods}
        old_u = {k: getattr(snd.u, k) for k in us}
        for k, v in mods.items():
            setattr(snd, k, v)
        for k, v in us.items():
            setattr(snd.u, k, v)
        try:
            return fn()
        finally:
            for k, v in old_m.items():
                setattr(snd, k, v)
            for k, v in old_u.items():
                setattr(snd.u, k, v)

    DESKTOP = {"OpenInputDesktop": None, "GetUserObjectInformationW": None, "CloseDesktop": None}

    def fake_desktop(name, handle=0x1234):
        def open_desktop(*_a):
            return handle

        def get_name(_h, _idx, buf, _size, _need):
            buf.value = name
            return True
        return {"OpenInputDesktop": open_desktop, "GetUserObjectInformationW": get_name,
                "CloseDesktop": lambda _h: True}

    # 判据一是「前台是 LockApp（类名 Windows.UI.Core.CoreWindow + 标题含锁屏）」——
    # 它要先于桌面名判据跑，所以测桌面名时必须把它按掉（前台=0），否则跑测试的机器
    # 一旦真锁着屏，Default 那条用例会被前台判据抢先命中而假红。
    NO_LOCKAPP = {"GetForegroundWindow": lambda: 0}

    def fake_lockapp(title="Windows 默认锁屏界面"):
        def cls(_h, buf, _size):
            buf.value = "Windows.UI.Core.CoreWindow"
            return len(buf.value)
        return {"GetForegroundWindow": lambda: 111, "GetClassNameW": cls,
                "GetWindowTextLengthW": lambda _h: len(title),
                "GetWindowTextW": lambda _h, buf, _n: setattr(buf, "value", title) or len(title)}

    def g0():
        st = fake_lockapp()
        assert with_stubs({}, {**DESKTOP, **st}, snd.session_locked) is True, \
            "前台是 LockApp 的锁屏界面=锁屏（Win11 主力判据）"
    r.case("前台是 LockApp 锁屏界面 ⇒ 判为锁屏（Win11 判据）", g0)

    def g1():
        st = fake_desktop("Winlogon")
        assert with_stubs({}, {**DESKTOP, **NO_LOCKAPP, **st}, snd.session_locked) is True, "Winlogon 桌面=锁屏"
    r.case("输入桌面是 Winlogon ⇒ 判为锁屏", g1)

    def g2():
        st = fake_desktop("Default")
        assert with_stubs({}, {**DESKTOP, **NO_LOCKAPP, **st}, snd.session_locked) is False, "Default=没锁屏"
    r.case("输入桌面是 Default ⇒ 没锁屏", g2)

    def g3():
        st = dict(DESKTOP, **NO_LOCKAPP, OpenInputDesktop=lambda *a: 0, CloseDesktop=lambda _h: True)
        assert with_stubs({}, st, snd.session_locked) is True, "连输入桌面都打不开=锁屏"
    r.case("OpenInputDesktop 失败 ⇒ 判为锁屏", g3)

    WININFO = {"IsWindowVisible": lambda _h: True, "IsIconic": lambda _h: False,
               "GetForegroundWindow": lambda: 199150, "GetDpiForWindow": lambda _h: 96}

    def g4():
        mods = {"weixin_pids": lambda: [1], "find_main_hwnd": lambda: 199150,
                "session_locked": lambda: True, "win_rect": lambda _h: (0, 0, 1280, 820)}
        info = with_stubs(mods, WININFO, snd.check_env)
        assert info["locked"] is True, "check_env 要把 locked 报出来（否则调用方只能猜）"
        assert info["ok"] is False, "锁屏时 ok 必须为 False——「能发吗」的答案是不能"
        assert "锁屏" in info["reason"], f"reason 得说清是锁屏，别甩给窗口：{info['reason']}"
    r.case("锁屏时 check_env：locked=true / ok=false / reason 点名锁屏", g4)

    def g5():
        mods = {"check_env": lambda: {"ok": True, "hwnd": 199150, "rect": (0, 0, 1280, 820),
                                      "reason": ""},
                "bring_to_front": lambda _h: False, "session_locked": lambda: True}
        def run():
            try:
                snd.Win().__enter__()
                raise AssertionError("拿不到前台还在锁屏，必须中止")
            except RuntimeError as e:
                assert "锁屏" in str(e), f"前台失败要归因到锁屏：{e}"
                assert "尺寸" not in str(e), "别把锁屏说成尺寸问题"
        with_stubs(mods, {}, run)
    r.case("锁屏时前台失败 ⇒ 报「已锁屏」，不报尺寸/窗口", g5)

    return r


def suite_H():
    """H 层：`read_ui_stable` 的重试预算——**读到字就算读到**，别拿「右侧有内容」当判据。

    为什么单开一层：没开会话 / 开着搜索浮层时聊天区本来就空，但左边会话列表还在、字也都读到了。
    旧判据（`header or chat_text`）在这两种形态下每处白等 4 轮 ≈ 8s，而一轮失败的 `send_text`
    要过 4–8 处这样的读——实测耗到 **29.7s**，离 MCP 客户端的 30s 超时只差 283ms。
    超时不是错误码 ⇒ Provider 归不出 `env_not_ready` ⇒ 那条回复静默没了（2026-10-09 实测）。
    """
    import wechat_sender as snd
    r = R("H 层：读界面重试预算")

    # 只有左侧列表、右侧空白的一帧——正是「没开会话/搜索浮层」的真实形态
    LIST_ONLY = [(126, 97, 196, 109, "产 品 术 部"), (126, 558, 300, 570, "文 件 传 输 助 手")]
    # 聊天区开着的一帧（对照：两种形态都必须一次返回）
    WITH_CHAT = LIST_ONLY + [(324, 49, 408, 61, "文 件 传 输 助 手"), (800, 300, 900, 312, "LOCK-9")]

    def run_with(frames, fn):
        """read_ui 按 frames 依次返回（用完后重复最后一个）；sleep/post_click/find_main_hwnd 打桩。"""
        st = {"n": 0}
        clicks = []

        def fake_read_ui(tag):
            i = min(st["n"], len(frames) - 1)
            st["n"] += 1
            return 1280, 820, list(frames[i])

        old = (snd.read_ui, snd.time.sleep, snd.find_main_hwnd, snd.post_click)
        snd.read_ui = fake_read_ui
        snd.time.sleep = lambda *_: None
        snd.find_main_hwnd = lambda: 199150
        snd.post_click = lambda h, x, y: clicks.append((x, y))
        try:
            return fn(st, clicks)
        finally:
            (snd.read_ui, snd.time.sleep, snd.find_main_hwnd, snd.post_click) = old

    def h1_list_only_returns_first_try():
        def run(st, clicks):
            ww, wh, lines = snd.read_ui_stable("t")
            assert st["n"] == 1, f"读到了就该立刻返回，别白等 4 轮：试了 {st['n']} 次"
            assert lines == LIST_ONLY, "返回的得是这一帧的行"
            assert clicks == [], "读到了就不该再逼重绘（那会点掉正开着的搜索浮层）"
        run_with([LIST_ONLY], run)
    r.case("只有会话列表（没开会话/搜索浮层）⇒ 一次返回，不逼重绘", h1_list_only_returns_first_try)

    def h2_with_chat_returns_first_try():
        def run(st, _clicks):
            _ww, _wh, lines = snd.read_ui_stable("t")
            assert st["n"] == 1 and lines == WITH_CHAT
        run_with([WITH_CHAT], run)
    r.case("聊天区开着 ⇒ 一次返回", h2_with_chat_returns_first_try)

    def h3_truly_blank_still_retries():
        """反面：真空白（OCR 一行都没读到）仍要重试到上限——这条别被上面两条顺手删掉。"""
        def run(st, clicks):
            ww, wh, lines = snd.read_ui_stable("t", tries=4)
            assert st["n"] == 4, f"真空白才该试满：试了 {st['n']} 次"
            assert lines == [] and (ww, wh) == (1280, 820)
            assert len(clicks) == 1, f"应在首轮空白时逼重绘**一次**：{clicks}"
        run_with([[]], run)
    r.case("真空白 ⇒ 试满 + 首轮逼重绘一次", h3_truly_blank_still_retries)

    def h4_blank_then_ok():
        def run(st, _clicks):
            _ww, _wh, lines = snd.read_ui_stable("t")
            assert st["n"] == 2 and lines == LIST_ONLY, "第二帧读到了就该收手"
        run_with([[], LIST_ONLY], run)
    r.case("首帧空白、次帧读到 ⇒ 第二次收手", h4_blank_then_ok)

    return r


def suite_I():
    """I 层：画像 scope 路由（`wechat_profile_get` 能不能把**用户本人**那份读回来）。

    为什么单开一层：`_resolve_scope` 曾把 `self`/`me`/`我` 一并归一成 `None`，而
    `core.profile_get(None)` 的语义是「**列出**已产出的画像文件」——于是
    `wechat_profile_get(scope="self")` 静默返回 `{dir, files}`（**没有 content/exists**）。
    调用方 `bridge.ts` 的判据是 `got.exists !== undefined && !content.trim()`，拿到 undefined
    就按「不缺失」处理 → **「关于我（本人）」这份画像从来没进过代聊的提示词**，
    而模型按工作流去查每次都得到"没有"，于是每轮重新蒸馏重建一遍。
    这层钉两件事：显式 self 必须读回**正文**；不给 scope 才允许只列清单。
    """
    import server

    r = R("I 层：画像 scope 路由")
    tmp = tempfile.mkdtemp(prefix="lumii-distill-")
    old_env = os.environ.get("LUMII_WECHAT_DISTILL")
    os.environ["LUMII_WECHAT_DISTILL"] = tmp
    try:
        server.tool_profile_save({"scope": "self", "content": "# 我\n说话短，爱用「好的」。"})

        def i0():
            got = server.tool_profile_get({"scope": "self"})
            assert "content" in got, f"显式 self 必须读回正文，而不是目录清单：{sorted(got)}"
            assert got.get("exists") is True, f"self.md 刚写过，exists 该为真：{got}"
            assert "好的" in got["content"], "读回来的必须是本人画像正文"
        r.case("scope=self ⇒ 读回本人画像正文（不是列清单）", i0)

        def i1():
            for alias in ("me", "我", "本人"):
                got = server.tool_profile_get({"scope": alias})
                assert "content" in got and got.get("exists") is True, f"{alias} 该与 self 同义：{got}"
        r.case("me / 我 / 本人 ⇒ 与 self 同义", i1)

        def i2():
            got = server.tool_profile_get({})
            assert "files" in got and "content" not in got, \
                f"不给 scope 才该只列清单（不给正文）：{got}"
        r.case("不给 scope ⇒ 只列已产出的画像文件", i2)

        def i3():
            """反面：scope 给了但解析不出来，要**报错**，不能退回列清单（那会重演静默失效）。"""
            got = server.tool_profile_get({"scope": "不存在的会话名xyz"})
            assert got.get("error_code") == "target_not_found", f"解析不出来该报 target_not_found：{got}"
        r.case("scope 解析不出来 ⇒ 报错，不退回列清单", i3)

        def i4():
            """蒸馏水位与画像走**同一个 self 键**（`state.json` 里就是 "self"），别一个 None 一个 "self"。"""
            server.tool_distill_state({"action": "set", "scope": "self", "ts": 1791532458})
            assert server.tool_distill_state({}).get("since") == 1791532458, "self 水位该被记住"
            assert server.tool_distill_state({"scope": "self"}).get("since") == 1791532458, \
                "给 scope=self 读水位要与不给一致"
        r.case("水位：set(scope=self) 与 get(不给) 是同一个键", i4)
    finally:
        if old_env is None:
            os.environ.pop("LUMII_WECHAT_DISTILL", None)
        else:
            os.environ["LUMII_WECHAT_DISTILL"] = old_env
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)

    return r


def suite_J():
    """J 层：微信数据目录探测（自定义目录 / 其他盘 / env）。

    为什么单开一层：旧实现只认 `~/xwechat_files`、`~/Documents/xwechat_files` 和 3.x 的
    注册表键 `Tencent\\WeChat\\FileSavePath`；微信 4.x 把自定义目录写在
    `%APPDATA%\\Tencent\\xwechat\\config\\*.ini`，且数据目录可落在**任意盘**。
    这层钉三件事：ini 能解析出来、被搬到其他盘的目录能被扫到、env 显式路径优先。
    """
    import wechat_core as core
    import shutil

    r = R("J 层：数据目录探测（ini / 其他盘 / env）")
    tmp = tempfile.mkdtemp(prefix="lumii-dbdir-")
    try:
        def mk(base, wxid_dir):
            """在 base 下造 `<base>/xwechat_files/<wxid_dir>/db_storage/…`，返回 db_storage。"""
            root = os.path.join(base, "xwechat_files", wxid_dir, "db_storage")
            os.makedirs(os.path.join(root, "message"), exist_ok=True)
            with open(os.path.join(root, "message", "message_0.db"), "wb") as f:
                f.write(b"x")
            return root

        # 1) ini 解析：纯路径 / Key=值 / Key: 值 三种写法都要认得
        def j0():
            for line, expect in (
                (r"C:\Users\Administrator", r"C:\Users\Administrator"),
                (r"MyDocument=D:\微信", r"D:\微信"),
                (r"My Document: D:\WeChatData", r"D:\WeChatData"),
            ):
                got = core._parse_ini_paths(line + "\n; 注释\n# 注释\n")
                assert got == [expect], f"{line!r} 应解析为 [{expect!r}]，实得 {got}"
        r.case("ini 三种写法（纯路径 / Key=值 / Key: 值）都能解析", j0)

        # 2) 路径归一：xwechat_files 本体 / 其父目录 / 账号目录 三种形态都认
        def j1():
            xf = os.path.join(tmp, "xwechat_files")
            acc = os.path.join(xf, "wxid_a_9c2d")
            mk(tmp, "wxid_a_9c2d")                 # tmp/xwechat_files/wxid_a_9c2d/db_storage
            assert core._resolve_xwechat_dir(xf) == xf, "给 xwechat_files 本体"
            assert core._resolve_xwechat_dir(tmp) == xf, "给 xwechat_files 的父目录"
            assert core._resolve_xwechat_dir(acc) == xf, "给账号目录"
        r.case("_resolve_xwechat_dir：父目录 / 本体 / 账号目录都能归一", j1)

        # 3) ini 命中即止 → source=ini（不再扫盘）
        def j2():
            base = os.path.join(tmp, "custom_base")
            mk(base, "wxid_b_5f3a")
            old_ini, old_reg = core._ini_bases, core._registry_bases
            core._ini_bases, core._registry_bases = (lambda: [base]), (lambda: [])
            try:
                accts = core.list_accounts()
                assert accts and accts[0]["source"] == "ini", f"该由 ini 命中：{accts}"
                assert accts[0]["wxid"] == "wxid_b", f"wxid 该从目录名反推：{accts}"
            finally:
                core._ini_bases, core._registry_bases = old_ini, old_reg
        r.case("ini 命中的自定义目录 ⇒ source=ini、wxid 反推正确", j2)

        # 4) 数据目录被搬到**另一块盘**的二级目录 → 有界扫描找得到
        def j4():
            drive = os.path.join(tmp, "F_drive")          # 冒充固定盘根
            os.makedirs(drive, exist_ok=True)
            mk(os.path.join(drive, "微信"), "wxid_c_1234")   # F:\微信\xwechat_files\...
            found = core._scan_xwechat_dirs([drive])
            assert os.path.join(drive, "微信", "xwechat_files") in found, \
                f"深度 2 的扫描该找到 F:\\微信\\xwechat_files：{found}"
        r.case("其他盘的二级目录（…\\微信\\xwechat_files）能被有界扫描找到", j4)

        # 5) LUMII_WECHAT_DB 显式路径优先，且能接受 db_storage / xwechat_files / 父目录三种
        def j5():
            base = os.path.join(tmp, "env_base")
            root = mk(base, "wxid_d_abcd")
            old_env = os.environ.get("LUMII_WECHAT_DB")
            try:
                for given, expect in (
                    (root, root),
                    (os.path.join(base, "xwechat_files"), root),
                    (base, root),
                ):
                    os.environ["LUMII_WECHAT_DB"] = given
                    got, src = core.db_root_info()
                    assert (got, src) == (expect, "env"), f"env={given!r} → 期望 env 源：{(got, src)}"
            finally:
                if old_env is None:
                    os.environ.pop("LUMII_WECHAT_DB", None)
                else:
                    os.environ["LUMII_WECHAT_DB"] = old_env
        r.case("LUMII_WECHAT_DB 优先，且接受 db_storage / xwechat_files / 父目录", j5)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    return r


def suite_K():
    """K 层：发送前**按序状态机**（preflight）与 repair_env。

    钉四件事：① 失败时**按 proc→window→restore→foreground 的序**给出档位（不是一句笼统的"环境不行"）；
    ② 尺寸不合规在 fix=False 时**不算失败**（只报告 size_ok），免得每次发送都搬窗口——
       规范化只在目标确认失败后**按需**触发；③ fix=True 才搬窗口；④ repair_env 能如实汇报动作。
    """
    import wechat_core as core
    import wechat_sender as snd

    r = R("K 层：发送前状态机与 repair_env")

    def with_stub(seq, find_hwnd, fn, rect=(0, 0, 894, 578), front=None, db=None, tray=None):
        st = {"n": 0}

        def fc():
            i = min(st["n"], len(seq) - 1)
            st["n"] += 1
            return dict(seq[i])

        shown, moved = [], []
        old = (snd.check_env, snd.find_main_hwnd, snd.u.ShowWindow, snd.time.sleep,
               snd.win_rect, snd.u.MoveWindow, snd.bring_to_front, core.db_root_info, snd._unfreeze_ui)
        snd.check_env = fc
        snd.find_main_hwnd = lambda include_hidden=False: find_hwnd
        snd.u.ShowWindow = lambda h, n: shown.append((getattr(h, "value", h), n))
        snd.time.sleep = lambda *_: None
        snd.win_rect = lambda h: rect
        snd.u.MoveWindow = lambda h, x, y, w, hh, rp: moved.append((x, y, w, hh))
        snd.bring_to_front = front or (lambda h, tries=3: True)

        def fake_unfreeze(tag="tray"):
            if tray is not None:
                tray.append(tag)
            return True
        snd._unfreeze_ui = fake_unfreeze       # 必须打桩：托盘拉起会真去点系统托盘
        if db is not None:
            core.db_root_info = db
        try:
            return fn(shown, moved, st)
        finally:
            (snd.check_env, snd.find_main_hwnd, snd.u.ShowWindow, snd.time.sleep,
             snd.win_rect, snd.u.MoveWindow, snd.bring_to_front, core.db_root_info,
             snd._unfreeze_ui) = old

    RUN = {"ok": True, "reason": "", "minimized": False, "visible": True, "locked": False,
           "weixin_running": True, "hwnd": 199150, "rect": [60, 40, 1280, 820]}
    BAD = {**RUN, "rect": [0, 0, 894, 578]}
    GONE = {"ok": False, "reason": "未检测到微信进程", "minimized": False, "visible": False,
            "locked": False, "weixin_running": False, "hwnd": 0, "rect": None}
    MIN = {"ok": False, "reason": "主窗口已最小化", "minimized": True, "visible": True,
           "locked": False, "weixin_running": True, "hwnd": 199150, "rect": [60, 40, 1280, 820]}
    NOHWND = {"ok": False, "reason": "找不到主窗口", "minimized": False, "visible": False,
              "locked": False, "weixin_running": True, "hwnd": 0, "rect": None}
    # 2026-10-12 实测现场：`visible=True`、没最小化，但位置在桌面外
    OFF = {**RUN, "ok": False, "onscreen": False, "reason": "主窗口被搬到桌面外",
           "rect": [-32000, -32000, 440, 452]}

    def k1_proc():
        def run(_s, _m, _st):
            ok, stage, detail, _i = snd.preflight()
            assert not ok and stage == "proc", (ok, stage)
            assert "环境前置检查" in detail, detail
        with_stub([GONE], 0, run)
    r.case("进程未运行 ⇒ stage=proc（第一道）", k1_proc)

    def k2_window():
        def run(_s, _m, _st):
            ok, stage, _d, _i = snd.preflight()
            assert not ok and stage == "window", (ok, stage)
        with_stub([NOHWND], 0, run)
    r.case("拿不到主窗口 ⇒ stage=window", k2_window)

    def k3_restore():
        tray = []

        def run(_shown, _m, _st):
            ok, stage, _d, _i = snd.preflight()
            assert not ok and stage == "restore", (ok, stage)
        with_stub([MIN, MIN], 199150, run, tray=tray)
        assert tray == ["wake"], f"该试过用托盘图标拉起一次：{tray}"
    r.case("还原后仍最小化 ⇒ stage=restore（拒发）", k3_restore)

    def k4_size_reported_not_failed():
        def run(_s, moved, _st):
            ok, stage, _d, info = snd.preflight(fix=False)
            assert ok and stage == "ok", (ok, stage)
            assert info.get("size_ok") is False, f"尺寸不合规要如实报告：{info.get('size_ok')}"
            assert moved == [], "fix=False 时不许搬窗口"
        with_stub([BAD], 199150, run)
    r.case("尺寸不合规 + fix=False ⇒ 不算失败、不搬窗口，只报告 size_ok=False", k4_size_reported_not_failed)

    def k5_size_fixed():
        def run(_s, moved, _st):
            ok, stage, _d, info = snd.preflight(fix=True)
            assert ok and stage == "ok", (ok, stage)
            assert info.get("size_ok") is True, "复检该已合规"
            assert moved == [(60, 40, 1280, 820)], f"fix=True 该规范化到预设尺寸：{moved}"
        with_stub([BAD, RUN], 199150, run)
    r.case("尺寸不合规 + fix=True ⇒ 规范化到预设尺寸并复检", k5_size_fixed)

    def k6_foreground_fails():
        def run(_s, _m, _st):
            ok, stage, _d, _i = snd.preflight(need_foreground=True)
            assert not ok and stage == "foreground", (ok, stage)
        with_stub([RUN], 199150, run, front=lambda h, tries=3: False)
    r.case("需要前台但切不过去 ⇒ stage=foreground", k6_foreground_fails)

    def k7_locked_delivery_ok():
        def run(_s, _m, _st):
            ok, _stage, _d, _i = snd.preflight(need_foreground=False, allow_locked=True)
            assert ok, "投递路锁屏不该拦（锁屏照发）"
        with_stub([{**RUN, "locked": True}], 199150, run)
    r.case("锁屏 + 投递路（allow_locked）⇒ 放行", k7_locked_delivery_ok)

    def k8_locked_needs_foreground():
        def run(_s, _m, _st):
            ok, stage, _d, _i = snd.preflight(need_foreground=True, allow_locked=True)
            assert not ok and stage == "foreground", (ok, stage)
        with_stub([{**RUN, "locked": True}], 199150, run)
    r.case("锁屏 + 需要前台 ⇒ stage=foreground", k8_locked_needs_foreground)

    def k9_repair_env_normalizes():
        def run(_s, moved, _st):
            out = snd.repair_env()
            assert out["db"]["ok"] and out["db"]["source"] == "stub", out["db"]
            assert any("窗口已规范化" in a for a in out["actions"]), out["actions"]
            assert moved == [(60, 40, 1280, 820)], f"repair 该规范化窗口：{moved}"
        with_stub([BAD, RUN], 199150, run, rect=(0, 0, 894, 578),
                  db=lambda: (r"C:\x\xwechat_files\wxid_a_1234\db_storage", "stub"))
    r.case("repair_env：尺寸异常 ⇒ 规范化窗口 + 重探数据目录并汇报", k9_repair_env_normalizes)

    # ── 窗口被搬到桌面外（2026-10-12 实测）─────────────────────────────────────────
    # 现场：`visible=True`、`iconic=False`、`rect=-32000,-32000 440x452`——Win32 眼里窗口一直
    # "显示着"，于是微信自己的托图标 toggle 方向正好反了、任务栏点了也没反应，用户彻底找不回
    # 微信界面。`-32000` 正是最小化窗口在 `GetWindowRect` 里的哨兵值（见 `_uia_origin`），
    # 而发送收尾的「还原几何」会把它照抄回去 ⇒ 钉死。这组钉住：判据、搬回、以及**不许还原**。
    def with_win(rect, fn, visible=True, iconic=False):
        """真跑 `check_env`，只把窗口探针换掉（这层测的就是 check_env 自己的判据）。"""
        moved = []
        old = (snd.weixin_pids, snd.find_main_hwnd, snd.session_locked, snd.win_rect,
               snd.u.IsWindowVisible, snd.u.IsIconic, snd.u.GetForegroundWindow,
               snd.u.GetDpiForWindow, snd.u.MoveWindow, snd._virtual_screen,
               core.list_accounts, core.self_wxid)
        snd.weixin_pids = lambda: [19732]
        snd.find_main_hwnd = lambda include_hidden=False: 199150
        snd.session_locked = lambda: False
        snd.win_rect = lambda h: rect
        snd.u.IsWindowVisible = lambda h: visible
        snd.u.IsIconic = lambda h: iconic
        snd.u.GetForegroundWindow = lambda: 199150
        snd.u.GetDpiForWindow = lambda h: 96
        snd.u.MoveWindow = lambda h, x, y, w, hh, rp: moved.append((x, y, w, hh))
        snd._virtual_screen = lambda: (0, 0, 2560, 1440)
        core.list_accounts = lambda: []
        core.self_wxid = lambda: None
        try:
            return fn(moved)
        finally:
            (snd.weixin_pids, snd.find_main_hwnd, snd.session_locked, snd.win_rect,
             snd.u.IsWindowVisible, snd.u.IsIconic, snd.u.GetForegroundWindow,
             snd.u.GetDpiForWindow, snd.u.MoveWindow, snd._virtual_screen,
             core.list_accounts, core.self_wxid) = old

    def k10_check_env_offscreen():
        def run(_m):
            st = snd.check_env()
            assert st["visible"] and not st["minimized"], st
            assert st["ok"] is False, "位置在桌面外就不算可用（原先只看 visible/minimized，会放行）"
            assert "桌面外" in st["reason"], st["reason"]
        with_win([-32000, -32000, 440, 452], run)
    r.case("check_env：窗口在桌面外 ⇒ ok=False（不是「可见」就放行）", k10_check_env_offscreen)

    def k11_check_env_normal_still_ok():
        def run(_m):
            st = snd.check_env()
            assert st["ok"] and st["onscreen"], st
            assert not st["reason"], st["reason"]
        with_win([60, 40, 1280, 820], run)
    r.case("check_env：正常窗口照样 ok（别把合规态也判成桌面外）", k11_check_env_normal_still_ok)

    def k12_offscreen_judgement():
        old = snd._virtual_screen
        snd._virtual_screen = lambda: (-1920, 0, 4480, 1440)      # 左边挂了一台显示器
        try:
            assert snd._offscreen([60, 40, 1280, 820]) is False, "主屏可见区不算"
            assert snd._offscreen([-1920, 0, 1920, 1080]) is False, "副屏的负坐标不算桌面外"
            assert snd._offscreen([-32000, -32000, 440, 452]) is True, "最小化哨兵必须算"
            assert snd._offscreen([5000, 100, 800, 600]) is True, "整窗在桌面右侧外"
            assert snd._offscreen([100, -900, 800, 600]) is True, "整窗在桌面上方外"
            assert snd._offscreen(None) is False, "位置读不到就不判"
        finally:
            snd._virtual_screen = old
    r.case("桌面外判据：哨兵/整窗出界算，副屏负坐标不算", k12_offscreen_judgement)

    def k13_wake_pulls_offscreen_back():
        tray = []

        def run(_s, moved, _st):
            st = snd.wake_window(OFF)
            assert st.get("ok") is True, f"该复检一遍再返回（不是把入参原样退回）：{st}"
            assert tray == [], f"桌面外别去点托盘图标（那是可见性 toggle，方向正好反）：{tray}"
            assert moved == [(60, 40, 440, 452)], f"该搬回预设原点、尺寸照旧：{moved}"
        with_stub([RUN], 199150, run, rect=(-32000, -32000, 440, 452), tray=tray)
    r.case("wake_window：桌面外 ⇒ 不点托盘、直接搬回可见区", k13_wake_pulls_offscreen_back)

    def k14_restore_skips_offscreen():
        moved = []
        old = snd.u.MoveWindow
        snd.u.MoveWindow = lambda h, x, y, w, hh, rp: moved.append((x, y, w, hh))
        try:
            snd._restore_geometry(199150, (-32000, -32000, 440, 452))
            assert moved == [], f"桌面外的原位置不许还原（还原 = 把微信永久搬出屏幕）：{moved}"
            snd._restore_geometry(199150, (0, 0, 894, 578))
            assert moved == [(0, 0, 894, 578)], f"桌面内的原位置要照常还原：{moved}"
        finally:
            snd.u.MoveWindow = old
    r.case("_restore_geometry：桌面外的原位置不还原", k14_restore_skips_offscreen)

    def k15_win_exit_uses_guarded_restore():
        # `Win()`（reply_to）退出时也得走同一个守卫，别再内联一份 MoveWindow
        moved = []
        old = snd.u.MoveWindow
        snd.u.MoveWindow = lambda h, x, y, w, hh, rp: moved.append((x, y, w, hh))
        try:
            w = snd.Win()
            w.h, w.orig = 199150, (-32000, -32000, 440, 452)
            w.__exit__()
            assert moved == [], f"Win 退出也不许把窗口还原到桌面外：{moved}"
        finally:
            snd.u.MoveWindow = old
    r.case("Win.__exit__：桌面外的原位置同样不还原", k15_win_exit_uses_guarded_restore)

    def k16_repair_env_pulls_back():
        def run(_s, moved, _st):
            out = snd.repair_env()
            assert moved == [(60, 40, 1280, 820)], f"桌面外要搬回预设位置+尺寸：{moved}"
            assert any("桌面外" in a for a in out["actions"]), out["actions"]
            assert out["ok"], out  # 复检后该恢复可用
        with_stub([OFF, RUN], 199150, run, rect=(-32000, -32000, 1280, 820),
                  db=lambda: (r"C:\x\xwechat_files\wxid_a_1234\db_storage", "stub"))
    r.case("repair_env：窗口在桌面外 ⇒ 搬回可见区（尺寸本来就合规也要搬）", k16_repair_env_pulls_back)

    return r


def suite_L():
    """L 层：搜索选会话——**读结果下拉、挑精确行**，不再回车开首条。

    背景（2026-10-11 实测）：搜「321」时微信把「微信号含 321 的联系人」（显示名 cruel，
    副标题「信号：crue1321」）排在**群「321」**前面，`press(Enter)` 开首条必然开错人，
    随后 verify_target fail-closed ⇒ `target_unconfirmed`。这层钉住「读下拉 → 选精确行 → 点它」。
    夹具用的是真机上抓到的下拉行（含坐标），不是编的。
    """
    import wechat_sender as snd

    r = R("L 层：搜索选会话（精确选行）")

    # 真机抓到的下拉左列：(cx, cy, text)，坐标是窗口坐标
    REAL_ROWS = [( 98,  48, "、 321 |"),            # 搜索框自己那一行
                 ( 92,  83, "杲 常 便 用"),          # 分区标题「最常使用」被 OCR 读花
                 (136, 118, "cruel"),               # 联系人：显示名不含 321（靠微信号命中）
                 (148, 142, "信 号 ： crue1321"),     # 它的微信号副标题，含 321
                 (137, 226, "321"),                 # 群「321」← 正确目标
                 (137, 312, "321"),                 # 聊天记录命中（同名，更靠下）
                 (137, 422, "网 络 查 找 手 QQ 号 ： 321"),
                 (118, 471, "搜 索 网 疳 结 果"),
                 ( 94, 501, "0 321")]               # 搜索网络结果区

    def rows_of(pairs):
        return [(t, cx, cy) for cx, cy, t in pairs]

    def l1_picks_group_not_contact():
        got = snd.pick_search_row(rows_of(REAL_ROWS), "321")
        assert got == (137, 226), f"应选中群行 (137,226)，实得 {got}"
    r.case("真机下拉：跳过联系人/微信号副标题/标题/网络查找，选中群行", l1_picks_group_not_contact)

    def l2_no_exact_returns_none():
        rows = [(120, "cruel"), (200, "某联系人")]
        got = snd.pick_search_row([(t, 130, cy) for cy, t in rows], "321")
        assert got is None, f"一个精确匹配都没有时**不许猜**，应返回 None：{got}"
    r.case("无精确匹配 ⇒ 返回 None（宁可不点也不点错）", l2_no_exact_returns_none)

    def l3_exact_beats_fuzzy():
        rows = [(130, "3215"), (260, "321")]      # 3215 会被子串抬分到 0.82
        got = snd.pick_search_row([(t, 137, cy) for cy, t in rows], "321")
        assert got == (137, 260), f"精确匹配必须压过模糊，实得 {got}"
    r.case("精确匹配优先于模糊（321 胜过 3215）", l3_exact_beats_fuzzy)

    def l4_empty_name():
        assert snd.pick_search_row(rows_of(REAL_ROWS), "") is None
    r.case("目标名为空 ⇒ None", l4_empty_name)

    def l5_uia_branch():
        """UIA 可读时走 search_list（精确文本 + 活几何），坐标按 UIA 根矩形换算。"""
        data = {"win": (100, 50, 1280, 820),
                "search_results": [{"cls": "mmui::SearchContentCellView",
                                    "rect": (300, 400, 100, 20), "name": "321"}]}
        old = (snd.read_uia, snd.win_rect)
        snd.read_uia = lambda h, tag, all_ctls=False: data
        snd.win_rect = lambda h: (100, 50, 1280, 820)
        try:
            got = snd._pick_search_result_row(199150, "321")
        finally:
            (snd.read_uia, snd.win_rect) = old
        assert got == (300 - 100 + 50, 400 - 50 + 10), f"UIA 行中心换算错误：{got}"
    r.case("UIA 可读 ⇒ 用 search_list 精确选行", l5_uia_branch)

    def l6_ocr_branch():
        """UIA 拿不到（微信未暴露控件树）时，退屏幕抓取 + OCR。"""
        ocr = [(100 + 137, 50 + 226, 100 + 158, 50 + 237, "321"),
               (100 + 136, 50 + 118, 100 + 160, 50 + 129, "cruel")]
        old = (snd.read_uia, snd.win_rect, snd._ocr_rect)
        snd.read_uia = lambda h, tag, all_ctls=False: None
        snd.win_rect = lambda h: (100, 50, 1280, 820)
        snd._ocr_rect = lambda l, t, w, h, tag: ocr
        try:
            got = snd._pick_search_result_row(199150, "321")
        finally:
            (snd.read_uia, snd.win_rect, snd._ocr_rect) = old
        want = ((137 + 158) // 2, (226 + 237) // 2)   # 行中心（屏幕→窗口各减 (100,50)）
        assert got == want, f"OCR 分支应换算出窗口坐标 {want}：{got}"
    r.case("UIA 拿不到 ⇒ 退屏幕抓取 OCR 选行", l6_ocr_branch)

    def l7_open_clicks_row_not_enter():
        """命中精确行时**点那一行**，不按回车。"""
        clicks, keys = [], []
        old = (snd._pick_search_result_row, snd.read_ui_stable, snd.verify_target,
               snd.time.sleep, snd.ctrl, snd.press, snd.type_text, snd._clip_set_text)
        snd._pick_search_result_row = lambda h, name, verbose=False: (137, 226)
        snd.read_ui_stable = lambda tag, tries=4: (1280, 820, [])
        snd.verify_target = lambda *a, **k: (True, "消息")
        snd.time.sleep = lambda *_: None
        snd.ctrl = lambda vk: None
        snd.press = lambda vk: keys.append(vk)
        snd.type_text = lambda s: None
        snd._clip_set_text = lambda s: True

        class W:
            def click(self, x, y): clicks.append((x, y))
        try:
            ok = snd.open_chat_via_search("321", "t", W(), h=199150,
                                          click=lambda x, y: clicks.append((x, y)))
        finally:
            (snd._pick_search_result_row, snd.read_ui_stable, snd.verify_target,
             snd.time.sleep, snd.ctrl, snd.press, snd.type_text, snd._clip_set_text) = old
        assert ok is True
        assert (137, 226) in clicks, f"应点中命中的行：{clicks}"
        assert snd.VK_RETURN not in keys, f"命中时不该按回车：{keys}"
    r.case("命中精确行 ⇒ 点它，不回车", l7_open_clicks_row_not_enter)

    def l8_open_falls_back_to_enter():
        """读不到结果下拉时**回退老行为**（回车），别把「读不到」变成「切不过去」。"""
        keys = []
        old = (snd._pick_search_result_row, snd.read_ui_stable, snd.verify_target,
               snd.time.sleep, snd.ctrl, snd.press, snd.type_text, snd._clip_set_text)
        snd._pick_search_result_row = lambda h, name, verbose=False: None
        snd.read_ui_stable = lambda tag, tries=4: (1280, 820, [])
        snd.verify_target = lambda *a, **k: (True, "消息")
        snd.time.sleep = lambda *_: None
        snd.ctrl = lambda vk: None
        snd.press = lambda vk: keys.append(vk)
        snd.type_text = lambda s: None
        snd._clip_set_text = lambda s: True

        class W:
            def click(self, x, y): pass
        try:
            ok = snd.open_chat_via_search("321", "t", W(), h=199150, click=lambda x, y: None)
        finally:
            (snd._pick_search_result_row, snd.read_ui_stable, snd.verify_target,
             snd.time.sleep, snd.ctrl, snd.press, snd.type_text, snd._clip_set_text) = old
        assert ok is True and snd.VK_RETURN in keys, f"读不到结果应回退回车：{keys}"
    r.case("读不到下拉 ⇒ 回退回车（老行为）", l8_open_falls_back_to_enter)

    def l9_scroll_aborts_when_no_change():
        """滚动**自证有效**：画面没变（滚轮在这台机器上不生效）⇒ 立刻放弃，不空转。"""
        wheels = []
        old = (snd._snap, snd.read_uia, snd.read_ui_stable, snd.post_wheel, snd.time.sleep)
        snd._snap = lambda tag: ("same-sig", 1280, 820, [])
        snd.read_uia = lambda h, tag, all_ctls=False: None
        snd.read_ui_stable = lambda tag, tries=4: (1280, 820, [])
        snd.post_wheel = lambda h, x, y, n: wheels.append(n) or True
        snd.time.sleep = lambda *_: None
        try:
            ok = snd._scroll_find_session(199150, "321", "t")
        finally:
            (snd._snap, snd.read_uia, snd.read_ui_stable, snd.post_wheel, snd.time.sleep) = old
        assert ok is False
        downs = [n for n in wheels if n < 0]
        assert len(downs) == 1, f"画面没变就该只滚一次就放弃：{wheels}"
    r.case("滚动无变化 ⇒ 一次即放弃（不空转）", l9_scroll_aborts_when_no_change)

    def l10_frozen_skips_scroll_and_search():
        calls = {"scroll": 0, "search": 0}
        old = (snd.open_chat_post, snd._scroll_find_session, snd.open_chat_via_search_posted,
               snd._LAST_DIAGNOSTICS, snd._ENV)
        snd._LAST_DIAGNOSTICS = dict(snd._LAST_DIAGNOSTICS)
        snd._ENV = dict(snd._ENV)
        snd._ENV["restored"] = False       # 隔离：前一层用例调过 wake_window，会把它留成 True

        def fake_post(_h, _name, _talker, verbose=False):
            snd._record_diagnostics(ui_frozen=True)   # 模拟 open_chat_post 探到界面卡死
            return False
        snd.open_chat_post = fake_post
        snd._scroll_find_session = lambda *a, **k: calls.__setitem__("scroll", calls["scroll"] + 1) or True
        snd.open_chat_via_search_posted = lambda *a, **k: calls.__setitem__("search", calls["search"] + 1) or True
        try:
            ok = snd.open_chat_any(199150, "321", "t")
        finally:
            (snd.open_chat_post, snd._scroll_find_session, snd.open_chat_via_search_posted,
             snd._LAST_DIAGNOSTICS, snd._ENV) = old
        assert ok is True, "判死时仍应走搜索兜底（它会 bring_to_front 自救）"
        assert calls == {"scroll": 0, "search": 1}, f"判死应只跳过滚动、保留搜索：{calls}"
    r.case("界面判死 ⇒ 跳过滚动，但仍走搜索兜底（避免误判致发送失败）", l10_frozen_skips_scroll_and_search)

    def l11_input_box_real_click_after_search():
        calls = {"real": 0, "post": 0}
        old = (snd._real_click_at, snd.post_click, snd._LAST_DIAGNOSTICS, snd._ENV)
        snd._LAST_DIAGNOSTICS = dict(snd._LAST_DIAGNOSTICS)
        snd._ENV = dict(snd._ENV)
        snd._real_click_at = lambda h, x, y: calls.__setitem__("real", calls["real"] + 1)
        snd.post_click = lambda h, x, y: calls.__setitem__("post", calls["post"] + 1) or True
        try:
            snd._record_diagnostics(switched_chat=True)
            snd._click_input_box(199150, (100, 200))
            assert calls == {"real": 1, "post": 0}, f"经搜索切过来应真点击激活输入框：{calls}"
            calls["real"] = calls["post"] = 0
            snd._record_diagnostics(switched_chat=None)
            snd._ENV["restored"] = True
            snd._click_input_box(199150, (100, 200))
            assert calls == {"real": 1, "post": 0}, f"还原过窗口也应真点击（输入框被夺焦）：{calls}"
            calls["real"] = calls["post"] = 0
            snd._ENV["restored"] = False
            snd._click_input_box(199150, (100, 200))
            assert calls == {"real": 0, "post": 1}, f"普通情形应仍走投递点击（不动光标）：{calls}"
        finally:
            (snd._real_click_at, snd.post_click, snd._LAST_DIAGNOSTICS, snd._ENV) = old
    r.case("搜索切换/还原过窗口 ⇒ 真点击激活输入框；否则投递", l11_input_box_real_click_after_search)

    def l12_left_only_frame():
        old = (snd.read_ui_stable, snd.SESSION_COL)
        left_only = [(126, 100, 200, 112, "321"), (126, 200, 260, 212, "韩玉")]
        with_right = left_only + [(400, 300, 600, 312, "消息内容")]
        try:
            snd.read_ui_stable = lambda tag, tries=4: (1280, 820, left_only)
            assert snd._left_only_frame() is True, "只有左列应判为半渲染"
            snd.read_ui_stable = lambda tag, tries=4: (1280, 820, with_right)
            assert snd._left_only_frame() is False, "聊天区有内容就不是半渲染"
            snd.read_ui_stable = lambda tag, tries=4: (1280, 820, [])
            assert snd._left_only_frame() is False, "空帧（读不到）不算半渲染，别误唤醒"
        finally:
            (snd.read_ui_stable, snd.SESSION_COL) = old
    r.case("只剩左列 ⇒ 判半渲染；有聊天区/空帧 ⇒ 否", l12_left_only_frame)

    def l13_recover_after_left_only():
        calls = {"post": 0, "unfreeze": 0, "search": 0}
        old = (snd.open_chat_post, snd._scroll_find_session, snd.open_chat_via_search_posted,
               snd._left_only_frame, snd._unfreeze_ui, snd._LAST_DIAGNOSTICS, snd._ENV)
        snd._LAST_DIAGNOSTICS = dict(snd._LAST_DIAGNOSTICS)
        snd._ENV = dict(snd._ENV)
        snd._ENV["restored"] = False

        def post(_h, _n, _t, verbose=False):
            calls["post"] += 1
            return calls["post"] >= 2          # 首次失败，唤醒后第二次成功
        snd.open_chat_post = post
        snd._scroll_find_session = lambda *a, **k: False
        snd.open_chat_via_search_posted = lambda *a, **k: calls.__setitem__("search", calls["search"] + 1) or False
        snd._left_only_frame = lambda: True
        snd._unfreeze_ui = lambda tag="tray": calls.__setitem__("unfreeze", calls["unfreeze"] + 1) or True
        try:
            ok = snd.open_chat_any(199150, "321", "t")
        finally:
            (snd.open_chat_post, snd._scroll_find_session, snd.open_chat_via_search_posted,
             snd._left_only_frame, snd._unfreeze_ui, snd._LAST_DIAGNOSTICS, snd._ENV) = old
        assert ok is True, "唤醒后重试成功应返回 True"
        assert calls["unfreeze"] == 1 and calls["post"] == 2, f"应**只**唤醒一次并重试：{calls}"
    r.case("三路失败+只剩左列 ⇒ 唤醒一次并重试成功（不反复戳）", l13_recover_after_left_only)

    def l14_restored_still_searches():
        """窗口是**还原来的**也必须走搜索——复杂环境（托盘→还原→搜索定位→发送）这条链要通。"""
        calls = {"search": 0}
        old = (snd.open_chat_post, snd._scroll_find_session, snd.open_chat_via_search_posted,
               snd._ENV, snd._LAST_DIAGNOSTICS)
        snd._ENV = dict(snd._ENV)
        snd._ENV["restored"] = True
        snd._LAST_DIAGNOSTICS = dict(snd._LAST_DIAGNOSTICS)
        snd.open_chat_post = lambda *a, **k: False
        snd._scroll_find_session = lambda *a, **k: False
        snd.open_chat_via_search_posted = lambda *a, **k: calls.__setitem__("search", calls["search"] + 1) or True
        try:
            ok = snd.open_chat_any(199150, "321", "t")
        finally:
            (snd.open_chat_post, snd._scroll_find_session, snd.open_chat_via_search_posted,
             snd._ENV, snd._LAST_DIAGNOSTICS) = old
        assert ok is True, "还原来的窗口找到目标后应返回 True"
        assert calls["search"] == 1, f"还原来的窗口也必须走搜索兜底：{calls}"
    r.case("窗口是还原来的 ⇒ 照样走搜索（托盘→还原→搜索→发送要通）", l14_restored_still_searches)

    def l15_list_switch_marks_switched():
        """经**会话列表点击**切换也要标记——切完焦点不在输入框，正文投递会落空。"""
        old = (snd.open_chat_post, snd._LAST_DIAGNOSTICS)
        snd._LAST_DIAGNOSTICS = dict(snd._LAST_DIAGNOSTICS)
        snd.open_chat_post = lambda *a, **k: True
        try:
            ok = snd.open_chat_any(199150, "321", "t")
            flag = snd._LAST_DIAGNOSTICS.get("switched_chat")
        finally:
            (snd.open_chat_post, snd._LAST_DIAGNOSTICS) = old
        assert ok is True and flag is True, f"列表点击切换也要标记 switched_chat：{flag}"
    r.case("列表点击切换 ⇒ 也标记 switched_chat（切完要真点击激活输入框）", l15_list_switch_marks_switched)

    def l16_attach_button_pt():
        """附件入口（工具栏「发送文件」图标）**没有名字**，只能按几何定位，且读不到帧要 fail-closed。"""
        frame = [(126, 100, 200, 112, "321"), (126, 200, 296, 212, "韩玉"),
                 (1200, 780, 1240, 796, "发送")]
        ly = snd.layout(frame, 1280, 820)
        old = snd.read_ui_stable
        try:
            snd.read_ui_stable = lambda tag, tries=4: (1280, 820, frame)
            pt = snd._attach_button_pt(199150)
            want = (ly["session_right"] + 103, ly["send_btn"][1] + 7)
            assert pt == want, f"附件锚点应随布局算：{pt} != {want}"
            snd.read_ui_stable = lambda tag, tries=4: (1280, 820, [])
            assert snd._attach_button_pt(199150) is None, "读不到帧必须返回 None（不许瞎点）"
        finally:
            snd.read_ui_stable = old
    r.case("附件入口按几何定位（会话列右边界+103、发送按钮 y+7）；读不到帧 ⇒ None", l16_attach_button_pt)

    return r


def suite_M():
    """M 层：MCP 进度通知的**服务端接线**（离线、不碰微信）。

    钉三件事：① 客户端带了 `_meta.progressToken` ⇒ 发送层的 `_progress` 变成 `notifications/progress`，
    token 原样回传、progress 单调递增；② **不带 token 就不发**（规范里无主通知非法）；
    ③ 调用结束**恢复**原来的进度槽（不泄漏到下一次调用）。
    """
    import server
    import wechat_sender as snd

    r = R("M 层：MCP 服务端接线（进度通知 / 版本门）")
    sent = []
    old_send = server._send
    old_handler = server.DISPATCH.get("send_text")

    def fake_handler(_args):
        snd._progress("第一步：检查环境")
        snd._progress("第二步：切换会话", total=3)
        return {"ok": True}

    def with_stub_send(fn):
        server._send = lambda m: sent.append(m)
        server.DISPATCH["send_text"] = fake_handler
        try:
            return fn()
        finally:
            server._send = old_send
            server.DISPATCH["send_text"] = old_handler

    def m1_with_token():
        server.handle_tools_call(1, {"name": "send_text", "arguments": {},
                                     "_meta": {"progressToken": "tk-7"}})
        notifs = [m for m in sent if m.get("method") == "notifications/progress"]
        assert len(notifs) == 2, f"应上报 2 条进度：{notifs}"
        ps = [n["params"] for n in notifs]
        assert all(p["progressToken"] == "tk-7" for p in ps), ps
        assert [p["progress"] for p in ps] == [1, 2], f"progress 必须从 1 单调递增：{ps}"
        assert ps[1].get("total") == 3 and all(p.get("message") for p in ps), ps
        assert any(m.get("id") == 1 and "result" in m for m in sent), "最终响应不能丢"
    r.case("带 token ⇒ 逐阶段发 notifications/progress（token 回传、progress 递增）",
           lambda: with_stub_send(m1_with_token))

    def m2_without_token():
        sent.clear()
        server.handle_tools_call(2, {"name": "send_text", "arguments": {}})
        notifs = [m for m in sent if m.get("method") == "notifications/progress"]
        assert notifs == [], f"没带 token 不该发进度：{notifs}"
    r.case("不带 token ⇒ 不发任何进度通知", lambda: with_stub_send(m2_without_token))

    def m3_restores():
        assert snd._PROGRESS["cb"] is None, "调用结束必须清掉进度槽，别泄漏到下一次"
    r.case("调用结束恢复进度槽（不泄漏）", m3_restores)

    def m5_version_gate():
        """§9.9 版本门：不在真机验证范围内的微信版本，告警要跟着**每个**工具结果出去。

        只写在 check_env 里等于没有——Agent 不会每次先调它，而"静默给错数据"（内存偏移、
        窗口类名、AutomationId 都是硬绑版本的假设）比报错糟得多。钉两件事：
        ① 判定本身：未验证才告警；「微信没运行 / 读不到版本」是**未知**不是故障，不该刷屏；
        ② 注入点在 `handle_tools_call` 唯一那一处 ⇒ 随便哪个工具的结果都带得上。
        """
        import json as _json

        import wechat_core as core

        old_ver = core.wechat_version
        try:
            for fake, want in (
                ({"path": "x", "version": "4.2.0.1", "verified": False, "hint": "⚠️ 未验证"}, "⚠️ 未验证"),
                ({"path": "x", "version": "4.1.15.13", "verified": True, "hint": "已验"}, None),
                ({"path": "", "version": "", "verified": False, "hint": "微信未运行"}, None),
            ):
                core.wechat_version = lambda _f=fake: _f
                assert core.version_warning() == want, (fake, core.version_warning())

            core.wechat_version = lambda: {"path": "x", "version": "4.2.0.1",
                                           "verified": False, "hint": "⚠️ 未验证"}
            sent.clear()
            with_stub_send(lambda: server.handle_tools_call(
                9, {"name": "send_text", "arguments": {}}))
            results = [m for m in sent if m.get("id") == 9 and "result" in m]
            assert results, f"没拿到最终响应：{sent}"
            payload = _json.loads(results[-1]["result"]["content"][0]["text"])
            assert payload.get("version_warning") == "⚠️ 未验证", payload
        finally:
            core.wechat_version = old_ver
    r.case("版本门：未验证的微信版本，告警跟着每个工具结果出去", m5_version_gate)

    def m6_image_key_flag():
        """`--image-key` 是 exe 抓图片 key 的**唯一口子**、也是 `read_image` 的前提。

        为什么值得锁：key 不在消息里、也不在配置文件里，只能扫微信进程内存；而 MCP 工具表里
        没有它、宿主 App 也没有这个界面 ⇒ 少了这个开关，装好的 pro exe **永远读不出图**，
        报错还会把锅推给「图没落到本地」。这里钉三件事：没扫到 ⇒ 非零码 + 教用户先点开一张图；
        扫到 ⇒ 报落盘路径；`--refresh` 真透传下去（换账号后要能重抓）。
        """
        import contextlib
        import json as _json
        import wechat_image as IM
        old_key = IM.image_aes_key
        seen = []

        def fake_image_aes_key(refresh=False, save=True):
            seen.append(refresh)
            return None if len(seen) == 1 else b"\x01" * 32   # 第一次扫不到，第二次拿到

        def run(args):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                return server.cmd_image_key(args), buf.getvalue()

        IM.image_aes_key = fake_image_aes_key
        try:
            rc1, s1 = run([])
            j1 = _json.loads(s1)
            assert rc1 == 1 and j1["ok"] is False and "点开" in j1["hint"], f"{rc1} {j1}"
            rc2, s2 = run(["--refresh"])
            j2 = _json.loads(s2)
            assert rc2 == 0 and j2["ok"] is True and j2["path"], f"{rc2} {j2}"
            assert seen == [False, True], f"--refresh 没透传：{seen}"
        finally:
            IM.image_aes_key = old_key

    r.case("--image-key：没扫到给非零码 + 教先点开一张图；--refresh 真透传", m6_image_key_flag)

    def m7_read_image_says_why():
        """`read_image` 取不到图时**逐因给话**——四种原因不能压成同一句。

        原先只报「不是图片 / 图没落到本地 / 原始图与中图都缺」，而最常见的那个
        （**图片 AES key 还没抓过**）根本不在里面，调用方照着那句话只会去查不存在的文件缺失。
        """
        import json as _json
        import wechat_core as core
        old, old_resolve = core.image_message, server._resolve_or_error
        server._resolve_or_error = lambda t: (TALKER, None)   # 会话解析不是这条用例的题
        try:
            for why in ("not_found", "not_image", "no_key", "no_file"):
                core.image_message = lambda t, l, w=why: (None, w)
                got = server.tool_image({"talker": TALKER, "local_id": 1})
                msg = got.get("error") or ""
                assert msg == server._IMAGE_WHY[why], f"{why} 没给对应的话：{msg}"
            assert len(set(server._IMAGE_WHY.values())) == len(server._IMAGE_WHY), \
                "有两条原因共用一句错话，等于没分开"
        finally:
            core.image_message, server._resolve_or_error = old, old_resolve

    r.case("read_image 的四种取不到，各自给各自的话（key 没抓 ≠ 文件缺失）", m7_read_image_says_why)

    return r


def suite_N():
    """N 层：图片解密链（`wechat_image`）——**缓存自愈**，以及"宁可没有也不能给错"那一档。

    真机链子（`attach_image` → `cached_aes_key()` → AES-ECB）**不过 `_verify_key`**：账号换过或
    key 陈旧时解出来是随机字节。随机字节既不是 WXGF 也不是 PNG，旧代码会把它当原图写成
    `.jpg` 返回——模型拿到一张**坏图**，比报错糟得多（`_verify_key` 注释原话）。
    """
    r = R("N 层：图片解密链（缓存自愈）")
    import wechat_image as IM
    import wechat_core as _core

    def n1_cache_is_verified_and_self_healing():
        d = tempfile.mkdtemp(prefix="wximg-")    # 缓存落在 core.WORK 下（`image/`）
        old_work, old_attach = _core.WORK, IM.attach_path
        _core.WORK = d
        IM.attach_path = lambda n: None          # 源 `.dat` 一律不存在：这一条只考缓存那一环
        try:
            os.makedirs(os.path.join(d, "image"), exist_ok=True)
            bad = os.path.join(d, "image", "hd_deadbeef.jpg")
            with open(bad, "wb") as f:
                f.write(b"\x9c\x11\x2a\x00 not an image, just random bytes")
            # ① 坏缓存不能当图返回，而且要**就地清掉**——命中发生在解密之前，不自愈就永远是坏的
            assert IM.image_file(None, b"\x00" * 32, "deadbeef") is None, "坏缓存被当图返回了"
            assert not os.path.exists(bad), "坏缓存没被清掉：换回好 key 也永远命中它"
            # ② 好缓存照旧走快路（不重新解密）：源文件都不存在，能返回路径就只可能是缓存
            ok = os.path.join(d, "image", "hd_cafebabe.jpg")
            with open(ok, "wb") as f:
                f.write(b"\xff\xd8\xff\xe0" + b"\x00" * 64)
            assert IM.image_file(None, b"\x00" * 32, "cafebabe") == ok, "好缓存被误判成坏图"
            assert os.path.exists(ok), "好缓存被删了"
        finally:
            _core.WORK, IM.attach_path = old_work, old_attach

    r.case("缓存必验头：坏图就地清掉（否则换回好 key 也永远吐坏图）", n1_cache_is_verified_and_self_healing)

    return r


def suite_O():
    """O 层：接收侧的两处"取不到"（视频路径 / 检索命中的可寻址性）——都是**判据**测试。

    这两条都是"多一点或少一点就静默给错"的地方：视频是靠 md5 换名 + 比大小来认领文件的，
    检索命中要是丢了 `local_id`，Agent 就没有任何手柄把命中交回给 `read_image`。
    """
    r = R("O 层：视频路径 + 检索命中可寻址")
    import wechat_core as c

    def o1_video_path_requires_exact_size():
        """视频要靠**大小精确相等**认领文件：md5 → hardlink 换名 → 比 `length`。

        只凭 md5 换名是不够的——换错就是给别人放另一段视频（"错文件比没文件糟"）。
        """
        d = tempfile.mkdtemp(prefix="wxvid-")
        p = os.path.join(d, "a.mp4")
        with open(p, "wb") as f:
            f.write(b"x" * 7)
        calls = []
        real_hl, real_vp = c._video_hardlink, c.video_file_path

        def fake_hl():
            calls.append("hl")
            return {"ab" * 16: "a.mp4"}          # 表里是小写 md5（实测如此）

        c._video_hardlink = fake_hl
        c.video_file_path = lambda n: p if n == "a.mp4" else None
        try:
            ok = [{"type": 43, "video_md5": "AB" * 16, "video_len": 7}]   # 大写也要认（要 lower）
            c.attach_video(ok)
            assert ok[0].get("video_path") == p, "大小对得上却没给路径"
            bad = [{"type": 43, "video_md5": "AB" * 16, "video_len": 8}]
            c.attach_video(bad)
            assert "video_path" not in bad[0], "大小对不上也给了路径——换错名就是放另一段视频"
            miss = [{"type": 43, "video_md5": "cd" * 16, "video_len": 7}]
            c.attach_video(miss)
            assert "video_path" not in miss[0], "hardlink 里没有的 md5 也给了路径"
            assert len(calls) == 3, "该开库的没开：%d 次" % len(calls)
            c.attach_video([{"type": 43, "video_len": 7}])               # 没有 md5
            c.attach_video([{"type": 1, "video_md5": "AB" * 16}])        # 不是视频
            assert len(calls) == 3, "白开了 hardlink.db：没有可取名的消息也去开库"
        finally:
            c._video_hardlink, c.video_file_path = real_hl, real_vp

    def o2_search_hits_are_addressable():
        """检索命中必须带 `local_id`（+ `source`/`packed`）——它是交回给 read_image 的唯一手柄。"""
        md5, thumb, base = "a" * 32, "b" * 32, "c" * 32
        row = (1700000000, 3,
               '<img aeskey="k" cdnthumbmd5="%s" md5="%s" length="18227"/>' % (thumb, md5),
               "wxid_me", 42,
               # 真库的 @我 就长这样（`<atuserlist>` 里的 CDATA 是**必须**的——
               # `_ATUSERS_RE` 只认这一种形状，别把它当无关细节改掉）
               "<msgsource><atuserlist><![CDATA[wxid_me]]></atuserlist></msgsource>",
               b"\x1a\x22\x22\x20" + base.encode())
        saved = {n: getattr(c, n) for n in
                 ("_refresh", "talkers", "names", "self_wxid", "_rows_full")}
        c._refresh = lambda: None
        c.talkers = lambda: [("Msg_x", TALKER)]
        c.names = lambda: {}
        c.self_wxid = lambda: "wxid_me"
        c._rows_full = lambda tbl, limit, **kw: [row]
        try:
            hit = c.search_messages("图片")["messages"][0]
        finally:
            for n, v in saved.items():
                setattr(c, n, v)
        assert hit.get("local_id") == 42, "命中丢了 local_id：Agent 没法把它交回 read_image"
        assert hit.get("image_md5") == md5, "命中丢了 image_md5（packed/source 没传下去）"
        assert hit.get("image_name") == base, "命中丢了 image_name"
        assert hit.get("at_me") is True, "命中丢了 at_me（source 没传下去）"

    r.case("视频路径要靠大小精确认领（换错名 = 放别人的视频）", o1_video_path_requires_exact_size)
    r.case("检索命中带 local_id/source/packed（否则读图那条路是死的）", o2_search_hits_are_addressable)
    return r


def suite_P():
    """P 层：翻页**不能丢同秒消息**。

    `read_history` 按**条数**切页，而 `create_time` 只到秒 —— 页切在某秒中间时，同秒更早的
    那些既 `> 本页` 又 `< 下一页`，两边都够不着。假库照 `_rows_full` 的**真语义**过滤
    （since 严格大于 / before 严格小于 / at 相等），这样"丢"是算法自己产生的，不是夹具编的。
    """
    r = R("P 层：翻页不丢同秒消息")
    import wechat_core as c

    # 三条挤在 ts=100，五条挤在 ts=200
    DATA = [(200, 1, b"m%d" % lid, "", lid, None, None) for lid in (4, 5, 6, 7, 8)] + \
           [(100, 1, b"m%d" % lid, "", lid, None, None) for lid in (1, 2, 3)]
    TBL = "Msg_fake"

    def p1_same_second_at_page_edge():
        """limit=3 时边界那一秒必须整秒给出（否则那秒剩下的永远取不到）。"""
        def fake(tbl, limit, since=0, before=0, at=0):
            out = [x for x in DATA
                   if (not since or x[0] > since) and (not before or x[0] < before)
                   and (not at or x[0] == at)]
            out.sort(key=lambda x: x[0], reverse=True)
            return out[:limit]

        saved = {n: getattr(c, n) for n in ("_rows_full", "tbl_of", "names", "self_wxid",
                                            "attach_voice", "attach_image", "attach_video")}
        c._rows_full = fake
        c.tbl_of = lambda t: TBL
        c.names = lambda: {}
        c.self_wxid = lambda: "me"
        c.attach_voice = c.attach_image = c.attach_video = lambda *a, **k: None
        try:
            seen, before, pages = set(), 0, 0
            while pages < 10:                       # 照 server 的用法翻页
                page = c.history(TBL, 3, before)
                ids = [m["local_id"] for m in page["messages"]]
                seen |= set(ids)
                if not page.get("has_more"):
                    break
                before, pages = page["cursor"], pages + 1
        finally:
            for n, v in saved.items():
                setattr(c, n, v)
        want = {x[4] for x in DATA}
        assert seen == want, "翻页丢了同秒消息：缺 %s" % sorted(want - seen)
    r.case("翻页边界那一秒要整秒给出（不能切在秒中间）", p1_same_second_at_page_edge)

    def p2_search_range_pushed_into_sql():
        """检索的时间范围要**下推**：否则查老时间段时扫描窗口被更新的消息占满 ⇒ 恒 0 条且不报错。"""
        # 6 条：前 3 条是"新的"（ts=900+），后 3 条是"老的"（ts=100..102）
        DATA = [(900 + i, 1, ("新%d" % i).encode(), "", 100 + i, None, None) for i in range(3)] + \
               [(100 + i, 1, ("老%d" % i).encode(), "", 10 + i, None, None) for i in range(3)]

        def fake(tbl, limit, since=0, before=0, at=0):
            out = [x for x in DATA
                   if (not since or x[0] > since) and (not before or x[0] < before)
                   and (not at or x[0] == at)]
            out.sort(key=lambda x: x[0], reverse=True)
            return out[:limit]                       # 真 `_rows_full` 就是"取最新的 limit 条"

        saved = {n: getattr(c, n) for n in ("_rows_full", "tbl_of", "names", "self_wxid", "talkers")}
        c._rows_full = fake
        c.tbl_of = lambda t: TBL
        c.names = lambda: {}
        c.self_wxid = lambda: "me"
        c.talkers = lambda: [(TBL, TBL)]
        try:
            # scan=3：正好够装下老的这 3 条。旧码的窗口取的是"最新 3 条"（全是新的那些）⇒ 0 命中
            got = c.search_messages("老", since=99, until=199, scan=3)
        finally:
            for n, v in saved.items():
                setattr(c, n, v)
        texts = [m["text"] for m in got["messages"]]
        assert len(texts) == 3, "老时间段的命中被扫描窗口吃掉了：%s" % texts
        assert all(t.startswith("老") for t in texts), texts
    r.case("检索的时间范围要下推到 SQL（否则老时间段恒 0 命中）", p2_search_range_pushed_into_sql)

    def p3_search_reports_truncation():
        """撞上 `scan` 上限必须**如实上报**（多取一条来判断）——静默截断 = 把"没扫到"当成"没有"。"""
        DATA = [(100 + i, 1, b"hi", "", i, None, None) for i in range(5)]

        def fake(tbl, limit, since=0, before=0, at=0):
            out = [x for x in DATA if (not at or x[0] == at)]
            out.sort(key=lambda x: x[0], reverse=True)
            return out[:limit]

        saved = {n: getattr(c, n) for n in ("_rows_full", "tbl_of", "names", "self_wxid", "talkers")}
        c._rows_full = fake
        c.tbl_of = lambda t: TBL
        c.names = lambda: {}
        c.self_wxid = lambda: "me"
        c.talkers = lambda: [(TBL, TBL)]
        try:
            cut = c.search_messages("hi", scan=2)
            whole = c.search_messages("hi", scan=99)
        finally:
            for n, v in saved.items():
                setattr(c, n, v)
        assert cut.get("truncated") is True, "撞了上限却没报 truncated"
        assert whole.get("truncated") is False, "没撞上限却报了 truncated"
    r.case("检索撞上扫描上限要报 truncated", p3_search_reports_truncation)
    return r


def main():
    try:
        import Crypto  # noqa: F401
        has_crypto = True
    except Exception:
        has_crypto = False
    print("=" * 70)
    print("  wechat-mcp 增量读取路径测试（离线夹具）")
    print("=" * 70)
    total_p = total_f = 0
    for suite, need_crypto in ((suite_A, True), (suite_B, False), (suite_C, False),
                               (suite_D, False), (suite_E, False), (suite_F, False),
                               (suite_G, False), (suite_H, False), (suite_I, False),
                               (suite_J, False), (suite_K, False), (suite_L, False),
                               (suite_M, False), (suite_N, False), (suite_O, False),
                               (suite_P, False)):
        if need_crypto and not has_crypto:
            print("\n（跳过 A 层：没有 pycryptodome）")
            continue
        print("")
        rr = suite()
        p, f = rr.done()
        print(f"  — {rr.title}: 通过 {p} / 失败 {f}")
        total_p += p
        total_f += f
    print(f"\n合计：通过 {total_p} / 失败 {total_f}")
    return 1 if total_f else 0


if __name__ == "__main__":
    sys.exit(main())
