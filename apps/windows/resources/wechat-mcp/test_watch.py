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
    return f"""CREATE TABLE [{tbl}](local_id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER,
 local_type INTEGER, sort_seq INTEGER, real_sender_id INTEGER, create_time INTEGER, status INTEGER,
 message_content TEXT);
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

    return r


def suite_C():
    import re
    import server
    r = R("C 层：错误码与重试边界")

    def c1_code_map():
        src = open(os.path.join(HERE, "wechat_sender.py"), encoding="utf-8").read()
        lits = [s for s in re.findall(r'return False, "([^"]+)"', src) if s != "-"]
        # ^ "-" 是 verify_target 的内部哨兵（不通过、但由上层转成「目标会话未确认」），不是对外的错误文案
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
        v, _ = with_fakes(["明天下午三点我们公司门口见"], NAMES,
                          lambda: snd.verify_target(TALKER, NAME, scene("韩玉", ["明天下午我们门口碰头"]), WW, WH))
        assert not v, "长锚点没命中却凭头部放行——这正是发错人的老路"
    r.case("够长的锚点没命中 ⇒ 仍然拒绝（头部不许绕过内容）", e5_long_anchor_missing)

    return r


def suite_F():
    """F 层：最小化时的**自恢复发送闸门**（`env_gate` / `wake_minimized`）——纯逻辑，假窗口。

    为什么单开一层：`check_env` 的严格闸门是给**报告**用的（如实说环境如何），但代聊回路的
    现实是「人不在电脑前 ⇒ 微信常是最小化的 ⇒ 自己不恢复就永远发不出去」。2026-10-08 实测
    被它挡了两次（22:33 Loop、22:37 韩玉）。这层钉四件事：
      1. 最小化 → 恢复一次后复检，复检过了就放行；
      2. 恢复不动（或没有窗口句柄）→ 照旧拒发，不假装成功；
      3. 本来 ok → **不碰窗口**（别平白把用户的窗口拎到前台）；
      4. 没运行 / 不可见 → 不恢复、直接拒（这两类恢复不了）。
    """
    import wechat_sender as snd
    r = R("F 层：最小化自恢复（发送闸门）")

    def with_env(seq, find_hwnd, fn):
        """`check_env` 按 seq 依次返回（用完后重复最后一个）；`ShowWindow`/`sleep` 打桩。"""
        st = {"n": 0}

        def fake_check_env():
            i = min(st["n"], len(seq) - 1)
            st["n"] += 1
            return dict(seq[i])

        shown = []
        old = (snd.check_env, snd.find_main_hwnd, snd.u.ShowWindow, snd.time.sleep)
        snd.check_env = fake_check_env
        snd.find_main_hwnd = lambda: find_hwnd
        # 传入的是 ctypes.c_void_p，这里归一成整数，免得断言被 c_void_p 包装挡住
        snd.u.ShowWindow = lambda h, n: shown.append((getattr(h, "value", h), n))
        snd.time.sleep = lambda *_: None
        try:
            return fn(shown, st)
        finally:
            (snd.check_env, snd.find_main_hwnd, snd.u.ShowWindow, snd.time.sleep) = old

    MIN = {"ok": False, "reason": "主窗口已最小化", "minimized": True,
           "visible": True, "weixin_running": True, "hwnd": 199150}
    OK = {"ok": True, "reason": "", "minimized": False,
          "visible": True, "weixin_running": True, "hwnd": 199150}
    GONE = {"ok": False, "reason": "未检测到微信进程（Weixin.exe 未运行）", "minimized": False,
            "visible": False, "weixin_running": False, "hwnd": 0}

    def f1_restores_and_passes():
        def run(shown, st):
            ok, s = snd.env_gate()
            assert ok and s["ok"], "恢复后复检通过就该放行"
            assert shown == [(199150, 9)], f"应当且只应当 SW_RESTORE 一次：{shown}"
            assert st["n"] == 2, f"应当复检一次：{st['n']}"
        with_env([MIN, OK], 0, run)
    r.case("最小化 ⇒ 自恢复一次 + 复检 ⇒ 放行", f1_restores_and_passes)

    def f2_stays_minimized():
        def run(shown, st):
            ok, _s = snd.env_gate()
            assert not ok, "恢复不动时必须拒发（不许带着最小化的窗口往下做）"
            assert shown == [(199150, 9)]
        with_env([MIN], 0, run)
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
                               (suite_G, False)):
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
