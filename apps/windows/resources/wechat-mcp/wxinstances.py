# -*- coding: utf-8 -*-
"""运行中的微信实例 ↔ 账号 ↔ 主窗口。

为什么需要它
------------
微信 4.x 原生多开后，多个 `Weixin.exe` 实例共用同一个数据根
`...\\xwechat_files`，每个账号一个 `wxid_*_xxxx` 子目录。主窗口类名和标题
都一样，**从窗口本身认不出是哪个账号**。

但每个实例都会打开自己账号目录下的数据库文件。枚举进程句柄、看它打开了
哪个 `xwechat_files\\<wxid>_<4hex>\\...`，就能把 PID 和 wxid 对上。
这是纯读取（`NtQuerySystemInformation` + `NtQueryObject`），不注入、不改内存。

对外只有四个函数：
- `instances(refresh=False)`：`[{pid, wxid, hwnd, visible, minimized, title}]`
- `window_for_account(wxid, include_hidden=False)`：该账号的主窗口句柄，找不到返回 0
- `window_for_pid(pid, include_hidden=False)`
- `accounts_detailed()`：把 `wechat_core.list_accounts()` 与运行态合并
"""
import ctypes
import os
import re
import time
from ctypes import wintypes

# ---------------------------------------------------------------------------
# ntdll：枚举全系统句柄
# ---------------------------------------------------------------------------

_ntdll = ctypes.WinDLL("ntdll")
_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
_user32 = ctypes.WinDLL("user32", use_last_error=True)

SYSTEM_EXTENDED_HANDLE_INFORMATION = 64
STATUS_INFO_LENGTH_MISMATCH = 0xC0000004
OBJECT_NAME_INFORMATION = 1
OBJECT_TYPE_INFORMATION = 2
PROCESS_DUP_HANDLE = 0x0040
DUPLICATE_SAME_ACCESS = 0x0002

_ntdll.NtQuerySystemInformation.argtypes = (
    ctypes.c_int, ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong))
_ntdll.NtQuerySystemInformation.restype = ctypes.c_uint32
_ntdll.NtQueryObject.argtypes = (
    ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_ulong,
    ctypes.POINTER(ctypes.c_ulong))
_ntdll.NtQueryObject.restype = ctypes.c_uint32
_k32.OpenProcess.argtypes = (ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong)
_k32.OpenProcess.restype = ctypes.c_void_p
_k32.CloseHandle.argtypes = (ctypes.c_void_p,)
_k32.CloseHandle.restype = ctypes.c_int
_k32.DuplicateHandle.argtypes = (
    ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
    ctypes.POINTER(ctypes.c_void_p), ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong)
_k32.DuplicateHandle.restype = ctypes.c_int
_k32.GetCurrentProcess.restype = ctypes.c_void_p


class _HandleEntry(ctypes.Structure):
    _fields_ = [
        ("Object", ctypes.c_void_p),
        ("UniqueProcessId", ctypes.c_size_t),
        ("HandleValue", ctypes.c_void_p),
        ("GrantedAccess", ctypes.c_ulong),
        ("CreatorBackTraceIndex", ctypes.c_ushort),
        ("ObjectTypeIndex", ctypes.c_ushort),
        ("HandleAttributes", ctypes.c_ulong),
        ("Reserved", ctypes.c_ulong),
    ]


def _query_string(handle, info_class):
    """读 OBJECT_NAME_INFORMATION / OBJECT_TYPE_INFORMATION 里的 UNICODE_STRING。"""
    need = ctypes.c_ulong(0)
    _ntdll.NtQueryObject(handle, info_class, None, 0, ctypes.byref(need))
    size = max(int(need.value), 4096)
    buf = ctypes.create_string_buffer(size)
    if _ntdll.NtQueryObject(handle, info_class, buf, size, ctypes.byref(need)) != 0:
        return None
    length = ctypes.c_ushort.from_buffer(buf).value
    if length <= 0:
        return None
    # UNICODE_STRING: ushort Length, ushort MaximumLength, PWSTR Buffer
    # x64 下 Buffer 对齐到偏移 8；x86 下偏移 4。
    ptr_off = ctypes.sizeof(ctypes.c_void_p)
    ptr = ctypes.c_void_p.from_buffer(buf, ptr_off).value
    if not ptr:
        return None
    return ctypes.wstring_at(ptr, length // 2)


def _iter_handles():
    size = 1 << 20
    buf = ctypes.create_string_buffer(size)
    ret = ctypes.c_ulong(0)
    while True:
        status = _ntdll.NtQuerySystemInformation(
            SYSTEM_EXTENDED_HANDLE_INFORMATION, buf, size, ctypes.byref(ret))
        if status == STATUS_INFO_LENGTH_MISMATCH:
            size = max(int(ret.value), size * 2)
            buf = ctypes.create_string_buffer(size)
            continue
        if status != 0:
            raise OSError(f"NtQuerySystemInformation 失败：0x{status & 0xFFFFFFFF:08X}")
        count = ctypes.c_size_t.from_buffer(buf).value
        base = ctypes.addressof(buf) + ctypes.sizeof(ctypes.c_size_t) * 2
        entry_size = ctypes.sizeof(_HandleEntry)
        for i in range(count):
            yield _HandleEntry.from_address(base + i * entry_size)
        return


def _file_paths_by_pid(pids, needle="xwechat_files"):
    """一次枚举全系统句柄，返回 {pid: [路径]}（只收目标 PID 的 File 句柄）。

    全机句柄 30 万级；逐 PID 重扫会让一次实例探测变成十几次全表扫描。
    """
    pidset = {int(p) for p in pids}
    out = {p: [] for p in pidset}
    if not pidset:
        return out
    for ent in _iter_handles():
        pid = int(ent.UniqueProcessId)
        if pid not in pidset:
            continue
        if not ent.HandleValue or ent.HandleValue == ctypes.c_void_p(-1).value:
            continue
        proc = _k32.OpenProcess(PROCESS_DUP_HANDLE, False, pid)
        if not proc:
            continue
        dup = ctypes.c_void_p()
        try:
            ok = _k32.DuplicateHandle(
                proc, ent.HandleValue, _k32.GetCurrentProcess(),
                ctypes.byref(dup), 0, False, DUPLICATE_SAME_ACCESS)
        finally:
            _k32.CloseHandle(proc)
        if not ok or not dup.value:
            continue
        try:
            type_name = _query_string(dup, OBJECT_TYPE_INFORMATION)
            if type_name != "File":
                continue
            name = _query_string(dup, OBJECT_NAME_INFORMATION)
            if name and needle.lower() in name.lower():
                out[pid].append(name)
        finally:
            _k32.CloseHandle(dup)
    return out


def _file_paths_for_pid(pid, needle="xwechat_files"):
    """单个进程的路径（诊断用）。"""
    return _file_paths_by_pid([pid], needle).get(int(pid), [])


# ---------------------------------------------------------------------------
# 窗口
# ---------------------------------------------------------------------------

EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
_user32.EnumWindows.argtypes = (EnumProc, ctypes.c_void_p)
_user32.GetWindowThreadProcessId.argtypes = (ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD))
_user32.GetClassNameW.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int)
_user32.IsWindowVisible.argtypes = (ctypes.c_void_p,)
_user32.IsIconic.argtypes = (ctypes.c_void_p,)
_user32.GetWindowTextW.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int)
_user32.GetWindowRect.argtypes = (ctypes.c_void_p, ctypes.POINTER(wintypes.RECT))


def _is_main_class(cls):
    return bool(cls) and cls.startswith("Qt") and cls.endswith("QWindowIcon")


def _windows_by_pid(include_hidden=False):
    found = {}          # pid -> (面积, hwnd)

    def cb(hwnd, _):
        if not include_hidden and not _user32.IsWindowVisible(hwnd):
            return True
        cls = ctypes.create_unicode_buffer(256)
        _user32.GetClassNameW(hwnd, cls, 256)
        if not _is_main_class(cls.value):
            return True
        pid = wintypes.DWORD()
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not pid.value:
            return True
        # 同一进程有**两个** Qt 顶层窗：真主窗和空壳。取面积最大的那个——
        # 按枚举顺序取第一个会在 include_hidden=True 时选中空壳（实测）。
        # 最小化窗的 rect 是哨兵 (-32000 160x28)，面积仍是正的，不影响排大小。
        r = wintypes.RECT()
        _user32.GetWindowRect(hwnd, ctypes.byref(r))
        area = max(0, r.right - r.left) * max(0, r.bottom - r.top)
        best = found.get(pid.value)
        if best is None or area > best[0]:
            found[pid.value] = (area, int(hwnd))
        return True

    _user32.EnumWindows(EnumProc(cb), None)
    return {pid: hwnd for pid, (_area, hwnd) in found.items()}


def _window_for_pid(pid, include_hidden=False):
    return _windows_by_pid(include_hidden).get(int(pid), 0)


# ---------------------------------------------------------------------------
# 实例表
# ---------------------------------------------------------------------------

_WXID_RE = re.compile(r"xwechat_files[\\/](wxid_[0-9A-Za-z]+)_[0-9a-fA-F]{4}[\\/]", re.I)
# 可见 / 含隐藏各一份缓存：两者枚举的是不同窗口集合，共用一份会互相覆盖。
_cache = {"visible": {"at": 0.0, "rows": []}, "hidden": {"at": 0.0, "rows": []}}
# 一次全量句柄枚举约 370ms（本机），2 秒的缓存等于几乎每次都重扫；10 秒足够跟上开/关微信。
CACHE_TTL = 10.0


def _wechat_pids():
    try:
        import wxkey4
        return [int(pid) for _mem, pid in wxkey4.find_wechat_pids()]
    except Exception:
        return []


def instances(refresh=False, include_hidden=False):
    """运行中的微信实例（每行带 wxid）。缓存 10 秒，避免每次工具调用都枚举句柄。

    `include_hidden=True` 时隐藏（收进托盘）的窗口也会出现在 `hwnd` 里，
    `visible` 字段仍如实反映可见性。
    """
    key = "hidden" if include_hidden else "visible"
    ent = _cache[key]
    now = time.time()
    if not refresh and now - ent["at"] < CACHE_TTL:
        return list(ent["rows"])
    pids = _wechat_pids()
    windows = _windows_by_pid(include_hidden)
    try:
        paths_by_pid = _file_paths_by_pid(pids)
    except Exception:
        paths_by_pid = {}
    rows = []
    for pid in pids:
        wxid = ""
        for path in paths_by_pid.get(pid, []):
            m = _WXID_RE.search(path)
            if m:
                wxid = m.group(1)
                break
        # 只有带账号目录句柄的进程才是"登录实例"；辅助进程没有 wxid，跳过
        if not wxid:
            continue
        hwnd = windows.get(pid, 0)
        title = ""
        if hwnd:
            buf = ctypes.create_unicode_buffer(256)
            _user32.GetWindowTextW(hwnd, buf, 256)
            title = buf.value
        rows.append({
            "pid": pid,
            "wxid": wxid,
            "hwnd": hwnd,
            "visible": bool(hwnd) and bool(_user32.IsWindowVisible(hwnd)),
            "minimized": bool(hwnd) and bool(_user32.IsIconic(hwnd)),
            "title": title,
        })
    rows.sort(key=lambda r: r["pid"])
    ent.update(at=now, rows=rows)
    return list(rows)


def window_for_account(wxid, include_hidden=False):
    """按 wxid 找主窗口。找不到返回 0（**不回退到别的账号**——宁可不发，也不能发错号）。"""
    if not wxid:
        return 0
    for row in instances(include_hidden=include_hidden):
        if row["wxid"] == wxid and row["hwnd"]:
            return row["hwnd"]
    # 缓存可能刚过期；强制再枚一次
    for row in instances(refresh=True, include_hidden=include_hidden):
        if row["wxid"] == wxid and row["hwnd"]:
            return row["hwnd"]
    return 0


def window_for_pid(pid, include_hidden=False):
    return _window_for_pid(pid, include_hidden)


def accounts_detailed():
    """`wechat_core.list_accounts()` + 运行态（pid/hwnd/visible）。"""
    import wechat_core as core
    live = {row["wxid"]: row for row in instances()}
    rows = []
    for a in core.list_accounts():
        row = live.get(a["wxid"], {})
        rows.append({
            **a,
            "running": bool(row),
            "pid": row.get("pid"),
            "hwnd": row.get("hwnd"),
            "visible": row.get("visible", False),
            "minimized": row.get("minimized", False),
        })
    return rows
