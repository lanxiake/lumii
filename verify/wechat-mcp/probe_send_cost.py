"""量一次发送里各个原语的真实成本——只读，不发任何消息、不碰用户剪贴板/光标。

为什么要量：MCP 自己的文档写着单次 send_text 7–15 秒，而 send 路径里 `time.sleep` 的
字面量加起来只有 ~5.5s。差额一定在别处，而"别处"只有两条候选：读 UIA（每次 spawn 一个
PowerShell 进程）和读帧 OCR。不量清楚就动手改，等于按想象优化。

⚠️ 第一次量到 `read_ui_stable` = 7.2s，但那是**假象**：`read_ui` 内部走 `find_main_hwnd()`
（只看"可见"），而最小化窗口在 Win32 眼里 `IsWindowVisible=True`——PrintWindow 拍回来是
空白帧，OCR 读不到，于是白跑满 4 轮。所以这里**先按原样量一轮，再还原窗口量一轮**，
两轮都打印出来；量完把窗口还原成我们发现时的样子（和 probe_uia_gate.ps1 同一套纪律）。

用法：
  set PYTHONIOENCODING=utf-8
  ~/.lumii/runtimes/python-embed/python.exe verify/wechat-mcp/probe_send_cost.py
"""
import ctypes
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "..",
                                                "apps", "windows", "resources", "wechat-mcp")))

import wechat_sender as S  # noqa: E402
import wechat_core as core  # noqa: E402

u = ctypes.windll.user32


def ms(t0):
    return (time.time() - t0) * 1000


def bench(label, fn, n=3):
    xs = []
    for _ in range(n):
        t0 = time.time()
        try:
            fn()
        except Exception as e:
            print(f"  {label:32s} ERR {type(e).__name__}: {e}")
            return None
        xs.append(ms(t0))
    xs.sort()
    print(f"  {label:32s} n={n}  min={xs[0]:7.1f}  median={xs[len(xs) // 2]:7.1f}  max={xs[-1]:7.1f} ms")
    return xs[len(xs) // 2]


def state(h):
    return (f"hwnd={h} iconic={bool(u.IsIconic(ctypes.c_void_p(h)))} "
            f"visible={bool(u.IsWindowVisible(ctypes.c_void_p(h)))} rect={S.win_rect(h)}")


def frame_report(tag):
    """拍一帧并报告 OCR 出了几行——用它区分「帧是空白」和「OCR 慢」。"""
    t0 = time.time()
    ww, wh, lines = S.read_ui(tag)
    return f"  read_ui({tag}) -> {ms(t0):6.0f} ms  {ww}x{wh}  lines={len(lines)}"


def main():
    h = S.find_main_hwnd()
    print("find_main_hwnd()  =", state(h) if h else "None")
    h2 = S.find_main_hwnd(include_hidden=True)
    print("include_hidden    =", state(h2) if h2 else "None")
    if not h2:
        print("找不到微信主窗口——先打开微信")
        return 1

    was_iconic = bool(u.IsIconic(ctypes.c_void_p(h2)))
    fg0 = int(u.GetForegroundWindow())

    print("\n[1] 按原样（不动窗口状态）")
    print(frame_report("costA"))
    print(frame_report("costB"))

    if not was_iconic:
        print("\n窗口没最小化，跳过还原轮；下面是各原语成本")
    else:
        print("\n[2] 还原窗口后（SW_SHOWNOACTIVATE，不抢前台）")
        S.wake_window(h2) if hasattr(S, "wake_window") else \
            u.ShowWindow(ctypes.c_void_p(h2), 4)
        time.sleep(1.0)
        print("  还原后：", state(S.find_main_hwnd() or h2),
              f"fg={int(u.GetForegroundWindow())}（原 fg={fg0}）")
        print(frame_report("costC"))
        print(frame_report("costD"))

    print("\n[3] 各原语成本")
    bench("read_ui_stable", lambda: S.read_ui_stable("costS"), 2)
    bench("read_uia (blank tree)", lambda: S.read_uia(h2, "cost"), 3)
    print(f"    _UIA_BLANK_NOTED = {S._UIA_BLANK_NOTED}")

    ps = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-STA"]
    bench("裸 powershell -STA spawn", lambda: subprocess.run(
        ps + ["-Command", "exit 0"], capture_output=True, text=True), 3)

    print("\n[4] 读库（_wait_new_message 每轮一次，决定轮询能多密）")
    all_sess = (core.sessions() or {}).get("sessions") or []
    tr = (all_sess[0].get("talker") if all_sess else None) or "filehelper"
    print(f"    取样 talker = {tr}")
    bench(f"core.history({tr},3)", lambda: core.history(tr, 3), 3)
    bench("core.sessions()", lambda: core.sessions(), 3)

    print("\n[5] send_text 快路径的固定 sleep 字面量")
    print("    0.4 点击后 + 0.8 盲退200 + 0.6 回读前 + 0.05 回车 + 1.0 送后 + 2.5 首轮轮询 ≈ 5.4 s")

    if was_iconic:
        u.ShowWindow(ctypes.c_void_p(h2), 6)      # SW_MINIMIZE：还原成我们发现时的样子
        print("\nRESTORE 窗口已重新最小化")
    return 0


if __name__ == "__main__":
    sys.exit(main())
