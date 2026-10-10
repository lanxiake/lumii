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


# ---------------------------------------------------------------------------
# 数据目录探测
#
# 微信 4.x（Weixin.exe）的**自定义数据目录不在注册表**，而是写在
# `%APPDATA%\Tencent\xwechat\config\<哈希>.ini`——文件内容就是数据基目录
# （`xwechat_files` 的父目录；实测本机内容为 `C:\Users\Administrator`）。
# 旧代码只认 3.x 的注册表键 `Tencent\WeChat\FileSavePath`，换机/自定义目录必挂。
#
# 探测优先级（先命中先用；`list_accounts` 命中即止，避免每次调用都整盘扫描）：
#   1. `LUMII_WECHAT_DB` / `LUMII_WECHAT_ACCOUNT`（显式，最高）
#   2. ini（4.x 自定义目录的权威来源）
#   3. 注册表（4.x `Tencent\Weixin` / 3.x `Tencent\WeChat`）
#   4. 默认路径（`~/xwechat_files`、`~/Documents/xwechat_files`）
#   5. 固定盘有界扫描（深度≤2，覆盖数据目录被放到**其他盘**的情形）
# ---------------------------------------------------------------------------

def _valid_root(root):
    """root 是否指向可读的 db_storage（含 message/message_0.db）。"""
    return bool(root) and os.path.isfile(os.path.join(root, "message", "message_0.db"))


def _parse_ini_paths(txt):
    """从 ini 文本抽出候选路径：兼容 `MyDocument=…` / `My Document: …` / 纯路径一行。"""
    out = []
    for raw in txt.splitlines():
        line = raw.strip()
        if not line or line.startswith((";", "#", "[")):
            continue
        val = line
        # 形如 `Key=值` / `Key: 值`；键不含盘符，避免把 `C:\…` 当键值对拆坏
        m = re.match(r"^[^:=]{1,32}\s*[:=]\s*(.+)$", line)
        if m and not re.match(r"^[A-Za-z]:[\\/]", line):
            val = m.group(1)
        val = val.strip().strip('"').strip("'")
        if val:
            out.append(val)
    return out


def _resolve_xwechat_dir(p):
    """把候选路径归一成**存在的** `xwechat_files` 目录，找不到返回 None。"""
    if not p:
        return None
    try:
        q = os.path.normpath(os.path.expandvars(os.path.expanduser(p.strip())))
    except Exception:
        return None
    cands = []
    if os.path.basename(q).lower() == "xwechat_files":
        cands.append(q)
    cands.append(os.path.join(q, "xwechat_files"))
    cands.append(os.path.dirname(q))          # 也可能给的是账号目录 <xwechat_files>/<wxid>_<4hex>
    for c in cands:
        if c and os.path.isdir(c) and os.path.basename(c).lower() == "xwechat_files":
            return c
    return None


def _ini_bases():
    """微信 4.x 自定义数据基目录（来自 config/*.ini）。"""
    out = []
    dirs = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        dirs.append(os.path.join(appdata, "Tencent", "xwechat", "config"))
    dirs.append(os.path.join(os.path.expanduser("~"), ".xwechat", "config"))
    for d in dirs:
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for name in names:
            if not name.lower().endswith(".ini"):
                continue
            try:
                with open(os.path.join(d, name), "r", encoding="utf-8", errors="ignore") as f:
                    out.extend(_parse_ini_paths(f.read(4096)))
            except OSError:
                continue
    return out


def _registry_bases():
    """注册表里的数据目录（4.x `Tencent\\Weixin` / 3.x `Tencent\\WeChat`）。"""
    out = []
    if os.name != "nt":
        return out
    try:
        import winreg
    except Exception:
        return out
    want = {"filesavepath", "filedir", "savedir", "datapath", "filesavedir"}
    for sub in (r"Software\Tencent\Weixin", r"Software\Tencent\WeChat", r"Software\Tencent\Wexin"):
        try:
            k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, sub, 0, winreg.KEY_READ)
        except OSError:
            continue
        try:
            i = 0
            while True:
                try:
                    name, val, _ = winreg.EnumValue(k, i)
                except OSError:
                    break
                i += 1
                if isinstance(val, str) and val and name.lower() in want:
                    out.append(val)
            try:
                val, _ = winreg.QueryValueEx(k, "")
                if isinstance(val, str) and val:
                    out.append(val)
            except OSError:
                pass
        finally:
            winreg.CloseKey(k)
    return out


def _fixed_drives():
    """本机固定盘根（仅 Windows；跳过网络/可移动盘）。"""
    if os.name != "nt":
        return []
    out = []
    try:
        import ctypes
        DRIVE_FIXED = 3
        k32 = ctypes.windll.kernel32
        for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            root = f"{letter}:\\"
            try:
                if k32.GetDriveTypeW(ctypes.c_wchar_p(root)) == DRIVE_FIXED and os.path.isdir(root):
                    out.append(root)
            except Exception:
                continue
    except Exception:
        return []
    return out


def _scan_xwechat_dirs(drives, max_depth=2):
    """在所有固定盘上按深度≤2找 `xwechat_files`（覆盖 `D:\\微信\\xwechat_files` 这类）。"""
    out = []
    for drv in drives:
        c = os.path.join(drv, "xwechat_files")
        if os.path.isdir(c):
            out.append(c)
        if max_depth < 2:
            continue
        try:
            subs = os.listdir(drv)
        except OSError:
            continue
        for s in subs:
            p = os.path.join(drv, s)
            if not os.path.isdir(p):
                continue
            c = os.path.join(p, "xwechat_files")
            if os.path.isdir(c):
                out.append(c)
    return out


def _accounts_under(xdir):
    """`xwechat_files` 目录下的账号：`[{wxid, dir, root, mtime}]`（按修改时间倒序）。"""
    out = []
    try:
        names = os.listdir(xdir)
    except OSError:
        return out
    for name in names:
        root = os.path.join(xdir, name, "db_storage")
        if not _valid_root(root):
            continue
        try:
            mtime = os.path.getmtime(os.path.join(root, "message", "message_0.db"))
        except OSError:
            mtime = 0.0
        out.append({"wxid": name.rsplit("_", 1)[0], "dir": name, "root": root, "mtime": mtime})
    out.sort(key=lambda r: r["mtime"], reverse=True)
    return out


def detect_xwechat_dirs():
    """按优先级**惰性**产出 `(xwechat_files 目录, source)`，去重保序。

    生成器：调用方命中即止（`list_accounts` 拿到账号就 return）时，后面的整盘扫描
    不会被执行——探测要覆盖任意盘，但绝不能每次调用都扫盘。
    """
    seen = set()

    def emit(d, src):
        if d and d not in seen:
            seen.add(d)
            return (d, src)
        return None

    for base in _ini_bases():
        e = emit(_resolve_xwechat_dir(base), "ini")
        if e:
            yield e
    for base in _registry_bases():
        e = emit(_resolve_xwechat_dir(base), "registry")
        if e:
            yield e
    home = os.path.expanduser("~")
    for p in (os.path.join(home, "xwechat_files"), os.path.join(home, "Documents", "xwechat_files")):
        e = emit(p if os.path.isdir(p) else None, "default")
        if e:
            yield e
    for d in _scan_xwechat_dirs(_fixed_drives()):
        e = emit(d, "scan")
        if e:
            yield e


def list_accounts():
    """枚举本机微信 4.x 账号数据目录：`[{wxid, dir, root, mtime, source}]`（按修改时间倒序）。

    先命中的探测源非空即返回（不再整盘扫描）。source ∈ ini/registry/default/scan。
    """
    for xdir, src in detect_xwechat_dirs():
        accts = _accounts_under(xdir)
        if accts:
            for a in accts:
                a["source"] = src
            return accts
    return []


def _root_from_any(p):
    """把一个可能是 db_storage / 账号目录 / xwechat_files / 其父目录的路径解析成 db_storage。"""
    if not p:
        return None
    try:
        q = os.path.normpath(os.path.expandvars(os.path.expanduser(p.strip())))
    except Exception:
        return None
    if _valid_root(q):
        return q
    if _valid_root(os.path.join(q, "db_storage")):
        return os.path.join(q, "db_storage")
    d = _resolve_xwechat_dir(q)
    if d:
        accs = _accounts_under(d)
        if accs:
            return accs[0]["root"]
    return None


def db_root_info():
    """定位微信数据目录，返回 `(root, source)`；source ∈ env/ini/registry/default/scan。

    优先级：`LUMII_WECHAT_DB`（显式路径，最高）> `LUMII_WECHAT_ACCOUNT`（指定 wxid/目录名）
    > 探测源（ini > 注册表 > 默认 > 固定盘扫描）。探测失败给出可操作提示。
    """
    env = os.environ.get("LUMII_WECHAT_DB")
    if env:
        root = _root_from_any(env)
        if root:
            return root, "env"
    accts = list_accounts()
    want = os.environ.get("LUMII_WECHAT_ACCOUNT")
    if want:
        for a in accts:
            if a["wxid"] == want or a["dir"] == want:
                return a["root"], a.get("source", "auto")
        avail = "、".join(a["wxid"] for a in accts) if accts else "（无）"
        raise RuntimeError(f"LUMII_WECHAT_ACCOUNT={want} 未匹配到账号数据目录。可选账号：{avail}")
    if not accts:
        home = os.path.expanduser("~")
        hint = ("未找到微信 4.x 数据目录。已尝试：\n"
                "  - 环境变量 LUMII_WECHAT_DB\n"
                "  - 配置 %APPDATA%/Tencent/xwechat/config/*.ini\n"
                "  - 注册表 HKCU\\Software\\Tencent\\Weixin\n"
                f"  - 默认路径 {home}/xwechat_files、{home}/Documents/xwechat_files\n"
                "  - 固定盘扫描（深度≤2）")
        if os.name == "nt":
            hint += ("\n\n修复建议：\n1. 确认微信已登录并有聊天记录\n"
                     "2. 在微信「设置 → 文件管理」里确认数据目录\n"
                     "3. 仍找不到时手动指定："
                     "LUMII_WECHAT_DB=<数据目录>\\xwechat_files\\<账号>_<4位>\\db_storage")
        raise RuntimeError(hint)
    return accts[0]["root"], accts[0].get("source", "auto")


def db_root():
    """定位微信 4.x 数据目录（含 message/message_0.db）。"""
    return db_root_info()[0]


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


# 非文本消息里的「人话」——以前一律压成 `[非文本消息]`，等于把图片/语音/位置/链接
# 全部信息丢掉（本机实测 470+ 条，占样本的 1/3）。这里按 local_type 抽成一行摘要。
_LINK_KINDS = {
    5: "链接", 6: "文件", 19: "聊天记录", 33: "小程序", 36: "小程序", 44: "视频号",
    49: "文件", 51: "视频号", 57: "直播", 63: "视频号", 87: "群公告",
    2000: "转账", 2001: "红包", 2002: "转账", 2003: "转账",
}


def _attr(raw, name):
    """取 XML 属性值（不引 bs4：这些标签结构固定，正则够用且不引入依赖）。"""
    m = re.search(name + r'="([^"]*)"', raw)
    return m.group(1) if m else ""


def _tag(raw, name):
    m = re.search(r"<" + name + r"[^>]*>(.*?)</" + name + r">", raw, re.S)
    return m.group(1).strip() if m else ""


def _num(raw, name):
    """数值字段——**先属性后元素**。

    appmsg 的 `<type>` 是**元素**（`<type>6</type>`），而 `img` 那些是**属性**（`length="18227"`）。
    只认属性会把分享文件的 `type=6` 读成 0，于是文件全被标成「链接」（实测踩过）。
    """
    v = _attr(raw, name) or _tag(raw, name)
    return int(v) if v.isdigit() else 0


def _unxml(s):
    import html
    s = (s or "").strip()
    if s.startswith("<![CDATA[") and s.endswith("]]>"):     # 通话那类内容包在 CDATA 里
        s = s[9:-3]
    return html.unescape(s).strip()


def describe_nontext(lt, raw):
    """非文本消息 → 一行**人能读的摘要**（以前一律是 `[非文本消息]`）。

    ⚠️ 只给**元数据**，拿不到内容本身——这一点是实测定死的，别再试：
    - **图片**：聊天图存在 `msg/attach/<hash>/<月>/Img/*.dat`，是 **V4 加密**
      （magic `07085632`，V3 是 `...31`）。试过用消息 XML 里的 `aeskey` 做
      AES-ECB/CBC 解密（398 个密钥 × 8 个偏移）**全部未命中**；文件里嵌明文 JPEG 的只有
      1.4%（7/504）；`cache/<月>/Message/<hash>/Thumb/` 看着像图片缩略图，实测 85 张
      **全是 type=49 的文章封面**，没有一张对得上 type=3。→ 要拿图片内容得先逆向 V4，
      是研究任务，不是顺手能做的。
    - **语音**：本机**一个音频文件都没有**（全盘搜 `.silk/.slk/.amr` 为空），
      `Msg` 表也没有转写列，`voicemsg` 只带 `voiceurl`+`aeskey`——
      音频在微信服务器上，播放时才按需下载。→ 离线拿不到，只能给时长。
    """
    if lt == 3:
        n = _attr(raw, "length")             # 中间图字节数
        size = ""
        if n.isdigit() and int(n) > 0:
            b = int(n)
            size = f" {b / 1024:.0f}KB" if b >= 1024 else f" {b}B"
        return f"[图片{size}]"
    if lt == 34:
        # voicelength 是**毫秒**（实测 2000 → 2.0 秒、11338 → 11.3 秒）
        ms = _attr(raw, "voicelength")
        sec = f" {int(ms) / 1000:.1f} 秒" if ms.isdigit() else ""
        return f"[语音{sec}]"
    if lt == 43:
        pl = _attr(raw, "playlength")
        return f"[视频 {pl} 秒]" if pl else "[视频]"
    if lt == 47:
        return "[表情]"
    if lt == 48:
        label, poi = _attr(raw, "label"), _attr(raw, "poiname")
        where = " ".join(x for x in (poi, label) if x)
        return f"[位置] {where}" if where else "[位置]"
    if lt == 49:
        kind = _LINK_KINDS.get(_num(raw, "type"), "链接")
        title = _unxml(_tag(raw, "title")) or _unxml(_attr(raw, "title"))
        url = _unxml(_tag(raw, "url"))
        out = f"[{kind}] {title}" if title else f"[{kind}]"
        if url:
            out += f" ({url[:120]})"
        return out
    if lt == 50:
        body = _unxml(_tag(raw, "msg"))      # CDATA：「通话时长 02:41」「已在其它设备接听」
        dur = _attr(raw, "duration")
        out = "[通话] " + (body or "已结束")
        if dur.isdigit() and dur != "0":
            out += f"（{int(dur) // 60}分{int(dur) % 60}秒）"
        return out
    if lt == 42:
        nick = _attr(raw, "nickname")
        return f"[名片] {nick}" if nick else "[名片]"
    if lt == 10000:                          # 系统消息：撤回、入群、拍一拍…
        body = _unxml(_tag(raw, "content"))  # `revokemsg` 这类内容直接在 <content> 里
        if body:
            return body
        # `sysmsgtemplate` 是**模板 + 变量**：模板里写 `"$username$"邀请"$names$"加入了群聊`，
        # 变量值在同级的 <link name="username"> → <list> → <nickname> 里。
        tmpl = _unxml(_tag(raw, "template"))
        if tmpl:
            for m in re.finditer(r'<link name="([^"]+)"[^>]*>(.*?)</link>', raw, re.S):
                nick = _unxml(_tag(m.group(2), "nickname"))
                if nick:
                    tmpl = tmpl.replace(f"${m.group(1)}$", nick)
            tmpl = re.sub(r"\$\w+\$", "", tmpl).strip()   # 没替上的变量清掉，别漏给 Agent
            if tmpl:
                return tmpl
        return "[系统消息]"
    if lt == 10002:
        return "[系统消息]"
    return "[非文本消息]"


# 群聊里 `message_content` 前**先缀了发送者**。两种形态：
#   非文本：`hdghdx: <?xml…`       → 不剥的话 `startswith("<")` 判定失败，整段 XML 漏给 Agent（实测踩过）
#   纯文本：`vicky1990202:\n12345那边回复了`  → 冒号后**紧跟换行**（实测 1117 条群文本命中 1010 条，
#           单聊 1461 条命中 **0** 条 ⇒ 这个形状本身足够安全）
# 不剥纯文本那半的后果（2026-10-10 实测）：群历史、会话预览、搜索、以及**群画像卡里的范本**
# 全是裸 id；而且客户端 `formatIncomingForHistory` 自己会补「名字：」，于是显示成
# `张三：wxid_xxx: 好的`。发送者另有 `sender` 字段承载，这里只管剥干净。
_PREFIX_RE = re.compile(r"^[^\s:]{1,40}:(?:\n|\s*(?=<))")


def _media_paths():
    """所有 `message/media_*.db` 的**明文镜像路径**（语音数据住在这里）。

    语音**不在磁盘文件里**——`VoiceInfo.voice_data` 才是音频本体（明文 SILK_V3，
    头 `\\x02#!SILK_V3`）。2026-10-10 实测本机 36 条全在，别再去文件系统里找 `.silk`（找不到）。

    **返回路径而不是连接**：`refresh()` 会**重写镜像文件**，而这里要能看见刚写进去的新行
    （语音 SILK 是异步落库的）。连接一旦缓存住就可能读到旧页——每次现开最稳。
    """
    out = []
    try:
        names = os.listdir(os.path.join(db_root(), "message"))
    except OSError:
        return out
    for n in names:
        if not (n.startswith("media_") and n.endswith(".db")):
            continue
        try:
            m = _mirror("message/" + n)
            m.refresh()
            out.append(m.out)
        except Exception:
            continue
    return out


# 语音 SILK 的异步下载窗口：只对**这个时长内**的语音等待（更老的数据已永久缺失）
_VOICE_FRESH_S = 180
# 有界等待：最多等这么久、每次隔这么久再看一眼。盯梢一拍 15s，这里封顶 6s 不会把节拍拖垮
_VOICE_WAIT_S = 6.0
_VOICE_POLL_S = 1.5


def voice_file(talker, ct, local_id=None):
    """把一条语音的 SILK 落成临时文件，返回路径；没有则 None。

    **为什么不直接回字节**：MCP 工具结果是文本，几万字节的 base64 灌进模型上下文纯属浪费，
    而且模型也解不了 SILK。落成文件，交给客户端**本来就有的**那套去处理
    （`channel/media-pipeline.transcribeVoiceFile`：silk-wasm 解码 → 本地 ASR → 文字，
    QQ/飞书语音走的就是它）。Python 这边因此**不需要任何新依赖**。

    **必须带 `local_id` 消歧**：`VoiceInfo` 与 `Msg_*` 用 `local_id` 一一对应，
    而 `create_time` 会撞（实测同一秒两条语音：lid 41 是 3.4 秒、lid 42 是 34.8 秒）。
    只按 `create_time` 取第一条会**转写出另一个人的另一段话**——比不转写更糟。
    没给 `local_id` 时宁可返回 None。

    命中率是**部分的**（本机 47 条语音消息里 36 条有数据，其余更早被清掉了）。

    **刚到的语音要等一拍**：SILK 是**异步下载**的——消息先落库、音频几秒后才写进 `VoiceInfo`
    （2026-10-10 实测：14:12:55 的语音，回声处理时读不到、过后就有了）。所以对**最近几分钟**的
    语音做有界重试；老语音不等待——它们的数据是**永久缺失**的，等再久也没有。
    """
    if local_id is None:
        return None
    recent = (time.time() - ct) < _VOICE_FRESH_S
    deadline = time.time() + (_VOICE_WAIT_S if recent else 0)
    while True:
        for path in _media_paths():          # 每次都重新取路径（refresh 会重写镜像）
            row = None
            try:
                conn = sqlite3.connect(path)  # 现开现关：缓存的连接会读到重写前的旧页
                try:
                    row = conn.execute(
                        "select v.voice_data from VoiceInfo v "
                        "join Name2Id n on v.chat_name_id = n.rowid "
                        "where n.user_name=? and v.local_id=? limit 1",
                        (talker, local_id)).fetchone()
                finally:
                    conn.close()
            except Exception:
                row = None
            if row and row[0]:
                d = os.path.join(WORK, "voice")
                try:
                    os.makedirs(d, exist_ok=True)
                    p = os.path.join(d, f"{hashlib.md5(talker.encode()).hexdigest()[:12]}_{ct}_{local_id}.silk")
                    if not os.path.exists(p):
                        raw = row[0] if isinstance(row[0], (bytes, bytearray)) else bytes(row[0])
                        with open(p, "wb") as f:
                            f.write(raw)
                    return p
                except OSError:
                    return None
        if time.time() >= deadline:
            return None
        time.sleep(_VOICE_POLL_S)


def _render(lt, content):
    """消息 → 一行可读文本。**唯一入口**——历史、会话列表预览、搜索、画像蒸馏都走它，
    免得有的地方还在吐原始 XML / 裸 wxid 前缀。"""
    # 顺序要紧：得在把换行压成空格**之前**剥前缀（纯文本那种形态靠 `\n` 定位）
    raw = _PREFIX_RE.sub("", decode(content)).replace("\n", " ").strip()
    if raw.startswith("<"):
        return describe_nontext(lt & 0xFFFFFFFF, raw)
    return raw


_ATUSERS_RE = re.compile(r"<atuserlist><!\[CDATA\[(.*?)\]\]></atuserlist>", re.S)


def at_me_in_source(source, me):
    """`source`（`msgsource` XML）的 `<atuserlist>` 里有没有本人 wxid。

    群消息 @人 时微信把**被 @ 的 wxid** 写在这里（2026-10-10 实测本机群库），是**确定性**信号
    ——比拿昵称去正文里猜可靠得多：群昵称跟全局昵称经常不是一回事（本人在群里叫 TOOLAN，
    正文里就只是一句 `@TOOLAN …`，同名/改名立刻失准）。
    """
    if not source or not me:
        return False
    try:
        s = decode(source) if isinstance(source, (bytes, bytearray)) else str(source)
    except Exception:
        return False
    m = _ATUSERS_RE.search(s)
    if not m:
        return False
    return me in [x.strip() for x in re.split(r"[,\s]+", m.group(1)) if x.strip()]


def msg_dict(ct, lt, content, nm, talker=None, name=None, sender=None, me=None, local_id=None,
             source=None):
    d = {"time": _ts(ct), "ts": ct, "type": lt & 0xFFFFFFFF, "text": _render(lt, content)[:400]}
    if local_id is not None:
        d["local_id"] = local_id             # 会话内稳定序号；语音靠它精确对应到 VoiceInfo
    if talker is not None:
        d["talker"] = talker
        d["name"] = name
    if sender is not None:                    # 发送者（real_sender_id 判定）；用于蒸馏分辨双方
        d["from_me"] = (sender == me) if sender else False
        d["sender"] = ("我" if sender == me else nm.get(sender, sender)) if sender else "(未知)"
    if at_me_in_source(source, me):           # 群消息 @我（客户端按它决定群要不要叫代聊）
        d["at_me"] = True
    return d


def _ts(ct):
    import time as _t
    return _t.strftime("%Y-%m-%d %H:%M:%S", _t.localtime(ct))


def sessions():
    nm = names()
    out = []
    for tbl, talker in talkers():
        rows = _rows(tbl, 1)
        # 走 _render：不然最后一条是图片/语音时，会话列表预览会吐一整段 XML
        last = _render(rows[0][1], rows[0][2])[:80] if rows else ""
        out.append({"talker": talker, "name": nm.get(talker, talker), "last": last})
    out.sort(key=lambda r: r["name"])
    return out


def attach_voice(msgs, talker):
    """给语音消息补上 `voice_path`（本地 SILK 文件），失败静默跳过。

    只对 `type=34` 且**真能从 `VoiceInfo` 取到音频**的消息加。客户端拿这个路径去
    解 SILK + 转写（见 `voice_file` 的说明）；取不到就只剩 `[语音 N 秒]` 那段元数据。
    """
    for m in msgs:
        if m.get("type") != 34:
            continue
        try:
            p = voice_file(talker, m["ts"], m.get("local_id"))
        except Exception:
            p = None
        if p:
            m["voice_path"] = p
    return msgs


def history(talker, limit=10, before_ts=0):
    """读历史（时间正序）。`before_ts` 取更早一页：只返回 create_time 严格小于它的消息。

    返回带 `cursor`（本页最老一条的 ts）与 `has_more`，Agent 可用 `before_ts=cursor` 翻更早的页。
    """
    nm = names()
    me = self_wxid()
    rows = _rows_full(tbl_of(talker), limit, before=before_ts)
    msgs = [msg_dict(ct, lt, c, nm, sender=s, me=me, local_id=lid, source=src)
            for ct, lt, c, s, lid, src in reversed(rows)]
    attach_voice(msgs, talker)
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
            batch = [msg_dict(ct, lt, content, nm, talker=talker, name=nm.get(talker, talker),
                              sender=sender, me=me, local_id=lid, source=src)
                     for ct, lt, content, sender, lid, src in rows]
            # 入站语音要能被代聊「听懂」：补上 SILK 文件路径，客户端据此转写。
            # 只在真有 type=34 时才去碰 media 库，绝大多数轮询是零成本。
            if any(m.get("type") == 34 for m in batch):
                attach_voice(batch, talker)
            out.extend(batch)
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


def _msg_select(tbl, where, with_source=True):
    """`Msg_*` 的公共 select（第 6 列是 `source`）。

    `with_source=False` 是**退化路**：老库/异形库里没有 `source` 列时不能整条读不出来
    ——那只 @我 信号没了，消息本身还是要读得到（盯梢宁可不认 @，也不能变成瞎子）。
    """
    col = "source" if with_source else "NULL"
    return (f"select create_time, local_type, message_content, real_sender_id, local_id, {col}"
            f" from [{tbl}]" + where + " order by create_time desc limit ?")


def _query_rows(c, tbl, where, params, with_source):
    """带 `source` 的查询失败（列不存在）就退化成不带它——见 `_msg_select`。"""
    try:
        return list(c.execute(_msg_select(tbl, where, with_source), params))
    except Exception:
        if not with_source:
            return []
        try:
            return list(c.execute(_msg_select(tbl, where, False), params))
        except Exception:
            return []


def _rows_full_conn(conns, rels, tbl, limit, since=0):
    """跨分片取 `[(create_time, local_type, content, sender, local_id, source)]`（复用调用方的连接）。"""
    where = " where create_time > ?"
    out = []
    for p in rels:
        smap = _cache["senders"].get(p, {})
        try:
            c = conns.get(p)
            if c is None:
                c = conns[p] = sqlite3.connect(p)
            rows = _query_rows(c, tbl, where, (since, limit), True)
        except Exception:
            continue
        for ct, lt, content, sid, lid, src in rows:
            out.append((ct, lt, content, smap.get(sid, ""), lid, src))
    out.sort(key=lambda r: r[0], reverse=True)
    return out[:limit]


def resolve_talker(query):
    """把显示名 / wxid / 群号解析成 talker。**严格**：只有唯一确定才返回，否则 None。

    安全要点（踩过事故）：**绝不做「短名嵌在长查询里」的宽松匹配**——
    查询「TOOLAN、韩玉」含子串「TOOLAN」，宽松匹配会命中好友 TOOLAN，导致**发错人**。
    所以：精确匹配 → 唯一候选的「查询是名字的子串」→ 否则一律 None（宁可不发，由上层报错让 Agent 重问）。

    **大小写不敏感**（2026-10-08 实测事故）：用户/Agent 常把 `Loop` 敲成 `loop`，
    之前严格区分大小写 → 「找不到会话」，人就卡在这一步（真实案例：飞书里说「发给loop」，
    助手回「微信里没有叫 loop 的会话」）。大小写不构成歧义，放开它不影响防错人。
    """
    if not query:
        return None
    q = str(query).strip()
    nm = names()
    talks = {t for _, t in talkers()}
    if q in nm or q in talks:
        return q
    # ① 区分大小写的精确匹配优先：**规范名**（微信里原样的显示名）必须永远可用。
    #    本机实测有三个 loop（`Loop`/`loop`/`loop`）——若先做忽略大小写，规范名 'Loop'
    #    反而变成三选一的歧义，把「本来能解析」的也弄坏。
    exact = [u for u, d in nm.items() if d == q]
    if len(exact) == 1:
        return exact[0]
    # ② 忽略大小写的精确匹配：仅唯一时采信（用户敲 loop 想找 Loop，但本机真有多个 loop 时
    #    这里会数出 3 个 → 落到 ③/④ 拒绝，交给上层问清是哪个）。
    ql = q.lower()
    ci = {u for u, d in nm.items() if d and d.lower() == ql}
    ci |= {t for t in talks if t.lower() == ql}
    if len(ci) == 1:
        return next(iter(ci))
    # ③ 模糊：仅当「查询是名字的子串」（用户只打了名字的一部分）且**候选唯一**时才采用
    cands = set()
    if len(q) >= 2:
        cands |= {u for u, d in nm.items() if d and ql in d.lower()}
    if len(q) >= 5:
        cands |= {t for t in talks if ql in t.lower()}
    if len(cands) == 1:
        return next(iter(cands))
    return None


def suggest_talkers(query, limit=6):
    """解析失败时的**近似候选**（名字或 talker 包含查询，忽略大小写）。

    用途：`resolve_talker` 拒绝歧义之后，上层不该只说「找不到」——本机真有三个 `loop`，
    要把它们列出来（`Loop(wxid_s6piy…)` / `loop(wxid_s7vhn…)` / `loop(zhaorenjien)`），
    人或 Agent 才能一句问清是哪个，而不是卡在「没有这个会话」。
    """
    q = str(query or "").strip().lower()
    if not q:
        return []
    nm = names()
    out = []
    for u, d in nm.items():
        if q in (d or "").lower() or q in u.lower():
            out.append({"talker": u, "name": d or u, "has_history": False})
    seen = {t for _, t in talkers()}
    for r in out:
        r["has_history"] = r["talker"] in seen
    out.sort(key=lambda r: (not r["has_history"], r["name"]))
    return out[:limit]


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
        for ct, lt, content, s, _lid, _src in rows:
            if since and ct <= since:
                continue
            if until and ct >= until:
                continue
            # 搜**渲染后的文本**而不是原始 XML：这样「图片」「语音」「撤回」这些
            # 摘要词才搜得到，也避免命中 XML 属性里的随机十六进制（aeskey/md5 之类）。
            if keyword in _render(lt, content):
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
    out = []
    for p in _cache["msg"]:
        if tbl not in _cache["tables"].get(p, ()):
            continue
        smap = _cache["senders"].get(p, {})
        c = sqlite3.connect(p)
        try:
            for ct, lt, content, sid, lid, src in _query_rows(c, tbl, where, params + [limit], True):
                out.append((ct, lt, content, smap.get(sid, ""), lid, src))
        except Exception:
            pass
        finally:
            c.close()
    out.sort(key=lambda r: r[0], reverse=True)
    return out[:limit]


def _tokens(t):
    return [w for w in re.findall(r"[A-Za-z]{2,}|[一-鿿]{2,}", t) if w.lower() not in _STOP]


_CJK_PUNCT = set("，。！？、：；…—～·「」『』《》（）")
_LONG_RUN = re.compile(r"[A-Za-z0-9+/=_-]{20,}")     # base64/token/长路径碎片
_SHELLY = re.compile(r"^(root@|\$ |# |[A-Za-z]:\|ps [A-Za-z]|sudo )")


def is_conversational(t):
    """这条消息是不是「**人打字说的话**」，而不是粘过来的命令/URL/配置/日志。

    为什么要它（2026-10-10 实测）：`top_words` 里前 20 有 7 个来自**同一条**粘贴的终端会话
    （`root@iZww601n9e4jlvpsogs18mZ:/home/wxwj# ls …` → 贡献 tomcat/wxwj/iZww/jlvpsogs/mZ/home/root），
    外加粘的配置（`ANTHROPIC_AUTH_TOKEN`、`sk-…`）。画像的「常聊话题」于是写成「服务器运维」——
    **那只是他把终端输出粘进聊天，不是他在聊什么**。
    同一批污染也在拉低风格统计：60 字的 base64 落进「26+ 字」档、且不带中文标点。
    """
    if not t:
        return False
    if "://" in t:                                    # URL
        return False
    if _SHELLY.match(t) or t.count("\n") >= 3:        # 终端提示符 / 多行粘贴
        return False
    if _LONG_RUN.search(t):                           # 一长串无空格字母数字 = token/密钥/路径
        return False
    # 可打印 ASCII（字母数字+常见符号）占比过高 ⇒ 代码/配置/日志，不是中文口语
    ascii_ish = sum(1 for c in t if c.isascii() and (c.isalnum() or c in "{}[]()<>/\|;=+*&^%$#@!~`\"'"))
    if ascii_ish / len(t) > 0.7:
        return False
    return True
_EMOJI_CODE = re.compile(r"\[[^\]\[]{1,6}\]")     # 微信表情短码，如 [捂脸]


_LEN_BUCKETS = (("1-5", 1, 5), ("6-12", 6, 12), ("13-25", 13, 25), ("26+", 26, 10 ** 9))
_SPACE_DELIM = (" ", "\t", "　")           # 半角空格 / 制表 / 全角空格


def _lenb(L):
    """长度 → 档名（`_LEN_BUCKETS` 的**唯一取档处**，别在各处再写一遍 if-else）。"""
    for k, lo, hi in _LEN_BUCKETS:
        if lo <= L <= hi:
            return k
    return "26+"


def style_stats(texts):
    """从我发出去的消息里量出**可核对的**打字风格数字。

    为什么要它：以前只给模型的 `avg_len` + 二十几条样本，模型就拿目测去写「口吻」那一栏——
    实测踩过：本机 809 条里 36% 带中文标点、长句（13 字以上）**66–69% 都带**，
    但样本里大量是「要得」「可以」这种三字短句，模型于是写成「**几乎不加标点**」，
    代聊照着模仿，用户一眼看出不对（2026-10-10 用户报障）。

    **短句本来就不需要标点**，所以只看总比例同样会误导——必须**按长度分层**给。

    `delim_long` 是补的第二刀：标点率只问「有没有中文标点」，而实测有人长句是
    **用空格代顿号**（「差不多 一整天都是阴的 上午到中午小雨最密 …出门带伞」）——
    空格不算标点，那条会被算进「无标点」，卡上「26+ 字 88% 带标点」于是偏高。
    """
    buckets = {k: [0, 0] for k, _, _ in _LEN_BUCKETS}
    n = punct = emoji = 0
    dl = {"n": 0, "punct": 0, "space": 0, "newline": 0, "none": 0}
    for t in texts:
        t = (t or "").strip()
        if not t or len(t) > 300 or not is_conversational(t):
            continue
        n += 1
        has_p = any(c in _CJK_PUNCT for c in t)
        if has_p:
            punct += 1
        if _EMOJI_CODE.search(t):
            emoji += 1
        L = len(t)
        key = _lenb(L)
        buckets[key][0] += 1
        if has_p:
            buckets[key][1] += 1
        if L >= 13:                        # 短句本来就不需要断句，只统计 13 字以上
            has_s = any(c in _SPACE_DELIM for c in t)
            has_n = "\n" in t
            dl["n"] += 1
            if has_p:
                dl["punct"] += 1
            if has_s:
                dl["space"] += 1
            if has_n:
                dl["newline"] += 1
            if not (has_p or has_s or has_n):
                dl["none"] += 1
    if not n:
        return {}
    r = lambda c: round(c / dl["n"], 2) if dl["n"] else None
    return {
        "messages": n,
        "punct_rate": round(punct / n, 2),
        "emoji_rate": round(emoji / n, 2),
        "length_hist": {k: v[0] for k, v in buckets.items()},
        # 按长度分层的标点率——**这一栏才是关键**，别只看总的
        "punct_rate_by_len": {k: (round(v[1] / v[0], 2) if v[0] else None)
                              for k, v in buckets.items()},
        # 13 字以上怎么断句（可叠加：既用标点也用空格是常态，四项不互斥）
        "delim_long": {"n": dl["n"], "punct": r(dl["punct"]), "space": r(dl["space"]),
                       "newline": r(dl["newline"]), "none": r(dl["none"])},
    }


def style_samples(texts, per_bucket=4, cap=200):
    """按**长度分层**挑几条原文，让上层看得见「长句是怎么写的」。

    为什么要它：`samples_from_me` 是「最新 24 条、每条截断到 80 字」。而口吻的关键恰恰在长句
    ——短句（「要得」「可以」）本来就不带标点，看不出风格；长句才分得出「用不用标点、怎么断句」。
    只给短样本，模型只能写出「几乎不加标点」这种错结论（2026-10-10 用户报障）。
    所以这里**每个长度档各给几条**，并且放宽截断（200 字）。
    """
    out = {k: [] for k, _, _ in _LEN_BUCKETS}
    for t in texts:
        t = (t or "").strip()
        if not t or not is_conversational(t):
            continue
        k = _lenb(len(t))
        if len(out[k]) < per_bucket:
            out[k].append(t[:cap])
    return out


# ---------- 范本对：对方说了什么 → 我回了什么（代聊面对的**就是这道题**）----------
_PAIR_GAP_S = 120          # 两条之间 ≤120s（中间没人插话）算同一「轮」
_PAIR_MIN_THEIR = 3        # 「?」「？」这种没有信息，别当范本
_PAIR_SCAN = 300           # 一次最多攒多少组（护栏，防大群把内存/耗时拉爆）


def _seq_of(rows, me, nm, talker):
    """rows（`_rows_full` 的产物，倒序）→ 时间正序的 `[(ct, 是不是我, 文本)]`。

    **同秒按 `local_id` 排**：微信时间戳只到秒，同秒的两条不加这层就会乱序，
    直接把「对方说完我接什么」配错（2026-10-10 实测，v1 版就是这么错配的）。
    """
    out = []
    for r in sorted(rows, key=lambda x: (x[0], x[4] if isinstance(x[4], int) else 0)):
        ct, lt, content, sender, _lid, _src = r
        if (lt & 0xFFFFFFFF) != 1:            # 只认纯文本；图片/语音走 describe_nontext
            continue
        body = _render(lt, content).strip()
        if not body or body.startswith("[") or len(body) > 300:
            continue
        mine = bool(me) and sender == me
        # 群消息补上说话人，否则范本里不知道是谁说的（私聊不必——就在这个会话里）
        if not mine and str(talker).endswith("@chatroom") and sender:
            body = f"{nm.get(sender, sender)}：{body}"
        out.append((ct, mine, body))
    return out


def _pairs_from(seq):
    """时间正序的 seq → `[(对方一轮, 我一轮)]`。两侧都必须像「人说的话」。

    **两侧都要过滤**这条是实测定死的：只过滤对方那侧的话，抽样里会出现
    「对方：收到！ / 我：http://内网地址/login 明文账号口令」这种对子——
    而范本是要**每轮拼进提示词**的，等于把口令烤进每一次模型请求。
    """
    turns = []
    for ct, mine, txt in seq:
        if turns and turns[-1][1] == mine and ct - turns[-1][3] <= _PAIR_GAP_S:
            turns[-1][0].append(txt)
            turns[-1][3] = ct
        else:
            turns.append([[txt], mine, ct, ct])
    out = []
    for k in range(len(turns) - 1):
        a, b = turns[k], turns[k + 1]
        if a[1] or not b[1]:                  # 只要「对方 → 我」
            continue
        their, mine = " / ".join(a[0]), " / ".join(b[0])
        if len(their) < _PAIR_MIN_THEIR:
            continue
        if not (is_conversational(their) and is_conversational(mine)):
            continue
        out.append((their, mine))
        if len(out) >= _PAIR_SCAN:
            break
    return out


def _pick_pairs(pairs, per_bucket=2):
    """按**我这边回话的长度**分层各取几条——长短都要有，别全是「收到」。"""
    b = {k: [] for k, _, _ in _LEN_BUCKETS}
    for their, mine in pairs:
        k = _lenb(len(mine))
        if len(b[k]) < per_bucket:
            b[k].append({"them": their, "me": mine})
    return [p for k, _, _ in _LEN_BUCKETS for p in b[k]]


def digest(talker=None, limit=500, samples=6, top=15, since=0):
    """蒸馏「行为与语料」：全局（`talker` 为空）或指定会话。

    ⚠️ **`since` 只收窄「样本」，统计永远基于全量**（见下面 pairs 循环里的说明）——
    这样增量蒸馏拿去覆盖画像时不会把老底丢掉。
    

    **确定性**：只用本地库统计（**不调用 LLM、不外传**），返回结构化 digest（统计 + 代表性样本
    + **真实对子** `exchange_pairs`），供上层（LLM 或模板）提炼成「用户画像 / 好友画像」。
    发送者判定用 `real_sender_id`（精确）。
    """
    _refresh()
    me = self_wxid()
    nm = names()
    pairs = [(talker, tbl_of(talker))] if talker else [(t, tbl) for tbl, t in talkers()]
    hour = [0] * 24
    by_type, words = {}, {}
    my_lens, my_samples = [], []
    my_texts = []                     # 我发的原文（量风格用；封顶防内存）
    their_texts = []                  # **对方**发的原文（只在限定了某个会话时才有意义）
    ex_by_talker = {}                 # {talker: [(对方一轮, 我一轮)]}
    per_contact = {}
    total = from_me = 0
    for t, tbl in pairs:
        # ⚠️ **统计永远基于全量**（不加 `since`）：`since` 只用来挑「这次要看的**新样本**」。
        #
        # 为什么必须这样（2026-10-10 实测）：`profile_save` 是**整体覆盖**，而提示词教的是
        # 「回来用 distill_state 记水位，下次 `wechat_digest(since=水位)` 只处理新消息」。
        # 若统计也被 `since` 收窄，一次增量蒸馏就会把全量画像换成几天切片的统计——
        # 实测：3 天切片只剩 403 条（全量 3903）、联系人 69→21、活跃时段只有 15 个小时非零，
        # 写出来的画像会把这些当成「事实」。
        rows = _rows_full(tbl, limit)
        tot = fm = ft = 0
        first = last = 0
        sm_me, sm_them = [], []
        for ct, lt, content, sender, _lid, _src in rows:
            body = decode(content).strip()
            is_me = (sender == me)
            fresh = (not since) or ct > since     # 只影响**样本**（见下）
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
                    if fresh and len(sm_me) < samples:
                        sm_me.append(body[:80])
                    if fresh and len(my_samples) < samples * 4:
                        my_samples.append(body[:80])
                    # 只从**人说的话**里收词：粘的终端输出/配置/URL 不算「常聊话题」
                    if is_conversational(body):
                        for w in _tokens(body):
                            words[w] = words.get(w, 0) + 1
                    if len(my_texts) < 3000:
                        my_texts.append(body)
                elif fresh and len(sm_them) < samples:
                    sm_them.append(body[:80])
                if not is_me and len(their_texts) < 3000:
                    their_texts.append(body)
        if tot:
            per_contact[t] = {"talker": t, "name": nm.get(t, t), "total": tot,
                              "from_me": fm, "from_them": ft, "first_ts": first, "last_ts": last,
                              "sample_from_me": sm_me, "sample_from_them": sm_them}
        # 范本对：代聊每轮面对的题面就是「对方说了 X，我回什么」，**真实对子**比
        # 一堆我的单句更贴题（研究结论：exemplar 胜过描述；而这是同一道题的标准答案）
        ex_by_talker[t] = _pairs_from(_seq_of(rows, me, nm, t))
    if talker:
        pool = ex_by_talker.get(talker, [])
    else:                                 # 全局：各会话**轮流**取，免得被最大的那个会话包场
        _lsts = [v for k, v in ex_by_talker.items()
                 if v and k != "filehelper" and "ClawBot" not in nm.get(k, "")]
        pool = [x for i in range(max((len(v) for v in _lsts), default=0))
                for v in _lsts if i < len(v) for x in (v[i],)]
    exchange_pairs = _pick_pairs(pool, per_bucket=2 if talker else 3)
    top_words = sorted(words.items(), key=lambda kv: -kv[1])[:top]
    top_contacts = sorted(({"talker": k, "name": v["name"], "sent": v["from_me"]}
                           for k, v in per_contact.items()), key=lambda d: -d["sent"])[:top]
    return {
        "scope": talker or "all",
        "generated_at": int(time.time()),
        "shards": len(_cache["msg"]),
        "scanned_per_talker": limit,
        "since": since,
        # 明确告诉调用方：`since` 只影响 samples_*，下面这些统计是全量的
        "stats_scope": "all",
        "self": {"total": total, "from_me": from_me, "from_others": total - from_me,
                 "by_type": by_type, "hour_hist": hour,
                 "avg_len": round(sum(my_lens) / len(my_lens), 1) if my_lens else 0,
                 # **写口吻那一栏必须看这两个**（见 style_stats / style_samples 的说明）
                "style": style_stats(my_texts),
                "style_samples": style_samples(my_texts),
                # 对方那侧的风格（**只在 talker 限定了某个会话时才有意义**）：
                # 联系人画像的「沟通风格」写的是**对方**，以前同样只能目测 6 条样本
                **({"style_from_them": style_stats(their_texts),
                    "style_samples_from_them": style_samples(their_texts)}
                   if talker else {}),
                "top_contacts": top_contacts},
        "top_words": [{"word": w, "n": n} for w, n in top_words],
        "contacts": sorted(per_contact.values(), key=lambda d: -d["total"])[:top],
        "contacts_total": len(per_contact),
        "samples_from_me": my_samples,
        # **写口吻那一栏优先用这个**：真实对子（对方一轮 → 我一轮），按我回话的长度分层。
        # 它自带「长度匹配」「标点习惯」「该不该发表情」——比任何描述句都直接。
        "exchange_pairs": exchange_pairs,
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
