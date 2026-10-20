# -*- coding: utf-8 -*-
"""按 Excel 分组给微信好友打标签（走微信自己的「通讯录管理 → 标签 → 添加成员」界面）。

为什么走 UI 而不是改库：标签成员关系存在加密的 contact.db 里、且是服务器同步的本地缓存；
直接改库不会同步到手机，还可能被覆盖。这里只做微信官方界面能做的事。

用法（用托管解释器 ~/.lumii/runtimes/python-embed/python.exe）：
  export --out 通讯录.xlsx [--account wxid_xxx] [--all]
  plan   --excel 分组.xlsx [--account wxid_xxx] [--sheet Sheet1]
  apply  --excel 分组.xlsx --account wxid_xxx [--limit 20] [--yes] [--fresh]

Excel 列名自动识别：
  分组/组别/group/标签/tag            必填，标签名（不存在会自动新建）
  username/wxid/好友ID                可选，最可靠
  微信号/alias                        可选，按微信号搜索（同名好友靠它区分）
  显示名/备注/昵称/姓名/name          可选，按微信里的显示名搜索

安全约定：
  - plan（默认）只读库、不碰微信界面。
  - apply 必须显式 --account；不带 --limit 时必须 --yes。
  - 每个联系人 tick 后都复核「已选择 N 个联系人」；对不上就取消整个标签，不盲发。
  - 只点「添加成员 / 完成 / 取消」，绝不点「删除标签」（清理自己新建的空标签时除外）。
"""
import argparse
import csv
import ctypes
import hashlib
import json
import os
import random
import re
import sqlite3
import sys
import time
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import wechat_core as core          # noqa: E402
import wechat_sender as s           # noqa: E402
import wxinstances as wxinst        # noqa: E402

SYSTEM_IDS = {
    "notifymessage", "filehelper", "floatbottle", "newsapp", "fmessage", "qmessage",
    "tmessage", "medianote", "weixin", "mphelper", "qqmail", "qqsafe", "voiceinput",
    "weixinreminder", "officialaccounts", "notification_messages", "exmail_tips",
    "weibo", "facebook", "linkedin", "weixinluckybag", "wechatsync",
}

# 自己的 WinDLL 实例：ctypes.windll.user32 是**全进程共享**的，给它设 argtypes 会把
# wechat_sender 里同名的调用一起改坏（实测 GetWindowRect 的 RECT 类型对不上）。
u = ctypes.WinDLL("user32", use_last_error=True)
WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
u.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
u.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
u.GetClassNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
u.GetWindowRect.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.RECT)]
u.IsWindowVisible.argtypes = [ctypes.c_void_p]
u.EnumWindows.argtypes = [WNDENUMPROC, ctypes.c_void_p]
u.GetWindow.argtypes = [ctypes.c_void_p, ctypes.c_uint]
u.GetWindow.restype = ctypes.c_void_p
u.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
u.SetWindowPos.argtypes = [ctypes.c_void_p, ctypes.c_void_p,
                           ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint]


def norm(t):
    """OCR / Excel 文本归一化：去掉所有空白，全角括号转半角。"""
    t = (t or "").replace("（", "(").replace("）", ")")
    return re.sub(r"\s+", "", t)


def _enum_windows(pid):
    out = []

    @WNDENUMPROC
    def cb(h, _l):
        p = ctypes.c_uint32()
        u.GetWindowThreadProcessId(h, ctypes.byref(p))
        if p.value != pid:
            return True
        title = ctypes.create_unicode_buffer(512)
        u.GetWindowTextW(h, title, 512)
        cls = ctypes.create_unicode_buffer(256)
        u.GetClassNameW(h, cls, 256)
        r = wintypes.RECT()
        u.GetWindowRect(h, ctypes.byref(r))
        out.append({
            "hwnd": int(h or 0), "title": title.value, "class": cls.value,
            "visible": bool(u.IsWindowVisible(h)),
            "owner": int(u.GetWindow(h, 4) or 0),
            "rect": (r.left, r.top, r.right - r.left, r.bottom - r.top),
        })
        return True

    u.EnumWindows(cb, None)
    return out


def _find_window(pid, title):
    for w in _enum_windows(pid):
        if w["title"] == title:
            return w
    return None


def _find_window_suffix(pid, suffix):
    for w in _enum_windows(pid):
        if w["title"].endswith(suffix):
            return w
    return None


def _restore(hwnd):
    r = s.win_rect(hwnd)
    if r[2] <= 0 or r[2] < 200 or r[3] < 200:
        u.ShowWindow(ctypes.c_void_p(hwnd), 9)       # SW_RESTORE
        time.sleep(0.4)
        r = s.win_rect(hwnd)
        if r[0] <= -30000 or r[1] <= -30000 or r[2] < 200 or r[3] < 200:
            u.SetWindowPos(ctypes.c_void_p(hwnd), None, 900, 350, 736, 568, 0x0040)
            time.sleep(0.4)


def _rclick(h, x, y):
    cx, cy = s._client_pt(h, x, y)
    lp = ((cy & 0xFFFF) << 16) | (cx & 0xFFFF)
    u.PostMessageW(ctypes.c_void_p(h), 0x0204, 2, lp)
    time.sleep(0.08)
    u.PostMessageW(ctypes.c_void_p(h), 0x0205, 0, lp)


# ---------------- 账号 / 数据库 ----------------

def pick_account(account):
    accs = {a["wxid"]: a for a in wxinst.accounts_detailed()}
    if account:
        a = accs.get(account)
        if not a:
            raise SystemExit("账号不存在：%s（可用：%s）" % (account, ", ".join(accs)))
        if not a.get("running"):
            raise SystemExit("账号 %s 没在运行，先登录微信" % account)
        return a
    running = [a for a in accs.values() if a.get("running")]
    if len(running) != 1:
        raise SystemExit("有 %d 个微信在运行，必须用 --account 指定：%s"
                         % (len(running), ", ".join(a["wxid"] for a in running)))
    return running[0]


def _label_ids(buf):
    """contact.extra_buffer 里字段 30 是逗号分隔的标签 id 串。"""
    i, buf = 0, buf or b""
    try:
        while i < len(buf):
            key = 0
            sh = 0
            while True:
                b = buf[i]
                i += 1
                key |= (b & 0x7F) << sh
                if b < 0x80:
                    break
                sh += 7
            fn, wt = key >> 3, key & 7
            if wt == 0:
                while buf[i] & 0x80:
                    i += 1
                i += 1
            elif wt == 2:
                n = 0
                sh = 0
                while True:
                    b = buf[i]
                    i += 1
                    n |= (b & 0x7F) << sh
                    if b < 0x80:
                        break
                    sh += 7
                if fn == 30:
                    raw = bytes(buf[i:i + n]).decode("ascii")
                    return [int(x) for x in raw.split(",") if x.strip().isdigit()]
                i += n
            elif wt in (1, 5):
                i += 8 if wt == 1 else 4
            else:
                return []
    except (IndexError, UnicodeDecodeError):
        return []
    return []


def load_contacts(account):
    """联系人 + 标签定义 + 成员集合（只读解密镜像）。"""
    core.set_account(account)
    m = core._mirror("contact/contact.db")
    m.refresh()
    con = sqlite3.connect("file:%s?mode=ro" % m.out.replace(os.sep, "/"), uri=True)
    try:
        labels = dict(con.execute(
            "select label_id_, label_name_ from contact_label order by sort_order_"))
        rows = []
        members = {}
        for username, lt, flag, deleted, remark, nick, alias, buf in con.execute(
                "select username, local_type, flag, delete_flag, remark, nick_name, alias, extra_buffer "
                "from contact"):
            u_ = username or ""
            kind = ("group" if u_.endswith("@chatroom") else
                    "open" if u_.endswith("@open") else
                    "official" if u_.startswith("gh_") else
                    "system" if u_ in SYSTEM_IDS else "friend")
            tag_ids = _label_ids(buf)
            for lid in tag_ids:
                if lid in labels:
                    members.setdefault(labels[lid], set()).add(u_)
            rows.append({
                "username": u_, "kind": kind, "local_type": lt, "flag": flag,
                "deleted": bool(deleted), "remark": remark or "", "nick": nick or "",
                "alias": alias or "", "display": remark or nick or u_,
                # 微信「添加成员」只列通讯录好友；陌生人（local_type=3）搜不到。
                "taggable": kind == "friend" and lt == 1 and not deleted,
                "labels": [labels[i] for i in tag_ids if i in labels],
            })
        return rows, labels, members
    finally:
        con.close()


# ---------------- Excel ----------------

ALIASES = {
    "group": ("分组", "组别", "group", "标签", "tag", "category", "组"),
    "username": ("username", "wxid", "好友id", "用户id", "账号id"),
    "alias": ("微信号", "alias", "wechat", "wechatid", "wechat_id"),
    "name": ("显示名", "备注", "昵称", "姓名", "联系人", "name", "remark", "nick", "昵称/备注"),
    "taggable": ("可打标签", "是否好友", "好友", "类型"),
}


def _header_map(headers):
    got = {}
    for i, h in enumerate(headers):
        nh = norm(h).lower()
        for key, names in ALIASES.items():
            if key in got:
                continue
            for n in names:
                if nh == norm(n).lower():
                    got[key] = i
                    break
    return got


def read_excel(path, sheet=None):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".csv":
        with open(path, encoding="utf-8-sig", newline="") as f:
            rows = list(csv.reader(f))
        sheet_name = "csv"
    else:
        from openpyxl import load_workbook
        wb = load_workbook(path, read_only=True, data_only=True)
        ws = wb[sheet] if sheet else wb.active
        rows = [[("" if c is None else str(c)) for c in r]
                for r in ws.iter_rows(values_only=True)]
        sheet_name = ws.title
        wb.close()
    if not rows:
        raise SystemExit("Excel 是空的：%s" % path)
    hm = _header_map(rows[0])
    if "group" not in hm:
        raise SystemExit("找不到分组列。表头：%s；需要 分组/组别/group/标签/tag 之一"
                         % rows[0])
    out = []
    for rn, r in enumerate(rows[1:], start=2):
        def cell(key):
            i = hm.get(key)
            return (r[i] if i is not None and i < len(r) else "") or ""
        group = cell("group").strip()
        username = cell("username").strip()
        alias = cell("alias").strip()
        name = cell("name").strip()
        if not any((group, username, alias, name)):
            continue
        if username.lower().startswith("wxid_"):
            pass
        elif alias.lower().startswith("wxid_"):
            username, alias = alias, ""
        out.append({"row": rn, "group": group, "username": username,
                    "alias": alias, "name": name})
    return out, sheet_name


# ---------------- 匹配 ----------------

def index_contacts(contacts):
    by_u, by_alias, by_name = {}, {}, {}
    for c in contacts:
        by_u[c["username"]] = c
        if c["alias"]:
            by_alias.setdefault(c["alias"].lower(), []).append(c)
        for nm in {c["display"], c["remark"], c["nick"]}:
            if nm:
                by_name.setdefault(norm(nm), []).append(c)
    return by_u, by_alias, by_name


def match_row(row, idx):
    by_u, by_alias, by_name = idx
    if row["username"] and row["username"] in by_u:
        return by_u[row["username"]], ""
    if row["alias"]:
        hits = by_alias.get(row["alias"].lower(), [])
        if len(hits) == 1:
            return hits[0], ""
        if len(hits) > 1:
            return None, "微信号重复"
    if row["name"]:
        hits = by_name.get(norm(row["name"]), [])
        if len(hits) == 1:
            return hits[0], ""
        if len(hits) > 1:
            return None, "显示名有 %d 个同名，请补微信号" % len(hits)
    if not any((row["username"], row["alias"], row["name"])):
        return None, "没有可匹配的标识"
    return None, "通讯录里找不到"


def build_plan(rows, contacts, labels, members):
    idx = index_contacts(contacts)
    out = []
    for r in rows:
        c, why = match_row(r, idx)
        item = dict(r)
        item["username_resolved"] = c["username"] if c else ""
        item["display"] = c["display"] if c else ""
        item["alias_resolved"] = c["alias"] if c else ""
        item["current_labels"] = ",".join(c["labels"]) if c else ""
        if not c:
            item["status"], item["reason"] = "not_found", why
        elif not c["taggable"]:
            item["status"], item["reason"] = "not_taggable", "不是通讯录好友（陌生人/公众号/群）"
        elif not r["group"]:
            item["status"], item["reason"] = "no_group", "分组为空"
        elif len(r["group"]) > 20:
            item["status"], item["reason"] = "bad_group", "标签名超过 20 字"
        elif r["group"] in c["labels"]:
            item["status"], item["reason"] = "already", "已有这个标签"
        else:
            item["status"], item["reason"] = "to_add", ""
        out.append(item)
    return out


def print_plan(plan, labels, members):
    groups = {}
    for p in plan:
        groups.setdefault(p["group"] or "(空)", []).append(p)
    print("分组数：%d；行数：%d" % (len(groups), len(plan)))
    for g, items in groups.items():
        cnt = {}
        for p in items:
            cnt[p["status"]] = cnt.get(p["status"], 0) + 1
        existing = len(members.get(g, ()))
        print("  %-16s 标签%s 现有成员 %-4d  待加 %-4d  已有 %-4d  不是好友 %-4d  找不到 %-4d"
              % (g, "存在" if g in labels.values() else "新建", existing,
                 cnt.get("to_add", 0), cnt.get("already", 0),
                 cnt.get("not_taggable", 0), cnt.get("not_found", 0)))
    bad = [p for p in plan if p["status"] in ("not_found", "not_taggable", "bad_group", "no_group")]
    if bad:
        print("\n有 %d 行不能处理（前 10 条）：" % len(bad))
        for p in bad[:10]:
            print("  第%d行 %-12s %-20s %s"
                  % (p["row"], p["group"][:12], (p["name"] or p["username"] or p["alias"])[:20],
                     p["reason"]))


def write_report(plan, path):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["行号", "分组", "输入名", "输入微信号", "解析username", "显示名",
                    "现有标签", "状态", "原因"])
        for p in plan:
            w.writerow([p["row"], p["group"], p["name"], p["alias"],
                        p["username_resolved"], p["display"], p["current_labels"],
                        p["status"], p["reason"]])


# ---------------- 微信界面 ----------------

def _ocr(h, tag):
    return s.read_ui(tag, h)


def _click_row(h, x0, y0, x1, y1):
    s.post_click(h, (x0 + x1) // 2, (y0 + y1) // 2)


def ensure_manager(acc):
    pid = acc["pid"]
    mgr = _find_window(pid, "通讯录管理")
    if mgr:
        _restore(mgr["hwnd"])
        return mgr["hwnd"]
    with s.target(acc["wxid"], pid):
        st = s.check_env(account=acc["wxid"], pid=pid)
        if not st.get("visible") or st.get("minimized") or not st.get("onscreen", True):
            st = s.wake_window(st)
        main = st.get("hwnd") or s.find_main_hwnd(account=acc["wxid"], pid=pid)
    if not main:
        raise SystemExit("找不到微信主窗口")
    # 先点通讯录（左侧导航第二个图标），再点「通讯录管理」
    s.post_click(main, 38, 157)
    time.sleep(1.0)
    ww, wh, lines = _ocr(main, "nav_contacts")
    hit = next((r for r in lines if norm(r[4]) == "通讯录管理"), None)
    if not hit:
        raise SystemExit("主窗口里找不到「通讯录管理」（截图见 %s）"
                         % os.path.join(core.WORK, "ui_nav_contacts.png"))
    _click_row(main, *hit[:4])
    for _ in range(10):
        time.sleep(0.5)
        mgr = _find_window(pid, "通讯录管理")
        if mgr:
            _restore(mgr["hwnd"])
            return mgr["hwnd"]
    raise SystemExit("通讯录管理窗口没有打开")


def tag_rows(lines):
    return [r for r in lines if r[0] < 230 and 140 < r[1] < 560]


def find_tag_row(lines, name):
    n = norm(name)
    rows = tag_rows(lines)
    for r in rows:
        if norm(r[4]) == n:
            return r
    # OCR 会把行尾的「（57）」读成「(5刀)」之类；前缀唯一就认它。
    # 前缀不唯一（例如同时有「未命名」「未命名1」）时宁可返回 None，交给调用方报错，
    # 也不能猜——猜错就是往别的标签里加人。
    cands = [r for r in rows if norm(r[4]).startswith(n)]
    if len(cands) == 1:
        return cands[0]
    return None


def click_tags_tab(mgr):
    """展开左侧「标签」分组。已经展开时**不要**再点（再点会收起来）。"""
    for _ in range(4):
        ww, wh, lines = _ocr(mgr, "mgr_tab")
        expanded = any(("新建标签" in norm(r[4])) or ("无标签" in norm(r[4]))
                       for r in lines)
        if expanded:
            return
        hit = next((r for r in lines if norm(r[4]) == "标签" and r[1] < 300), None)
        if not hit:
            time.sleep(0.4)
            continue
        _click_row(mgr, *hit[:4])
        time.sleep(0.8)
    raise SystemExit("通讯录管理里找不到「标签」或展开失败")


def open_tag_menu(mgr, row):
    before = {w["hwnd"] for w in _enum_windows(_pid_of(mgr))}
    _rclick(mgr, (row[0] + row[2]) // 2, (row[1] + row[3]) // 2)
    for _ in range(12):
        time.sleep(0.15)
        for w in _enum_windows(_pid_of(mgr)):
            if w["hwnd"] not in before and w["owner"] == mgr and "ToolSaveBits" in w["class"]:
                return w["hwnd"]
    return 0


def _pid_of(hwnd):
    p = ctypes.c_uint32()
    u.GetWindowThreadProcessId(ctypes.c_void_p(hwnd), ctypes.byref(p))
    return p.value


def menu_click(menu, text):
    # 菜单刚创建时 PrintWindow 可能还是空白帧，给它几拍
    for attempt in range(4):
        ww, wh, lines = _ocr(menu, "menu%d" % attempt)
        hit = next((r for r in lines if norm(r[4]) == norm(text)), None)
        if hit:
            s._real_click_at(menu, (hit[0] + hit[2]) // 2, (hit[1] + hit[3]) // 2)
            return
        time.sleep(0.3)
    raise RuntimeError("菜单里没有「%s」" % text)


def open_picker(mgr, row):
    menu = open_tag_menu(mgr, row)
    if not menu:
        raise RuntimeError("右键菜单没出现")
    menu_click(menu, "添加成员")
    pid = _pid_of(mgr)
    for _ in range(12):
        time.sleep(0.25)
        p = _find_window_suffix(pid, "添加成员")
        if p:
            _restore(p["hwnd"])
            return p["hwnd"]
    raise RuntimeError("添加成员窗口没打开")


def create_tag(mgr, name, existing_names):
    """新建标签并改名。返回 (标签行, 最新的 manager hwnd)。

    微信在新建标签后会把「通讯录管理」窗口重建一次（hwnd 变了，旧句柄上的 OCR 直接是空），
    所以提交后必须**按标题重新找窗口**，不能继续用传进来的 mgr。
    """
    pid = _pid_of(mgr)
    ww, wh, lines = _ocr(mgr, "newtag0")
    hit = next((r for r in lines if "新建标签" in norm(r[4])), None)
    if not hit:
        raise RuntimeError("找不到「新建标签」")
    _click_row(mgr, *hit[:4])
    time.sleep(0.8)
    s.post_backspaces(mgr, 40)
    s.post_text(mgr, name)
    time.sleep(0.4)
    s.post_click(mgr, 600, 450)          # 点空白处提交内联改名
    time.sleep(1.0)
    win = _find_window(pid, "通讯录管理")
    mgr = win["hwnd"] if win else mgr
    click_tags_tab(mgr)
    ww, wh, lines = _ocr(mgr, "newtag1")
    row = find_tag_row(lines, name)
    if row:
        return row, mgr
    # 改名没成功：把这次新建出来的「未命名N」删掉，别留垃圾
    for r in tag_rows(lines):
        t = norm(r[4])
        if "未命名" in t and t not in {norm(x) for x in existing_names}:
            try:
                delete_tag(mgr, r)
            except Exception:
                pass
    raise RuntimeError("新建标签「%s」失败" % name)


def delete_tag(mgr, row):
    menu = open_tag_menu(mgr, row)
    if not menu:
        raise RuntimeError("右键菜单没出现")
    menu_click(menu, "删除标签")
    pid = _pid_of(mgr)
    dlg = None
    for _ in range(10):
        time.sleep(0.2)
        for w in _enum_windows(pid):
            if w["owner"] == mgr and w["class"] == "Qt51514QWindowIcon" and w["visible"]:
                dlg = w["hwnd"]
                break
        if dlg:
            break
    if not dlg:
        raise RuntimeError("删除确认框没出现")
    ww, wh, lines = _ocr(dlg, "delconfirm")
    hit = next((r for r in lines if norm(r[4]) == "删除"), None)
    if not hit:
        raise RuntimeError("确认框里找不到「删除」")
    s.post_click(dlg, (hit[0] + hit[2]) // 2, (hit[1] + hit[3]) // 2)
    time.sleep(0.8)


SELECTED_RE = re.compile(r"已选择(\d+)个")


def selected_count(lines):
    for r in lines:
        m = SELECTED_RE.search(norm(r[4]))
        if m:
            return int(m.group(1))
    return None


def search_picker(picker, query):
    # 搜索框位置按窗口尺寸缩放（770x610 标定）
    r = s.win_rect(picker)
    ww, wh = r[2], r[3]
    sx, sy = int(ww * 0.247), int(wh * 0.093)
    s.post_click(picker, sx, sy)
    time.sleep(0.25)
    s.post_backspaces(picker, 120)
    time.sleep(0.2)
    s.post_text(picker, query)
    time.sleep(1.0)


def add_one(picker, query, expect, alias=""):
    """搜索并勾选一个联系人。返回 (ok, detail)。expect 是归一化后的显示名集合。"""
    search_picker(picker, query)
    ww, wh, lines = _ocr(picker, "picker_search")
    cands = []
    for r in lines:
        if r[0] > ww * 0.5 or r[1] < 100:
            continue
        t = norm(r[4])
        if t in expect:
            cands.append(r)
        elif alias and t == norm("微信号：" + alias):
            # 副标题行：只用来确认，不当作可点的行
            pass
    if not cands:
        # 再等一拍（搜索结果渲染慢）
        time.sleep(0.6)
        ww, wh, lines = _ocr(picker, "picker_search2")
        for r in lines:
            if r[0] > ww * 0.5 or r[1] < 100:
                continue
            if norm(r[4]) in expect:
                cands.append(r)
    if not cands:
        return False, "搜索无结果"
    if len(cands) > 1:
        return False, "搜索结果有 %d 个同名" % len(cands)
    row = cands[0]
    cbx = int(ww * 0.074)
    cby = row[1] + 6
    before = selected_count(lines)
    s.post_click(picker, cbx, cby)
    time.sleep(0.4)
    ww2, wh2, lines2 = _ocr(picker, "picker_tick")
    after = selected_count(lines2)
    if before is not None and after is not None and after == before + 1:
        return True, "已勾选"
    # 计数读不到时，用右侧「已选择」面板里的名字兜底
    right = [norm(r[4]) for r in lines2 if r[0] > ww2 * 0.5 and r[1] > 80]
    if any(t in right for t in expect):
        return True, "已勾选（面板确认）"
    return False, "勾选未确认（before=%s after=%s）" % (before, after)


def finish_picker(picker, commit):
    r = s.win_rect(picker)
    ww, wh = r[2], r[3]
    x = int(ww * (0.618 if commit else 0.742))
    y = int(wh * 0.897)
    s.post_click(picker, x, y)
    time.sleep(1.0)


def db_tag_members(account, tag):
    rows, labels, members = load_contacts(account)
    return members.get(tag, set())


def wait_tag_members(account, tag, want, tries=8):
    """微信落库有延迟（实测 2–5 秒）；等到人数够或超时，返回最后一次结果。"""
    m = db_tag_members(account, tag)
    for _ in range(tries):
        if len(m) >= want:
            return m
        time.sleep(0.6)
        m = db_tag_members(account, tag)
    return m


# ---------------- 导出 ----------------

def cmd_export(args):
    acc = pick_account(args.account)
    contacts, labels, members = load_contacts(acc["wxid"])
    people = [c for c in contacts if c["kind"] == "friend"]
    main_rows = people if args.all else [c for c in people if c["taggable"]]
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "通讯录"
    head = ["显示名", "备注", "昵称", "微信号", "现有标签", "username", "可打标签", "分组"]
    ws.append(head)
    for c in sorted(main_rows, key=lambda x: norm(x["display"]).lower()):
        ws.append([c["display"], c["remark"], c["nick"], c["alias"],
                   ",".join(c["labels"]), c["username"],
                   "是" if c["taggable"] else "否", ""])
    ws.freeze_panes = "A2"
    for col, w in zip("ABCDEFGH", (24, 18, 18, 20, 20, 26, 10, 14)):
        ws.column_dimensions[col].width = w
    if args.all:
        ws2 = wb.create_sheet("非好友")
        ws2.append(["显示名", "username", "类型", "分组成员"])
        for c in contacts:
            if c["kind"] != "friend":
                ws2.append([c["display"], c["username"], c["kind"], ""])
        ws2.freeze_panes = "A2"
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    wb.save(args.out)
    print("已导出 %d 行到 %s（好友 %d，可打标签 %d；标签 %d 个，已有成员 %d 人次）"
          % (len(main_rows), args.out, len(people),
             sum(1 for c in people if c["taggable"]), len(labels),
             sum(len(v) for v in members.values())))


def cmd_plan(args):
    acc = pick_account(args.account)
    rows, sheet = read_excel(args.excel, args.sheet)
    contacts, labels, members = load_contacts(acc["wxid"])
    plan = build_plan(rows, contacts, labels, members)
    print("账号 %s，工作表 %s" % (acc["wxid"], sheet))
    print_plan(plan, labels, members)
    out = os.path.splitext(args.excel)[0] + ".plan.csv"
    write_report(plan, out)
    print("\n明细已写入 %s" % out)


def cmd_apply(args):
    acc = pick_account(args.account)
    rows, sheet = read_excel(args.excel, args.sheet)
    contacts, labels, members = load_contacts(acc["wxid"])
    plan = build_plan(rows, contacts, labels, members)
    todo = [p for p in plan if p["status"] == "to_add"]
    print("账号 %s，工作表 %s：待加 %d 行" % (acc["wxid"], sheet, len(todo)))
    if not todo:
        return
    if not args.limit and not args.yes:
        raise SystemExit("要写 %d 个联系人，确认后加 --yes（或先用 --limit 20 试一批）" % len(todo))
    if args.limit:
        todo = todo[:args.limit]

    state_path = args.state or os.path.splitext(args.excel)[0] + ".state.json"
    state = {}
    if os.path.exists(state_path) and not args.fresh:
        try:
            state = json.load(open(state_path, encoding="utf-8"))
        except Exception:
            state = {}
    state.setdefault("done", {})
    state.setdefault("failed", {})
    state["account"] = acc["wxid"]

    def save_state():
        tmp = state_path + ".tmp"
        json.dump(state, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        os.replace(tmp, state_path)

    # 按标签分组，一个标签只开一次「添加成员」
    by_tag = {}
    for p in todo:
        key = "%s|%s" % (p["username_resolved"], p["group"])
        if state["done"].get(key):
            continue
        by_tag.setdefault(p["group"], []).append(p)
    if not by_tag:
        print("没有需要新加的（断点续传已全部完成）")
        return

    mgr = ensure_manager(acc)
    click_tags_tab(mgr)
    ww, wh, lines = _ocr(mgr, "mgr_tags")
    existing_names = [norm(r[4]) for r in tag_rows(lines)]
    known_tags = set(labels.values())

    for tag, items in by_tag.items():
        # 微信可能在上一次操作后重建了 manager 窗口，每轮都按标题重新拿一次
        win = _find_window(acc["pid"], "通讯录管理")
        if not win:
            raise SystemExit("通讯录管理窗口不见了（可能被关掉了）")
        mgr = win["hwnd"]
        click_tags_tab(mgr)
        ww, wh, lines = _ocr(mgr, "mgr_before_" + hashlib.md5(tag.encode()).hexdigest()[:6])
        row = find_tag_row(lines, tag)
        if not row:
            if tag in known_tags:
                # 库里有、界面上却认不出来：绝不新建同名标签（会造重复），交给人看
                raise SystemExit("标签「%s」在库里存在，但界面上找不到（可能被 OCR 读花了）。"
                                 "先手动滚动/截图确认，别让工具新建重复标签。" % tag)
            print("\n[新建标签] %s" % tag)
            row, mgr = create_tag(mgr, tag, existing_names)
            existing_names.append(norm(tag))
            known_tags.add(tag)
            ww, wh, lines = _ocr(mgr, "mgr_afternew")
            row = find_tag_row(lines, tag) or row
        before_members = db_tag_members(acc["wxid"], tag)
        print("\n[标签] %s：现有 %d 人，本批待加 %d 人"
              % (tag, len(before_members), len(items)))
        picker = open_picker(mgr, row)
        added, failed = 0, 0
        try:
            for i, p in enumerate(items, 1):
                key = "%s|%s" % (p["username_resolved"], tag)
                display = p["display"]
                alias = p["alias_resolved"] or p["alias"]
                # 搜索词优先用微信号（同名好友也能唯一命中），否则用显示名
                query = alias or display
                expect = {norm(display)}
                if alias:
                    expect.add(norm(alias))
                # 和发送链共用一把跨进程 UI 锁：每个联系人只占 ~2 秒，代聊的发送可以插空
                lock = s._acquire_ui(timeout=120)
                if lock is None:
                    ok, detail = False, "微信 UI 被占用（busy）"
                else:
                    try:
                        ok, detail = add_one(picker, query, expect, alias)
                    finally:
                        s._release_ui(lock)
                if ok:
                    added += 1
                    state["done"][key] = int(time.time())
                    print("  %3d/%d %-24s ok" % (i, len(items), display[:24]))
                else:
                    failed += 1
                    state["failed"][key] = detail
                    print("  %3d/%d %-24s FAIL %s" % (i, len(items), display[:24], detail))
                save_state()
                time.sleep(random.uniform(1.0, 2.2))
            if added:
                finish_picker(picker, commit=True)
                after = wait_tag_members(acc["wxid"], tag, len(before_members) + added)
                gained = len(after - before_members)
                print("  完成：界面勾选 %d，库里新增 %d（现有 %d 人）"
                      % (added, gained, len(after)))
                if gained < added:
                    print("  ⚠ 库还没追平，稍后再跑一次 plan 核对（微信同步有延迟）")
            else:
                finish_picker(picker, commit=False)
                print("  没有成功勾选，已取消（未改标签）")
        finally:
            p2 = _find_window_suffix(acc["pid"], "添加成员")
            if p2:
                finish_picker(p2["hwnd"], commit=False)

    save_state()
    fails = [(k, v) for k, v in state["failed"].items()
             if k in {"%s|%s" % (p["username_resolved"], p["group"]) for p in todo}]
    if fails:
        print("\n失败 %d 个（重跑会再试；明细在状态文件里）：" % len(fails))
        for k, v in fails[:20]:
            print("  %s  %s" % (k.split("|")[0], v))
    print("\n状态文件：%s（重跑会跳过已完成的）" % state_path)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("export", help="导出通讯录模板（带分组空列）")
    e.add_argument("--out", required=True)
    e.add_argument("--account")
    e.add_argument("--all", action="store_true", help="连陌生人/公众号一起导出（第二个表）")
    e.set_defaults(func=cmd_export)

    p = sub.add_parser("plan", help="只读检查 Excel，不改微信")
    p.add_argument("--excel", required=True)
    p.add_argument("--sheet")
    p.add_argument("--account")
    p.set_defaults(func=cmd_plan)

    a = sub.add_parser("apply", help="真正给微信打标签")
    a.add_argument("--excel", required=True)
    a.add_argument("--sheet")
    a.add_argument("--account", required=True)
    a.add_argument("--limit", type=int, default=0)
    a.add_argument("--yes", action="store_true")
    a.add_argument("--fresh", action="store_true", help="丢弃断点状态")
    a.add_argument("--state")
    a.set_defaults(func=cmd_apply)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
