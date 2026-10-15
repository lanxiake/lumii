"""wechat_core —— 微信 4.x 本地数据只读读取（发现数据目录 / 取密钥 / 解密 / 查询）。

只用只读方式：进程内存只读扫描取密钥 + SQLCipher4 直读，不改动任何微信文件。
数据目录自动发现：`~/xwechat_files/<wxid>_<4hex>/db_storage`（可被环境变量 LUMII_WECHAT_DB 覆盖）。
"""
import glob
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


class EnvError(RuntimeError):
    """**环境没就绪**（不是"这个会话没数据"，也不是调用方传错了参数）。

    三个来源，都是"用户需要动手做点什么"而不是"重试就好"：
      1. 找不到微信数据目录（没登录过 / 自定义目录在别的盘且探测不到）
      2. `LUMII_WECHAT_ACCOUNT` 指定的账号不存在
      3. 读不到数据库密钥（微信没在运行 / 刚重启还没建连接）

    `hint` 是**给用户看的可操作建议**，与 `message`（发生了什么）分开——工具边界把两者
    一起端出去，别让用户对着 `FileNotFoundError` 猜。MCP 侧统一翻成 `env_not_ready`
    （见 `mcp_stdio.py`）。

    ⚠️ `__str__` **必须把 hint 一起带出来**：全仓有大量 `except Exception as e: ... str(e)`
    的兜底路径（主产品 `wechat-mcp/server.py` 的读类工具就是 `ERROR: {e}`、`check_env` 是
    `db_hint=str(e)`）。只把 hint 放独立属性，这些路径**一个字都看不到**——那等于把用户的
    修复建议弄丢了，比不分类还糟。
    """

    def __init__(self, message, hint=""):
        super().__init__(message)
        self.message = message        # 不含 hint 的原话，供结构化出口单取
        self.hint = hint

    def __str__(self):
        return f"{super().__str__()}\n\n{self.hint}" if self.hint else super().__str__()


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
        raise EnvError(
            f"LUMII_WECHAT_ACCOUNT={want} 未匹配到账号数据目录",
            hint=f"本机可选的账号有：{avail}。改成其中之一，或清掉这个环境变量让它自动挑。")
    if not accts:
        home = os.path.expanduser("~")
        tried = "\n".join(("  - 环境变量 LUMII_WECHAT_DB",
                           "  - 配置 %APPDATA%/Tencent/xwechat/config/*.ini",
                           "  - 注册表 HKCU\\Software\\Tencent\\Weixin",
                           f"  - 默认路径 {home}/xwechat_files、{home}/Documents/xwechat_files",
                           "  - 固定盘扫描（深度≤2）"))
        raise EnvError(
            "未找到微信 4.x 数据目录",
            hint=("已扫描路径（按优先级，全部落空）：\n" + tried +
                  "\n\n修复建议：\n"
                  "1. 确认微信**已登录**（没登录过就没有数据目录）\n"
                  "2. 在微信「设置 → 文件管理」里看数据目录在哪\n"
                  "3. 仍找不到时手动指定："
                  "LUMII_WECHAT_DB=<数据目录>\\xwechat_files\\<账号>_<4位>\\db_storage"))
    return accts[0]["root"], accts[0].get("source", "auto")


def db_root():
    """定位微信 4.x 数据目录（含 message/message_0.db）。"""
    return db_root_info()[0]


# ---------------------------------------------------------------------------
# 微信版本探测
#
# 为什么要它：这套代码**只在 4.1.15.x 上真机验过**，而它对微信内部结构的假设是硬的
# （`wxkey4` 的 Config.Cipher 结构体偏移、发送层的窗口类名、`uia_read.ps1` 的 AutomationId）。
# 换版本最怕的不是报错，是**静默给错东西**——所以宁可先报"这个版本没验证过"。
# ---------------------------------------------------------------------------

# 真机验证过的版本前缀（见 `wechat_sender.py:38` 的标注）。新版本验过就往这里加。
VERIFIED_VERSION_PREFIXES = ("4.1.15",)


def wechat_exe_path():
    """运行中的微信主程序路径（进程枚举 + 镜像路径查询，不依赖安装位置）。取不到返回 ""。"""
    import ctypes
    import wxkey4
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    k32 = ctypes.windll.kernel32
    # 三个原型都得显式写：只设 restype 的话 ctypes 猜不出 PID 该按什么类型传
    k32.OpenProcess.argtypes = (ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32)
    k32.OpenProcess.restype = ctypes.c_void_p
    k32.CloseHandle.argtypes = (ctypes.c_void_p,)
    k32.QueryFullProcessImageNameW.argtypes = (ctypes.c_void_p, ctypes.c_uint32,
                                               ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_uint32))
    # `find_wechat_pids` 返回 `(工作集字节数, pid)` 并按内存降序——主进程排在最前
    for _mem, pid in wxkey4.find_wechat_pids():
        h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            continue
        try:
            buf = ctypes.create_unicode_buffer(32768)
            size = ctypes.c_uint32(32768)
            if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                return buf.value
        finally:
            k32.CloseHandle(ctypes.c_void_p(h))
    return ""


def _exe_version(path):
    """读 PE 版本资源里的 FileVersion（形如 `4.1.15.19`）。读不到返回 ""。"""
    import ctypes

    class VS_FIXEDFILEINFO(ctypes.Structure):
        _fields_ = [("dwSignature", ctypes.c_uint32), ("dwStrucVersion", ctypes.c_uint32),
                    ("dwFileVersionMS", ctypes.c_uint32), ("dwFileVersionLS", ctypes.c_uint32),
                    ("dwProductVersionMS", ctypes.c_uint32), ("dwProductVersionLS", ctypes.c_uint32),
                    ("dwFileFlagsMask", ctypes.c_uint32), ("dwFileFlags", ctypes.c_uint32),
                    ("dwFileOS", ctypes.c_uint32), ("dwFileType", ctypes.c_uint32),
                    ("dwFileSubtype", ctypes.c_uint32), ("dwFileDateMS", ctypes.c_uint32),
                    ("dwFileDateLS", ctypes.c_uint32)]

    ver = ctypes.windll.version
    size = ver.GetFileVersionInfoSizeW(ctypes.c_wchar_p(path), None)
    if not size:
        return ""
    buf = ctypes.create_string_buffer(size)
    if not ver.GetFileVersionInfoW(ctypes.c_wchar_p(path), 0, size, buf):
        return ""
    ptr = ctypes.c_void_p()
    length = ctypes.c_uint32()
    if not ver.VerQueryValueW(buf, ctypes.c_wchar_p("\\"), ctypes.byref(ptr), ctypes.byref(length)):
        return ""
    info = ctypes.cast(ptr, ctypes.POINTER(VS_FIXEDFILEINFO)).contents
    if info.dwSignature != 0xFEEF04BD:
        return ""
    ms, ls = info.dwFileVersionMS, info.dwFileVersionLS
    return f"{ms >> 16}.{ms & 0xFFFF}.{ls >> 16}.{ls & 0xFFFF}"


def wechat_version():
    """微信版本 + 是否落在真机验证过的范围内。

    返回 `{"path","version","verified","hint"}`——**没装/没运行**时各项为空，按"未知"处理即可，
    不要当成故障。
    """
    path = wechat_exe_path()
    version = _exe_version(path) if path else ""
    verified = bool(version) and version.startswith(VERIFIED_VERSION_PREFIXES)
    if not path:
        hint = "微信未运行，无法读取版本"
    elif not version:
        hint = "读不到 exe 版本资源（非预期：权限不足，或安装被改过）"
    elif verified:
        hint = "该版本已真机验证"
    else:
        hint = (f"⚠️ 微信 {version} **未在本项目验证过**（已验：{'/'.join(VERIFIED_VERSION_PREFIXES)}.x）。"
                "读到的内容可能是错的——先 locate_db 确认数据目录能定位，"
                "再用 read_history 抽查几条与界面核对，别直接拿结果当真。")
    return {"path": path, "version": version, "verified": verified, "hint": hint}


def version_warning():
    """版本不在真机验证范围内时给一句告警，否则 `None`。

    这是给 `server.handle_tools_call` 的**单点注入**：本模块对微信内部结构的假设是硬的
    （`wxkey4` 的固定内存偏移、窗口类名、AutomationId），换版本最怕的不是报错，是**静默给错
    东西**——所以宁可每个工具结果都挂一句"这版没验过"。

    为什么不能只留在 `check_env` 里：Agent 不会每次先调它，用户更不会。而这条信息**只在
    出错前有用**，事后补报已经没意义了（与项目既有的 fail-closed 口径一致）。

    微信没运行 / 版本读不出来时**不**告警（那是"未知"，本模块按未知处理，不是故障，
    挂在每个结果上只会变成噪音）。实测本机 8ms/次，不值得加缓存。
    """
    v = wechat_version()
    return v["hint"] if v["version"] and not v["verified"] else None


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
        raise EnvError(
            "未能从微信进程内存取到数据库密钥",
            hint=("通常是这三种情况：\n"
                  "1. **微信没在运行** —— 打开微信并登录后重试\n"
                  "2. 微信**刚启动**、还没打开过任何聊天窗口 —— 点开一个会话，等几秒再试\n"
                  "3. 微信版本不在已验证范围内（密钥扫描依赖固定内存偏移）"
                  "—— 见 wechat_core.VERIFIED_VERSION_PREFIXES"))
    remember_keys(root, km, rem)
    return km


def lookup_db_key(km, rel):
    """按相对路径在密钥表里找 key。找不到返回 None。

    不要用 `next(...)`：找不到时抛的是 `StopIteration`，而 `str(StopIteration())` 是空串。
    MCP 把它收成 `ERROR:`，盯梢每拍都只看到一句空错误，分不清是该等微信还是该修代码。
    """
    want = str(rel).replace("\\", "/").lower()
    for _salt, pair in (km or {}).items():
        key, path = pair
        if str(path).replace("\\", "/").lower() == want:
            return key
    return None


def remember_keys(root, km, remaining):
    """完整密钥表才写入长缓存；还有库没扫到就不缓存。

    微信刚启动时，进程内存里常常只有一部分库的密钥。这种残缺表若按 `KEY_TTL_S`
    （10 分钟）缓存，盯梢会在密钥补齐之前每拍都用同一份表失败。返回是否写入了缓存。
    """
    if remaining:
        _key_cache.pop(root, None)
        return False
    _key_cache[root] = (km, time.time())
    return True


def _missing_key_error(rel):
    """某个库在重扫之后仍然没有密钥。文案必须非空，调用方靠它判断「等一等」而不是当硬故障。"""
    return EnvError(
        f"未能取到 {rel} 的数据库密钥",
        hint=("微信可能刚启动，内存里还没有这个库的密钥。"
              "打开微信并点开一个会话后会自动重试；持续如此再看微信版本是否在已验证范围内。"))


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
    key = lookup_db_key(km, rel)
    if key is None and _retry:
        # 表里没有这个库：作废缓存再扫一次（上次扫早了，或微信重启换了密钥）
        return _plain(keys(root, refresh=True), root, rel, _retry=False)
    if key is None:
        raise _missing_key_error(rel)
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
    # 写完再换名：任何时刻读到的都是完整的一份镜像。
    # ⚠️ Windows 不能替换一个**仍被打开**的文件。两种来路：调用方自己持着这个镜像的 sqlite
    # 连接（设计 §6.6 记过 C 踩的同一坑，修法是"刷新调用一律排在开连接之前"），
    # 或者杀软/索引器短暂占用。前者重试也没用，所以**重试之外还要把原因说清楚**——
    # 裸 PermissionError 会让人去查权限，而真正的原因是「你自己没关连接」。
    for attempt in range(3):
        try:
            os.replace(tmp, out)
            return out
        except PermissionError as e:
            if attempt == 2:
                raise PermissionError(
                    f"无法替换镜像 {out}：它正被占用。最常见的原因是**本进程还开着这个库的 "
                    f"sqlite 连接**（Windows 不允许替换已打开的文件）——请先 close() 再解密；"
                    f"其次是杀软/索引器短暂占用，重试即可。（原始错误：{e}）") from e
            time.sleep(0.05)


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
            k = lookup_db_key(km, self.rel)
            if k is None:
                k = lookup_db_key(keys(self.root, refresh=True), self.rel)
            if k is None:
                raise _missing_key_error(self.rel)
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
    # ⚠️ **57 是「引用」，不是「直播」**（2026-10-11 实测纠正）：扫全库 84 条
    # `appmsg <type>57` 的消息，**每一条**的 XML 里都带 `<refermsg>`（引用的原文 + 时间 +
    # 发送者），没有一条例外。原先标成「直播」会让每一条引用回复在代聊上下文里显示成
    # `[直播] <原文>`——模型据此判断消息性质时会读歪。
    49: "文件", 51: "视频号", 57: "引用", 62: "拍一拍", 63: "视频号", 87: "群公告",
    2000: "转账", 2001: "红包", 2002: "转账", 2003: "转账",
}

# 「升级提示页」——实测视频号/转账/小程序的 `<url>` 全指向这几类页面（`support.weixin.qq.com`
# 的 upgrade 模板、`mp.weixin.qq.com/mp/waerrpage?…&type=upgrade`），它们**不是内容**：
# 渲染成 `[转账] 微信转账 (https://support.weixin.qq.com/…upgrade…)` 既占地方又误导，
# 所以一律不往摘要里放。
_NAG_URL = re.compile(r"support\.weixin\.qq\.com|waerrpage|type=upgrade")


def _attr(raw, name):
    """取 XML 属性值（不引 bs4：这些标签结构固定，正则够用且不引入依赖）。

    ⚠️ **必须卡住属性名的左边界**（`(?<![\\w-])`）：裸 `re.search('type="')` 会命中
    `datatype="2"`。合并转发正是这样翻的车（2026-10-14 实测）：`<type>19</type>` 是**元素**、
    不匹配 `type="`，而它后面的 `<dataitem datatype="2">` 是全串第一个 `type="`，
    于是 type=19 被读成 2 ⇒ 整条合并转发显示成 `[链接] <标题> (<support.weixin.qq.com…>)`。
    同一根棍子还打中 `length="`（先命中 `cdnthumblength="`，拿缩略图字节数冒充原图大小）。
    """
    m = re.search(r"(?<![\w-])" + name + r'="([^"]*)"', raw)
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


# 合并转发（`appmsg type=19`）里 `<dataitem datatype="N">` 的类型表。
# 只有 1/2/8/17 在本机实测出现过（40 个 dataitem 样本），其余是**推断**——
# 推错了只会把某条显示成「内容」，不会吞消息，不值得为它去凑更全的表。
_MERGED_DT = {1: "文本", 2: "图片", 3: "视频", 4: "链接", 5: "位置", 6: "名片",
              7: "表情", 8: "文件", 16: "位置", 17: "聊天记录"}


def _nested_text(x, _depth=0):
    """引用/合并转发里**嵌着的原始内容** → 一行摘要。

    `<refermsg><content>` 不一定是纯文本：实测本机 15 条引用里，两条的被引内容是
    `<msg><img …/></msg>`、一条是 `<msg><appmsg …><type>6</type>`（文件）——直接当文本
    输出就是把一整段 XML 灌给模型。所以这里判出类型后**复用自己的 describe_nontext**。

    **群里的**引用还多一层坑：被引原文自带「发送者: 」前缀（实测 `wxid_jnt7kck7di1622: <?xml …`）。
    `_render` 早把换行压成了空格，所以那个前缀长成 `: ` 而不是 `:\n`——不在这儿复用
    `_PREFIX_RE` 剥一道，整段 XML 会原样漏进用户看到的文本（`test_automation` 全类型扫描逮到，
    589 条里 2 条）。剥完还是 XML 才继续解析；真是人话就原样留着。
    """
    s = (x or "").strip()
    if not s.startswith("<"):
        s = _PREFIX_RE.sub("", s)
        if not s.startswith("<"):
            return x.strip()
    if _depth >= 2:                                  # 引用里套引用，到此为止
        return ""
    for marker, lt in (("<img", 3), ("<voicemsg", 34), ("<videomsg", 43),
                       ("<location", 48), ("<appmsg", 49)):
        if marker in s:
            return describe_nontext(lt, s, _depth=_depth + 1)
    return ""


def refer_text(raw):
    """引用（`appmsg type=57`）→ `(谁说的, 被引用的原文)`；不是引用返回 `("", "")`。

    ⚠️ **别把 `<title>` 当被引内容**：实测 15 条 type=57，`<title>` 一律是**回复正文**
    （"都看过，还是需要很多专业知识的"），被引的原文在 `<refermsg><content>` 里
    （"AI网文、AI短剧都上了，是吧"）。说话人在 `<refermsg><displayname>`，**可能为空**
    （转发来的、或引用系统消息时）——空了就别硬填一个名字。
    """
    rm = re.search(r"<refermsg>(.*?)</refermsg>", raw, re.S)
    if not rm:
        return "", ""
    body = rm.group(1)
    return _unxml(_tag(body, "displayname")), _nested_text(_unxml(_tag(body, "content")))


def merged_forward(raw, _depth=0):
    """合并转发（`lt=49` + `appmsg type=19`）→ 逐条 `{sender, time, ts, kind, text}`。

    **整段内容都在 `<recorditem>` 的 CDATA 里**（一段独立的 `<recordinfo>` XML）。
    展不开就返回 `[]` —— 调用方按「内容不可读」处理，不要假装展开成功。

    实测本机 8 条合并转发、40 个 dataitem 的四类形状：

    | datatype | 内容住哪 | 例 |
    |---|---|---|
    | 1  文本 | `<datadesc>` | "你如果有自己的意识…" |
    | 2  图片 | 只有 `datafmt`/`datasize`，**没有标题** | → `[图片]` |
    | 8  文件 | `<datatitle>` | "给6岁宝贝的日式料理50道.html" |
    | 17 嵌套的合并转发 | `<datatitle>` + `<datadesc>`（多行预览） | — |

    `ponytail:` datatype=17 用它自带的 `<datadesc>` 预览（已是人话），没有递归进它自己的
    `<recordxml>`——真要嵌套展开时再补。
    """
    if _depth >= 1:
        return []
    inner = _unxml(_tag(raw, "recorditem"))
    if not inner.startswith("<"):
        return []
    out = []
    for m in re.finditer(r"<dataitem\b([^>]*)>(.*?)</dataitem>", inner, re.S):
        attrs, body = m.group(1), m.group(2)
        kind = int(_attr(attrs, "datatype") or 0)
        text = _unxml(_tag(body, "datadesc")) or _unxml(_tag(body, "datatitle"))
        if not text:
            text = "[%s]" % _MERGED_DT.get(kind, "内容")
        # 压掉多余空白但**留住换行**：datatype=17（嵌套转发）的 `<datadesc>` 是多行预览
        # （`Miku: xxx\nMiku: yyy`），全压成一行会把 4 个人的发言糊成一大坨（实测）。
        out.append({"sender": _unxml(_tag(body, "sourcename")),
                    "time": _unxml(_tag(body, "sourcetime")),
                    "ts": _num(body, "srcMsgCreateTime"),
                    "kind": kind,
                    "text": "\n".join(" ".join(ln.split()) for ln in text.splitlines() if ln.strip())})
    return out


def forward_block(raw):
    """合并转发正文 → `> 说话人 时间：正文` 的多行块；展不开返回 `""`（不假装成功）。

    形状与导出层（`exportcore` 的 md 转发块）**一致**：同一个东西两处长得不一样，
    下次改的人就得先判断哪个是正本。`datatype=17`（嵌套转发）的 `text` 自带换行，
    首行挂说话人、续行不挂（照抄 exportcore 的排法）。
    """
    out = []
    for it in merged_forward(raw):
        head = " ".join(x for x in (it["sender"], it["time"]) if x)
        for i, ln in enumerate(str(it["text"]).split("\n")):
            out.append("> " + (head + "：" if head and i == 0 else "") + ln)
    return "\n".join(out)


# ---------------------------------------------------------------------------
# 文件消息（`appmsg type=6`）→ 磁盘上的真文件
# ---------------------------------------------------------------------------
# 原先住在 `wechat-file-mcp/filecore.py`（A 归档）。B 导出也要"把记录里的文件一起收出来"
# （用户说的"提取文件"），而这段是**读原语**、不是某个产品的策略，所以上移到共享层：
# 一份实现，两个产品用。A 只留"归档布局怎么摆"那部分（`_dest_path` / `_conflict` 等）。
#
# 关键实测事实（2026-10-12，当时写在 filecore 里的，一并带过来）：
# - 消息 `<title>` 与磁盘文件名**直接同名**；同名用 `<totallen>` 对大小消歧。
# - 本机命中率 140 条 → 129 条 title+大小双命中（92%）；剩 8% 是未下载/已过期。
# - 微信给重名文件加 `(1)`/`(3)` 后缀；少量文件有 `YYYYMMDD` 日期前缀；同一磁盘文件可被多条消息引用。
_APPMSG_TYPE_FILE = 6
_DATE_PREFIX = re.compile(r"^\d{8}\s*")          # 磁盘侧偶见的 YYYYMMDD 前缀（连同其后的空格）


def parse_file_msg(raw):
    """消息原文 → `{title, size, ext}`；**不是文件消息**（非 appmsg / 非 type=6 / 无标题）返回 None。"""
    if "<appmsg" not in raw:
        return None
    if _num(raw, "type") != _APPMSG_TYPE_FILE:
        return None
    title = _unxml(_tag(raw, "title"))
    if not title:
        return None
    size = _num(raw, "totallen")
    ext = _unxml(_tag(raw, "fileext")).lower()
    if not ext:
        ext = os.path.splitext(title)[1].lstrip(".").lower()
    return {"title": title, "size": max(size, 0), "ext": ext}


def files_root():
    """磁盘上的文件根：`<账号目录>/msg/file`。"""
    return os.path.join(os.path.dirname(db_root()), "msg", "file")


def build_index(root=None):
    """扫描磁盘 → `{文件名: [(大小, 路径), …]}`。

    少量文件带 `YYYYMMDD` 日期前缀（磁盘侧有、消息标题没有），所以再给去前缀的名字挂**别名键**
    （真名优先，别名只在没撞名时加），让 `match_file` 保持一次查表。

    **每次调用都真扫**（2026-10-13 改）：原先按 root 把结果缓存起来且永不失效，后果是
    「`list_files` 报 8 条过期 → 用户去微信里点下载 → 再跑还是报过期」，直到 MCP 进程重启
    ——而「过期预警 → 下载 → 归档」正是本产品的卖点路径（原 docstring 还说"重扫传 force"，
    那个参数**从来就不存在**）。实测整盘重扫本机 135 个文件只要 **8.9 ms**，比同一次调用里读
    消息库便宜得多，缓存换来的那点时间不值这个 bug。
    """
    root = root or files_root()
    idx = {}
    for dp, _dirs, fs in os.walk(root):
        for f in fs:
            p = os.path.join(dp, f)
            try:
                idx.setdefault(f, []).append((os.path.getsize(p), p))
            except OSError:
                continue
    for name, cands in list(idx.items()):
        alias = _DATE_PREFIX.sub("", name)
        if alias and alias != name:
            idx.setdefault(alias, cands)
    return idx


def match_file(idx, title, size):
    """消息 → 磁盘文件。返回 `(路径 | None, status)`；status ∈ ok / size_mismatch / missing。"""
    cands = idx.get(title) or idx.get(_DATE_PREFIX.sub("", title))
    if not cands:
        return None, "missing"
    if size:
        exact = [p for s, p in cands if s == size]
        if exact:
            return exact[0], "ok"
        return cands[0][1], "size_mismatch"        # 同名但大小不符：可能是另一版本
    return cands[0][1], "ok"


def _finder_text(raw):
    """视频号（appmsg 44/51/63）→ `「作者：描述」`。

    `<title>` 实测是「当前版本不支持展示该内容，请升级至最新版本。」——那是**微信自己的升级提示**，
    每条视频号都渲染成这句话等于把内容丢了还误导（`<url>` 同理，指向上级升级页）。
    真东西在 `<finderFeed>`（作品）或 `<finderLive>`（直播）里：`<nickname>` + `<desc>`
    （实测 51=「菇乡视界／光影定格爱」、63=「Qoder.ai／运营，造自己的工具|第一期收官」）。

    只在 44/51/63 上调它：`<finderLive>` 也会出现在别的卡片里（实测一个小程序里就有），
    那些卡片的 `<title>` 本身是有内容的，别拿作者名顶掉它。
    """
    for tag in ("finderFeed", "finderLive"):
        body = _tag(raw, tag)
        if not body:
            continue
        name = _unxml(_tag(body, "nickname"))
        desc = " ".join(_unxml(_tag(body, "desc")).split())
        out = "：".join(x for x in (name, desc[:60]) if x)
        if out:
            return out
    return ""


def _pay_text(raw):
    """转账（appmsg 2000/2002/2003；实测 `type=0` 里也夹着 2 条带 `<wcpayinfo>` 的）→ 金额。

    金额在 `<wcpayinfo><feedesc>`（实测 `￥1000.00`）。`<des>` 是「收到转账1000.00元。如需收钱，
    请点此升级至最新版本」——**后半句是升级提示**，所以只取第一句。抽不出就返回空串
    （红包 2001 的金额根本不在消息里，**别硬编一个 0** 冒充）。

    ⚠️ 必须先确认**这真是转账**再抽 `<des>`：`<des>` 是通用字段——合并转发的 `<des>` 就是
    内容预览，不判类型的话每条转发都会渲染成 `[转账] 时遇: [图片]`（第一版就是这么翻的，
    是 `test_render_labels` 的合并转发那条逮住的）。
    """
    if "<wcpayinfo" not in raw and _num(raw, "type") not in (2000, 2002, 2003):
        return ""
    esc = _unxml(_tag(raw, "feedesc"))
    if esc:
        return esc
    des = " ".join(_unxml(_tag(raw, "des")).split())
    return re.split(r"[。；，]", des)[0][:40] if des else ""


def describe_nontext(lt, raw, _depth=0):
    """非文本消息 → 一行**人能读的摘要**（以前一律是 `[非文本消息]`）。

    ⚠️ 只给**元数据**，拿不到内容本身——这一点是实测定死的，别再试：
    - **图片**：聊天图存在 `msg/attach/<hash>/<月>/Img/*.dat`，V2 容器（magic `07085632`）。
      ⇒ **内容由 `wechat_image.py` 解**（`aes_size` + XOR 尾 + 账号级 AES key，实测 464/465
      命中），这里**只给尺寸**，不重复那份工作。
      （旧注释写的是"要拿图片内容得先逆向 V4，是研究任务"——**2026-10-14 作废**：
      它把后来人指到了那条已经走通的路的起点，本次写计划时就被它误导过一次。）
    - **语音**：**不在磁盘文件里**——音频本体在 `message/media_*.db` 的 `VoiceInfo.voice_data`
      （明文 SILK_V3，取法见 `voice_file`）。这里只给时长。
    - **引用**：`appmsg type=57` 的被引原文在 `<refermsg><content>`，走 `refer_text()`；
      这里**接在标签后面**（一行内），展开成引用块是导出层（B）的事。
    - **合并转发**：`appmsg type=19` 的正文在 `<recorditem>` CDATA 里，一行装不下
      ⇒ 这里只报**条数**，逐条展开走 `merged_forward()`。
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
        sub = _num(raw, "type")
        # **有 `<refermsg>` 就是引用**，别按子类型硬编：实测本机 `type=57` 120 条是引用，
        # 而 `type=1`（链接卡片）里也夹着 2 条引用——按 57 判，那 2 条会被当成普通链接、
        # 被引原文整段丢掉（和当初"57 被标成直播"是同一类错：标签错 = 模型判错消息性质）。
        #
        # ⚠️ **必须卡住标签名的右边界**（2026-10-15 实测）：合并转发的 `<recorditem>` CDATA 里，
        # 转发进来的**引用消息**带 `<refermsgitem>`——裸子串 `"<refermsg" in raw` 命中它，
        # 于是整条合并转发被标成 `[引用] 地图鱼与…的聊天记录（10 条）`。与 `_attr` 的
        # `datatype`/`cdnthumblength`、以及 57 被标成「直播」是同一根棍子的第三次。
        is_refer = bool(re.search(r"<refermsg[\s>/]", raw))
        kind = "引用" if is_refer else _LINK_KINDS.get(sub, "链接")
        title = _unxml(_tag(raw, "title")) or _unxml(_attr(raw, "title"))
        pay = _pay_text(raw)
        if pay:                              # 转账：`<title>` 是「微信转账」，金额才是有用的
            return f"[转账] {pay}"
        finder = _finder_text(raw) if sub in (44, 51, 63) else ""
        if finder:                           # 视频号：`<title>` 是「请升级至最新版本」的升级提示
            title = finder
        url = _unxml(_tag(raw, "url"))
        out = f"[{kind}] {title}" if title else f"[{kind}]"
        if sub == 19:                       # 合并转发：正文一行装不下，只报条数
            items = merged_forward(raw, _depth)
            return out + (f"（{len(items)} 条）" if items else "")
        if is_refer:                        # 引用：被引原文接在后面，回复正文就是上面的 title
            who, quoted = refer_text(raw)
            if quoted:
                out += f" ← {who + ': ' if who else ''}{quoted[:120]}"
            return out
        if url and not _NAG_URL.search(url):
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
# ⚠️ 这是**一批**的额度、不是**一条**的（见 `attach_voice`）：一条一条各给 6s 会累乘，
#    实测全库任一 180s 窗口里最多 6 条语音 ⇒ 一趟 poll 最坏 36s，正好把 15s 那一拍拖穿。
_VOICE_WAIT_S = 6.0
_VOICE_POLL_S = 1.5


def voice_file(talker, ct, local_id=None, deadline=None):
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

    `deadline`：等待的**绝对截止时刻**（`None` = 按这一条自己算；`0` = 只看一眼、不等）。
    一批语音要**共用一个** `deadline`——它们是**同时**在下载的，等第一条就把整批都等到了，
    而一条一条各等 6s 会累乘（见 `attach_voice`）。
    """
    if local_id is None:
        return None
    if deadline is None:
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
    body = _PREFIX_RE.sub("", decode(content))
    raw = body.replace("\n", " ").strip()
    if not raw.startswith("<"):
        return raw
    out = describe_nontext(lt & 0xFFFFFFFF, raw)
    if (lt & 0xFFFFFFFF) == 49 and _num(raw, "type") == 19:
        # 合并转发的**正文**补在这里（2026-10-15）：`describe_nontext` 只报「（N 条）」，
        # 而那一段正文原先只有导出层（B）要——于是代聊/Agent 拿到的永远只有条数，
        # 「他转发过来那段说了什么」在**全部**读类工具里都读不到（检索也搜不着，
        # 因为 `search_messages` 匹配的正是这里的返回值）。
        # **必须在 `_render` 这一层补、不能进 `describe_nontext`**：导出层的 `render_text`
        # 是直接调后者的，在那儿展开会让 md/html 把同一段正文渲染两遍。
        # ⚠️ 用 `body`（未压换行）而不是 `raw`：嵌套转发的预览靠换行分辨说话人。
        block = forward_block(body)
        if block:
            out += "\n" + block
    return out


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


_IMG_MD5_RE = re.compile(r'(?<![0-9A-Za-z_])md5="([0-9a-fA-F]{32})"')


def _image_md5(content):
    """图片消息原文里的 `md5`——**消息里没有文件路径**，磁盘文件名只能拿它去 `hardlink` 索引换。

    负向后视是必须的（实测踩点）：`<img … cdnthumbmd5="…" …>` 也以 `md5="` 结尾，
    宽松匹配会取到**缩略图的 md5**，换出来的文件是另一张图——而且不报错。
    """
    try:
        raw = decode(content) if isinstance(content, (bytes, bytearray)) else str(content)
    except Exception:
        return None
    m = _IMG_MD5_RE.search(raw or "")
    return m.group(1) if m else None


_PACKED_NAME_RE = re.compile(rb"[0-9a-f]{32}")


def _image_name(packed):
    """`packed_info_data` 里那个 32 位十六进制 —— 就是**本地图片的文件名**（不含后缀）。

    ⚠️ 这是「图读不到」的正解（2026-10-11 实测）：消息 XML 里的 `md5` 是**原图**的 md5，
    而微信**并不总是把原图下下来**——原图那份 `_h.dat` 缺失时，`hardlink` 索引里就没有这个
    md5，整条链子断在里面（症状：一批图里前几张读得到、后几张永远读不到，XML 属性还一模一样）。
    但只要中图 `.dat` 落了盘，`packed_info_data` 就带着它的文件名——**它才是本地真有的那份**。
    """
    if not packed:
        return None
    try:
        m = _PACKED_NAME_RE.search(bytes(packed))
    except Exception:
        return None
    return m.group(0).decode() if m else None


def _video_meta(content):
    """\u89c6\u9891\u6d88\u606f\uff08`lt=43`\uff09\u2192 `(md5, length)`\uff1b\u53d6\u4e0d\u5230\u5c31\u662f `None` / `0`\u3002

    \u5b57\u6bb5\u5168\u5728 `videomsg` \u81ea\u5df1\u8eab\u4e0a\uff1a`md5` \u662f\u8fd9\u4efd**\u6b63\u7247**\u7684 md5\uff0c`length` \u662f\u5b83\u7684\u5b57\u8282\u6570\u3002
    `rawmd5`/`newmd5`/`originsourcemd5` \u662f\u53e6\u5916\u51e0\u7248\u2014\u2014\u5b9e\u6d4b**\u90fd\u5bf9\u4e0d\u4e0a**\u78c1\u76d8\u4e0a\u7684\u6587\u4ef6\u540d
    \uff08`probe_e2_video_map.py` \u9010\u5c5e\u6027\u8bd5\uff0c\u96f6\u547d\u4e2d\uff09\uff0c\u522b\u62ff\u5b83\u4eec\u5f53\u6587\u4ef6\u540d\u3002
    """
    try:
        raw = content if isinstance(content, str) else decode(content)
    except Exception:
        return None, 0
    m = _IMG_MD5_RE.search(raw or "")   # \u540c\u4e00\u4e2a\u6b63\u5219\uff1a\u8d1f\u5411\u540e\u89c6\u5df2\u6321\u6389 rawmd5/newmd5/cdnthumbmd5
    return (m.group(1) if m else None), _num(raw or "", "length")


# `hardlink.db` \u7684\u8bfb\u6cd5\u540c `wechat_image.hardlink_map`\uff08\u90a3\u8fb9\u662f\u56fe\u7247\u8868\uff09\uff1a\u77ed TTL \u7f13\u5b58\uff0c
# \u56e0\u4e3a `refresh()` \u4f1a\u91cd\u5199\u955c\u50cf\u3001\u800c\u65b0\u89c6\u9891\u662f\u5f02\u6b65\u843d\u5e93\u7684\u3002
_VIDEO_HL_TTL_S = 30.0
_video_hl = {}


def _video_hardlink():
    """`{md5: \u78c1\u76d8\u4e0a\u7684 mp4 \u6587\u4ef6\u540d}`\uff08`hardlink.db` \u7684 `video_hardlink_info_v4`\uff09\u3002

    \u5b9e\u6d4b\uff082026-10-14\uff09\u672c\u673a 26 \u884c\u3001`file_name` \u5168\u90e8\u80fd\u5728 `msg/video/<\u6708>/` \u91cc\u627e\u5230\u3002
    **\u53ea\u8981\u8f6c\u7801\u540e\u7684\u6b63\u7247**\uff1a\u540c\u4e00 stem \u4e0b\u8fd8\u6709 `_raw.mp4`\uff08\u539f\u7247\uff0c\u5b57\u8282\u6570\u662f\u6d88\u606f\u91cc\u7684 `rawlength`\uff09
    \u548c `_thumb.jpg`\uff08\u7f29\u7565\u56fe\uff09\u2014\u2014\u6df7\u8fdb\u6765\u5c31\u662f"\u7ed9\u9519\u6587\u4ef6"\uff0c\u800c\u9519\u6587\u4ef6\u6bd4\u6ca1\u6709\u6587\u4ef6\u7cdf\u5f97\u591a\u3002
    """
    root = db_root()
    ent = _video_hl.get(root)
    if ent and time.time() - ent[0] < _VIDEO_HL_TTL_S:
        return ent[1]
    out = {}
    try:
        m = _mirror("hardlink/hardlink.db")
        m.refresh()
        conn = sqlite3.connect(m.out)     # \u73b0\u5f00\u73b0\u5173\uff1arefresh \u4f1a\u91cd\u5199\u955c\u50cf\uff0c\u7f13\u5b58\u8fde\u63a5\u4f1a\u8bfb\u5230\u91cd\u5199\u524d\u7684\u65e7\u9875
        try:
            for md5, name in conn.execute("select md5, file_name from video_hardlink_info_v4"):
                n = (name or "").lower()
                if md5 and n.endswith(".mp4") and not n.endswith("_raw.mp4"):
                    out.setdefault(md5.lower(), name)
        finally:
            conn.close()
    except Exception:
        out = {}
    _video_hl[root] = (time.time(), out)
    return out


def video_file_path(file_name):
    """\u78c1\u76d8\u4e0a\u90a3\u4efd mp4\uff1a`msg/video/<\u6708>/<\u6587\u4ef6\u540d>`\uff08\u6309\u6708\u5206\u7247\uff0c\u6587\u4ef6\u540d\u5168\u5c40\u552f\u4e00\uff09\u3002"""
    if not file_name:
        return None
    hits = glob.glob(os.path.join(os.path.dirname(db_root()), "msg", "video", "*",
                                  os.path.basename(file_name)))
    return hits[0] if hits else None


AGENT_MARK = "\u200b\u200c\u200b"


def split_agent_mark(text):
    """剥掉「Agent 代发」标记，返回 `(纯文本, 是否 Agent 代发)`。

    标记由客户端（`wechat-watch-tick.ts` 的 `withAgentMarker`）在**发送前**追加，
    落在微信消息正文里，所以这里读出来时也在。**必须纯不可见**（零宽字符）——这段文本
    是真的发给真人的，可见标记会印在对方气泡里。

    为什么要有它：自聊会话（文件传输助手 / 本人 wxid）里用户和助手发的消息 `from_me`
    **都是真**，身份分不开。客户端原先靠**文本匹配**（`wasSelfSent`，内存态 + 5 分钟 TTL），
    读不到或延迟落库时会漏，漏了就是助手自己回自己。标记是精确的身份识别。
    """
    if text.endswith(AGENT_MARK):
        return text[:-len(AGENT_MARK)], True
    return text, False


def with_agent_mark(text):
    """给正文打上「Agent 代发」标记（**幂等**：已有就先剥再加，重复调用只留一个）。

    **唯一打标记的地方就在发送出口**（`wechat_sender.send_text`）——别在调用方各打一遍：
    客户端 `pcwechat-outbound-provider` 也打，是因为它的重试/排队要带着标记走；两条路都会
    经过 `send_text`（见 `wechat_sender.send_text` 顶部），所以这里幂等才不会叠成两串。
    """
    return split_agent_mark(text)[0] + AGENT_MARK


# 链路自检载荷的前缀：`test_mcp_client.py` 的「自检：…」与手工发的「【自检】…」。
# 它们以**用户身份**落在真实会话里（不可撤回），但一个字都不是人打的。
SELFCHECK_PREFIXES = ("【自检】", "自检：")


def is_agent_or_probe(text):
    """这条正文算不算「本人打的字」。不算的两类：Agent 代发（零宽标记）、链路自检载荷。

    为什么必须一刀切：**蒸馏的输入只有本人打的字**（2026-10-12 用户报障「不要蒸馏错误人了」）。
    实测 321 群：卡片把代聊自己写的「潜水大半年了 看你们还活着我就放心了」当成**我的原话**
    举证口吻，又把 6 条 `【自检】…` 当成我的长句——统计出来的是**代聊 + 测试载荷**的人格，
    再喂回去让代聊照着演，越演越不像本人（反馈回路，见 `digest` 顶部）。
    """
    body, agent = split_agent_mark(text)
    return agent or body.lstrip().startswith(SELFCHECK_PREFIXES)


def msg_dict(ct, lt, content, nm, talker=None, name=None, sender=None, me=None, local_id=None,
             source=None, packed=None):
    # ⚠️ **先剥标记、再截断**：下面是 400 字硬截断，长消息会把末尾的标记切掉——
    # 先截断的话标记根本认不出来（标记恒在**末尾**，被截掉就等于没打）。
    text, agent_sent = split_agent_mark(_render(lt, content))
    d = {"time": _ts(ct), "ts": ct, "type": lt & 0xFFFFFFFF, "text": text[:400]}
    if len(text) > 400:
        # 截断要**留痕**（2026-10-14）：`text` 只是全文的前 400 字，读的人（Agent）不能拿它当全文
        # ——本机实测 **73/5101 条（1.4%）** 渲染后超 400 字、最长 3069 字，粘日志/长段落就是这个形态，
        # 拿前 400 字当全文去总结或回话，是"看不到就编"的同一个坑。
        # `text_len` 是全文长度（判据），`text_more` 是后面那截（最多再给 3600 字，免得一条长消息
        # 把工具输出撑爆）；两者相加仍短于 `text_len` ⇒ 还没给全。
        d["text_len"] = len(text)
        d["text_more"] = text[400:4000]
    if agent_sent:
        d["agent_sent"] = True               # 客户端据此跳过：这条是助手代发的，不是用户说的
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
    if (lt & 0xFFFFFFFF) == 3:
        md5 = _image_md5(content)
        if md5:
            d["image_md5"] = md5
        nm2 = _image_name(packed)      # 本地真有的那份（原图没下时 `image_md5` 是查不到的死键）
        if nm2:
            d["image_name"] = nm2
    if (lt & 0xFFFFFFFF) == 43:        # 视频：路径要走 hardlink 换名 + 比大小，见 `attach_video`
        vmd5, vlen = _video_meta(content)
        if vmd5:
            d["video_md5"] = vmd5
        if vlen:
            d["video_len"] = vlen
    return d


def _ts(ct):
    import time as _t
    return _t.strftime("%Y-%m-%d %H:%M:%S", _t.localtime(ct))


def sessions():
    """列出所有会话（显示名 + talker + 最新一条预览）。

    性能（2026-10-18 实测）：旧实现每个会话调一次 `_rows`，而 `_rows` 每次都新开
    sqlite 连接——287 个会话 × 逐次 connect ≈ **6.8s**。这里改成**每个分片复用一条连接**，
    一次遍历该分片的表各取最新一行，再按 create_time 合并（同一 talker 跨分片时取更新的）。
    实测降到百毫秒级。
    """
    nm = names()
    _refresh()
    latest = {}                      # tbl -> (create_time, local_type, content)
    for p in _cache["msg"]:
        tables = _cache["tables"].get(p, ())
        if not tables:
            continue
        c = sqlite3.connect(p)
        try:
            for tbl in tables:
                try:
                    row = c.execute(
                        f"select create_time, local_type, message_content from [{tbl}]"
                        " order by create_time desc limit 1").fetchone()
                except Exception:
                    continue
                if row and (tbl not in latest or row[0] > latest[tbl][0]):
                    latest[tbl] = row
        finally:
            c.close()
    out = []
    for tbl, talker in talkers():
        row = latest.get(tbl)
        # 走 _render：不然最后一条是图片/语音时，会话列表预览会吐一整段 XML
        # `split("\n")[0]`：末条是合并转发时 `_render` 会展开成多行（2026-10-15），
        # 而预览是**单行**字段——不切的话会话列表里会多出一截转发正文。
        last = _render(row[1], row[2]).split("\n")[0][:80] if row else ""
        out.append({"talker": talker, "name": nm.get(talker, talker), "last": last})
    out.sort(key=lambda r: r["name"])
    return out


def attach_image(msgs):
    """给图片消息补上 `image_path`（解密后的本地图片），失败静默跳过。

    与 `attach_voice` 同约定：只补路径、不回字节（MCP 结果是文本，几十万字节灌进模型纯浪费），
    交给客户端**本来就有的**那套看图/读文件的能力去处理。

    解密需要**账号级的图片 AES key**，而抓它要扫一遍微信内存（本机约 50 秒），绝不能塞进
    15 秒一拍的盯梢回路。所以这里**只用已缓存的 key**，没有就原样返回。
    抓取的**唯一用户入口是 `wechat-mcp.exe --image-key`**（2026-10-14 补：此前只有源码树里的
    devcli 能抓，而文档里写的「设置页按钮」**根本不存在**——等于装好的 exe 永远读不出图）。
    `check_env`（pro）会报 `image_key.cached`，调用方据此判断是「key 没抓」还是「图不在本地」。
    """
    try:
        import wechat_image                 # 延迟导入：它依赖本模块（镜像 / 数据目录 / WORK）
        return wechat_image.attach_image(msgs)
    except Exception:
        return msgs


def attach_video(msgs):
    """给视频消息补上 `video_path`（客户端**已经下下来**的那份 mp4），失败静默跳过。

    与 `attach_image`/`attach_voice` 同约定：只补路径、不回字节。视频比图片还省事——
    **不需要 key、不需要模型**，落盘的就是明文 mp4（转发/另存只要一个路径）。

    三条实测事实（2026-10-14，`verify/wechat-mcp/probe_e2_video_map.py`，本机 48 条视频消息）：

    1. 磁盘文件名**既不是**消息的 `md5` 也**不是** `newmd5`（逐属性试，零命中），
       只能经 `hardlink.db` 的 `video_hardlink_info_v4` 换名；
    2. 换完必须**再比大小**：消息的 `length` 与磁盘字节数**精确相等**（8/8 命中样本全等）。
       这是"这条消息 ↔ 这份文件"的**唯一**判据——只凭 md5 换名，换错就是给别人放另一段视频；
    3. 覆盖受"文件还在不在"限制：磁盘上只留得下最近下过的那几份（≤7 天 3/4，更早的多数已被
       微信清掉）。取不到就**原样返回**：不猜、不报假路径（与图片 `no_file` 同口径）。
    """
    need = [m for m in msgs if m.get("type") == 43 and m.get("video_md5")]
    if not need:
        return msgs
    try:
        idx = _video_hardlink()
    except Exception:
        return msgs
    for m in need:
        try:
            p = video_file_path(idx.get(m["video_md5"].lower()))
            if p and m.get("video_len") and os.path.getsize(p) == m["video_len"]:
                m["video_path"] = p
        except OSError:
            continue
    return msgs


def attach_voice(msgs, talker):
    """给语音消息补上 `voice_path`（本地 SILK 文件），失败静默跳过。

    只对 `type=34` 且**真能从 `VoiceInfo` 取到音频**的消息加。客户端拿这个路径去
    解 SILK + 转写（见 `voice_file` 的说明）；取不到就只剩 `[语音 N 秒]` 那段元数据。

    **一批共用一个等待额度**（2026-10-14 修）：一批里的语音是**同时**在下载的，等第一条
    就把整批都等到了；而一条一条各给 `_VOICE_WAIT_S` 会**累乘**——实测真机全库合并流里，
    任一 180s 窗口内最多 **6 条**语音 ⇒ 一趟 `poll_new` 最坏 **36s**，把 15s 那一拍整个拖穿
    （水位在等待**之前**就已提交，重试会拿回同一批，所以不丢消息、只是延迟几十秒到代聊）。
    老语音仍是只看一眼：它们的数据是**永久缺失**的，等再久也没有。
    """
    budget = time.time() + _VOICE_WAIT_S
    for m in msgs:
        if m.get("type") != 34:
            continue
        try:
            fresh = (time.time() - m["ts"]) < _VOICE_FRESH_S
            p = voice_file(talker, m["ts"], m.get("local_id"),
                           deadline=budget if fresh else 0)
        except Exception:
            p = None
        if p:
            m["voice_path"] = p
    return msgs


def _pad_page(tbl, rows, limit):
    """把一页补到**边界那一秒的整秒**——否则下一页的 `create_time < cursor` 会把这秒剩下的丢掉。

    `create_time` **只到秒**，而页是按**条数**切的。最老那条所在的秒被切开时，同秒更早的那些
    `> 本页` 又 `< 下一页`，两边都够不着（和 `poll` 的水位是同一类 bug，见 §9.12 ①）。
    实测本机：`limit=10` 逐表模拟翻页，**17 张表丢 76/4973 条（1.5%）**，最坏一张 19/87。
    补秒后 `cursor` 仍是**单个 int**，调用方一个字都不用改。
    """
    if not rows or len(rows) < limit:      # 空结果或没切在中间（这一页就是剩下的全部）
        return rows
    bts = min(r[0] for r in rows)
    have = {r[4] for r in rows}             # local_id：同秒可能有很多条
    extra = [r for r in _rows_full(tbl, 10 ** 9, at=bts) if r[4] not in have]
    if not extra:
        return rows
    return sorted(rows + extra, key=lambda r: (r[0], r[4]), reverse=True)


def history(talker, limit=10, before_ts=0):
    """读历史（时间正序）。`before_ts` 取更早一页：只返回 create_time 严格小于它的消息。

    返回带 `cursor`（本页最老一条的 ts）与 `has_more`，Agent 可用 `before_ts=cursor` 翻更早的页。
    翻页**不会丢同秒消息**：页会补到边界那一秒的整秒（见 `_pad_page`），所以那一页可能比
    `limit` 略多几条。
    """
    nm = names()
    me = self_wxid()
    tbl = tbl_of(talker)
    rows = _pad_page(tbl, _rows_full(tbl, limit, before=before_ts), limit)
    msgs = [msg_dict(ct, lt, c, nm, sender=s, me=me, local_id=lid, source=src, packed=pk)
            for ct, lt, c, s, lid, src, pk in reversed(rows)]
    attach_voice(msgs, talker)
    attach_image(msgs)
    attach_video(msgs)
    out = {"talker": talker, "name": nm.get(talker, talker), "count": len(msgs), "messages": msgs}
    if msgs:
        out["cursor"] = msgs[0]["ts"]          # 本页最老一条，供取更早一页
        out["has_more"] = len(rows) >= limit
    return out


def _message_by_id(talker, local_id, ts=0, want_type=0):
    """按 `talker` + `local_id` 定位**单条**消息 → `msg_dict`（不含媒体路径）。找不到返回 None。

    ⚠️ **`local_id` 只在单个时间分片内唯一**——每个 `message_N.db` 各自从 1 自增，
    同一会话跨分片撞号是常态（本机实测 3694 处，如 2024 年的语音与 2026 年的系统消息
    都叫 `local_id=4`）。所以：
    - 调用方传 `ts`（`read_history` 的 `msg_dict.ts`）→ 精确锁定那一条；
    - 没传 `ts` → 先按 `want_type`（图片=3 / 语音=34）挑，再取最新的一条。

    按 `local_id` 而不是 `create_time`：后者会撞——实测同一秒两条语音，
    lid 41 是 3.4 秒、lid 42 是 34.8 秒，按时间取会**转写出另一个人说的另一段话**。
    """
    _refresh()
    tbl = tbl_of(talker)
    nm = names()
    me = self_wxid()
    try:
        lid = int(local_id)
    except (TypeError, ValueError):
        return None
    matches = []
    for p in _cache["msg"]:
        if tbl not in _cache["tables"].get(p, ()):
            continue
        c = sqlite3.connect(p)
        try:
            rows = _query_rows(c, tbl, " where local_id = ?", [lid, 10 ** 9], True)
        except Exception:
            rows = []
        finally:
            c.close()
        for row in rows:
            matches.append((p, row))
    if not matches:
        return None
    if ts:
        matches = [x for x in matches if int(x[1][0]) == int(ts)]
        if not matches:
            return None
    if want_type:
        typed = [x for x in matches if (int(x[1][1]) & 0xFFFFFFFF) == want_type]
        if typed:
            matches = typed
    matches.sort(key=lambda x: int(x[1][0]), reverse=True)   # 同秒/没给 ts 时取最新
    p, (ct, lt, content, sid, lid2, src, pk) = matches[0]
    return msg_dict(ct, lt, content, nm, talker=talker, name=nm.get(talker, talker),
                    sender=_cache["senders"].get(p, {}).get(sid, ""), me=me,
                    local_id=lid2, source=src, packed=pk)


def _image_key_cached():
    """图片 AES key 是否**已抓过并缓存**（不扫内存，见 `wechat_image.cached_aes_key`）。"""
    try:
        import wechat_image
        return bool(wechat_image.cached_aes_key())
    except Exception:
        return False


def image_message(talker, local_id, ts=0):
    """按 `talker` + `local_id` 定位**单条**图片消息 → `(带 image_path 的 msg_dict, 失败原因)`。

    给 MCP 的 `read_image` 用：Agent 先在 `read_history` 里看见图片消息的 `local_id`，
    再按这个 id 单独把图取回去——**别让 `read_history` 每次都内联多张图的 base64**
    （一条原图 base64 后好几 MB，翻一页历史就爆了）。

    `ts` 可选：`local_id` 跨时间分片撞号（每个分片自增从 1 开始），把 `read_history`
    返回的 `ts` 一并传进来才能精确锁定；不传则优先挑 `type=3` 的分片。

    `m` 为 None 时看第二个返回值：`not_found`（这个会话里没这条）/ `not_image`（不是图片）/
    `no_key`（**图片 AES key 还没抓过**）/ `no_file`（原图与中图都没落到本地，永久缺失）。
    **`no_key` 必须与 `no_file` 分开**（2026-10-14 修）：`attach_image` 拿不到 key 就原样返回，
    症状与「图没落本地」**一模一样**，调用方分不出来就会去查根本不存在的文件缺失。调用方
    据此报错，**不要**伪造路径。
    """
    m = _message_by_id(talker, local_id, ts=ts, want_type=3)
    if not m:
        return None, "not_found"
    if m.get("type") != 3:
        return None, "not_image"
    if not _image_key_cached():
        return None, "no_key"
    attach_image([m])
    return (m, "") if m.get("image_path") else (None, "no_file")


def voice_message(talker, local_id, ts=0):
    """按 `talker` + `local_id` 定位**单条**语音消息 → 带 `voice_path` 的 `msg_dict`。

    给 MCP 的 `transcribe_voice` 用。返回 None 的三种情形要分开告诉用户：
    不是语音 / 找不到这条 / `VoiceInfo` 里没有音频（本机 47 条语音里 36 条有数据，
    其余更早被清掉了，**永久缺失**）。

    `ts` 可选：`local_id` 跨时间分片撞号，传 `read_history` 返回的 `ts` 才能精确锁定；
    不传则优先挑 `type=34` 的分片。
    """
    m = _message_by_id(talker, local_id, ts=ts, want_type=34)
    if not m or m.get("type") != 34:
        return None
    attach_voice([m], talker)
    return m if m.get("voice_path") else None


# 满量的会话一拍最多放大到这个倍数（`per * _POLL_BURST`）。25×20 = 500 条/会话/拍：
# 已经远超"15 秒内一个会话能来多少条"，再高只是病态刷屏时白扫，不如承认截断并上报。
#
# 已知代价：`since_ts=0`（要全量历史）时会逐表放大 ⇒ 实测 2.5s → 6.8s。**产品路径不会走它**
# （盯梢首拍用"现在"、水位只有 >0 才落库），所以不为此加复杂度；真要优化得给 create_time
# 建索引——那是另一件事。
_POLL_BURST = 25


def poll(since_ts, per=20):
    """增量新消息（实时监控用）。返回 `create_time > since_ts` 的消息，按时间正序。

    性能关键：`Msg_*` 表**没有 create_time 索引**，`create_time > ?` 是全表扫描 + 临时排序
    （实测：68 张表一轮 266ms，用户库越大越慢，且要区分「有变化」才能跳过）。这里用
    `local_id`（INTEGER PRIMARY KEY，AUTOINCREMENT，插入即单调增）做**高水位探测**：
    表的高水位没动、且上次已按不更窄的窗口查过、还留了完整结果 → 直接复用，一次索引探测即可跳过；
    只有真变了的表才做那次扫描。`per` 是每会话上限（达到上限的表标记为不完整，不复用）。

    返回带 `from_me`/`sender`（自己发的也返回——用户可能自己在手机上回过了，Agent 应当知道）。

    **截断（2026-10-14 修）**：`next_since_ts` 是**全局**水位（所有返回消息里最大的 ts），而
    `per` 是**每会话**上限。旧实现取每会话**最新**的 `per` 条，某会话 15 秒来了 30 条时返回的是
    第 11–30 条、水位推到第 30 条 ⇒ **第 1–10 条永久丢失且毫无迹象**（`per=20` 实测本机
    71 张表里 **39 张满量**，不是罕见分支）。现在：满量的会话**整批放大重取**（同一批的超集，
    无重复），一拍把它读全，水位照旧推；放大到 `per*_POLL_BURST` 仍满才放弃，并置 `truncated`
    如实上报。取的是**最早**的那批，所以万一真放弃，留下的是最新的那条尾巴——下一拍水位只推到
    本批最大 ts，会把它们接着读回来。
    已知残余（2026-10-14 复查，刻意不修）：若放弃点**恰好切在某一秒中间**，那一秒剩下的既够不着
    `> 水位`、又够不着 `= 水位且 local_id > 上次表尾`（表尾是本拍扫描时的最大值，已越过它们），
    这一秒的尾巴就真丢了。要修得让 `_rows_full_conn` 按分片回传"已投递的最大 local_id"（现只回
    无分片的行），波及 4 个调用方；而触发它要**单表 500 条（per×_POLL_BURST）新消息挤在同一个
    15 秒窗口**，且那一拍已经带了 `truncated: true`——代价与概率都不支持为它加复杂度。

    **秒级水位（2026-10-14 修，同样是"水位越过消息"这一类）**：`next_since_ts` 取的是
    "本拍见过的最大 ts"，而 `create_time` **只到秒**。轮询只要**落在某个活跃秒的中间**，水位就已经
    是那一秒 ⇒ 同一秒后面到达的消息用 `create_time > 水位` **永远取不到**（群聊一个爆发秒里几十条
    就是这个形态）。实测真机 5067 行里 **195 行**落在"与已见最大 ts 同一秒"，**旧语义全丢**。
    修法：除了 `create_time > 水位`，再认 **`create_time = 水位 且 local_id > 上次扫描时的最大
    local_id`**（见 `_rows_full_conn`）——`local_id` 是 AUTOINCREMENT，那条分界线恰好把集合切成
    "已送达的"与"之后才插入的"，所以这条补集**既不重复也不遗漏**。
    拿不到那条分界线时（本进程**第一次**扫这张表）退回纯 `>`：**宁可漏掉这一秒的尾巴，也不冒险
    重复投递**——重复会让代聊把同一条消息回两遍，比漏更难查。
    真机历史按两套语义对推：旧 **7–195** 条（随轮询密度），新 **0 条 0 重复**
    （`verify/wechat-mcp/probe_watermark_loss.py`）。
    """
    since_ts = int(since_ts or 0)
    _refresh()
    nm = names()
    me = self_wxid()
    out = []
    stats = {"tables": 0, "scanned": 0, "reused": 0, "truncated": 0}
    truncated = False                      # 有会话满量 ⇒ 本拍只带走了一部分，下一拍接着读
    conns = {}
    try:
        for tbl, talker in talkers():
            rels = [p for p in _cache["msg"] if tbl in _cache["tables"].get(p, ())]
            if not rels:
                continue
            stats["tables"] += 1
            ids = tuple(_max_local_id(conns, p, tbl) for p in rels)
            ent = _poll_memo.get(tbl)
            # 上次扫描时的逐分片高水位 = 那条「已送达 / 之后才插入」的分界线（见 `_rows_full_conn`）。
            # 拿不到 memo（本进程第一次扫这张表）就没有分界线，只能退回纯 `>` 水位：
            # **宁可漏掉这一秒的尾巴，也不冒险重复投递**——重复会让代聊把同一条消息回两遍，更难查。
            cuts = dict(zip(rels, ent["ids"])) if ent and len(ent["ids"]) == len(rels) else None
            rows = None
            if (ent and None not in ids and ent["ids"] == ids
                    and since_ts >= ent["since"] and ent["complete"]):
                # 复用：`ids` 没变 ⇒ 上次扫描之后**一次插入都没有** ⇒ 没有要补的边界行，
                # 按 `> since_ts` 过滤即完整（这也是复用路不必带 `cuts` 的原因）。
                rows = [r for r in ent["rows"] if r[0] > since_ts]
                stats["reused"] += 1
            if rows is None:
                rows = _rows_full_conn(conns, rels, tbl, per, since=since_ts, min_lids=cuts)
                if len(rows) >= per:
                    # 满量 ⇒ 多半还有没返回的。**整批放大重取一次**（是同一批的超集：同 since、
                    # 同升序、只是 limit 更大 ⇒ 只多不少、绝不重复），把这一拍的该会话读全。
                    # 为什么必须读全：水位是**全局单条** ts，任何别的会话有更新消息就会把它顶上去，
                    # 越过本会话没返回的那几条 ⇒ **永久丢失**（`per=20` 实测 71 张表里 39 张满量）。
                    rows = _rows_full_conn(conns, rels, tbl, per * _POLL_BURST, since=since_ts,
                                           min_lids=cuts)
                if len(rows) >= per * _POLL_BURST:
                    # 放大到上限还是满的：认输但**如实上报**，别让它无声（病态刷屏才会到这）
                    stats["truncated"] += 1
                    truncated = True
                _poll_memo[tbl] = {"ids": ids, "since": since_ts, "rows": rows,
                                   "complete": len(rows) < per}
                stats["scanned"] += 1
            batch = [msg_dict(ct, lt, content, nm, talker=talker, name=nm.get(talker, talker),
                              sender=sender, me=me, local_id=lid, source=src, packed=pk)
                     for ct, lt, content, sender, lid, src, pk in rows]
            # 入站语音要能被代聊「听懂」：补上 SILK 文件路径，客户端据此转写。
            # 只在真有 type=34 时才去碰 media 库，绝大多数轮询是零成本。
            if any(m.get("type") == 34 for m in batch):
                attach_voice(batch, talker)
            # 图片同理：没缓存图片 AES key 时 `attach_image` 立刻返回，零成本
            if any(m.get("type") == 3 for m in batch):
                attach_image(batch)
            # 视频同理（要开 hardlink.db 换名，约 10ms）：一批里没有 type=43 就完全不碰
            if any(m.get("type") == 43 for m in batch):
                attach_video(batch)
            out.extend(batch)
    finally:
        for c in conns.values():
            try:
                c.close()
            except Exception:
                pass
    out.sort(key=lambda d: d["ts"])
    return {"count": len(out), "messages": out, "since_ts": since_ts,
            "next_since_ts": (out[-1]["ts"] if out else since_ts),
            # 本拍有条会话没读完（满量）⇒ 调用方**别把它当成"已经追平"**，水位停在
            # 第 per 条上、下一拍自己会接着读到剩下的。留个显式信号，免得又被无声吞掉。
            "truncated": truncated, "stats": stats}


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


def _msg_select(tbl, where, with_source=True, with_packed=True):
    """`Msg_*` 的公共 select（第 6 列 `source`、第 7 列 `packed_info_data`）。

    `with_source=False` / `with_packed=False` 是**退化路**：老库/异形库里缺列时不能整条读不出来
    ——少了 @我 信号、或少了图片文件名，消息本身还是要读得到（盯梢宁可不认 @、认不出图，
    也不能变成瞎子）。
    """
    col = "source" if with_source else "NULL"
    pk = "packed_info_data" if with_packed else "NULL"
    return (f"select create_time, local_type, message_content, real_sender_id, local_id, {col}, {pk}"
            f" from [{tbl}]" + where + " order by create_time desc limit ?")


def _query_rows(c, tbl, where, params, with_source, with_packed=True):
    """带 `source` / `packed_info_data` 的查询失败（列不存在）就逐级退化——见 `_msg_select`。"""
    for ws, wp in ((with_source, with_packed), (False, with_packed), (False, False)):
        try:
            return list(c.execute(_msg_select(tbl, where, ws, wp), params))
        except Exception:
            continue
    return []


def _rows_full_conn(conns, rels, tbl, limit, since=0, min_lids=None):
    """跨分片取 `[(create_time, local_type, content, sender, local_id, source)]`（复用调用方的连接）。

    截断时给**最早**的 `limit` 条（升序），这是 `poll` 的水位能安全推进的前提——见 `poll`。

    `min_lids`（{分片路径: local_id}）：把**水位那一秒**里、"上次扫描之后才落库"的那些也纳入
    （`create_time = since AND local_id > min_lids[分片]`）。为什么必须这样补：`create_time` **只到秒**，
    而水位是"本拍见过的最大 ts"——轮询落在某个活跃秒中间时，同一秒后面到达的消息用 `> 水位`
    **永远取不到**（见 `poll` 的 docstring）。`local_id` 是 `INTEGER PRIMARY KEY AUTOINCREMENT`
    （逐分片单调递增），于是"上次扫描时的最大值"恰好把集合切成两半：**之前就存在的（必然已送达）**
    与**之后插入的（必然是新的）**——这一个补集既不重复也不遗漏，所以它同时是"不丢"和"不重"的判据。
    """
    out = []
    for p in rels:
        smap = _cache["senders"].get(p, {})
        try:
            c = conns.get(p)
            if c is None:
                c = conns[p] = sqlite3.connect(p)
            cut = (min_lids or {}).get(p)
            if cut is None:
                where, params = " where create_time > ?", (since, limit)
            else:
                where = " where create_time > ? or (create_time = ? and local_id > ?)"
                params = (since, since, cut, limit)
            rows = _query_rows(c, tbl, where, params, True)
        except Exception:
            continue
        for ct, lt, content, sid, lid, src, pk in rows:
            out.append((ct, lt, content, smap.get(sid, ""), lid, src, pk))
    out.sort(key=lambda r: r[0])
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


class UnknownTalker(LookupError):
    """会话参数解析不出**唯一**目标（`resolve_talker` 返回 None）。

    为什么要一个专门的类型：工具边界上不能"猜"，也**不允许静默降级成空结果**——
    `{"count": 0}` 与「这个会话真没消息」在 JSON 里一模一样，四件套里 A/C/D 都踩过这一跤
    （传显示名 → 算出不存在的表 → 0 条，看着像正常回答）。MCP 侧统一翻成 `target_not_found`
    （见 `mcp_stdio.py`）。

    `candidates`：解析失败时的近似候选（见 `suggest_talkers`）。带上它，"找不到"才**可操作**
    ——本机真有三个 `loop`，把三个列出来，用户或 Agent 才能一句话说清是哪个。
    """

    def __init__(self, query, candidates=None):
        super().__init__(query)
        self.candidates = list(candidates or [])


def talker_of(query):
    """用户给的会话名 / wxid / 群号 → talker。解析不出唯一目标就抛 `UnknownTalker`。

    与 `resolve_talker` 的分工：那个是纯解析（返回 None，让调用方按自己的语义决定），
    这个给**工具边界**用——`query` 为空返回 None（表示"不筛会话"），非空则要么给出 talker、
    要么抛。

    失败路径顺手带上近似候选。只在这条路上做（`names()` 本身有缓存），成功路径一点开销不加；
    取候选本身失败也不能盖掉"找不到会话"这个主因——那会报成 env 问题，更难查。
    """
    if not query:
        return None
    got = resolve_talker(query)
    if got is None:
        try:
            cands = suggest_talkers(query)
        except Exception:
            cands = []
        raise UnknownTalker(str(query), cands)
    return got


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
    """按关键词检索消息（跨会话或指定会话；支持时间范围，**跨全部分片**）。逐条解码匹配。

    ⚠️ 每条命中都要带 `local_id`（2026-10-14 修）：它是**唯一**能把命中交回给
    `read_image` / `transcribe_voice` 的手柄。早先这里把 `local_id`/`source`/`packed`
    直接从行里丢掉（`for ct, lt, content, s, _lid, _src, *_`），于是"先搜到一条图片消息、
    再去取图"这条路是**死的**——Agent 手里只有一个 ts，而同秒多条只能靠 local_id 消歧。
    `source`/`packed` 一并带上：@我 与图片文件名本来就在这两列里，扔掉等于让命中成为二等公民。

    返回里的 `truncated`：至少一个会话撞到了 `scan` 上限（多取一条来判断），**如实上报**——
    "被上限截断"和"这段真没有"在 0 命中时长得一模一样，不报就等于让人把答案当事实。
    """
    _refresh()
    nm = names()
    me = self_wxid()
    pairs = [(talker, tbl_of(talker))] if talker else [(t, tbl) for tbl, t in talkers()]
    hits = []
    trunc = False
    for t, tbl in pairs:
        try:
            # 时间范围**下推到 SQL**（2026-10-14 修）：原先取"最新 `scan` 条"再在内存里过滤，
            # 于是查一个**老的时间段**时扫描窗口早被更新的消息占满 ⇒ 恒返回 0 条**而且不报错**
            # ——"这段确实没有"和"根本没扫到"长得一模一样。下推后窗口落在**时间段内**。
            # `since`/`before` 的取值口径与函数入口一致（都是严格大于 / 严格小于）。
            rows = _rows_full(tbl, scan + 1, since=since, before=until)
        except Exception:
            continue
        if len(rows) > scan:               # 多要一条只为**知道**被截断了（如实上报，不静默）
            trunc = True
            rows = rows[:scan]
        for ct, lt, content, s, lid, src, *rest in rows:
            # 搜**渲染后的文本**而不是原始 XML：这样「图片」「语音」「撤回」这些
            # 摘要词才搜得到，也避免命中 XML 属性里的随机十六进制（aeskey/md5 之类）。
            if keyword in _render(lt, content):
                hits.append(msg_dict(ct, lt, content, nm, talker=t, name=nm.get(t, t), sender=s, me=me,
                                     local_id=lid, source=src, packed=(rest[0] if rest else None)))
    hits.sort(key=lambda d: d["ts"], reverse=True)
    # 视频命中要带 `video_path`（2026-10-14 补）：`history`/`poll_new` 都挂了，唯独**检索**
    # 这条最该挂的没挂——于是「搜到那段视频」返回的是一条**点不开**的消息（实测搜「视频」命中 48 条、
    # 带路径 0 条），用户要的恰恰是"搜到了就给我"。成本很低：只读 hardlink.db（30s 缓存）+ 比大小，
    # 不扫内存、不需要 key。取不到就维持没路径——**本地根本没有那份字节**（多数视频从没在微信里点开过，
    # 点开一次就会下载落盘），不猜、不编。
    attach_video(hits[:limit])
    return {"keyword": keyword, "count": len(hits), "scanned_per_talker": scan,
            "truncated": trunc, "messages": hits[:limit]}


def unread():
    """未读会话（读 session.db 的 unread_count），附未读条数与最近一条预览。

    预览用**客户端自己算好的** `SessionTable.summary` —— 微信会话列表上显示的就是它。
    早先的实现对每个未读会话各调一次 `history(u, 1)` 再渲染：实测本机 128 个未读会话
    ⇒ **1.8 秒**，比全库检索一次还慢 5 倍，而这一整块信息客户端早就算好躺在同一行里了。
    summary 覆盖率实测 127/128（剩的是「你撤回了一条消息」这类微信自己也不给预览的），
    空就空着——预览只用于「先看哪条」，要准确内容应当用 read_history。

    排序按 `last_timestamp` 倒序（最近活跃在前，与微信 UI 一致）；原先按 username
    字典序返回，顺序对用户没有意义。
    """
    nm = names()
    try:
        c = sqlite3.connect(_session_plain())
        rows = list(c.execute(
            "select username, unread_count, ifnull(summary, ''), ifnull(last_timestamp, 0) "
            "from SessionTable where unread_count > 0 order by last_timestamp desc"))
        c.close()
    except Exception as e:
        return {"count": 0, "sessions": [], "error": f"session.db 读取失败: {e}"}
    out = [{"talker": u, "name": nm.get(u, u), "last": (s or "")[:80], "unread": n}
           for u, n, s, _ts in rows]
    return {"count": len(out), "sessions": out}


# ---------- P0：用户/好友知识与行为蒸馏（确定性、只读、本地）----------
_STOP = {"的", "了", "是", "我", "你", "他", "她", "它", "在", "就", "都", "和", "也", "这", "那",
         "不", "有", "要", "会", "吗", "呢", "啊", "吧", "嗯", "一个", "我们", "你们", "他们",
         "the", "a", "an", "and", "to", "of", "is", "in", "it", "for", "on", "you", "that",
         "this", "with", "at", "be", "are", "was", "s", "t", "re", "ve", "ll", "don"}


def _rows_full(tbl, limit, since=0, before=0, at=0):
    """跨分片取会话消息（带发送者 user_name）：[(create_time, local_type, content, sender)]。

    `at` 单独取**某一秒的全部**（`create_time = ?`），只给 `_pad_page` 翻页补秒用。
    """
    _refresh()
    conds, params = [], []
    if since:
        conds.append("create_time > ?")
        params.append(since)
    if before:
        conds.append("create_time < ?")
        params.append(before)
    if at:
        conds.append("create_time = ?")
        params.append(at)
    where = (" where " + " and ".join(conds)) if conds else ""
    out = []
    for p in _cache["msg"]:
        if tbl not in _cache["tables"].get(p, ()):
            continue
        smap = _cache["senders"].get(p, {})
        c = sqlite3.connect(p)
        try:
            for ct, lt, content, sid, lid, src, pk in _query_rows(c, tbl, where, params + [limit], True):
                out.append((ct, lt, content, smap.get(sid, ""), lid, src, pk))
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
        ct, lt, content, sender, _lid, _src, *_ = r   # `_rows_full` 现在是 7 列（多带 packed_info_data）
        if (lt & 0xFFFFFFFF) != 1:            # 只认纯文本；图片/语音走 describe_nontext
            continue
        body = _render(lt, content).strip()
        # 代聊代发的、自检载荷的一律不进对子——`exchange_pairs` 是要**每轮拼进提示词**的
        # 「对方说 X → 我回 Y」，把 AI 自己写的那一轮当示例，就是让模型照着自己的口气学。
        if is_agent_or_probe(body):
            continue
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
        # 「隔了太久就不是回他」：范本的含义是「他这么说 → 我这么接」，中间隔夜/隔半天，
        # 这两句根本没有因果关系。**代发消息被剔除后，序列会出现空洞**，不卡这一条就会把
        # 「他昨晚最后一句 → 我今天第一句」配成范本（2026-10-12 实锤：剔除代发后 321 群
        # 立刻冒出「张松：故意不小心是吧[旺柴] → 我：兄弟门，出来和我的AI聊会儿天呀」，
        # 两句差 10 小时）。
        if b[2] - a[3] > _PAIR_GAP_S:
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


def digest(talker=None, limit=0, samples=6, top=15, since=0):
    """蒸馏「行为与语料」：全局（`talker` 为空）或指定会话。

    ⚠️ **`since` 只收窄「样本」，统计永远基于全量**（见下面 pairs 循环里的说明）——
    这样增量蒸馏拿去覆盖画像时不会把老底丢掉。

    ⚠️ **`limit` 默认 0 = 全量**（2026-10-14 改，原默认 500）：它和上面那句话**本来是打架的**
    ——「统计永远基于全量」而每个会话只扫最新 500 条时，超过 500 条的会话给出的
    `self.total`/`hour_hist`/`contacts`/`style` 全是**切片**，而返回里写着 `stats_scope: "all"`。
    本机就有会话 >500 条（最大 614），所以这是**当下就在错**的一条，不是理论问题。
    设了 `limit` 就是**有损**的（省时间用），那时 `capped_talkers` 会把被截断的会话列出来
    ——**别拿它当真值**。

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
    scanned, capped = 0, []
    for t, tbl in pairs:
        # ⚠️ **统计永远基于全量**（不加 `since`）：`since` 只用来挑「这次要看的**新样本**」。
        #
        # 为什么必须这样（2026-10-10 实测）：`profile_save` 是**整体覆盖**，而提示词教的是
        # 「回来用 distill_state 记水位，下次 `wechat_digest(since=水位)` 只处理新消息」。
        # 若统计也被 `since` 收窄，一次增量蒸馏就会把全量画像换成几天切片的统计——
        # 实测：3 天切片只剩 403 条（全量 3903）、联系人 69→21、活跃时段只有 15 个小时非零，
        # 写出来的画像会把这些当成「事实」。
        #
        # `limit` 默认 0 = 全量（多要一条只为**知道**被截断了，好如实上报 `capped_talkers`）。
        rows = _rows_full(tbl, (limit + 1) if limit else 10 ** 9)
        if limit and len(rows) > limit:
            capped.append(t)
            rows = rows[:limit]
        scanned = max(scanned, len(rows))
        tot = fm = ft = 0
        first = last = 0
        sm_me, sm_them = [], []
        for ct, lt, content, sender, _lid, _src, *_ in rows:
            body = decode(content).strip()
            # **蒸馏只用本人打的字**（2026-10-12）：代聊自己发的、MCP 自检载荷全都不算——
            # 它们 `from_me` 恒真（以本人身份发出），混进来就是拿 AI 的口气当我的口气，
            # 再写成画像卡喂回去，代聊照着演一个不属于本人的人格。见 `is_agent_or_probe`。
            if is_agent_or_probe(body):
                continue
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
        "scanned_per_talker": scanned,        # 实扫条数（不是上限）；=limit 且 capped 非空即被截断
        "capped_talkers": capped,
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


_KEEP_ON_CLEAR = {"image_key.json"}        # 同目录里**不属于**蒸馏产物的文件，清空时保留


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
        # 图片 AES key 也落在这个目录（`wechat_image._key_path`），但它不是蒸馏产物：
        # 跟着删掉的话，用户「清空画像」之后 read_image 全部变成 no_key，得重新扫内存才能看图。
        for name in os.listdir(d):
            if name in _KEEP_ON_CLEAR:
                continue
            p = os.path.join(d, name)
            if os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)
            else:
                try:
                    os.remove(p)
                except OSError:
                    continue
            removed.append(name)
    else:
        return {"ok": False, "error_code": "bad_args",
                "error": "需给 scope 清除单个画像，或显式 everything=true 清空全部（防误清）"}
    return {"ok": True, "removed": removed, "dir": d}
