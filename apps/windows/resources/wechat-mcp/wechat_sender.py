"""wechat_sender —— 微信 4.x「零注入」发送（窗口消息投递 + UIA 读数），fail-closed。

安全模型（任一道不通过即中止，绝不盲发）：
1. 目标校验：以 UIA 的 `current_chat_name_label`（活表头、精确文本）为准；只有它拿不到时
   才退回帧 OCR 的证据强度判据（见 `verify_target`）。
2. 发送前清空输入框（投递退格 + 回读确认）：框里的残留会被随后的回车一起发出去（实测踩过）。
   读不到框里有什么时退化为盲退，不拦（别把"读不到"变成"发不出去"）。
3. 输入落地 / 附件落地校验：正文读回输入框（容忍投递丢字，不容忍正文之外的残留）；
   附件走文件对话框，写进文件名框后**回读确认**才点「打开」。
4. 发送成功校验：**发完读库**确认目标会话出现新消息——不像读输入框那样受前台/遮挡影响。

文本与附件都走**全投递**：不抢前台、不碰鼠标键盘、不劫持剪贴板、不搬窗口（锁屏下同样可用）。
只有 `reply_to`（引用回复）仍是前台模拟键鼠 —— 它的右键菜单还没找到后台通路。
"""
import ctypes
import difflib
import os
import re
import subprocess
import sys
import time
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import wechat_core as core  # noqa: E402

u = ctypes.windll.user32
# 打成单文件 wechat-mcp.exe（PyInstaller）后，随包数据解压在 sys._MEIPASS 而不在模块旁
OCR4 = os.path.join(getattr(sys, "_MEIPASS", HERE), "ocr4.ps1")
UIA_READ = os.path.join(getattr(sys, "_MEIPASS", HERE), "uia_read.ps1")

# ============================================================================
# 微信 4.x 主窗口几何与操作锚点（1280×820 规范化后实测，2026-10-07，微信 4.1.15.x）
# ----------------------------------------------------------------------------
# 规范化：Enter 时 ShowWindow + MoveWindow 到 (NX,NY) 尺寸 (NW,NH)；退出时还原原位置尺寸。
# 之所以固定尺寸：微信窗口尺寸会漂移（实测 896→1340px），坐标类方案必须锁定布局。
#
# 布局（窗口内相对坐标，窗口左上角为原点）：
#   会话列表：固定宽 ~300px（不随窗口宽度缩放）；条目文字 x≈126，时间戳 x≈248。
#   聊天头部：紧贴会话列表右侧，y≈49（x≈324）。header 区域 = x∈[session_right, +460]、y1<80。
#   聊天区  ：x ≥ session_right，y ∈ (60, 发送按钮 y − 115)。
#   输入框  ：文字落点 ≈(330, 680)；点击用 ≈(648, 675)。
#   「发送」按钮：右下角 ≈(1216, 773)。判定条件 y>0.6·高 且 x1>0.85·宽
#                （必须加 x1 约束：聊天气泡里出现「…发送…」字样时会误判为按钮）。
#
# 窗口比例参考：1280×820 ≈ 1.561（16:10.25）；当前用固定像素而非比例，
#   因为会话列宽是固定像素，按比例算会在换尺寸时把聊天头部/输入框排错（已踩）。
# ============================================================================
NW, NH, NX, NY = 1280, 820, 60, 40
UL = ctypes.c_ulonglong


class KI(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", UL)]


class MI(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", UL)]


class UI(ctypes.Union):
    _fields_ = [("ki", KI), ("mi", MI)]


class INP(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", UI)]


def _snd(items):
    a = (INP * len(items))(*items)
    u.SendInput(len(items), ctypes.byref(a), ctypes.sizeof(INP))


def _kd(vk, up=False, sc=0, uni=False):
    return INP(type=1, u=UI(ki=KI(0 if uni else vk, sc, (4 if uni else 0) | (2 if up else 0), 0, 0)))


def type_text(s):
    items = []
    for ch in s:
        c = ord(ch)
        if c > 0xFFFF:
            hi = 0xD800 + ((c - 0x10000) >> 10)
            lo = 0xDC00 + ((c - 0x10000) & 0x3FF)
            items += [_kd(0, False, hi, True), _kd(0, True, hi, True), _kd(0, False, lo, True), _kd(0, True, lo, True)]
        else:
            items += [_kd(0, False, c, True), _kd(0, True, c, True)]
    _snd(items)


def press(vk):
    _snd([_kd(vk), _kd(vk, True)])


def ctrl(vk):
    _snd([_kd(0x11), _kd(vk), _kd(vk, True), _kd(0x11, True)])


# ---- 剪贴板回读（输入落地/清空校验用；替代不可靠的区域 OCR）------------------
# ⚠️ 必须显式声明 restype/argtypes：HANDLE 在 64 位下是 8 字节，ctypes 默认按
#    32 位 int 接收会把句柄**高位截断**，GlobalLock 拿到非法指针 → 静默返回空串。
_k32 = ctypes.windll.kernel32
CF_UNICODETEXT = 13

u.OpenClipboard.restype = ctypes.c_bool
u.OpenClipboard.argtypes = [ctypes.c_void_p]
u.GetClipboardData.restype = ctypes.c_void_p
u.GetClipboardData.argtypes = [ctypes.c_uint]
u.CloseClipboard.restype = ctypes.c_bool
u.CloseClipboard.argtypes = []
u.EmptyClipboard.restype = ctypes.c_bool
u.EmptyClipboard.argtypes = []
_k32.GlobalLock.restype = ctypes.c_void_p
_k32.GlobalLock.argtypes = [ctypes.c_void_p]
_k32.GlobalUnlock.restype = ctypes.c_bool
_k32.GlobalUnlock.argtypes = [ctypes.c_void_p]
u.SetClipboardData.restype = ctypes.c_void_p
u.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
_k32.GlobalAlloc.restype = ctypes.c_void_p
_k32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
_k32.GlobalFree.restype = ctypes.c_void_p
_k32.GlobalFree.argtypes = [ctypes.c_void_p]


def _clip_open(retries=6):
    for _ in range(retries):
        if u.OpenClipboard(None):
            return True
        time.sleep(0.05)  # 别的进程正占用剪贴板：短暂重试
    return False


def _clip_get_text():
    """读系统剪贴板文本（CF_UNICODETEXT）；无文本/打不开返回 ''。"""
    if not _clip_open():
        return ""
    try:
        h = u.GetClipboardData(CF_UNICODETEXT)
        if not h:
            return ""
        p = _k32.GlobalLock(ctypes.c_void_p(h))
        if not p:
            return ""
        try:
            return ctypes.c_wchar_p(p).value or ""
        finally:
            _k32.GlobalUnlock(ctypes.c_void_p(h))
    finally:
        u.CloseClipboard()


def _clip_clear():
    """清空剪贴板（只放一个空文本项）。"""
    if not _clip_open():
        return
    try:
        u.EmptyClipboard()
    finally:
        u.CloseClipboard()


def _clip_set_text(s):
    """把文本写入系统剪贴板（CF_UNICODETEXT）。成功返回 True。

    用于「粘贴代替键入」：SendInput 逐字注入在本版微信输入框上会把**每个标点后的
    一个字符替换成该标点**（实测 "看-着，挺-离谱，的" → "看--，，--谱，，"，
    100% 可复现、加字符间隔也不解决）；剪贴板粘贴是原子的，无此问题。
    """
    if not _clip_open():
        return False
    h = None
    try:
        u.EmptyClipboard()
        data = (s + "\0").encode("utf-16-le")
        GMEM_MOVEABLE = 0x0002
        h = _k32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not h:
            return False
        p = _k32.GlobalLock(ctypes.c_void_p(h))
        if not p:
            _k32.GlobalFree(ctypes.c_void_p(h))
            return False
        ctypes.memmove(p, data, len(data))
        _k32.GlobalUnlock(ctypes.c_void_p(h))
        if not u.SetClipboardData(CF_UNICODETEXT, ctypes.c_void_p(h)):
            _k32.GlobalFree(ctypes.c_void_p(h))
            return False
        h = None  # 所有权已移交系统，不能再释放
        return True
    finally:
        u.CloseClipboard()


def _composer_copy_all():
    """读回「微信输入框里当前内容」：清空剪贴板 → Ctrl+A 全选 → Ctrl+C 复制 → 读文本。

    为什么不用截图 OCR 做这个判断：
    1. 本版微信输入框很高（实测 1280×820 下占 y≈455~795），文字从**框的顶部**开始
       渲染，而旧实现按「输入框贴底」取区域（by−115 起），区域里根本没有文字；
    2. Windows OCR 读不出小号拉丁字符——实测输入框里的 "test" 在整张 OCR 结果里
       一行都没有，中文也只有零散乱码。
    剪贴板回读是确定性的：复制到什么就是什么，不受字号/渲染影响。
    输入框为空且无选区时 Ctrl+C 是 no-op，剪贴板保持我们刚清空的空串——不会误读旧内容。
    """
    _clip_clear()
    ctrl(0x41)  # 全选输入框内容
    time.sleep(0.12)
    ctrl(0x43)  # 复制
    time.sleep(0.25)
    return _clip_get_text()


EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)


def find_main_hwnd(include_hidden=False):
    """微信主窗口句柄（取面积最大的 Qt 窗口）。默认**只看可见窗口**。

    默认口径是「这双手现在能不能用」：微信主窗口可以进入「进程在跑、句柄还在、
    `IsWindowVisible=0`（不是最小化）」的隐藏态（用户收进托盘了），那种态不算可用。
    发送路径因此不会在本函数上撞死——闸门会先还原窗口（见 `wake_window`），还原后它自然可见。

    `include_hidden=True` 连隐藏态一起收，专供还原那一步用：隐藏态下**句柄依然在**
    （2026-10-09 实测：`SW_HIDE` 后按可见性过滤枚举到 `[]`，不过滤枚举到 `[199150, 199070]`），
    所以能先找到、再用 `SW_SHOWNOACTIVATE` 原地还原。这里仍取**面积最大**的那个，
    实测两条候选里主窗口面积最大，选不岔。

    **认窗口还要认进程**：类名 `Qt51514QWindowIcon` 只标 Qt 版本（5.15.14），别的用同版本 Qt
    的应用会撞名。2026-10-09 实测撞过一次——微信收起来时这里返回了一个**不属于微信**的可见窗口。
    拿错窗口的后果不是崩，是静默走偏：`verify_target` 对着别人家的界面校验 ⇒ `target_unconfirmed`
    （那正是真机上反复出现、一直没定位到的那个失败）。取不到 PID 时退回「只认类名」（今天之前的行为），
    免得工具坏了反而把整条发送链掐死。
    """
    pids = set(weixin_pids())
    best = [0, 0]        # 微信进程名下：面积最大的
    fallback = [0, 0]    # 同类名但进程认不出：兜底

    def cb(h, _l):
        if not include_hidden and not u.IsWindowVisible(h):
            return True
        cls = ctypes.create_unicode_buffer(256)
        u.GetClassNameW(h, cls, 256)
        if cls.value == "Qt51514QWindowIcon":
            r = Rect()
            u.GetWindowRect(h, ctypes.byref(r))
            area = (r.R - r.L) * (r.B - r.T)
            pid = ctypes.c_ulong()
            u.GetWindowThreadProcessId(ctypes.c_void_p(h), ctypes.byref(pid))
            slot = best if (not pids or pid.value in pids) else fallback
            if area > slot[0]:
                slot[0], slot[1] = area, int(h)
        return True

    u.EnumWindows(EnumProc(cb), None)
    return best[1] or fallback[1]


class Rect(ctypes.Structure):
    _fields_ = [("L", ctypes.c_long), ("T", ctypes.c_long), ("R", ctypes.c_long), ("B", ctypes.c_long)]


def win_rect(h):
    r = Rect()
    u.GetWindowRect(ctypes.c_void_p(h), ctypes.byref(r))
    return r.L, r.T, r.R - r.L, r.B - r.T


def weixin_pids():
    """微信进程 PID 列表（用于判断「是否在运行」）。"""
    try:
        import wxkey4
        return [int(p) for _n, p in wxkey4.find_wechat_pids()]
    except Exception:
        return []


def bring_to_front(h, tries=3):
    """把窗口切到前台并**确认成功**。

    后台进程直接 `SetForegroundWindow` 常被 Windows 前台锁拦下（尤其用户正在用别的窗口，
    而 Agent 就跑在 Lumii 里），故逐级升级：① 直接设；② `AttachThreadInput` 借用前台线程；
    ③ 模拟一次 Alt 键让本进程获得「最近输入」后强设。全部失败返回 False（调用方据此拒绝操作）。
    """
    if not h:
        return False
    u.ShowWindow(ctypes.c_void_p(h), 9)  # SW_RESTORE（从最小化/隐藏恢复）
    for i in range(tries):
        try:
            u.SetForegroundWindow(ctypes.c_void_p(h))
        except Exception:
            pass
        time.sleep(0.3)
        if int(u.GetForegroundWindow()) == h:
            return True
        try:
            fg = u.GetForegroundWindow()
            t1 = u.GetWindowThreadProcessId(fg, None)
            t2 = u.GetWindowThreadProcessId(ctypes.c_void_p(h), None)
            if t1 and t2 and t1 != t2:
                u.AttachThreadInput(t1, t2, True)
                u.SetForegroundWindow(ctypes.c_void_p(h))
                u.AttachThreadInput(t1, t2, False)
                time.sleep(0.2)
                if int(u.GetForegroundWindow()) == h:
                    return True
        except Exception:
            pass
        if i == tries - 1:  # 最后一招：模拟 Alt（单按无副作用）取得「最近输入」后强设前台
            try:
                u.keybd_event(0x12, 0, 0, 0)
                u.keybd_event(0x12, 0, 2, 0)
                time.sleep(0.05)
                u.SetForegroundWindow(ctypes.c_void_p(h))
                time.sleep(0.3)
            except Exception:
                pass
    return int(u.GetForegroundWindow()) == h


DESKTOP_READOBJECTS = 0x0001


def session_locked():
    """电脑是不是锁屏了。

    判据一（Win11 主力）：锁屏是 LockApp.exe 的窗口——类名 `Windows.UI.Core.CoreWindow`、
    标题含「锁屏」——它**覆盖在同一个 Default 桌面上**。所以下面那条老判据在 Win11 上会
    **假阴性**（2026-10-09 实测：锁屏时 OpenInputDesktop 依然返回 Default）。
    判据二（经典）：输入桌面切到了 Winlogon；连输入桌面都拿不到时保守当作已锁。

    注意：锁屏 ≠ 发不出去。`SendInput` 那类模拟键鼠确实够不着 Winlogon，但**投递**
    （PostMessage）走的是窗口消息队列，锁屏期间照样有效（实测搜索/切会话/输入/发送全通）。
    这个判据用来判断「能不能走需要前台的那条路」，别拿它当「能不能发」。
    """
    try:
        fh = int(u.GetForegroundWindow())
        if fh:
            cls = ctypes.create_unicode_buffer(256)
            u.GetClassNameW(ctypes.c_void_p(fh), cls, 256)
            if cls.value == "Windows.UI.Core.CoreWindow":
                n = u.GetWindowTextLengthW(ctypes.c_void_p(fh))
                b = ctypes.create_unicode_buffer(n + 1)
                u.GetWindowTextW(ctypes.c_void_p(fh), b, n + 1)
                if "锁屏" in b.value:
                    return True
    except Exception:
        pass
    try:
        dh = u.OpenInputDesktop(0, False, DESKTOP_READOBJECTS)
        if not dh:
            return True
        try:
            buf = ctypes.create_unicode_buffer(256)
            need = ctypes.c_ulong()
            # UOI_NAME = 2；正常桌面叫 "Default"，锁屏/安全桌面叫 "Winlogon"
            if u.GetUserObjectInformationW(dh, 2, buf, ctypes.sizeof(buf), ctypes.byref(need)):
                return buf.value.strip().lower() != "default"
            return False
        finally:
            u.CloseDesktop(dh)
    except Exception:
        return False


# ============================================================================
# 全投递路径 —— 不抢前台、不碰鼠标键盘、不劫持剪贴板
# ----------------------------------------------------------------------------
# 2026-10-09 实测的能力边界（1280×820、微信 4.x）：
#   读界面  PrintWindow 即可，窗口在后台 / 最小化 / 被锁屏盖住都能拍到完整内容
#   切会话  投递点击**左侧会话列表**那一行（列表常驻、最稳）；不在列表里才回退搜索浮层
#   送文本  投递 WM_CHAR，**前提是输入框已有焦点**（微信切会话时会自动 focus）
#   发送    投递回车（或投递点击发送按钮），读库回读确认落地
# 绕不开的一点：投递字符会让微信**自己**跳到前台（0.1–0.3 秒，Qt 收到输入消息时的自激活）。
# 子窗口 MMUIRenderSubWindowHW 虽不抢前台，但输入也进不去，所以没有替代路径。
# ============================================================================
WM_CHAR, WM_LBUTTONDOWN, WM_LBUTTONUP = 0x0102, 0x0201, 0x0202
WM_KEYDOWN, WM_KEYUP, VK_RETURN, VK_ESC, VK_BACK = 0x0100, 0x0101, 0x0D, 0x1B, 0x08


def _client_pt(h, x, y):
    """把 layout() 的窗口坐标换算成 PostMessage 要的客户区坐标（两者差一个边框）。"""
    l, t, _w, _h = win_rect(h)
    pt = wintypes.POINT(l + x, t + y)
    u.ScreenToClient(ctypes.c_void_p(h), ctypes.byref(pt))
    return pt.x, pt.y


def post_click(h, x, y):
    """投递一次点击（x,y 同 layout 的窗口坐标）。窗口不必在前台。"""
    cx, cy = _client_pt(h, x, y)
    lp = ((cy & 0xFFFF) << 16) | (cx & 0xFFFF)
    r1 = u.PostMessageW(ctypes.c_void_p(h), WM_LBUTTONDOWN, 1, lp)
    time.sleep(0.06)
    r2 = u.PostMessageW(ctypes.c_void_p(h), WM_LBUTTONUP, 0, lp)
    return bool(r1) and bool(r2)


def post_text(h, text, dt=0.05):
    """把文本投进输入框。

    走 WM_CHAR 而不是剪贴板：**不劫持用户的剪贴板**（用户可能正在复制别的东西）。
    需要输入框已有焦点 —— 微信切换会话时会自动 focus 输入框；焦点不在时投递会落空，
    表现为「投递返回成功但读库无新消息」，由调用方按失败处理（排队重试）。
    非 BMP 字符（emoji 等代理对）会漏，暂不支持。
    """
    ok = True
    for ch in text:
        if not u.PostMessageW(ctypes.c_void_p(h), WM_CHAR, ord(ch), 1):
            ok = False
        time.sleep(dt)
    return ok


def post_key(h, vk):
    a = bool(u.PostMessageW(ctypes.c_void_p(h), WM_KEYDOWN, vk, 1))
    time.sleep(0.05)
    b = bool(u.PostMessageW(ctypes.c_void_p(h), WM_KEYUP, vk, 1))
    return a and b


def post_backspaces(h, n, dt=0.004):
    """投递 n 次退格。

    组合键在 Qt 微信上无效（Qt 读真实键盘状态，Ctrl+A/C/V 实测全不通），所以没法「全选删除」，
    只能一次一个退格。调用方（见 `clear_input`）负责决定退几次、并回读复核。
    """
    for _ in range(n):
        u.PostMessageW(ctypes.c_void_p(h), WM_KEYDOWN, VK_BACK, 1)
        u.PostMessageW(ctypes.c_void_p(h), WM_KEYUP, VK_BACK, 1)
        time.sleep(dt)


def clear_input(h, cur=None):
    """发送前清空输入框，**回读确认**。返回 (ok, detail)。

    **这不是洁癖**：框里的残留会被随后的回车一起发出去——2026-10-09 实测踩过（探测留下的
    'ZQ1aaccaaaacc' 跟着附件一起发了出去）。以前只能盲退格（读不到框里有什么）；现在
    UIA 的 `chat_input_field` 能读到原文，所以退格次数按**实际长度**算，退完再回读复核。
    代价是目标会话里**用户的草稿会被删掉**——老的前台路径本来就是 Ctrl+A/Del，口径一致。
    读不到内容时退化为「盲退 200 次」，且回读失败也不拦（别把"读不到"变成"发不出去"）。
    """
    if cur == "":
        return True, "输入框本来就是空的"
    n = min(len(cur) + 20, 2000) if cur is not None else 200
    post_backspaces(h, n)
    left = (read_uia(h, "clr") or {}).get("input")
    if left:
        return False, f"输入框未清空（还剩 {len(left)} 字，fail-closed）"
    return True, "已清空"


def _residue(got, text):
    """`got` 里"不属于 text"的那些字（按子序列贪心消费）。

    为什么要这么比，而不是 `got == text`：投递**丢字**是已知的（非 BMP 字符/emoji 走 WM_CHAR
    会漏）。严格相等会让带 emoji 的正常回复永远判失败、卡在重试队列里；子序列则能容忍"我们的字
    少了一点"，但仍然抓得住"框里混进了别人的东西"（残留文本里的字对不上我们的正文）。
    """
    i = 0
    for ch in got:
        if i < len(text) and ch == text[i]:
            i += 1
        else:
            yield ch


def _post_click_verify(h, x, y, tag, name, talker, verbose):
    """投递点一下 (x,y)，等一拍再用 verify_target 复核是否切到了目标会话。"""
    post_click(h, x, y)
    time.sleep(1.3)
    ww, wh, lines = read_ui_stable(f"{tag}v")
    return verify_target(talker, name, lines, ww, wh, verbose)[0]


def _uia_origin(data):
    """UIA 根矩形（客户区，屏幕坐标）——点击换算的参考系。

    **和条目取自同一棵树**，所以不会被「窗口被挪走」「最小化时 Win32 报 -32000 跳变」割裂。
    实测窗口最小化时 UIA 依然给还原位（`537 269 1264 788`），条目坐标也是同一套，能直接算。
    拿不到就别点（返回 None）——那时算出来的坐标是猜的。
    """
    w0 = (data or {}).get("win")
    if not w0 or w0[0] < -10000 or w0[2] < 200 or w0[3] < 200:
        return None
    return w0


def _uia_layout(h, data, x, y):
    """UIA 屏幕坐标 → post_click 的窗口坐标。参考系是客户区原点，故比真实窗口原点偏一个边框
    （实测 8px），最终落点因此有 ≤8px 的固定偏差——会话行高 65px、输入框更大，够用。"""
    o = _uia_origin(data)
    if not o:
        return None
    return x - o[0], y - o[1]


def read_uia(h=None, tag="uia", all_ctls=False):
    """读微信的 UI Automation 树：活状态 + 活几何 + 精确文本。拿不到返回 None。

    **为什么不继续用 read_ui 的帧判状态（2026-10-09 实测）**：`PrintWindow` 给的是窗口
    **最后一次绘制**的表面。窗口被别的窗口整块盖住时 Qt 不再重绘，那块表面就冻在那儿——
    同一个窗口，帧里会话列表少了 5 个置顶会话、时间戳停在 13:40，而 UIA 给的是当前值
    （14:09）。拿旧帧当状态源 ⇒ 点的是几分钟前的行位、再把正确结果判成「目标未确认」，
    然后掉进搜索兜底（那条路既劫持剪贴板、又会把搜索浮层留在窗口上）。
    这正是那个反复出现、一直没定位到的 `target_unconfirmed`（累计 4 次）的真凶。

    UIA 读的是应用的模型，不受遮挡/最小化/收进托盘影响，且名字是**精确文本**
    （「杨冬」「韩玉」「公众号」这些 OCR 读不出来的名字都是准的）。
    只读不写：读整棵树约 1.8s，实测**不抢前台**（`Select()` 那种动作会抢，别用）。
    """
    h = h or find_main_hwnd(include_hidden=True)
    if not h:
        return None
    out = os.path.join(core.WORK, f"uia_{tag}.txt")
    args = ["-Hwnd", str(h), "-Out", out] + (["-All"] if all_ctls else [])
    _run_ps(UIA_READ, args, sta=True)
    data = {"h": h, "win": None, "items": [], "header": None, "edits": [],
            "mlist": None, "btns": [], "ctls": [], "input": None}
    try:
        for ln in open(out, encoding="utf-8", errors="replace").read().splitlines():
            q = ln.split("\t")
            k = q[0]
            if k == "ERR":
                return None
            if k == "WIN" and len(q) == 5:
                data["win"] = tuple(int(v) for v in q[1:5])
            elif k == "ITEM" and len(q) >= 8:
                data["items"].append({"aid": q[1], "rect": tuple(int(v) for v in q[2:6]),
                                      "sel": q[6] == "1", "name": "\t".join(q[7:])})
            elif k == "HEADER":
                data["header"] = "\t".join(q[1:])
            elif k == "INPUT":                 # 输入框当前内容（空串 = 空；字段缺失 = 读不到）
                data["input"] = "\t".join(q[1:])
            elif k == "EDIT" and len(q) >= 7:
                data["edits"].append({"aid": q[1], "rect": tuple(int(v) for v in q[2:6]),
                                      "name": "\t".join(q[6:])})
            elif k == "MLIST" and len(q) == 5:
                data["mlist"] = tuple(int(v) for v in q[1:5])
            elif k == "BTN" and len(q) >= 7:
                data["btns"].append({"aid": q[1], "rect": tuple(int(v) for v in q[2:6]),
                                     "name": "\t".join(q[6:])})
            elif k == "CTL" and len(q) >= 8:      # 仅 -All：原生句柄是驱动文件对话框的唯一抓手
                try:
                    nwh = int(q[3])
                except ValueError:
                    nwh = 0
                data["ctls"].append({"type": q[1], "aid": q[2], "nwh": nwh,
                                     "rect": tuple(int(v) for v in q[4:8]),
                                     "name": "\t".join(q[8:])})
    except Exception:
        return None
    if not data["win"]:
        return None
    if _uia_tree_blank(data):
        _note_uia_blank(tag)
        return None
    return data


_UIA_BLANK_NOTED = False


def _uia_tree_blank(data):
    """UIA 树是不是**只剩窗口外框**（微信没向 UIA 暴露内部控件）。

    微信 4.x 默认不暴露 mmui 控件树：能不能读到取决于微信进程本身（登录前开着讲述人、
    账号/设备未受限等，社区记录见 pywechat Weixin4.0.md），且**跟进程同生命周期**——
    2026-10-09 19:44 微信重启后整棵树只剩两个 Win32 Pane，连读多次、设读屏标志、
    挂 UIA 事件监听都唤不醒。这种树里没有会话列表、表头、按钮、输入框中的任何一个，
    却带着 WIN 行；当成「有效 UIA」用的后果是：表头恒空 ⇒ 判成「不是目标会话」，
    还跳过了本来能用的帧判据 ⇒ `target_unconfirmed`（2026-10-09 20:33 Loop 那条）。
    """
    return not (data["items"] or data["header"] or data["edits"] or data["btns"]
                or data["mlist"] or data["input"] is not None or data["ctls"])


def _note_uia_blank(tag):
    """空树按进程只记一次指标：每次发送要读好几次 UIA，逐次记会把 metrics 刷屏。"""
    global _UIA_BLANK_NOTED
    if _UIA_BLANK_NOTED:
        return
    _UIA_BLANK_NOTED = True
    _metric("uia_blank", 0, False, {"tag": tag, "detail": "微信未暴露 UIA 控件树，退回帧判据"})


def uia_find_session(data, name):
    """在 UIA 会话列表里找目标行。

    主判据是 AutomationId（`session_item_<显示名>`）——精确、不受预览文字影响；
    认不出再退回显示名模糊匹配（防微信改 id 规则）。找不到返回 None。
    """
    if not data:
        return None
    want = "session_item_" + name
    for it in data["items"]:
        if it["aid"] == want:
            return it
    n = norm(name)
    best = None
    for it in data["items"]:
        disp = it["aid"][len("session_item_"):] if it["aid"].startswith("session_item_") else it["name"]
        r = _session_name_score(n, norm(disp))
        if r > 0.8 and (best is None or r > best[0]):
            best = (r, it)
    return best[1] if best else None


def uia_header_is(data, name):
    """当前打开的会话是不是目标（UIA 的精确表头，不需要 OCR 猜头部）。"""
    if not data or not data.get("header"):
        return False
    hd, n = norm(data["header"]), norm(name)
    return bool(n) and (hd == n or n in hd)


def uia_click_item(h, data, it):
    """点 UIA 给的那一行：用**活几何**，不是帧里的旧坐标。

    注意 `rect` 是 `(x, y, w, h)`（PS 侧发的就是 `BoundingRectangle` 四元组），不是对角点。
    """
    o = _uia_origin(data)
    x, y, w, ht = it["rect"]
    cx, cy = x + w // 2, y + ht // 2
    if not o or not (o[0] <= cx <= o[0] + o[2] and o[1] <= cy <= o[1] + o[3]):
        return False        # 参考系不可信、或行已滚出可视区：点下去会点到别人身上
    pt = _uia_layout(h, data, cx, cy)
    return bool(pt) and post_click(h, *pt)


def uia_input_pt(h, data):
    """消息输入框要点的窗口坐标。

    **输入框不在 UIA 树里**（实测整棵树只有一个 Edit，就是左上角那个搜索框），用同一棵树里
    那个 `发送` 按钮反推：输入框就在它左上方（实测输入框中心 = 按钮中心上方 101px、横向取
    客户区中心；与帧 OCR 推的真值 y 相同、x 差 18px，框宽约 800px 够用）。

    ⚠ 别拿 `chat_message_list` 的底边当锚——那是**随消息内容伸缩**的（同一窗口实测 703 vs 992）。
    """
    o = _uia_origin(data)
    sb = next((b for b in (data or {}).get("btns", []) if (b.get("name") or "").strip() == "发送"), None)
    if not o or not sb:
        return None
    _bx, by, _bw, bh = sb["rect"]
    cy = by + bh // 2 - 101
    if not (o[1] < cy < o[1] + o[3]):
        return None
    return _uia_layout(h, data, o[0] + o[2] // 2, cy)


def open_chat_post(h, name, talker, verbose=False):
    """切到目标会话，全程投递（锁屏也能用）。

    两条路，优先走稳的那条：
    1. **UIA 会话列表**——活状态 + 活几何，窗口被盖住/最小化/收进托盘都准（见 `read_uia`）。
    2. **矢量帧列表**——UIA 拿不到时的兜底（`find_session` 的模糊匹配，受旧帧影响）。

    点完都用「当前会话名」复核，通过才返回。**不再有搜索浮层兜底**：投递进去的搜索词
    微信只会收下、不渲染结果（实测浮层里读到的「候选」全是底下那层会话列表），而这条路的
    代价是劫持剪贴板 + 失败时把浮层留在窗口上——2026-10-09 那次「界面卡住」就是它被补发
    回路每分钟重放一次攒出来的。目标不在列表里就 fail-closed，交给上层排队。
    """
    try:
        d = read_uia(h, "uopen")
        it = uia_find_session(d, name) if d else None
        if it:
            if verbose:
                print(f"[open] UIA 命中「{it['aid'][len('session_item_'):][:16]}」@({it['rect'][0]},{it['rect'][1]})")
            if uia_click_item(h, d, it):
                time.sleep(1.2)
                if uia_header_is(read_uia(h, "uopen2"), name):
                    return True
    except Exception as e:
        if verbose:
            print(f"[open] UIA 路径异常，回退帧路径：{e}")

    ww, wh, lines = read_ui_stable("lst")
    s = find_session(lines, name, ww, wh)
    if s:
        if verbose:
            print(f"[open] 帧列表命中「{s[3][:16]}」@({s[1]},{s[2]})")
        if _post_click_verify(h, s[1], s[2], "lst", name, talker, verbose):
            return True
    return False


def check_env():
    """操作前置检查：微信是否运行 / 主窗口 / 可见 / 已最小化 / 是否前台 / 尺寸·比例 / DPI。

    「验证完成再进行操作」——任何 UI 操作前先跑这个，`ok=False` 就绝不动作。
    """
    info = {"weixin_running": False, "pids": [], "hwnd": 0, "visible": False, "minimized": False,
            "foreground": False, "locked": False, "rect": None, "size": None, "ratio": None, "dpi": None,
            "target_size": [NW, NH], "ok": False, "reason": "", "deps": core.deps()}
    try:                      # 多账号：报告本机账号与当前使用的账号（P2-6）
        info["accounts"] = [a["wxid"] for a in core.list_accounts()]
        info["active_account"] = core.self_wxid()
    except Exception:
        info["accounts"], info["active_account"] = [], None
    pids = weixin_pids()
    info["weixin_running"] = bool(pids)
    info["pids"] = pids
    info["locked"] = session_locked()
    h = find_main_hwnd()
    if not h:
        info["reason"] = ("微信进程在运行，但找不到可见主窗口（可能收进托盘或未登录；"
                          "发送时会先自动还原一次）"
                          if pids else "未检测到微信进程（Weixin.exe 未运行）")
        return info
    info["hwnd"] = h
    info["visible"] = bool(u.IsWindowVisible(h))
    info["minimized"] = bool(u.IsIconic(h))
    info["foreground"] = (int(u.GetForegroundWindow()) == h)
    l, t, w, ht = win_rect(h)
    info["rect"] = [l, t, w, ht]
    info["size"] = [w, ht]
    info["ratio"] = round(w / ht, 3) if ht else None
    try:
        info["dpi"] = int(u.GetDpiForWindow(ctypes.c_void_p(h)))
    except Exception:
        info["dpi"] = None
    if info["locked"]:
        # 最具体的原因先说：锁屏时窗口状态全是"正常"，但一条也发不出去
        info["reason"] = ("电脑已锁屏（锁屏期间模拟键鼠到不了微信；**send_text 走投递、锁屏照发**，"
                          "附件类解锁后发送门自己会恢复）")
    elif not info["visible"]:
        info["reason"] = "主窗口不可见（已收进托盘；发送时会先自动还原一次）"
    elif info["minimized"]:
        info["reason"] = "主窗口已最小化（发送时会先自动还原一次）"
    else:
        info["ok"] = True
    return info


def wake_window(st=None):
    """主窗口最小化 / 被收进托盘时把它还原出来，再复检一遍环境。返回**复检后**的 check_env()。

    为什么发送路径要自己恢复：`check_env` 那道严格闸门是给**报告**用的（如实告诉调用方
    环境如何），但无人值守的代聊回路里「窗口不在 ⇒ 永远发不出去」是死锁——用户
    2026-10-08 实测被它挡了两次（22:33 Loop、22:37 韩玉），而人不在电脑前时窗口本来就
    常是最小化的。恢复只做 `ShowWindow`（不点微信内部任何东西），且**可逆**：
    `Win.__exit__` 本来就会把窗口的位置与尺寸还原。

    **收进托盘（隐藏态）也一起恢复**（用户 2026-10-09 决策「一律自动拉起」）。早先专门
    不强显，怕把用户收起来的微信弹出来打扰他；现在的还原不一样——用 `SW_SHOWNOACTIVATE`
    而不是 `SW_SHOWNA`/`SW_RESTORE`，实测**窗口回来但前台不变**（隐藏态与最小化态各测一次，
    `GetForegroundWindow` 前后同一），也不动光标、不动窗口位置。不还原的代价是那条回复最多
    在补发队列里躺 30 分钟然后被丢掉。

    真的恢复不了的不硬来：微信没运行、或连句柄都拿不到（未登录），照旧拒发。
    """
    st = st or check_env()
    # 窗口本来就可用（visible 且非最小化）就别碰它——锁屏那条理由不是窗口的错，平白动一下没意义
    if st.get("ok") or (st.get("visible") and not st.get("minimized") and st.get("hwnd")):
        return st
    if not st.get("weixin_running"):
        return st
    h = st.get("hwnd") or find_main_hwnd(include_hidden=True)
    if not h:
        return st
    u.ShowWindow(ctypes.c_void_p(h), 4)          # SW_SHOWNOACTIVATE：还原，但不抢前台
    time.sleep(0.7)
    return check_env()


def env_gate(allow_locked=False):
    """发送入口的统一闸门：(ok, st)。窗口最小化 / 收进托盘时先自还原一次再判定。

    allow_locked=True 给**全投递**的文本路径用：锁屏只挡得住 SendInput（模拟键鼠），
    挡不住 PostMessage 投递 —— 实测锁屏下搜索/切会话/输入/发送全通，不该拦。
    附件路径仍用默认的 False：它靠剪贴板 + Ctrl+V，是真的 SendInput，锁屏时够不着。

    ⚠️ 放行只针对**锁屏这一条理由**，不能连「窗口根本读不了」一起放掉：窗口恢复不出来时
    `PrintWindow` 拍出来是空白，投递照样跑不动，却会一路重试到 MCP 客户端超时——而超时不是
    错误码，出站 Provider 归不出 `env_not_ready`、**那条回复就静默没了**（2026-10-09 实测：
    锁屏 + 最小化，send_text 跑满 30.006s 被超时杀掉）。所以逐条要求窗口本身可用。
    """
    st = wake_window()
    win_usable = bool(st.get("visible")) and not st.get("minimized") and bool(st.get("hwnd"))
    if allow_locked and st.get("locked") and win_usable:
        st = dict(st, ok=True)
    return bool(st["ok"]), st


class Win:
    """窗口几何：进入时【前置检查 → 规范化为固定尺寸 → 逐项校验】，退出时还原。"""

    def __init__(self):
        self.h = 0
        self.orig = None

    def __enter__(self):
        st = check_env()
        if not st["ok"]:
            raise RuntimeError(f"前置检查未通过：{st['reason']}")
        self.h = st["hwnd"]
        self.orig = tuple(st["rect"])
        if not bring_to_front(self.h):
            if session_locked():
                # 锁屏时拿不到前台是**必然**的，不是"窗口有问题"——说清楚，别让人去点窗口
                raise RuntimeError("电脑已锁屏：锁屏期间无法模拟键鼠（解锁后会自动补发）")
            raise RuntimeError("微信窗口切不到前台（自动化要求窗口可见且在前台）")
        u.MoveWindow(ctypes.c_void_p(self.h), NX, NY, NW, NH, True)
        time.sleep(0.9)
        self.L, self.T, self.W, self.H = win_rect(self.h)
        # —— 逐项校验「规范化是否真的生效」，任一不符即中止，绝不带着错布局往下做 ——
        if u.IsIconic(ctypes.c_void_p(self.h)):
            raise RuntimeError("窗口仍处于最小化状态")
        if (abs(self.L - NX) > 4 or abs(self.T - NY) > 4
                or abs(self.W - NW) > 8 or abs(self.H - NH) > 8):
            raise RuntimeError(f"窗口规范化失败：实际 {(self.L, self.T, self.W, self.H)}，期望 {(NX, NY, NW, NH)}")
        if int(u.GetForegroundWindow()) != self.h:
            raise RuntimeError("微信窗口不在前台")
        return self

    def __exit__(self, *_a):
        try:
            ol, ot, ow, oh = self.orig
            u.MoveWindow(ctypes.c_void_p(self.h), ol, ot, ow, oh, True)
        except Exception:
            pass

    def click(self, x, y):
        u.SetForegroundWindow(ctypes.c_void_p(self.h))
        time.sleep(0.25)
        u.SetCursorPos(self.L + x, self.T + y)
        time.sleep(0.12)
        u.mouse_event(0x0002, 0, 0, 0, 0)
        time.sleep(0.05)
        u.mouse_event(0x0004, 0, 0, 0, 0)
        time.sleep(0.7)


def _run_ps(script, args, sta=False):
    # UIA（uia_read.ps1）要 -STA：UIAutomationClient 的 COM 在 MTA 线程上对部分 provider
    # 拿不到 pattern。Windows.Media.Ocr（ocr4.ps1）不需要，保持默认少一次切换。
    ps = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass"]
    if sta:
        ps.append("-STA")
    subprocess.run(ps + ["-File", script] + args, capture_output=True, text=True)


# ---- 进程内截图（ctypes GDI → PNG）----
# 为什么不用 shot.ps1：每张截图 spawn 一次 PowerShell 要约 1~2s，一次发送要抓 5~8 张，
# 累计是最大的一处浪费。这里直接抓窗口内容（PrintWindow，见 read_ui），再手写 PNG（零依赖）。
_gdi = ctypes.windll.gdi32


class _BMIH(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]


def _png_from_bgra(buf, w, h):
    import struct
    import zlib
    b = bytearray(buf)
    b[0::4], b[2::4] = b[2::4], b[0::4]          # BGRA -> RGBA（切片赋值在 C 层，够快）
    n = len(b) // 4
    b[3::4] = b"\xff" * n
    stride = w * 4
    raw = b"".join(b"\x00" + bytes(b[y * stride:(y + 1) * stride]) for y in range(h))  # 每行 filter=0

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def read_ui(tag):
    """拍微信主窗口并 OCR。

    用 `PrintWindow(PW_RENDERFULLCONTENT)` 而不是 BitBlt 屏幕区域：只取**这个窗口**的内容，
    所以窗口在后台、被别的窗口盖住、乃至被锁屏盖住时都拍得到（2026-10-09 实测）。
    BitBlt 拍的是屏幕那一块——锁屏时拍回来的是锁屏壁纸，于是 header 读成空、
    被误判成「目标会话未确认」。顺带也不再 `SetForegroundWindow`，读界面不必抢前台。
    """
    h = find_main_hwnd()    # 只认可见窗口：调用方（env_gate / 发送路径）已经还原过一次了
    if not h:
        return 0, 0, []
    _, _, ww, wh = win_rect(h)
    png = os.path.join(core.WORK, f"ui_{tag}.png")
    out = os.path.join(core.WORK, f"ui_{tag}.txt")
    if ww <= 0 or wh <= 0:
        return ww, wh, []
    hdc = u.GetDC(None)
    mem = _gdi.CreateCompatibleDC(hdc)
    bmp = _gdi.CreateCompatibleBitmap(hdc, ww, wh)
    _gdi.SelectObject(mem, bmp)
    ok = u.PrintWindow(ctypes.c_void_p(h), mem, 2)          # 2 = PW_RENDERFULLCONTENT
    bi = _BMIH(ctypes.sizeof(_BMIH), ww, -wh, 1, 32, 0, 0, 0, 0, 0, 0)
    buf = ctypes.create_string_buffer(ww * 4 * wh)
    _gdi.GetDIBits(mem, bmp, 0, wh, buf, ctypes.byref(bi), 0)
    _gdi.DeleteObject(bmp)
    _gdi.DeleteDC(mem)
    u.ReleaseDC(None, hdc)
    if not ok:
        return ww, wh, []          # 拍不到就交空结果让调用方 fail-closed，别拿旧画面糊弄
    open(png, "wb").write(_png_from_bgra(buf.raw, ww, wh))
    _LAST_SHOT["path"] = png
    _run_ps(OCR4, ["-Path", png, "-Out", out])
    lines = []
    try:
        for ln in open(out, encoding="utf-8", errors="replace").read().splitlines():
            q = ln.split("\t")
            if len(q) == 5:
                lines.append((int(q[0]), int(q[1]), int(q[2]), int(q[3]), q[4]))
    except Exception:
        pass
    return ww, wh, lines


def read_ui_stable(tag, tries=4):
    """拍一帧**读得动**的界面，读到就返回；真的抓成空白才重试（或到次数上限）。

    判据是「**OCR 出过东西**」，不是「右侧有内容」：没开会话、开着搜索浮层时聊天区本来就空，
    但左边会话列表还在、字也都读到了——拿 header/chat 当判据会在这两种形态下白等 4 轮
    （每轮 PrintWindow+OCR+0.7s ≈ 2s）。重试预算从没跟 MCP 客户端的 30s 超时对过账：
    实测失败一轮 `send_text` 一路耗到 **29.7s**，离被超时杀掉只差 283ms——而超时不是错误码，
    Provider 归不出 `env_not_ready`，那条回复就静默没了（2026-10-09 实测）。

    空白时**投递**点一下聊天区逼微信重绘——不能用真鼠标（`SetCursorPos` + `mouse_event`）：
    那既违反「不动用户光标」的约定，又会把正开着的搜索浮层点掉（2026-10-09 实测）。
    """
    ww = wh = 0
    lines = []
    for i in range(tries):
        ww, wh, lines = read_ui(f"{tag}{i}")
        if lines:
            return ww, wh, lines
        if i == 0:  # 首轮空白：投递点一下聊天区逼它重绘
            try:
                h = find_main_hwnd()
                if h and ww > 0 and wh > 0:
                    post_click(h, int(ww * 0.55), int(wh * 0.35))
            except Exception:
                pass
        time.sleep(0.7)
    return ww, wh, lines


def norm(s):
    """归一化：只保留字母数字（含 CJK）+ 统一小写。

    小写化是必须的：Windows OCR 对短拉丁词常**全大写输出**（实测把会话名 "Loop"
    读成 "LOOP"），而 difflib 比较区分大小写——"Loop" vs "LOOP" 相似度只有 0.25，
    会让头部匹配（verify_target）与列表查找（find_session）双双误判为「未找到会话」。
    """
    return "".join(ch for ch in s if ch.isalnum()).lower()


def contains_sub(a, b, n=4):
    a, b = norm(a), norm(b)
    if len(a) < n:
        return bool(a) and a in b
    return any(a[i:i + n] in b for i in range(len(a) - n + 1))


def _lcs_len(a, b):
    """a、b 的最长公共子序列长度（对 OCR 误读比子串匹配更宽容）。"""
    if not a or not b:
        return 0
    prev = [0] * (len(b) + 1)
    for ca in a:
        cur = [0] * (len(b) + 1)
        for j, cb in enumerate(b):
            cur[j + 1] = prev[j] + 1 if ca == cb else max(prev[j + 1], cur[j])
        prev = cur
    return prev[-1]


def anchor_exact(anchor, chat):
    """锚点**精确**命中：8 字窗口（归一化已去掉空格/全角噪声）。"""
    na = norm(anchor)
    return len(na) >= 4 and contains_sub(anchor, chat, min(8, len(na)))


def anchor_lcs(anchor, chat):
    """锚点 **LCS 模糊**命中：**高门槛**（≥0.85 且 ≥10 字）。

    ⚠️ 踩过事故：门槛过松（0.7/6 字）时，内容相似的**不同会话**会撞车——
    同一批消息发给两个人后，「微信MCP发送测试」这种 9 字公共前缀会让 A 会话被判定成 B 会话目标，
    导致**发错人**。故宁可漏判（拒绝发送），也不误判。
    """
    na, nc = norm(anchor), norm(chat)
    need = max(10, int(0.85 * len(na)))
    return len(na) >= need and _lcs_len(na, nc) >= need


SESSION_COL = 310        # 会话列表固定宽（不随窗口宽度缩放）
CHAT_BOTTOM_DY = 115     # 聊天区下界 = 「发送」按钮 y − 115（避免漏掉贴底最后一条消息）
INPUT_PT_DY = 95         # 输入框点击 y = 「发送」按钮 y − 95
HEADER_DY = 80           # 聊天头部行的 y1 上界
HEADER_DX = 460          # 头部行 x0 相对 session_right 的最大偏移


def layout(lines, ww, wh, btn_hint=None):
    sess = [(x0, y0, x1, y1, t) for x0, y0, x1, y1, t in lines
            if x0 < SESSION_COL and 40 < y0 < wh * 0.85 and norm(t)]
    session_right = min(max([s[2] for s in sess], default=300) + 8, SESSION_COL)
    # 「发送」按钮只会出现窗口最底部（y≈92% 处）。聊天区长到贴底时，气泡文字会被
    # OCR 出「发送」样样的行（实测 y≈590 的误读也能命中），所以：贴底 8% 以内才算，
    # 且取最靠下的一条；再不可信就退回默认坐标（btn_hint=None 也强制走默认）。
    btns = [(x0, y0, x1, y1, t) for x0, y0, x1, y1, t in lines
            if norm(t).startswith("发送") and y0 > wh * 0.92]
    sb = max(btns, key=lambda b: b[3]) if btns else None
    if btn_hint == "default":
        sb = None
    bx, by = (sb[0], (sb[1] + sb[3]) // 2) if sb else (int(ww * 0.95), int(wh * 0.94))
    hdr = [(x0, y0, x1, y1, t) for x0, y0, x1, y1, t in lines
           if session_right - 25 <= x0 <= session_right + HEADER_DX and y1 < HEADER_DY and norm(t)]
    header = sorted(hdr, key=lambda c: (c[1], c[0]))[0][4] if hdr else ""
    # 聊天区下界：以「发送」按钮为锚（输入框在它上方约 115px），避免漏掉贴底的最后一条消息
    chat_bottom = by - CHAT_BOTTOM_DY
    input_pt = ((max(session_right + 40, bx - 300) + session_right) // 2 + 40, by - INPUT_PT_DY)
    input_region = (session_right + 20, chat_bottom + 5, bx - 60, by + 22)
    chat = " ".join(t for x0, y0, x1, y1, t in sorted(lines, key=lambda c: (c[1], c[0]))
                    if x0 >= session_right - 8 and 60 < y0 < chat_bottom)
    return {"session_right": session_right, "header": header, "send_btn": (bx, by),
            "input_pt": input_pt, "input_region": input_region, "chat_text": chat}


_GRP_PREFIX = re.compile(r"^[A-Za-z0-9_\-@\.]{4,}:\s*\n?")
_XML_TITLE = re.compile(r"<title>(.*?)</title>", re.S)


def _usable_anchors(talker):
    """目标会话可用于校验的文本锚点：排除占位符/整段 XML、剥离群消息前缀、至少 4 字。"""
    out = []
    for m in core.history(talker, 8)["messages"]:
        t = m["text"]
        if t == "[非文本消息]":
            continue
        t = _GRP_PREFIX.sub("", t)
        if t.startswith("<"):  # XML 类消息只取标题作锚点
            mt = _XML_TITLE.search(t)
            if not mt:
                continue
            t = mt.group(1)
        if len(norm(t)) >= 4:
            out.append(t)
    return out


def _member_nick_hits(lines, ly, members):
    """聊天区里「群成员显示名」作为**独立短行**出现的次数（群里「发送者昵称行」的特征）。

    只认**左侧**（对方/群成员消息一侧，x∈[session_right, session_right+260]），
    排除右侧「自己」的消息与页面右侧固定栏——它们不含昵称行、且会造成干扰。
    """
    ms = {norm(m) for m in members if len(norm(m)) >= 2}
    if not ms:
        return 0
    left = ly["session_right"] + 8
    right = left + 260
    n = 0
    for x0, y0, _x1, _y1, t in lines:
        if not (left <= x0 <= right and 60 < y0):
            continue
        nt = norm(t)
        if 2 <= len(nt) <= 20 and nt in ms:
            n += 1
    return n


def _header_distinguishes_target(hn, hr, talker):
    """只凭「聊天头部」放行**安全**吗——即头部真的在区分目标与别人。

    不安全 = 有**别的会话**名字与头部吻合得不比目标差：那时头部不含任何区分信息。
    本机实测有三个 `loop`（不同 wxid、显示名归一后相同），拿 `Loop` 当目标时头部只会照出
    「loop」——凭它放行等于抽签发错人。反过来「两河10组村民群」目标 + 真开着的
    「两河10组村民群2」也会被这条挡住（那个名字对头部的吻合度只会更高）——正是要的拒绝。
    """
    if not hn:
        return False
    for u, d in core.names().items():
        if u == talker or not d:
            continue
        if difflib.SequenceMatcher(None, norm(d), hn).ratio() >= max(0.85, hr - 0.05):
            return False
    return True


def verify_target(talker, name, lines, ww, wh, verbose=False):
    """目标会话校验。**判据从紧**——错判 = 发错人。

    通过条件（按强度）：
    ⓪ **反证**（通用）：聊天头部明显更像**别的会话**（而非目标）⇒ 判定为「开错了会话」，直接拒绝。
       这一条专门堵历史事故根因——「同批内容发过多个会话」会让内容锚点撞车（锚点相同），
       但**头部必然不同**；用「头部更像谁」一票否决，比只看锚点稳得多。
    ⓪′ **群结构**（P2-4）：目标是群、且聊天区出现**群成员昵称独立行** ⇒ 确认是群（第三重印证）。
    ① 内容锚点命中 **且** 聊天头部与目标名吻合（hr≥0.5）。
    ② 内容锚点命中 **≥2 个**（头部 OCR 全花时的兜底）。
    ③ **很强**且**能区分是谁**的头部匹配（hr>0.85 且没有别的会话名字同样吻合）。
       锚点缺位**不构成否决**（2026-10-09：聊天区 OCR 读花长锚点是常态，命中数会随机翻转）。
    """
    ly = layout(lines, ww, wh)
    header, chat = ly["header"], ly["chat_text"]
    hn, nn = norm(header), norm(name) if name else ""
    hr = difflib.SequenceMatcher(None, nn, hn).ratio() if nn and hn else 0.0
    usable = _usable_anchors(talker)
    hits = sum(1 for t in usable if anchor_exact(t, chat) or anchor_lcs(t, chat))

    # ⓪ 反证：头部更像**别的会话** ⇒ 拒绝（宁可拒绝，不许盲发）
    if hn:
        others = [d for u, d in core.names().items() if u != talker and d]
        other_hr = max((difflib.SequenceMatcher(None, norm(d), hn).ratio() for d in others), default=0.0)
        if verbose:
            print(f"[verify] header「{header[:16]}」目标hr={hr:.2f} 别家最高hr={other_hr:.2f} 锚点{len(usable)}命中{hits}")
        if other_hr >= 0.6 and other_hr > hr + 0.15:
            return False, "头部更像其它会话(疑为开错会话)"

    # ⓪′ 群结构（P2-4）：目标是群 + 聊天区出现成员昵称独立行 ⇒ 确认是群
    if str(talker).endswith("@chatroom"):
        members = core.group_members(talker)
        if _member_nick_hits(lines, ly, members):
            return True, "群结构"

    if hits >= 1 and hr >= 0.5:
        return True, "消息"
    if hits >= 2:
        return True, "消息x2"
    # ③ 头部**能独立区分是谁**时放行——不再要求「没有够长的锚点」。
    #    这一档原是 2026-10-08 加的：短锚点靠 anchor_exact，OCR 读花一个字就整体失效
    #    （实测「你在干嘛？」→「你在干雨7」⇒ 4 字锚点全灭），那时若还拿「有锚点」否决头部，
    #    白名单里的人会永远发不出去。当时的让步只开到「锚点都短」为止，长锚点仍一票否决，
    #    理由是「够长的锚点真能证伪」。
    #
    #    ⚠️ 那条理由实测不成立（2026-10-09）：聊天区 OCR 烂到中文也读花，长锚点照样命中不了
    #    ——同一句「全链实测」读成「金链妄测」、「后台」读成「启台」。于是命中数在**同一个操作上
    #    随机翻转**：12:24 那次 `锚点8命中3` 放行，13:06 同一条链 `锚点8命中0` 否决（现场帧
    #    `ui_lstv0.txt` 里目标会话明明开着、header hr=1.00）。一个随 OCR 运气翻转的门禁，
    #    挡不住错发（它否决的是**读不清**，不是**不对**），却让回复常态性地进补发队列。
    #    历史那次事故（同批内容发多人 ⇒ 锚点撞车）本身由 ⓪「头部更像谁就否决」+ 下面这条
    #    「有没有别人跟头部一样像」独立覆盖，不依赖锚点。
    #    锚点仍按 ①② 加分（命中≥1 且 hr≥0.5 就够，比这档更宽），只是**不再能否决**。
    if hr > 0.85 and _header_distinguishes_target(hn, hr, talker):
        return True, "标题"
    return False, "-"


def _session_name_score(n, nt):
    """会话列表 OCR 行与目标显示名的吻合分。

    精确名必须压过「群名里嵌短名」（实测 `杨冬` vs `严子云。、杨冬`：旧逻辑子串一律抬到
    0.95，列表路会点进群聊，verify_target 过不了 ⇒ `target_unconfirmed`）。
    """
    if not nt:
        return 0.0
    if nt == n:
        return 1.0
    r = difflib.SequenceMatcher(None, n, nt).ratio()
    if n and n in nt and nt != n:
        r = max(r, 0.82)
    elif n and nt in n and nt != n:
        r = max(r, 0.82)
    return r


def find_session(lines, name, ww, wh):
    n = norm(name)
    best = None
    for x0, y0, x1, y1, t in lines:
        # 下界用整窗高度而不是 wh*0.85：会话列（x<SESSION_COL）从 y=40 一直排到窗口底部，
        # 卡在 85% 会把**最后两行**会话滤掉——实测「文件传输助手」在 y≈747/wh=820 时被滤，
        # 于是列表路找不到目标、只能退搜索，锁屏下整条链就断在这儿（2026-10-09）。
        if x0 < SESSION_COL and 40 < y0 < wh - 8:
            nt = norm(t)
            r = _session_name_score(n, nt)
            if r <= 0.55:
                continue
            cand = (r, (x0 + x1) // 2, (y0 + y1) // 2, t, len(nt))
            if best is None or cand[0] > best[0] or (cand[0] == best[0] and cand[4] < best[4]):
                best = cand
    if not best:
        return None
    return best[0], best[1], best[2], best[3]


def open_chat(name, talker, win, verbose=False, attempts=2):
    for i in range(attempts):
        ww, wh, lines = read_ui_stable(f"open{i}")
        s = find_session(lines, name, ww, wh)
        if not s:
            time.sleep(0.8)
            continue
        if verbose:
            print(f"[open] 点击「{s[3][:16]}」@({s[1]},{s[2]})")
        win.click(s[1], s[2])
        time.sleep(1.1)
        ww, wh, lines2 = read_ui_stable(f"open{i}b")
        if verify_target(talker, name, lines2, ww, wh)[0]:
            return True
    return False


def open_chat_via_search(name, talker, win, verbose=False):
    """兜底开法：用**微信自带搜索**打开会话。

    会话列表里的名字全靠 OCR（小字、易读花，实测「测试微信群」被读成「测满启群」），
    而搜索是我们**输入**名字、微信自己模糊匹配——不依赖 OCR，稳得多。
    打开后仍由 verify_target 把关（含头部 + 锚点，失败即拒绝）。
    """
    for attempt in range(2):
        win.click(600, 400)          # 点聊天区让微信吃键盘焦点
        time.sleep(0.4)
        ctrl(0x46)                   # Ctrl+F 搜索
        time.sleep(1.0)
        ctrl(0x41)
        press(0x2E)                  # 清空搜索框
        time.sleep(0.2)
        # 同样用粘贴代替键入：名字里带标点时逐字注入会被吞字（见 _clip_set_text）
        if _clip_set_text(name):
            time.sleep(0.15)
            ctrl(0x56)
        else:
            type_text(name)
        time.sleep(1.4)
        press(0x0D)                  # 回车打开首条结果
        time.sleep(1.5)
        ww, wh, lines = read_ui_stable(f"srch{attempt}")
        ok, _why = verify_target(talker, name, lines, ww, wh, verbose)
        if ok:
            if verbose:
                print("[open] 搜索打开并校验通过")
            return True
    return False



# ---- 跨进程互斥：一次只允许一个 UI 操作（两个回合同时抢微信窗口会互相破坏）----
import msvcrt  # noqa: E402

_LOCK_PATH = os.path.join(core.WORK, "ui.lock")
_METRICS = os.path.join(core.WORK, "metrics.jsonl")
_LAST_SHOT = {"path": None}


def last_shot():
    """最近一次截图路径（失败现场取证用）。"""
    return _LAST_SHOT["path"]


def _metric(op, ms, ok, extra=None):
    """记录一次操作的耗时/结果，供「准确·稳定·快速」量化。"""
    try:
        rec = {"ts": time.time(), "op": op, "ms": int(ms), "ok": bool(ok)}
        if extra:
            rec.update(extra)
        with open(_METRICS, "a", encoding="utf-8") as f:
            f.write(__import__("json").dumps(rec, ensure_ascii=False) + chr(10))
    except Exception:
        pass


def _acquire_ui(timeout=90):
    """尝试独占 UI。拿不到返回 None（调用方据此返回 busy）。"""
    try:
        fh = open(_LOCK_PATH, "a+")
    except Exception:
        return None
    t0 = time.time()
    while True:
        try:
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            return fh
        except OSError:
            if time.time() - t0 > timeout:
                fh.close()
                return None
            time.sleep(0.5)


def _release_ui(fh):
    try:
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
    except Exception:
        pass
    try:
        fh.close()
    except Exception:
        pass


def send_text(text, talker, name=None, dry_run=True, verbose=False):
    """发送文本。返回 (ok, detail)。

    走**全投递**路径（PostMessage）：不抢前台、不碰鼠标键盘、不劫持剪贴板，锁屏下同样可用。
    前置闸门只剩 `env_gate(allow_locked=True)`：微信是否运行 / 主窗口可用（最小化或收进托盘时先自还原一次）。
    之后是「目标校验 → 输入落地 → 发送生效（读库）」三道动作校验，任一不过即中止、绝不盲发。
    send_file 已改成同一条投递路（点「发送文件」+ 驱动文件对话框，见下节）；reply_to 仍走
    `Win()` + 模拟键鼠，需要前台。
    """
    if not name:
        name = core.names().get(talker, talker)
    env_ok, st = env_gate(allow_locked=True)   # 文本走投递，锁屏也能发
    if not env_ok:
        return False, f"环境前置检查未通过：{st['reason']}（微信运行={st['weixin_running']}，可见={st['visible']}，最小化={st['minimized']}）"
    lk = _acquire_ui()
    if lk is None:
        return False, "另一个微信操作正在进行，请稍后重试（busy）"
    _t0 = time.time()
    try:
        _ok, _d = _send_locked(text, talker, name, dry_run, verbose)
        _metric("send_text", (time.time() - _t0) * 1000, _ok, {"dry_run": bool(dry_run), "detail": _d[:60]})
        return _ok, _d
    except RuntimeError as e:
        return False, f"窗口前置检查未通过：{e}"
    finally:
        _release_ui(lk)


def _give_back_foreground(wechat_h, prev_fg):
    """把前台还给用户。

    投递字符会让微信**自己**跳到前台（Qt 收到输入消息时的自激活，实测 0.1–0.3 秒内发生），
    投递完必须还回去，否则用户正要敲的字会落进微信输入框、被随后的回车一起发出去。
    锁屏时前台是 LockApp、微信抢不上去，这一步是无害的空转。
    """
    try:
        if prev_fg and prev_fg != wechat_h and int(u.GetForegroundWindow()) == wechat_h:
            u.SetForegroundWindow(ctypes.c_void_p(prev_fg))
    except Exception:
        pass


def _send_locked(text, talker, name, dry_run, verbose):
    """全投递发送：不抢前台、不碰鼠标键盘、不劫持剪贴板，锁屏下同样可用。

    三道安全网不变（目标校验 → 发送 → 读库确认），只是执行手段从 SendInput 换成了
    PostMessage。fail-closed：任一步不成立即返回失败，由上层排队重试。
    发送生效校验改为**发完读库**——那本就是最后一道，且不像剪贴板回读那样需要前台。
    **不动窗口**（原先每次发送都把微信 MoveWindow 到 1280×820 再还原，那本身就是打扰）：
    只有 `Win()` 那条前台老路需要规范化尺寸，投递路的坐标现在来自 UIA 活几何。
    """
    h = find_main_hwnd()    # 走到这儿窗口必然可见：上面的 env_gate 已经还原过（含收进托盘那种）
    if not h:
        return False, "找不到微信主窗口"
    prev_fg = int(u.GetForegroundWindow())
    return _send_locked_body(h, text, talker, name, dry_run, verbose, prev_fg)


def _send_locked_body(h, text, talker, name, dry_run, verbose, prev_fg):
    # 目标校验优先用 UIA 的**活表头**（`current_chat_name_label`，精确文本）：这是唯一不受
    # 旧帧影响的判据。窗口被盖住时帧里的会话列表和头部都是几分钟前的，用它校验正是那些
    # `target_unconfirmed` 的来路。UIA 拿不到才退回帧判据，两路都不做反向放行。
    # 「拿不到」**并不罕见**：微信 4.x 不暴露控件树时 read_uia 返回 None（见 `_uia_tree_blank`），
    # 此时整条发送都靠帧判据——这正是那次 20:34 补发成功走的路。
    d = read_uia(h, "s0")
    if d:
        ok = uia_header_is(d, name)
    else:
        ww, wh, lines = read_ui_stable("s0")
        ok, _why = verify_target(talker, name, lines, ww, wh, verbose)
    if not ok:
        ok = open_chat_post(h, name, talker, verbose)
        if ok:
            d = read_uia(h, "s1")     # 切完重读：下面点输入框要用切换后的活几何
    if not ok:
        return False, "目标会话未确认（fail-closed）"
    if dry_run:
        return True, "dry-run：已验证目标会话，未输入未发送"
    base_ts = _talker_latest_ts(talker)   # 发送后据此**读库确认**真的落到目标会话

    # 投递点击输入框：尽力把焦点摆过去。微信切会话时会自动 focus 输入框，这里是兜底；
    # 焦点若真在别处，投递的字符会落空 —— 下面的读库校验会把它拦成失败，不会盲发。
    ip = uia_input_pt(h, d) if d else None
    if not ip:
        ww, wh, lines = read_ui_stable("s1")
        ip = layout(lines, ww, wh)["input_pt"]
    post_click(h, *ip)
    time.sleep(0.4)
    ok, why = clear_input(h, (d or {}).get("input"))   # 残留（用户草稿/上次失败留下的）会被回车一起发出去
    if not ok:
        _give_back_foreground(h, prev_fg)   # 退格也是输入消息，微信可能已经自己跳到前台了
        return False, why
    if not post_text(h, text):
        _give_back_foreground(h, prev_fg)
        return False, "投递输入失败（PostMessage 未送达）"
    time.sleep(0.6)
    # 回车前**读回框里到底有什么**：投递是逐字 WM_CHAR，丢字/落空都不报错（`post_text` 只看
    # PostMessage 的返回值，而它基本恒真）。读不到就不拦（别把"读不到"变成"发不出去"），
    # 读到了但混进正文之外的东西就中止——那正是「残留跟着一起发出去」的那个事故。
    got = (read_uia(h, "s2") or {}).get("input")
    if got is not None:
        res = "".join(_residue(got, text))
        if res:
            _give_back_foreground(h, prev_fg)
            return False, f"输入框未清空（正文之外还有残留 {len(res)} 字，fail-closed）"
    post_key(h, VK_RETURN)
    _give_back_foreground(h, prev_fg)
    time.sleep(1.0)
    # 最后一道：**读库确认**新消息真的落在目标会话（防「看着发出去了、其实发到别处」）
    if not _wait_new_message(talker, base_ts):
        return False, "已回车但目标会话未见新消息（可能发到了别处或未生效）"
    return True, "已发送"



# ============================================================================
# 附件发送（图片 / 文件 / 视频 / 音频）——「工具栏 → 文件对话框 → 回车」
# ----------------------------------------------------------------------------
# 老路是「剪贴板粘贴 + 回车」（放 CF_DIB/CF_HDROP 进剪贴板、Ctrl+V、真鼠标点输入框），
# 它要三样打扰：劫持用户的剪贴板、把窗口搬到固定尺寸（MoveWindow）、挪用户的光标。
#
# 新路三样都不要（2026-10-09 真机实测：全程前台没变、窗口没动、光标没动、剪贴板没碰）：
#   1. 投递点击工具栏的「发送文件」→ 微信自己弹出**标准** `#32770 '选择文件'`（不抢前台）
#   2. UIA `-All` 读那个对话框，拿控件的 **NativeWindowHandle**
#   3. `WM_SETTEXT` 把路径写进文件名框、`BM_CLICK` 点「打开」→ 附件进输入框 → 投递回车
# 为什么必须走控件消息而不是投递按键：**投递的组合键在 Qt 微信上无效**（Qt 读的是真实键盘
# 状态，实测 Ctrl+A/C/V 全不通），所以对话框填不了、输入框也没法「全选删除」。
# 实测 `WM_SETTEXT`/`BM_CLICK` 能跨进程（这两个是系统消息，Windows 替我们做参数 marshal），
# 回读文件名框可验证写入生效——不必注入、不必模拟键鼠。
# 语音仍不支持：微信语音是「按住录音」，只能把音频文件当附件发。
# ============================================================================

WM_SETTEXT, WM_GETTEXT, WM_CLOSE, BM_CLICK = 0x000C, 0x000D, 0x0010, 0x00F5
# 独立的 WinDLL 句柄：要给 SendMessageW 声明 argtypes（不然 64 位指针会被按 int 截断），
# 声明在共享的 windll.user32 上会波及别的调用点。
_u32 = ctypes.WinDLL("user32", use_last_error=True)
_u32.SendMessageW.argtypes = [wintypes.HWND, ctypes.c_uint, ctypes.c_size_t, ctypes.c_void_p]
_u32.SendMessageW.restype = ctypes.c_ssize_t


def _dlg_set_text(hwnd, text):
    _u32.SendMessageW(ctypes.c_void_p(hwnd), WM_SETTEXT, 0, ctypes.c_wchar_p(text))


def _dlg_get_text(hwnd, n=1024):
    buf = ctypes.create_unicode_buffer(n)
    _u32.SendMessageW(ctypes.c_void_p(hwnd), WM_GETTEXT, n, buf)
    return buf.value


def _weixin_dialog(pids, klass="#32770"):
    """微信进程名下类名为 klass 的顶层窗口句柄（标准对话框）。"""
    out = []

    def cb(h, _l):
        pid = ctypes.c_ulong()
        u.GetWindowThreadProcessId(h, ctypes.byref(pid))
        if pid.value in pids:
            b = ctypes.create_unicode_buffer(64)
            u.GetClassNameW(h, b, 64)
            if b.value == klass:
                out.append(int(h or 0))
        return True

    u.EnumWindows(EnumProc(cb), None)
    return out


def _dlg_pick(ctls, want):
    return next((c for c in ctls if want(c)), None)


def _dlg_fill_and_open(dlg, path, verbose=False):
    """把 path 填进已经弹出的文件对话框并点「打开」。返回 (ok, detail)。

    控件是**异步就绪**的：刚出现时 UIA 树还没建好，读出来是空的/报错（实测锁屏下更慢），
    所以轮询到「文件名框 + 打开按钮」都在为止，别拿第一次读的结果当终态。
    """
    # 控件按 AutomationId 认：文件名框 1148、打开按钮 1（经典对话框的固定 id）。
    # 名字里必须带「打开/Open」——**不能只认 aid "1"**：文件列表项的 aid 也可能是 "1"，
    # 实测误点过（点到文件列表上，对话框不关）。
    box = opn = None
    ctls = []
    base = os.path.basename(path).lower()
    t0 = time.time()
    while time.time() - t0 < 8:
        ctls = (read_uia(dlg, "dlg", all_ctls=True) or {}).get("ctls") or []
        box = _dlg_pick(ctls, lambda c: c["aid"] == "1148" and c["nwh"]) or \
            _dlg_pick(ctls, lambda c: c["type"] == "Edit" and c["nwh"] and not c["aid"].startswith("System."))
        opn = _dlg_pick(ctls, lambda c: c["aid"] == "1" and c["nwh"] and "打开" in c["name"]) or \
            _dlg_pick(ctls, lambda c: c["nwh"] and ("打开" in c["name"] or "Open" in c["name"]))
        if box and opn:
            break
        time.sleep(0.6)
    if not box or not opn:
        return False, (f"文件对话框控件不全（文件名框={bool(box)} 打开={bool(opn)} "
                       f"控件数={len(ctls)}，fail-closed）")
    # aid 1148 一次能命中好几个（外层 ComboBox 与内层 Edit 同 id 同矩形），挑哪个不靠猜：
    # 挨个写，**以回读为准**——写不进去就别点「打开」（那是空点，发出去的是上一个文件名）。
    for cand in [box] + [c for c in ctls if c["nwh"] and c["aid"] == "1148" and c is not box]:
        _dlg_set_text(cand["nwh"], path)
        time.sleep(0.3)
        if base in _dlg_get_text(cand["nwh"]).lower():
            if verbose:
                print(f"[attach] 对话框 {dlg} 文件名框={cand['nwh']} 打开={opn['nwh']}")
            box = cand
            break
    else:
        return False, "路径没写进文件对话框（回读对不上，fail-closed）"
    _u32.SendMessageW(ctypes.c_void_p(opn["nwh"]), BM_CLICK, 0, 0)
    t0 = time.time()                             # 对话框消失 = 微信收下了这个文件
    while time.time() - t0 < 8:
        if not u.IsWindow(ctypes.c_void_p(dlg)):
            return True, "附件已进输入框"
        time.sleep(0.4)
    return False, "点了「打开」但文件对话框没关（fail-closed）"


def _attach_via_dialog(h, path, verbose=False):
    """投递点「发送文件」→ 驱动弹出的文件对话框。返回 (ok, detail)。"""
    pids = set(weixin_pids())
    before = set(_weixin_dialog(pids))
    d = read_uia(h, "at0")
    btn = next((b for b in (d or {}).get("btns", []) if "发送文件" in b["name"]), None)
    if not btn:
        return False, "没找到工具栏的「发送文件」按钮（fail-closed）"
    bx, by, bw, bh = btn["rect"]
    p = _uia_layout(h, d, bx + bw // 2, by + bh // 2)
    if not p:
        return False, "UIA 参考系拿不到（fail-closed）"
    post_click(h, *p)
    dlg = 0
    t0 = time.time()
    while time.time() - t0 < 10:
        time.sleep(0.5)
        new = [w for w in _weixin_dialog(pids) if w not in before]
        if new:
            dlg = new[0]
            break
    if not dlg:
        return False, "点了「发送文件」但文件对话框没出现（fail-closed）"
    try:
        return _dlg_fill_and_open(dlg, path, verbose)
    finally:
        if u.IsWindow(ctypes.c_void_p(dlg)):     # 失败时别把对话框留在用户屏幕上
            u.PostMessageW(ctypes.c_void_p(dlg), WM_CLOSE, 0, 0)
            time.sleep(0.5)


def _talker_latest_ts(talker):
    try:
        msgs = core.history(talker, 1).get("messages") or []
        return msgs[-1]["ts"] if msgs else 0
    except Exception:
        return 0


def _wait_new_message(talker, since_ts, timeout=25):
    """轮询目标会话是否出现比 since_ts 更新的消息（微信落库有延迟）。"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(2.5)
        try:
            msgs = core.history(talker, 3).get("messages") or []
            if any(m["ts"] > since_ts for m in msgs):
                return True
        except Exception:
            pass
    return False


def send_attachment(path, talker, name=None, dry_run=True, verbose=False):
    """发送一个图片 / 文件 / 视频 / 音频文件。返回 (ok, detail)。

    全投递路径（见本节头注释）：不抢前台、不碰鼠标键盘、不劫持剪贴板、不搬窗口，锁屏下同样可用。
    闸门与文本路径同一套：环境 → 目标会话（UIA 活表头）→ 清空输入框 → 附件进输入框（对话框
    消失）→ 回车 → **读库确认**，任一不过即中止、绝不盲发。
    dry_run 只校验目标会话就收手（不像老路那样先把附件粘进输入框）。
    """
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        return False, f"文件不存在：{path}"
    if not name:
        name = core.names().get(talker, talker)
    env_ok, st = env_gate(allow_locked=True)   # 投递路，锁屏也能发
    if not env_ok:
        return False, f"环境前置检查未通过：{st['reason']}"
    lk = _acquire_ui()
    if lk is None:
        return False, "另一个微信操作正在进行，请稍后重试（busy）"
    _t0 = time.time()
    _ok, _d = False, ""
    try:
        h = find_main_hwnd()
        if not h:
            return False, "找不到微信主窗口"
        prev_fg = int(u.GetForegroundWindow())
        d = read_uia(h, "af0")
        ok = uia_header_is(d, name) if d else False
        if not ok:
            ok = open_chat_post(h, name, talker, verbose)
            if ok:
                d = read_uia(h, "af1")          # 切完重读：下面点输入框要用切换后的活几何
        if not ok:
            return False, "目标会话未确认（fail-closed）"
        if dry_run:
            return True, "dry-run：已验证目标会话，未发送附件"
        base_ts = _talker_latest_ts(talker)
        # 先点输入框再清空：投递的按键落在**当前有焦点的控件**上，而切会话若走的是搜索框
        # （`open_chat_via_search`），焦点还在搜索框里，那几下退格会去删搜索词。
        ip = uia_input_pt(h, d) if d else None
        if ip:
            post_click(h, *ip)
            time.sleep(0.4)
        ok, why = clear_input(h, (d or {}).get("input"))   # 残留会跟附件一起发出去
        if not ok:
            return False, why
        _ok, _d = _attach_via_dialog(h, path, verbose)
        if not _ok:
            return False, _d
        post_key(h, VK_RETURN)
        _give_back_foreground(h, prev_fg)
        time.sleep(1.5)
        _ok = _wait_new_message(talker, base_ts)
        _d = "已发送" if _ok else "已回车但目标会话未见新消息（可能发到了别处或未生效）"
        return _ok, _d
    except RuntimeError as e:
        _ok, _d = False, f"窗口前置检查未通过：{e}"
        return _ok, _d
    finally:
        _metric("send_file", (time.time() - _t0) * 1000, _ok, {"path": os.path.basename(path)})
        _release_ui(lk)


# ============================================================================
# 引用回复（P2-2）——「右键消息 → 菜单选『引用』 → 输入正文 → 发送」
# ----------------------------------------------------------------------------
# 微信的右键菜单是**独立弹窗**，且常**超出主窗口矩形**；同时是小字号、原生分辨率 OCR 才稳。
# 因此菜单必须按**屏幕区域**抓（不能只抓窗口矩形），并在 OCR 结果里找「引用」项点击。
# 实测菜单项顺序：复制/放大阅读/翻译/搜一搜/转发/收藏/多选/提醒/**引用**/置顶/删除。
# ============================================================================

def _grab_rect(l, t, w, h, path):
    """抓屏幕任意矩形并存 PNG（右键菜单超出窗口矩形，必须按屏幕区域抓）。"""
    if w <= 0 or h <= 0:
        return False
    hdc = u.GetDC(None)
    mem = _gdi.CreateCompatibleDC(hdc)
    bmp = _gdi.CreateCompatibleBitmap(hdc, w, h)
    _gdi.SelectObject(mem, bmp)
    ok = _gdi.BitBlt(mem, 0, 0, w, h, hdc, l, t, 0x00CC0020)
    bi = _BMIH(ctypes.sizeof(_BMIH), w, -h, 1, 32, 0, 0, 0, 0, 0, 0)
    buf = ctypes.create_string_buffer(w * 4 * h)
    _gdi.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), 0)
    _gdi.DeleteObject(bmp)
    _gdi.DeleteDC(mem)
    u.ReleaseDC(None, hdc)
    if not ok:
        return False
    open(path, "wb").write(_png_from_bgra(buf.raw, w, h))
    return True


def _ocr_rect(l, t, w, h, tag):
    """抓屏幕矩形并 OCR，返回**屏幕坐标**的行 [(x0,y0,x1,y1,text)]。"""
    png = os.path.join(core.WORK, f"rect_{tag}.png")
    out = png + ".txt"
    if not _grab_rect(l, t, w, h, png):
        return []
    _run_ps(OCR4, ["-Path", png, "-Out", out])
    lines = []
    try:
        for ln in open(out, encoding="utf-8", errors="replace").read().splitlines():
            q = ln.split("\t")
            if len(q) == 5:
                lines.append((int(q[0]) + l, int(q[1]) + t, int(q[2]) + l, int(q[3]) + t, q[4]))
    except Exception:
        pass
    return lines


def _rclick(sx, sy):
    u.SetCursorPos(int(sx), int(sy))
    time.sleep(0.2)
    u.mouse_event(0x0008, 0, 0, 0, 0)
    time.sleep(0.05)
    u.mouse_event(0x0010, 0, 0, 0, 0)


def _lclick(sx, sy):
    u.SetCursorPos(int(sx), int(sy))
    time.sleep(0.15)
    u.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.05)
    u.mouse_event(0x0004, 0, 0, 0, 0)


def _find_message(lines, ly, quote):
    """在聊天区找要引用的那条消息（按含 quote 的行；取最靠下=最新的一条）。"""
    nq = norm(quote)
    if len(nq) < 2:
        return None
    bottom = ly["send_btn"][1] - CHAT_BOTTOM_DY
    best = None
    for x0, y0, x1, y1, t in lines:
        if x0 < ly["session_right"] or y0 < 60 or y0 > bottom:
            continue
        nt = norm(t)
        if len(nt) < 2:
            continue
        if nq in nt or nt in nq or difflib.SequenceMatcher(None, nq, nt).ratio() >= 0.6:
            if best is None or y0 > best[1]:
                best = (x0, y0, x1, y1, t)
    return best


def reply_text(quote, text, talker, name=None, dry_run=True, verbose=False):
    """引用回复：引用聊天区含 `quote` 的那条消息，再发出 `text`。返回 (ok, detail)。

    `quote` 用于**定位要引用的消息**（取聊天区里含该文字的最新一条）。
    前置闸门与 send_text 相同（环境 → 目标会话 → 消息定位 → 菜单引用 → 输入落地 → 读库确认）。
    """
    if not name:
        name = core.names().get(talker, talker)
    if not quote:
        return False, "quote 为空：给出要引用消息的文字（用于定位）"
    env_ok, st = env_gate()
    if not env_ok:
        return False, f"环境前置检查未通过：{st['reason']}"
    lk = _acquire_ui()
    if lk is None:
        return False, "另一个微信操作正在进行，请稍后重试（busy）"
    _t0 = time.time()
    try:
        _ok, _d = _reply_locked(quote, text, talker, name, dry_run, verbose)
        _metric("reply_text", (time.time() - _t0) * 1000, _ok, {"dry_run": bool(dry_run), "detail": _d[:60]})
        return _ok, _d
    except RuntimeError as e:
        return False, f"窗口前置检查未通过：{e}"
    finally:
        _release_ui(lk)


def _reply_locked(quote, text, talker, name, dry_run, verbose):
    with Win() as win:
        ww, wh, lines = read_ui_stable("q0")
        if not verify_target(talker, name, lines, ww, wh, verbose)[0]:
            if not (open_chat(name, talker, win, verbose) or open_chat_via_search(name, talker, win, verbose)):
                return False, "目标会话未确认（fail-closed）"
        ww, wh, lines = read_ui_stable("q1")
        ly = layout(lines, ww, wh)
        # 先清空输入框，避免残留正文混进引用回复
        win.click(*ly["input_pt"])
        ctrl(0x41)
        time.sleep(0.15)
        press(0x2E)
        time.sleep(0.3)
        # 1) 定位要引用的消息
        m = _find_message(lines, ly, quote)
        if not m:
            return False, f"聊天区未找到要引用的消息（quote=「{quote[:16]}」）"
        mx, my = (m[0] + m[2]) // 2, (m[1] + m[3]) // 2
        if verbose:
            print(f"[reply] 右键「{m[4][:16]}」@win({mx},{my})")
        L, T = win.L, win.T
        # 2) 右键 → 屏幕区域 OCR 找「引用」
        item = None
        for attempt in range(2):
            _rclick(L + mx, T + my)
            time.sleep(1.2)
            menu = _ocr_rect(L + mx - 220, T + my - 40, 620, 720, f"menu{attempt}")
            item = next((c for c in menu if "引用" in norm(c[4])), None)
            if item:
                break
            _lclick(L + int(ww * 0.5), T + int(wh * 0.3))   # 关掉误开的菜单再重试
            time.sleep(0.5)
        if not item:
            _lclick(L + int(ww * 0.5), T + int(wh * 0.3))
            return False, "右键菜单里未找到「引用」（fail-closed）"
        if verbose:
            print(f"[reply] 点「引用」@screen({(item[0]+item[2])//2},{(item[1]+item[3])//2})")
        _lclick((item[0] + item[2]) // 2, (item[1] + item[3]) // 2)
        time.sleep(1.0)
        # 3) 输入正文（点输入框后**粘贴**，保留引用条；不 Ctrl+A/Del——引用条不能删）
        ww, wh, l2 = read_ui_stable("q2")
        win.click(*layout(l2, ww, wh)["input_pt"])
        time.sleep(0.3)
        if not _clip_set_text(text):
            return False, "剪贴板写入失败（fail-closed）"
        time.sleep(0.15)
        ctrl(0x56)
        time.sleep(0.8)
        # 落地校验走剪贴板回读：此时输入框 = 引用条 + 正文，复制回来的文本里含正文即可
        if not contains_sub(text, _composer_copy_all(), 4):
            ctrl(0x41)
            press(0x2E)
            return False, "输入未落地（fail-closed）"
        if dry_run:
            ctrl(0x41)
            press(0x2E)
            return True, "dry-run：已引用并填入、未发送"
        base_ts = _talker_latest_ts(talker)
        press(0x0D)
        time.sleep(1.2)
        if not _wait_new_message(talker, base_ts):
            return False, "已回车但目标会话未见新消息（可能未生效）"
        return True, "已发送（引用回复）"
