"""可逆实验：`wake_window` 遇到**最小化**的主窗口时到底做了什么。

怀疑：`_offscreen()` 把「最小化」和「被搬到桌面外」混为一谈（两者的 `GetWindowRect` 都是
-32000 哨兵，见 `_SENTINEL`），于是 `wake_window` 第 1088 行把最小化窗口也塞进
`_bring_onscreen(h)`；而 `_bring_onscreen` 读回的就是最小化态的**假尺寸**（160x28），
再 `MoveWindow(h, 60, 40, 160, 28)` 写回去 —— 用户窗口的尺寸/位置就这么被改掉了，
第 1101 行那条「经托盘图标自愈」的路（注释说最小化态唯一能真正恢复的路）**永远走不到**。

全程可逆：最后走 `repair_env` 的路径（SW_RESTORE + MoveWindow 到预设几何）还原。
"""
import ctypes
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "apps", "windows", "resources", "wechat-mcp"))
import wechat_sender as S  # noqa: E402


def snap(h, tag):
    l, t, w, ht = S.win_rect(h)
    print(f"{tag:<30} rect={l},{t} {w}x{ht}  visible={bool(S.u.IsWindowVisible(h))} "
          f"iconic={bool(S.u.IsIconic(h))}  offscreen={S._offscreen((l, t, w, ht))}")
    return (l, t, w, ht)


def restore(h):
    S.u.ShowWindow(ctypes.c_void_p(h), 9)
    time.sleep(0.3)
    S.u.MoveWindow(ctypes.c_void_p(h), S.NX, S.NY, S.NW, S.NH, True)
    time.sleep(0.7)


h = S.find_main_hwnd()
print(f"hwnd={h}")
before = snap(h, "before")

print("\n— step 1: SW_MINIMIZE(6)（模拟用户把微信收起来）—")
S.u.ShowWindow(ctypes.c_void_p(h), 6)
time.sleep(1.2)
mini = snap(h, "minimized")

print("\n— step 2: 模拟一次发送：check_env() → wake_window() —")
st = S.check_env()
print(f"  check_env: ok={st.get('ok')} minimized={st.get('minimized')} "
      f"onscreen={st.get('onscreen')} reason={st.get('reason')}")
try:
    S._bring_onscreen(h)
except Exception as e:
    print(f"  _bring_onscreen 抛错：{type(e).__name__}: {e}")
after = snap(h, "after _bring_onscreen")

print("\n— step 3: 只 SW_RESTORE(9)，看窗口以什么尺寸/位置回来 —")
S.u.ShowWindow(ctypes.c_void_p(h), 9)
time.sleep(0.8)
woke = snap(h, "after SW_RESTORE")

print("\n— step 4: 还原回预设几何 —")
restore(h)
snap(h, "restored")
print(f"\n（实验前 {before}；最小化态 {mini}；wake 之后 {after}）")
