"""wechat_sender —— 微信 4.x「零注入」发送（OCR 定位 + SendInput），fail-closed。

安全模型（任一道不通过即中止，绝不盲发）：
1. 固定窗口几何（MoveWindow 到 1280x820），消除尺寸漂移；结束还原。
2. 目标校验（主证据 = 数据库锚点）：聊天区可见文本须命中「目标会话最近消息」，
   避免发错会话；无可用消息时仅接受很强（ratio>0.85）的头部匹配兜底。
3. 输入落地校验：键入后 OCR 输入区，确认文字确实进了输入框。
4. 发送成功校验：发完确认输入框已清空（微信发出会清空），未清空改点按钮、再不行判失败。

不发消息时不触碰微信窗口（dry_run 只到「输入落地」为止并清空）。
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
SHOT = os.path.join(HERE, "shot.ps1")
OCR4 = os.path.join(HERE, "ocr4.ps1")

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


EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)


def find_main_hwnd():
    best = [0, 0]

    def cb(h, _l):
        if not u.IsWindowVisible(h):
            return True
        cls = ctypes.create_unicode_buffer(256)
        u.GetClassNameW(h, cls, 256)
        if cls.value == "Qt51514QWindowIcon":
            r = Rect()
            u.GetWindowRect(h, ctypes.byref(r))
            area = (r.R - r.L) * (r.B - r.T)
            if area > best[0]:
                best[0], best[1] = area, int(h)
        return True

    u.EnumWindows(EnumProc(cb), None)
    return best[1]


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


def check_env():
    """操作前置检查：微信是否运行 / 主窗口 / 可见 / 已最小化 / 是否前台 / 尺寸·比例 / DPI。

    「验证完成再进行操作」——任何 UI 操作前先跑这个，`ok=False` 就绝不动作。
    """
    info = {"weixin_running": False, "pids": [], "hwnd": 0, "visible": False, "minimized": False,
            "foreground": False, "rect": None, "size": None, "ratio": None, "dpi": None,
            "target_size": [NW, NH], "ok": False, "reason": "", "deps": core.deps()}
    try:                      # 多账号：报告本机账号与当前使用的账号（P2-6）
        info["accounts"] = [a["wxid"] for a in core.list_accounts()]
        info["active_account"] = core.self_wxid()
    except Exception:
        info["accounts"], info["active_account"] = [], None
    pids = weixin_pids()
    info["weixin_running"] = bool(pids)
    info["pids"] = pids
    h = find_main_hwnd()
    if not h:
        info["reason"] = ("微信进程在运行，但找不到可见主窗口（可能最小化到托盘或未登录）"
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
    if not info["visible"]:
        info["reason"] = "主窗口不可见（可能已隐藏到托盘）"
    elif info["minimized"]:
        info["reason"] = "主窗口已最小化"
    else:
        info["ok"] = True
    return info


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


def _run_ps(script, args):
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] + args,
                   capture_output=True, text=True)


# ---- 进程内截图（ctypes GDI BitBlt → PNG）----
# 为什么不用 shot.ps1：每张截图 spawn 一次 PowerShell 要约 1~2s，一次发送要抓 5~8 张，
# 累计是最大的一处浪费。这里直接 BitBlt 屏幕对应区域，再手写 PNG（零依赖）。
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


def grab_png(h, path):
    """抓窗口所在屏幕区域并存 PNG。返回是否成功。"""
    l, t, w, hh = win_rect(h)
    if w <= 0 or hh <= 0:
        return False
    hdc = u.GetDC(None)
    mem = _gdi.CreateCompatibleDC(hdc)
    bmp = _gdi.CreateCompatibleBitmap(hdc, w, hh)
    _gdi.SelectObject(mem, bmp)
    ok = _gdi.BitBlt(mem, 0, 0, w, hh, hdc, l, t, 0x00CC0020)  # SRCCOPY
    bi = _BMIH(ctypes.sizeof(_BMIH), w, -hh, 1, 32, 0, 0, 0, 0, 0, 0)
    buf = ctypes.create_string_buffer(w * 4 * hh)
    _gdi.GetDIBits(mem, bmp, 0, hh, buf, ctypes.byref(bi), 0)
    _gdi.DeleteObject(bmp)
    _gdi.DeleteDC(mem)
    u.ReleaseDC(None, hdc)
    if not ok:
        return False
    open(path, "wb").write(_png_from_bgra(buf.raw, w, hh))
    return True


def read_ui(tag):
    h = find_main_hwnd()
    _, _, ww, wh = win_rect(h)
    png = os.path.join(core.WORK, f"ui_{tag}.png")
    out = os.path.join(core.WORK, f"ui_{tag}.txt")
    try:
        u.SetForegroundWindow(ctypes.c_void_p(h))
        if not grab_png(h, png):
            raise RuntimeError("grab failed")
    except Exception:
        _run_ps(SHOT, ["-Out", png, "-Hwnd", str(h)])   # 回退：老路径（spawn PowerShell）
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
    """聊天区偶发抓成空白；重试直到右侧有内容（或到次数上限）。
    空白时点一下聊天区，促使微信重绘/置前。"""
    ww = wh = 0
    lines = []
    for i in range(tries):
        ww, wh, lines = read_ui(f"{tag}{i}")
        ly = layout(lines, ww, wh)
        if ly["header"] or ly["chat_text"]:
            return ww, wh, lines
        if i == 0:  # 首轮空白：点一下聊天区逼它重绘
            try:
                u.SetForegroundWindow(ctypes.c_void_p(find_main_hwnd()))
                _, _, w0, h0 = win_rect(find_main_hwnd())
                u.SetCursorPos(int(w0 * 0.55), int(h0 * 0.35))
                u.mouse_event(0x0002, 0, 0, 0, 0)
                time.sleep(0.05)
                u.mouse_event(0x0004, 0, 0, 0, 0)
            except Exception:
                pass
        time.sleep(0.7)
    return ww, wh, lines


def norm(s):
    return "".join(ch for ch in s if ch.isalnum())


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


def _input_text(lines, ww, wh):
    # 只按「行起点落在输入区内」筛：输入框文字 OCR 常只出左半段（x1 很小），
    # 若再要求 x1<=区域右边会把刚打进框的字整个漏掉（实测：落地成功却判「未落地」）。
    x0, y0, x1, y1 = layout(lines, ww, wh)["input_region"]
    return " ".join(t for a, b, c, d, t in lines if a >= x0 - 10 and b >= y0 - 10 and b <= y1 + 10)


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


def verify_target(talker, name, lines, ww, wh, verbose=False):
    """目标会话校验。**判据从紧**——错判 = 发错人。

    通过条件（按强度）：
    ⓪ **反证**（通用）：聊天头部明显更像**别的会话**（而非目标）⇒ 判定为「开错了会话」，直接拒绝。
       这一条专门堵历史事故根因——「同批内容发过多个会话」会让内容锚点撞车（锚点相同），
       但**头部必然不同**；用「头部更像谁」一票否决，比只看锚点稳得多。
    ⓪′ **群结构**（P2-4）：目标是群、且聊天区出现**群成员昵称独立行** ⇒ 确认是群（第三重印证）。
    ① 内容锚点命中 **且** 聊天头部与目标名吻合（hr≥0.5）。
    ② 内容锚点命中 **≥2 个**（头部 OCR 全花时的兜底）。
    ③ 无可用锚点（纯语音/图片会话）时，只认**很强**的头部匹配（hr>0.85）。
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
    if not usable and hr > 0.85:
        return True, "标题"
    return False, "-"


def find_session(lines, name, ww, wh):
    n = norm(name)
    best = None
    for x0, y0, x1, y1, t in lines:
        if x0 < SESSION_COL and 40 < y0 < wh * 0.85:
            nt = norm(t)
            if not nt:
                continue
            r = difflib.SequenceMatcher(None, n, nt).ratio()
            if n and (n in nt or nt in n):
                r = max(r, 0.95)
            if r > 0.55 and (best is None or r > best[0]):
                best = (r, (x0 + x1) // 2, (y0 + y1) // 2, t)
    return best


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

    两步前置闸门，任一不过就**不触碰窗口**直接失败：
    1. `check_env()`：微信是否运行 / 主窗口可见 / 未最小化。
    2. `Win.__enter__`：切前台 + 固定尺寸，并逐项校验规范化真的生效。
    之后才是「目标校验 → 输入落地 → 发送生效」三道动作校验。
    """
    if not name:
        name = core.names().get(talker, talker)
    st = check_env()
    if not st["ok"]:
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


def _send_locked(text, talker, name, dry_run, verbose):
    with Win() as win:
        ww, wh, lines = read_ui_stable("s0")
        ok, why = verify_target(talker, name, lines, ww, wh, verbose)
        if not ok:
            # ① 会话列表按名点击；② 列表名被 OCR 读花时用微信自带搜索兜底
            ok = open_chat(name, talker, win, verbose) or open_chat_via_search(name, talker, win, verbose)
        if not ok:
            return False, "目标会话未确认（fail-closed）"
        base_ts = _talker_latest_ts(talker)   # 发送后据此**读库确认**真的落到目标会话
        ww, wh, lines = read_ui_stable("s1")

        def _type_and_check(btn_hint, tag):
            ip = layout(lines, ww, wh, btn_hint=btn_hint)["input_pt"]
            win.click(ip[0], ip[1])
            ctrl(0x41)
            time.sleep(0.15)
            press(0x2E)
            time.sleep(0.3)
            type_text(text)
            time.sleep(1.0)
            w2, h2, l2 = read_ui_stable(tag)
            if not contains_sub(text, _input_text(l2, w2, h2), 4):
                ctrl(0x41)
                press(0x2E)
                return False, None
            return True, (w2, h2, l2)

        ok, got = _type_and_check(None, "s2")
        if not ok:
            # OCR 把聊天区误当输入区时的兜底：无视按钮检测，用贴底默认坐标重来一次
            if verbose:
                print("[type] 首轮输入未落地，改用默认贴底坐标重试", flush=True)
            ok, got = _type_and_check("default", "s2b")
        if not ok:
            return False, "输入未落地（fail-closed）"
        ww, wh, l2 = got
        if dry_run:
            ctrl(0x41)
            press(0x2E)
            return True, "dry-run：已校验、未发送"
        ly2 = layout(l2, ww, wh)
        press(0x0D)
        time.sleep(1.0)
        ww, wh, l3 = read_ui("s3")
        if contains_sub(text, _input_text(l3, ww, wh), 4):
            win.click(*ly2["send_btn"])
            time.sleep(1.0)
            ww, wh, l3 = read_ui("s3b")
            if contains_sub(text, _input_text(l3, ww, wh), 4):
                ctrl(0x41)
                press(0x2E)
                return False, "发送未生效（输入框未清空）"
        # 最后一道：**读库确认**新消息真的落在目标会话（防「看着发出去了、其实发到别处」）
        if not _wait_new_message(talker, base_ts):
            return False, "已回车但目标会话未见新消息（可能发到了别处或未生效）"
        return True, "已发送"


# ============================================================================
# 附件发送（图片 / 文件 / 视频 / 语音文件）——「剪贴板粘贴 + 回车」
# ----------------------------------------------------------------------------
# 微信支持把剪贴板里的图片/文件直接粘进输入框，所以不必去点工具栏图标、也不用操作文件对话框：
#   - 图片（png/jpg/gif/bmp/webp/tiff）→ 剪贴板放**图像**（CF_DIB），粘贴后是内联图片
#   - 其它文件（pdf/docx/xlsx/mp4/mp3/wav/zip…）→ 剪贴板放**文件**（CF_HDROP），粘贴后是附件
#   - 视频（mp4/mov）：微信一般按视频消息发出；**语音**：微信语音是「按住录音」，无法自动化，
#     只能把音频文件当附件发
# 图片的剪贴板数据由持有进程提供（延迟渲染），所以 PowerShell 必须**存活到粘贴完成**。
# ============================================================================

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff"}


def _ps_quote(s):
    return "'" + str(s).replace("'", "''") + "'"


CF_BITMAP, CF_DIB, CF_HDROP = 2, 8, 15


def _empty_clipboard():
    """清空剪贴板——否则「格式已存在」的判定会被上一次的残留骗过。"""
    try:
        u.OpenClipboard(None)
        u.EmptyClipboard()
        u.CloseClipboard()
    except Exception:
        pass


def _wait_clipboard_ready(is_image, timeout=15):
    """轮询剪贴板是否已含我们刚放进去的数据（PowerShell 冷启动要 1~2s，不能立刻粘贴）。"""
    fmts = (CF_BITMAP, CF_DIB) if is_image else (CF_HDROP,)
    t0 = time.time()
    while time.time() - t0 < timeout:
        if any(u.IsClipboardFormatAvailable(f) for f in fmts):
            return True
        time.sleep(0.25)
    return False


def _set_clipboard(path, is_image):
    """把图片/文件放进剪贴板。

    - 图片返回一个需**保持存活**的进程（图片走延迟渲染，进程一退剪贴板就空）。
    - 返回后**已确认剪贴板就绪**，调用方可直接粘贴。
    """
    _empty_clipboard()
    if is_image:
        cmd = ("Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
               f"$i=[System.Drawing.Image]::FromFile({_ps_quote(path)});"
               "[System.Windows.Forms.Clipboard]::SetImage($i);"
               "Start-Sleep -Seconds 90")
        holder = subprocess.Popen(["powershell", "-Sta", "-NoProfile", "-Command", cmd],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        _wait_clipboard_ready(True)
        return holder
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    f"Set-Clipboard -LiteralPath {_ps_quote(path)}"], capture_output=True, text=True)
    _wait_clipboard_ready(False)
    return None


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

    校验：环境 → 目标会话 → （非图片）输入区见文件名 → 回车后目标会话出现新消息。
    图片无文字可 OCR，落地校验由「发送后读库确认」兜底。
    """
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        return False, f"文件不存在：{path}"
    if not name:
        name = core.names().get(talker, talker)
    st = check_env()
    if not st["ok"]:
        return False, f"环境前置检查未通过：{st['reason']}"
    is_image = os.path.splitext(path)[1].lower() in IMAGE_EXTS
    holder = None
    lk = _acquire_ui()
    if lk is None:
        return False, "另一个微信操作正在进行，请稍后重试（busy）"
    _t0 = time.time()
    try:
        with Win() as win:
            ww, wh, lines = read_ui_stable("a0")
            ok, _why = verify_target(talker, name, lines, ww, wh, verbose)
            if not ok:
                ok = open_chat(name, talker, win, verbose)
            if not ok:
                return False, "目标会话未确认（fail-closed）"
            base_ts = _talker_latest_ts(talker)
            ww, wh, lines = read_ui_stable("a1")
            ip = layout(lines, ww, wh)["input_pt"]
            win.click(ip[0], ip[1])
            ctrl(0x41)
            time.sleep(0.15)
            press(0x2E)
            time.sleep(0.3)                     # 清空输入框
            holder = _set_clipboard(path, is_image)
            time.sleep(0.6)
            ctrl(0x56)                          # Ctrl+V
            time.sleep(1.8)
            if not is_image:                    # 文件：输入区应出现文件名（强校验）
                ww, wh, l2 = read_ui_stable("a2")
                if not contains_sub(os.path.basename(path), _input_text(l2, ww, wh), 4):
                    return False, "附件未落地（输入区未见文件名，fail-closed）"
            if dry_run:
                ctrl(0x41)
                press(0x2E)
                return True, "dry-run：已粘贴进输入框、未发送"
            press(0x0D)
            time.sleep(1.2)
            if not _wait_new_message(talker, base_ts):
                return False, "已回车但目标会话未见新消息（发送可能未生效）"
            return True, "已发送"
    except RuntimeError as e:
        return False, f"窗口前置检查未通过：{e}"
    finally:
        _metric("send_file", (time.time() - _t0) * 1000, True, {"path": os.path.basename(path)})
        _release_ui(lk)
        if holder is not None:
            try:
                holder.terminate()
            except Exception:
                pass


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
    st = check_env()
    if not st["ok"]:
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
        # 3) 输入正文（点输入框后直接打字，保留引用条）
        ww, wh, l2 = read_ui_stable("q2")
        win.click(*layout(l2, ww, wh)["input_pt"])
        time.sleep(0.3)
        type_text(text)
        time.sleep(1.0)
        ww, wh, l3 = read_ui_stable("q3")
        if not contains_sub(text, _input_text(l3, ww, wh), 4):
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
