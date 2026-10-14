"""探针：真实控制台（ConPTY）下方向键到底被 msvcrt.getch() 解成什么。

父进程 = 本文件（pty 宿主，模拟 Windows Terminal / 双击建控制台）；
子进程 = --child，加载真 mcp_install._key_reader() 并把解出的键名落盘。

跑法：python probe_arrow_keys.py
"""
import ctypes
import os
import sys
import threading
import time
from ctypes import wintypes

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "..", "apps", "windows", "resources", "wechat-mcp")
SRC = os.path.abspath(SRC)
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "arrow_keys.log")

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016
EXTENDED_STARTUPINFO_PRESENT = 0x00080000
INFINITE = 0xFFFFFFFF


class COORD(ctypes.Structure):
    _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]


class SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("nLength", wintypes.DWORD),
                ("lpSecurityDescriptor", ctypes.c_void_p),
                ("bInheritHandle", wintypes.BOOL)]


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR),
                ("lpDesktop", wintypes.LPWSTR), ("lpTitle", wintypes.LPWSTR),
                ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD),
                ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD),
                ("dwXCountChars", wintypes.DWORD),
                ("dwYCountChars", wintypes.DWORD),
                ("dwFillAttribute", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("wShowWindow", wintypes.WORD),
                ("cbReserved2", wintypes.WORD),
                ("lpReserved2", ctypes.c_void_p),
                ("hStdInput", wintypes.HANDLE), ("hStdOutput", wintypes.HANDLE),
                ("hStdError", wintypes.HANDLE)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE),
                ("dwProcessId", wintypes.DWORD),
                ("dwThreadId", wintypes.DWORD)]


class STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [("StartupInfo", STARTUPINFOW),
                ("lpAttributeList", ctypes.c_void_p)]


def _child():
    # CreateProcess+假控制台**不会**给子进程设 std 句柄（实测拿到的是宿主残留的管道）。
    # 双击/Windows Terminal 那条路上它们是控制台句柄，这里手工补回来才等价。
    import io
    import msvcrt as _m
    k32 = ctypes.windll.kernel32
    conin = k32.CreateFileW("CONIN$", 0xC0000000, 3, None, 3, 0, None)
    conout = k32.CreateFileW("CONOUT$", 0xC0000000, 3, None, 3, 0, None)
    k32.SetStdHandle(-10, conin)
    k32.SetStdHandle(-11, conout)
    k32.SetStdHandle(-12, conout)
    os.dup2(_m.open_osfhandle(conin, os.O_RDONLY), 0)
    sys.stdin = io.TextIOWrapper(io.FileIO(0, "r", closefd=False),
                                 encoding="utf-8", errors="replace",
                                 line_buffering=True)

    sys.path.insert(0, SRC)
    import mcp_install as M
    with open(LOG, "w", encoding="utf-8") as f:
        for tag, h in (("-10", -10), ("-11", -11), ("-12", -12)):
            hh = k32.GetStdHandle(h)
            m = ctypes.c_uint32(0)
            ok = k32.GetConsoleMode(ctypes.c_void_p(hh), ctypes.byref(m))
            f.write("std%s handle=%r consolemode=%r %s\n"
                    % (tag, hh, bool(ok), hex(m.value) if ok else ""))
        f.write("CONIN$=%r\n" % k32.CreateFileW("CONIN$", 0xC0000000, 3, None, 3, 0, None))
        f.write("interactive=%r vt_ok=%r\n" % (M.is_interactive(), M._vt_ok()))
        f.flush()
        read = M._key_reader()
        f.write("reader=%r\n" % (read is not None))
        f.flush()
        if read is None:
            return
        for i in range(12):
            try:
                k = read()
            except Exception as e:                                  # noqa: BLE001
                f.write("key %d raised %r\n" % (i, e))
                break
            f.write("key %d: %r\n" % (i, k))
            f.flush()
            if k in ("enter", "quit"):
                break


def _child_menu():
    """真菜单端到端：把每次重画的文本截下来，看 `>` 是不是真跟着 ↑/↓ 走。"""
    import io
    import msvcrt as _m
    k32 = ctypes.windll.kernel32
    conin = k32.CreateFileW("CONIN$", 0xC0000000, 3, None, 3, 0, None)
    k32.SetStdHandle(-10, conin)
    os.dup2(_m.open_osfhandle(conin, os.O_RDONLY), 0)
    sys.stdin = io.TextIOWrapper(io.FileIO(0, "r", closefd=False),
                                 encoding="utf-8", errors="replace")

    sys.path.insert(0, SRC)
    import mcp_install as M
    cs = [{"key": "a", "label": "Claude Code", "detected": True},
          {"key": "b", "label": "Cursor", "detected": True},
          {"key": "c", "label": "OpenCode", "detected": True}]
    with open(LOG, "w", encoding="utf-8") as f:
        def emit(s):
            f.write("[画] " + s.replace("\x1b", "<ESC>") + "\n")
            f.flush()
        M._emit = emit
        M._vt_ok = lambda: False                     # 每按一次印一整块，便于逐帧比对
        got = M.pick_clients(cs)
        f.write("[结果] %r\n" % sorted(got))


def _spawn(cmd):
    """建 pseudoconsole 起子进程 → (hPC, hIn(写), hOut(读))。"""
    sa = SECURITY_ATTRIBUTES(ctypes.sizeof(SECURITY_ATTRIBUTES), None, True)
    h_in_r = wintypes.HANDLE()
    h_in_w = wintypes.HANDLE()
    h_out_r = wintypes.HANDLE()
    h_out_w = wintypes.HANDLE()
    for a, b in ((h_in_r, h_in_w), (h_out_r, h_out_w)):
        if not kernel32.CreatePipe(ctypes.byref(a), ctypes.byref(b),
                                   ctypes.byref(sa), 0):
            raise OSError("CreatePipe failed %d" % ctypes.get_last_error())

    hpc = wintypes.HANDLE()
    hr = kernel32.CreatePseudoConsole(COORD(120, 30), h_in_r, h_out_w, 0,
                                      ctypes.byref(hpc))
    if hr != 0:
        raise OSError("CreatePseudoConsole hr=%#x" % hr)
    kernel32.CloseHandle(h_in_r)
    kernel32.CloseHandle(h_out_w)

    size = ctypes.c_size_t(0)
    kernel32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
    buf = ctypes.create_string_buffer(size.value)
    if not kernel32.InitializeProcThreadAttributeList(buf, 1, 0,
                                                     ctypes.byref(size)):
        raise OSError("InitAttrList failed %d" % ctypes.get_last_error())
    if not kernel32.UpdateProcThreadAttribute(
            buf, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hpc,
            ctypes.sizeof(hpc), None, None):
        raise OSError("UpdateAttr failed %d" % ctypes.get_last_error())

    si = STARTUPINFOEXW()
    si.StartupInfo.cb = ctypes.sizeof(STARTUPINFOEXW)
    si.lpAttributeList = ctypes.cast(buf, ctypes.c_void_p)
    pi = PROCESS_INFORMATION()
    if not kernel32.CreateProcessW(None, ctypes.c_wchar_p(cmd), None, None,
                                   False, EXTENDED_STARTUPINFO_PRESENT,
                                   None, None,
                                   ctypes.byref(si.StartupInfo),
                                   ctypes.byref(pi)):
        raise OSError("CreateProcess failed %d" % ctypes.get_last_error())
    kernel32.CloseHandle(hpc)                        # 父进程不再需要
    return pi, h_in_w, h_out_r


def main():
    py = sys.executable
    mode = "--child-menu" if "--menu" in sys.argv else "--child"
    cmd = '"%s" "%s" %s' % (py, os.path.abspath(__file__), mode)
    def tr(m):
        with open("trace.txt", "a", encoding="utf-8") as fh:
            fh.write(m + "\n")

    tr("spawn前")
    pi, h_in, h_out = _spawn(cmd)
    tr("spawn后 pid=%d" % pi.dwProcessId)
    out = []

    def pump():
        n = wintypes.DWORD(0)
        buf = ctypes.create_string_buffer(65536)
        while kernel32.ReadFile(h_out, buf, 65536,
                                ctypes.byref(n), None):
            if n.value == 0:
                break
            out.append(buf.raw[:n.value])

    t = threading.Thread(target=pump, daemon=True)
    t.start()

    time.sleep(2.5)                                   # 等子进程就绪
    seqs = [b"\x1b[A", b"\x1b[B", b"\x1b[C", b"\x1b[D", b" ", b"a", b"\r"]
    n = wintypes.DWORD(0)
    for s in seqs:
        tr("写前 %r" % s)
        kernel32.WriteFile(h_in, s, len(s), ctypes.byref(n), None)
        tr("写后 %r n=%d" % (s, n.value))
        time.sleep(0.5)

    tr("等子进程")
    kernel32.WaitForSingleObject(pi.hProcess, 15000)
    tr("等到/超时")
    kernel32.TerminateProcess(pi.hProcess, 0)
    time.sleep(0.5)
    kernel32.CloseHandle(h_in)
    kernel32.CloseHandle(h_out)
    t.join(3)
    print("=== 每帧里 `>` 落在哪一行 ===")
    log = open(LOG, encoding="utf-8").read()
    for ln in log.splitlines():
        if "> " in ln or ln.startswith("[结果]"):
            print(ln)

    print("=== 子进程看到的键 ===")
    print(open(LOG, encoding="utf-8").read() if os.path.exists(LOG) else "(没日志)")
    print("=== 屏幕输出（转义可见）===")
    print(repr(b"".join(out)[-1200:]))
    print("=== 还原 ===")
    print(b"".join(out).decode("utf-8", "replace")[-1200:])


if __name__ == "__main__":
    if "--child-menu" in sys.argv:          # 必须排在 --child 前面：它是 --child 的前缀
        _child_menu()
    elif "--child" in sys.argv:
        _child()
    else:
        main()
