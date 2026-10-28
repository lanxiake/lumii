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
import secrets
import sqlite3
import subprocess
import sys
import time
import traceback
from ctypes import wintypes

try:
    import msvcrt
except ImportError:          # 非 Windows 只用于跑纯函数自测
    msvcrt = None

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


def _is_tag_word(t):
    """OCR 常把「签」读成「筌/筌」，界面文案判定不能死抠字面。"""
    return "标" in t and ("签" in t or "筌" in t)


def _is_tag_row_label(t):
    return len(t) <= 3 and _is_tag_word(t)


def _is_new_tag_button(t):
    """「新建标签」按钮。OCR 常把左侧的计数一起读进来（实测读成「0新建标签」），
    所以不能 `startswith("新建")`——两个字都要认。"""
    return _is_tag_word(t) and "新建" in t


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
                    "open" if u_.endswith(("@open", "@openim")) else
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
    "group": ("分组", "组别", "群组", "客户分组", "客户组", "分组标签",
              "group", "标签", "tag", "category", "组"),
    "username": ("username", "wxid", "wxid号", "好友id", "用户id", "账号id", "用户标识"),
    "alias": ("微信号", "微信账号", "vx", "vx号", "alias", "wechat", "wechatid", "wechat_id"),
    "name": ("显示名", "微信名", "微信昵称", "备注名", "备注", "昵称", "姓名", "名称",
             "客户名", "客户", "联系人", "name", "remark", "nick", "昵称/备注"),
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
            item["status"] = "ambiguous" if "同名" in (why or "") else "not_found"
            item["reason"] = why
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


def rows_from_assignments(assignments):
    """MCP 直接给 `[{username?, name?, alias?, tag}]` 时，转成和 Excel 一样的行。"""
    out = []
    for i, a in enumerate(assignments or [], start=1):
        if not isinstance(a, dict):
            continue
        tag = str(a.get("tag") or a.get("group") or "").strip()
        username = str(a.get("username") or a.get("wxid") or "").strip()
        alias = str(a.get("alias") or "").strip()
        name = str(a.get("name") or a.get("display") or "").strip()
        if username.lower().startswith("wxid_"):
            pass
        elif alias.lower().startswith("wxid_"):
            username, alias = alias, ""
        out.append({"row": i, "group": tag, "username": username,
                    "alias": alias, "name": name})
    return out


def load_rows(excel=None, sheet=None, assignments=None):
    """MCP/CLI 共用的输入：Excel 或 assignments，二选一。"""
    if excel:
        rows, sheet_name = read_excel(excel, sheet)
        return rows, sheet_name
    if assignments is not None:
        return rows_from_assignments(assignments), "assignments"
    raise ValueError("需要 excel 或 assignments 之一")


def summarize_plan(plan, labels, members):
    """把逐行计划压成按标签的汇总（MCP 直接返回这个，别把 749 行灌给模型）。"""
    groups = {}
    for p in plan:
        groups.setdefault(p["group"] or "", []).append(p)
    out = []
    for tag, items in groups.items():
        cnt = {}
        for p in items:
            cnt[p["status"]] = cnt.get(p["status"], 0) + 1
        out.append({
            "tag": tag,
            "exists": tag in labels.values() if tag else False,
            "existing_members": len(members.get(tag, ())) if tag else 0,
            "total": len(items),
            "to_add": cnt.get("to_add", 0),
            "already": cnt.get("already", 0),
            "not_taggable": cnt.get("not_taggable", 0),
            "not_found": cnt.get("not_found", 0),
            "ambiguous": cnt.get("ambiguous", 0),
            "no_group": cnt.get("no_group", 0),
            "bad_group": cnt.get("bad_group", 0),
        })
    errors = []
    for p in plan:
        if p["status"] in ("not_found", "not_taggable", "ambiguous", "bad_group", "no_group"):
            errors.append({"row": p["row"], "tag": p["group"],
                           "name": p["name"] or p["username"] or p["alias"],
                           "status": p["status"], "reason": p["reason"]})
            if len(errors) >= 30:
                break
    return {"groups": out,
            "counts": {s: sum(1 for p in plan if p["status"] == s)
                       for s in ("to_add", "already", "not_taggable",
                                 "not_found", "ambiguous", "no_group", "bad_group")},
            "errors": errors}


def _key_of(p):
    return "%s|%s" % (p["username_resolved"], p["group"])


def _load_state(state_path, fresh=False):
    state = {}
    if state_path and os.path.exists(state_path) and not fresh:
        try:
            state = json.load(open(state_path, encoding="utf-8"))
        except Exception:
            state = {}
    state.setdefault("done", {})
    state.setdefault("failed", {})
    return state


def _save_state(state_path, state):
    tmp = state_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    os.replace(tmp, state_path)


def default_state_path(excel=None, account="", assignments=None):
    if excel:
        return os.path.splitext(excel)[0] + ".state.json"
    base = os.path.join(os.path.expanduser("~"), ".lumii", "wechat-tags", "state")
    os.makedirs(base, exist_ok=True)
    h = hashlib.sha1(json.dumps(assignments or [], ensure_ascii=False,
                                sort_keys=True).encode("utf-8")).hexdigest()[:12]
    return os.path.join(base, "%s_%s.json" % (account or "default", h))


# ---------------- 微信界面 ----------------

def _ocr(h, tag):
    return s.read_ui(tag, h)


def selected_row_rect():
    """从最近一帧截图里找微信高亮选中的标签行（绿色 #15AC70）。

    新建标签后它是选中态。OCR 读不出单字标签，按锚点算行高又会差十几像素
    （实测点到了行底边，右键菜单出不来）；直接认高亮色最准。
    """
    import struct
    import zlib
    path = s._LAST_SHOT.get("path")
    if not path:
        return None
    try:
        data = open(path, "rb").read()
        pos, idat, w, h = 8, b"", 0, 0
        while pos + 8 <= len(data):
            n = struct.unpack(">I", data[pos:pos + 4])[0]
            tag = data[pos + 4:pos + 8]
            chunk = data[pos + 8:pos + 8 + n]
            pos += 12 + n
            if tag == b"IHDR":
                w, h = struct.unpack(">II", chunk[:8])
            elif tag == b"IDAT":
                idat += chunk
        raw = zlib.decompress(idat)
    except Exception:
        return None
    stride = w * 4

    def green(x, y):
        o = y * (stride + 1) + 1 + x * 4
        r, g, b = raw[o], raw[o + 1], raw[o + 2]
        return g > 140 and g > r + 40 and g > b + 20 and r < 80

    ys = [y for y in range(h)
          if sum(1 for x in range(20, 200, 10) if green(x, y)) >= 10]
    if not ys or max(ys) - min(ys) < 12:
        return None
    return (20, min(ys), 220, max(ys) + 1)


def _click_row(h, x0, y0, x1, y1):
    s.post_click(h, (x0 + x1) // 2, (y0 + y1) // 2)


def _is_contacts_manager_label(t):
    """识别主窗口「通讯录管理」按钮文案；允许 OCR 轻微读花。"""
    t = norm(t)
    if not t:
        return False
    if t == "通讯录管理":
        return True
    # 五个字偶发少读/拆读：关键锚点还在就认，避免「联系人」等短词误伤
    return (("通讯录" in t and "管" in t)
            or ("通讯" in t and "管理" in t))


def _find_contacts_manager_row(lines):
    """从 OCR 行里找「通讯录管理」按钮。"""
    return next((r for r in lines if _is_contacts_manager_label(r[4])), None)


def _scroll_contact_list_top(main):
    """把中间通讯录列表滚回顶部，露出「通讯录管理」。

    列表滚进字母区后按钮会离开视口；只再点左侧导航图标不会复位滚动位置
    （实测 ui_nav_contacts_retry.png：通讯录页已选中，但只见「联系人」与名单）。
    """
    s.post_click(main, 160, 280)
    time.sleep(0.15)
    for _ in range(10):
        s.post_wheel(main, 160, 280, 3)
        time.sleep(0.05)
    time.sleep(0.35)


def ensure_manager(acc):
    pid = acc["pid"]
    mgr = _find_window(pid, "通讯录管理")
    if mgr:
        _restore(mgr["hwnd"])
        return mgr["hwnd"]
    with s.target(acc["wxid"], pid):
        st = s.check_env(account=acc["wxid"], pid=pid)
        if not st.get("ok") or not st.get("visible") or st.get("minimized") or not st.get("onscreen", True):
            # 主窗口最小化/收托盘/桌面外时先还原，再判定；还原后仍读不到就自己搬回可见区
            st = s.wake_window(st)
        main = st.get("hwnd") or s.find_main_hwnd(account=acc["wxid"], pid=pid)
    if not main:
        raise SystemExit("找不到微信主窗口")
    # 先点通讯录（左侧导航通讯录图标），再找「通讯录管理」
    s.post_click(main, 38, 157)
    time.sleep(1.0)
    last_tag = "nav_contacts"
    ww, wh, lines = _ocr(main, last_tag)
    hit = _find_contacts_manager_row(lines)
    if not hit:
        # 常见：名单已下滚，「通讯录管理」在视口外——滚回顶再读，别只盲点导航。
        _scroll_contact_list_top(main)
        s.post_click(main, 38, 157)
        time.sleep(0.6)
        last_tag = "nav_contacts_retry"
        ww, wh, lines = _ocr(main, last_tag)
        hit = _find_contacts_manager_row(lines)
    if not hit:
        _scroll_contact_list_top(main)
        time.sleep(0.4)
        last_tag = "nav_contacts_retry"
        ww, wh, lines = _ocr(main, last_tag)
        hit = _find_contacts_manager_row(lines)
    if not hit:
        raise SystemExit("主窗口里找不到「通讯录管理」（截图见 %s）"
                         % os.path.join(core.WORK, "ui_%s.png" % last_tag))
    # 主窗口的 OCR y 比实拍画面高约一个标题栏（实测偏 24–34px），而管理窗口里的
    # OCR 坐标是准的。这里沿文本中心往下扫几个点，避免把「加偏移」写死到别的 DPI 上。
    cx = (hit[0] + hit[2]) // 2
    cy = (hit[1] + hit[3]) // 2
    for dy in (24, 32, 16, 0, 40, 8):
        s.post_click(main, cx, min(wh - 2, cy + dy))
        for _ in range(4):
            time.sleep(0.45)
            mgr = _find_window(pid, "通讯录管理")
            if mgr:
                _restore(mgr["hwnd"])
                return mgr["hwnd"]
    raise SystemExit("通讯录管理窗口没有打开")


def tag_rows(lines):
    return [r for r in lines if r[0] < 230 and 140 < r[1] < 560]


def _tag_base(t):
    """去掉 OCR 读到的人数尾巴：「ai(3)」「客户(5刀)」→「ai」「客户」。"""
    return re.sub(r"[\(（].*$", "", norm(t) or "")


def find_tag_row(lines, name):
    n = norm(name)
    rows = tag_rows(lines)
    for r in rows:
        if norm(r[4]) == n or _tag_base(r[4]) == n:
            return r
    # 大小写不敏感（英文短标签 OCR 常大小写乱跳）
    nl = n.lower()
    for r in rows:
        if _tag_base(r[4]).lower() == nl:
            return r
    # OCR 会把行尾的「（57）」读成「(5刀)」之类；前缀唯一就认它。
    # 前缀不唯一（例如同时有「未命名」「未命名1」）时宁可返回 None，交给调用方报错，
    # 也不能猜——猜错就是往别的标签里加人。
    cands = [r for r in rows if _tag_base(r[4]).startswith(n) or norm(r[4]).startswith(n)]
    if len(cands) == 1:
        return cands[0]
    # 短标签（如 ai）OCR 经常读丢或读花：只在「唯一含有这些字符」时认
    if 1 <= len(n) <= 3:
        loose = [r for r in rows
                 if nl and nl in _tag_base(r[4]).lower() and len(_tag_base(r[4])) <= len(n) + 2]
        if len(loose) == 1:
            return loose[0]
    return None


def click_tags_tab(mgr):
    """展开左侧「标签」分组。已经展开时**不要**再点（再点会收起来）。"""
    for _ in range(4):
        ww, wh, lines = _ocr(mgr, "mgr_tab")
        expanded = any(_is_tag_word(norm(r[4])) and
                       ("新建" in norm(r[4]) or "无" in norm(r[4]))
                       for r in lines)
        if expanded:
            return
        hit = next((r for r in lines if _is_tag_row_label(norm(r[4])) and r[1] < 300), None)
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


def _close_menu(menu):
    try:
        s.post_key(menu, 0x1B)
    except Exception:
        pass
    time.sleep(0.2)


def menu_click(menu, text):
    """点菜单项。**只用 PostMessage**：锁屏/窗口不在前台时真鼠标点不到菜单，
    而投递点击实测能直接选中「添加成员」（2026-10-20）。"""
    for attempt in range(4):
        ww, wh, lines = _ocr(menu, "menu%d" % attempt)
        hit = next((r for r in lines if norm(r[4]) == norm(text)), None)
        if hit:
            ok = s.post_click(menu, (hit[0] + hit[2]) // 2, (hit[1] + hit[3]) // 2)
            time.sleep(0.25)
            if ok:
                return
        time.sleep(0.3)
    raise RuntimeError("菜单里没有「%s」或点击失败" % text)


def open_picker(mgr, row):
    """打开「添加成员」。全程投递点击，不抢前台、锁屏也能跑。"""
    pid = _pid_of(mgr)
    for _attempt in range(3):
        p = _find_window_suffix(pid, "添加成员")
        if p:
            _restore(p["hwnd"])
            return p["hwnd"]
        menu = open_tag_menu(mgr, row)
        if menu:
            try:
                menu_click(menu, "添加成员")
            except Exception:
                _close_menu(menu)
        for _ in range(24):                            # 最多等 6 秒
            time.sleep(0.25)
            p = _find_window_suffix(pid, "添加成员")
            if p:
                _restore(p["hwnd"])
                return p["hwnd"]
        for w in _enum_windows(pid):
            if w["owner"] == mgr and "ToolSaveBits" in w["class"] and w["visible"]:
                _close_menu(w["hwnd"])
        time.sleep(0.3)
    raise RuntimeError("添加成员窗口没打开（重试 3 次）")


def _slow_type(h, text, delay=0.35):
    """逐字投递。实测一次灌多个字符时微信的标签内联编辑器**只吃第一个字**；
    单字 + 350ms 间隔能完整输入（2026-10-20）。"""
    for ch in text:
        cp = ord(ch)
        if cp > 0xFFFF:
            continue
        u.PostMessageW(ctypes.c_void_p(h), 0x0102, cp, 1)   # WM_CHAR
        time.sleep(delay)


def _paste_text(h, x, y, text):
    """右键 → 粘贴。中文 WM_CHAR 在部分 Qt 输入框里会被吃掉，剪贴板粘贴是稳定路径。
    粘贴完把用户原来的剪贴板内容还回去（项目约定：不劫持剪贴板）。"""
    old = s._clip_get_text()
    s._clip_set_text(text)
    time.sleep(0.15)
    _rclick(h, x, y)
    time.sleep(0.5)
    menu = next((w["hwnd"] for w in _enum_windows(_pid_of(h))
                 if w["visible"] and "ToolSaveBits" in w["class"]), None)
    if menu:
        ww, wh, lines = _ocr(menu, "paste_menu")
        hit = next((r for r in lines if norm(r[4]) == "粘贴"), None)
        if hit:
            s.post_click(menu, (hit[0] + hit[2]) // 2, (hit[1] + hit[3]) // 2)
    time.sleep(0.3)
    if old is not None:
        s._clip_set_text(old)


def _settle(h, tries=10):
    """等窗口几何稳定。管理窗口会在打开/提交后改一次尺寸；old OCR 坐标+新尺寸=点空。"""
    last = None
    for _ in range(tries):
        r = s.win_rect(h)
        if r == last and r[2] > 0:
            return r
        last = r
        time.sleep(0.25)
    return last


def _dismiss_empty_name(pid, mgr):
    for w in _enum_windows(pid):
        if w["visible"] and w["owner"] == mgr and w["title"] == "Weixin":
            _ww, _wh, ml = _ocr(w["hwnd"], "emptyname")
            btn = next((r for r in ml if "我知道了" in norm(r[4])), None)
            if btn:
                _click_row(w["hwnd"], *btn[:4])
                time.sleep(0.4)
                return True
    return False


def create_tag(mgr, name, existing_names, account=None, log=None):
    """新建标签并改名。返回 (标签行, 最新的 manager hwnd)。

    点「新建标签」后微信会**就地**插入一行「未命名N」并把默认名全选——光标已经在
    内联编辑器里。这里绝不能再点「新建标签」按钮（旧实现把名字粘到按钮坐标，结果
    每次都新建一个空标签），也不能点行（点行会退出编辑器）。

    ⚠️ 新建出来的编辑器**只吃第一个字**（实测：输入「控制台测试标签」只落下一个
    「控」，后续 WM_CHAR 全丢——列表模型在第一字后重建，焦点没了）。所以分两步：
    先用第一个字建出来，再走 `rename_tag`（重命名编辑器能稳定吃完整名字）。

    只尝试一次：失败就报错，宁可留一个短名标签让用户人工确认，也不连续新建垃圾。
    """
    log = log or (lambda _m: None)
    pid = _pid_of(mgr)
    _dismiss_empty_name(pid, mgr)
    _settle(mgr)
    win = _find_window(pid, "通讯录管理")
    mgr = win["hwnd"] if win else mgr
    click_tags_tab(mgr)
    _settle(mgr)
    log("  读取标签库（首次读取要解密，可能需要十几秒）…")
    before = set(db_label_names(account)) if account else set()
    _ww, _wh, lines = _ocr(mgr, "newtag_0")
    hit = next((r for r in lines if _is_new_tag_button(norm(r[4]))), None)
    if not hit:
        raise RuntimeError("找不到「新建标签」")
    _click_row(mgr, *hit[:4])
    log("  已插入标签行，正在等微信落库…")
    time.sleep(0.9)
    win = _find_window(pid, "通讯录管理")
    mgr = win["hwnd"] if win else mgr
    _settle(mgr)
    # 默认名「未命名N」是选中态，第一个字会替换它；不要先退格（清空后提交会弹
    # 「标签不能为空」，把后续操作全挡在模态框后面）。
    _slow_type(mgr, name[0], 0.5)
    time.sleep(0.3)
    # 点右栏标题区提交；这一带没有联系人行，不会选中别人
    s.post_click(mgr, 500, 60)
    time.sleep(1.0)
    win = _find_window(pid, "通讯录管理")
    mgr = win["hwnd"] if win else mgr
    _settle(mgr)
    _dismiss_empty_name(pid, mgr)
    if not account or len(name) == 1:
        log("  标签已建好")
        return None, mgr             # 是否成功由调用方回读 contact.db 判定
    if not _db_wait(account, present=[name[0]]):
        raise RuntimeError("新建标签「%s」的第一个字没落库，请人工检查标签列表" % name)
    created = [n for n in db_label_names(account) if n not in before]
    created = name[0] if name[0] in created else (created[0] if created else name[0])
    if created != name:
        log("  临时标签已落库，正在改名为「%s」…" % name)
        lines = _ocr(mgr, "newtag_rename")[2]
        # 新标签是选中态：优先认高亮行；退路是「新建标签」上方那行。
        # 不要按数据库序号对位——刚删掉、还没同步的标签会让数据库比界面多几行。
        row = selected_row_rect()
        header, none, new = _tag_anchors(lines)
        if row and ((none and row[1] <= none[3]) or (new and row[1] >= new[1])):
            row = None
        row = row or newest_tag_row(lines) or resolve_tag_row(lines, created, account)
        if not row:
            raise RuntimeError("新建出「%s」后定位不到该行，无法改成「%s」，请人工处理"
                               % (created, name))
        rename_tag(mgr, row, created, name, log=log)
        if not _db_wait(account, present=[name], absent=[created]):
            now = db_label_names(account)
            extra = [n for n in now if n not in before]
            raise RuntimeError("新建出「%s」后改成「%s」没落库；实际落库为 %s，"
                               "请人工检查标签列表"
                               % (created, name, "、".join(extra) or "无"))
    log("  标签「%s」已建好" % name)
    return None, mgr


def delete_tag(mgr, row, name=""):
    """删除标签。**用界面验证**：删除只改了微信内存态，contact.db 要等服务器同步
    才落盘（实测删完 12 秒后 contact_label 里还有），所以不能拿数据库判成功。"""
    before_lines = _ocr(mgr, "del_before")[2]
    before = len(_visible_tag_list(before_lines))
    _h0, _n0, new_before = _tag_anchors(before_lines)
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
    hit = None
    for attempt in range(4):                      # 对话框刚出来时可能还是空白帧
        ww, wh, lines = _ocr(dlg, "delconfirm%d" % attempt)
        hit = next((r for r in lines if norm(r[4]) == "删除"), None)
        if hit:
            break
        time.sleep(0.3)
    if not hit:
        raise RuntimeError("确认框里找不到「删除」")
    s.post_click(dlg, (hit[0] + hit[2]) // 2, (hit[1] + hit[3]) // 2)
    # 删除已经生效，但 PrintWindow 拿的是「最后一次绘制」的表面：界面还没重绘完就
    # 截图会读到旧列表，把成功误判成「标签还在」（实测第一张就是旧帧）。多等几帧。
    for attempt in range(8):
        time.sleep(0.4)
        win = _find_window(_pid_of(mgr), "通讯录管理")
        if win:
            mgr = win["hwnd"]
        click_tags_tab(mgr)
        lines = _ocr(mgr, "del_after%d" % attempt)[2]
        if name and find_tag_row(lines, name):
            continue
        _h1, _n1, new_after = _tag_anchors(lines)
        if new_before and new_after:
            # 删掉一行后「新建标签」会整行上移；比行数可靠——单字标签 OCR 本来就读不出来，
            # 拿它数行数会在「删的正好是读不出的那行」时误报失败。
            if new_after[1] < new_before[1] - 10:
                return True
        elif len(_visible_tag_list(lines)) < before:
            return True
    raise RuntimeError("删除后界面没有更新（标签「%s」仍在或列表没上移），请人工确认"
                       % (name or row[4]))


def rename_tag(mgr, row, old, new, log=None):
    """右键「修改标签名」→ 直接输入新名（旧名默认全选）→ 点右栏标题提交。

    踩过的坑（2026-10-21 实测）：
    - 菜单项打开的就是内联编辑器，旧名已全选；**再点一下行会退出编辑器并把旧名提交**，
      于是调用方看到「成功」但名字根本没变。
    - 先退格清空再输入，清空状态提交会弹「标签不能为空」模态框，把后面的右键菜单全挡住。
    - 右键「粘贴」同样会退出编辑器；中文用 WM_CHAR 逐字投递（0.5s 间隔）可以稳定输入。

    只按**全名/唯一前缀**匹配行（调用方保证），改名后由调用方重新 OCR 核对。
    """
    log = log or (lambda _m: None)
    pid = _pid_of(mgr)
    _dismiss_empty_name(pid, mgr)
    log("  正在输入新标签名并提交…")
    menu = open_tag_menu(mgr, row)
    if not menu:
        raise RuntimeError("右键菜单没出现")
    # 4.1.15 实测菜单项叫「修改标签名」；旧版是「重命名标签」，两版都认。
    try:
        menu_click(menu, "修改标签名")
    except RuntimeError:
        try:
            menu_click(menu, "重命名标签")
        except RuntimeError:
            menu_click(menu, "重命名")
    time.sleep(0.6)
    win = _find_window(pid, "通讯录管理")
    if win:
        mgr = win["hwnd"]
    _settle(mgr)
    _slow_type(mgr, new, 0.5)               # 替换已全选的旧名
    # 最后一个字是 WM_CHAR 投递的，提交点击来得太快会把还在队列里的末字冲掉
    # （实测「黑窗测试3」落成「黑窗测试」）。多等一拍再提交。
    time.sleep(1.0)
    s.post_click(mgr, 500, 60)              # 右栏标题区提交，不会选中联系人
    time.sleep(1.0)
    win = _find_window(pid, "通讯录管理")
    mgr = win["hwnd"] if win else mgr
    _dismiss_empty_name(pid, mgr)
    return mgr


SELECTED_RE = re.compile(r"已选择(\d+)个")


def selected_count(lines):
    for r in lines:
        m = SELECTED_RE.search(norm(r[4]))
        if m:
            return int(m.group(1))
    return None


def search_picker(picker, query):
    """把 query 输进搜索框，并**回读确认**（输入框没吃进去时结果是空的，别误判成没这个人）。"""
    r = s.win_rect(picker)
    ww, wh = r[2], r[3]
    sx, sy = int(ww * 0.247), int(wh * 0.093)
    clear_x = int(ww * 0.387)          # 搜索框右侧的清除按钮（实测 770 宽时 x≈298）
    q = norm(query)
    for attempt in range(3):
        s.post_click(picker, sx, sy)
        time.sleep(0.2)
        s.post_click(picker, clear_x, sy)       # 右侧清除按钮
        time.sleep(0.2)
        s.post_backspaces(picker, 80)
        time.sleep(0.15)
        if any(ord(c) > 127 for c in query):
            _slow_type(picker, query, 0.2)      # 中文逐字投，防掉字
        else:
            s.post_text(picker, query)
        time.sleep(1.0)
        ww2, wh2, lines = _ocr(picker, "search_chk%d" % attempt)
        box = "".join(norm(x[4]) for x in lines if x[1] < 80 and x[0] < ww2 * 0.5)
        if q and q in box:
            time.sleep(0.3)
            return True
        # 放宽回读：特殊字符/emoji（#^_^#啊国、.没u烦恼.^）OCR 常读不全，只要
        # 输入框里有 query 的**任一汉字**就算投进去了——漏读符号不该判「没进框」。
        # 汉字集：query 里所有非 ASCII、非符号的 CJK 字符（换成可打印的 ASCII 也认）。
        key_chars = [c for c in q if c and (ord(c) > 127 or c.isalnum())]
        if key_chars and any(c in box for c in key_chars):
            time.sleep(0.3)
            return True
    return False


def add_one(picker, query, expect, alias="", unique_id=False):
    """搜索并勾选一个联系人。返回 (ok, detail)。

    `alias`（微信号）是比显示名更强的身份：结果行下面会出现「微信号：xxx」副标题。
    同名好友靠它唯一命中；名字 OCR 掉了也能用副标题定位复选框。

    `unique_id=True` 表示 query 是微信号或 wxid（计划侧已唯一）：搜到多行时仍可点
    唯一精确命中；**禁止**在「只按显示名搜」时点第一行——前缀重叠（如 123 / 1234）
    会打到别人。
    """
    typed = search_picker(picker, query)
    ww, wh, lines = _ocr(picker, "picker_search")
    qn = norm(query)

    def scan(ls):
        names, subs, exact_subs = [], [], []
        for r in ls:
            if r[0] > ww * 0.5 or r[1] < 100:
                continue
            t = norm(r[4])
            if t in expect or (qn and t == qn):
                names.append(r)
            if t.startswith("微信号"):
                subs.append(r)
                # 「微信号：xxx」——精确对上 alias/query 才算唯一身份
                tail = t.split(":", 1)[-1] if ":" in t else t[3:]
                tail = norm(tail)
                if alias and tail == norm(alias):
                    exact_subs.append(r)
                elif qn and tail == qn:
                    exact_subs.append(r)
        return names, subs, exact_subs

    names, subs, exact_subs = scan(lines)
    if not names and not exact_subs:
        time.sleep(0.8)                         # 搜索结果渲染慢
        ww, wh, lines = _ocr(picker, "picker_search2")
        names, subs, exact_subs = scan(lines)

    if len(exact_subs) == 1:
        # 微信号副标题精确命中：最可靠
        row = ("sub", exact_subs[0][1] - 14, exact_subs[0][2], exact_subs[0][1] - 2)
    elif len(names) > 1:
        return False, "搜索结果有多个同名（请用微信号/wxid 再试）"
    elif len(names) == 1:
        row = names[0]
    elif len(exact_subs) == 0 and len(subs) == 1 and unique_id:
        row = ("sub", subs[0][1] - 14, subs[0][2], subs[0][1] - 2)
    elif typed and unique_id:
        # 仅当用微信号/wxid 搜时，才允许「已输入 → 点第一行」兜底
        cand = [r for r in lines if r[0] < ww * 0.5 and r[1] > 100 and r[4].strip()]
        if cand:
            row = cand[0]
            s.post_click(picker, int(ww * 0.074), row[1] + 6)
            time.sleep(0.4)
            ww2, wh2, lines2 = _ocr(picker, "picker_tick_fallback")
            after = selected_count(lines2)
            if after is not None and after > 0:
                return True, "已勾选（唯一 ID）"
            return False, "勾选未确认（唯一 ID）"
        return False, "搜索无结果"
    elif typed and not unique_id:
        return False, "按显示名搜到多人/未精确命中，已拒绝点选以免打错人（请用微信号）"
    else:
        return False, "搜索无结果" + ("" if typed else "（搜索词没进输入框）")
    if row[0] == "sub":
        cbx, cby = int(ww * 0.074), row[1]
    else:
        cbx, cby = int(ww * 0.074), row[1] + 6
    before = selected_count(lines)
    s.post_click(picker, cbx, cby)
    time.sleep(0.4)
    ww2, wh2, lines2 = _ocr(picker, "picker_tick")
    after = selected_count(lines2)
    # 点的是**唯一命中**的结果行；计数只要涨了就认。before 读不到（None）时也认 after>0：
    # 之前要求 before 非空，把「已勾选但计数没读全」误判成失败，恢复时白重试。
    if after is not None and (before is None and after > 0 or before is not None and after == before + 1):
        return True, "已勾选"
    # 计数读不到时，用右侧「已选择」面板里的名字兜底
    right = [norm(r[4]) for r in lines2 if r[0] > ww2 * 0.5 and r[1] > 80]
    if any(t in right for t in expect) or (alias and any(t.endswith(norm(alias)) for t in right)):
        return True, "已勾选（面板确认）"
    return False, "勾选未确认（before=%s after=%s）" % (before, after)


def finish_picker(picker, commit):
    """点完成/取消。返回窗口是否真的关掉了（完成没生效时不能把联系人记成已加）。"""
    r = s.win_rect(picker)
    ww, wh = r[2], r[3]
    x = int(ww * (0.618 if commit else 0.742))
    y = int(wh * 0.897)
    for _ in range(2):
        s.post_click(picker, x, y)
        time.sleep(1.0)
        if _find_window_suffix(_pid_of(picker), "添加成员") is None:
            return True
    return False


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
    n_tag = sum(1 for c in people if c["taggable"])
    print("已导出 %d 行到 %s（联系人 %d：可打标签的好友 %d，陌生人 %d；标签 %d 个，已有成员 %d 人次）"
          % (len(main_rows), args.out, len(people), n_tag, len(people) - n_tag,
             len(labels), sum(len(v) for v in members.values())))


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


def apply_core(acc, pending, state_path, state, known_tags, *,
               cancel_event=None, cancel_path=None, log=print, on_progress=None):
    """真正跑「添加成员」。`pending` 已按状态过滤/限流。

    返回 `{total, processed, added, failed, cancelled, tags}`。
    **状态只在「完成」成功且库里核对到之后才记 done**——否则一次崩溃/取消会把
    没提交的勾选记成已完成，下次续跑就永远跳过它们。
    """
    total = len(pending)
    stats = {"total": total, "processed": 0, "added": 0, "failed": 0,
             "cancelled": False, "tags": []}

    def emit(**kw):
        if on_progress:
            d = dict(stats)
            d.update(kw)
            on_progress(d)

    def is_cancelled():
        return ((cancel_event is not None and cancel_event.is_set())
                or bool(cancel_path and os.path.exists(cancel_path)))

    by_tag = {}
    for p in pending:
        by_tag.setdefault(p["group"], []).append(p)
    if not by_tag:
        emit(state="done")
        return stats

    mgr = ensure_manager(acc)
    click_tags_tab(mgr)
    ww, wh, lines = _ocr(mgr, "mgr_tags")
    existing_names = [norm(r[4]) for r in tag_rows(lines)]
    known = set(known_tags)

    for tag, items in by_tag.items():
        if is_cancelled():
            stats["cancelled"] = True
            break
        # 微信可能在上一次操作后重建了 manager 窗口，每轮都按标题重新拿一次
        win = _find_window(acc["pid"], "通讯录管理")
        if not win:
            raise RuntimeError("通讯录管理窗口不见了（可能被关掉了）")
        mgr = win["hwnd"]
        click_tags_tab(mgr)
        ww, wh, lines = _ocr(mgr, "mgr_before_" + hashlib.md5(tag.encode()).hexdigest()[:6])
        # 短标签 OCR 常读不出字，必须走 resolve（含按库顺序对位），不能只用 find
        row = resolve_tag_row(lines, tag, acc["wxid"])
        if not row:
            if tag in known:
                raise RuntimeError("标签「%s」在库里存在，但界面上定位不到（可能被滚动或 OCR 读花了）。"
                                   "把通讯录管理的标签列表滚到该标签可见后再试；"
                                   "别让工具新建同名重复标签。" % tag)
            log("[新建标签] %s" % tag)
            _row, mgr = create_tag(mgr, tag, existing_names, acc["wxid"], log=log)
            if not _db_wait(acc["wxid"], present=[tag]):
                raise RuntimeError("新建标签「%s」没落库（可能弹了「标签不能为空」）" % tag)
            existing_names.append(norm(tag))
            known.add(tag)
            ww, wh, lines = _ocr(mgr, "mgr_afternew")
            row = resolve_tag_row(lines, tag, acc["wxid"])
            if not row:
                raise RuntimeError("新建的标签「%s」在界面上定位不到（OCR 读不出），请人工确认" % tag)
        before_members = db_tag_members(acc["wxid"], tag)
        log("[标签] %s：现有 %d 人，本批待加 %d 人" % (tag, len(before_members), len(items)))
        emit(tag=tag, current="", state="running")
        log("  打开「添加成员」…")
        picker = open_picker(mgr, row)
        ticked, failed_local = [], []
        try:
            for p in items:
                if is_cancelled():
                    stats["cancelled"] = True
                    break
                display = p["display"]
                alias = p["alias_resolved"] or p["alias"]
                wxid = p.get("username_resolved") or p.get("username") or ""
                # 搜索优先：微信号 > wxid > 显示名。显示名同名/前缀重叠时微信会返回多人，
                # 绝不能点「第一行」——那会打到别人身上。
                query = alias or wxid or display
                expect = {norm(display)}
                if alias:
                    expect.add(norm(alias))
                if wxid:
                    expect.add(norm(wxid))
                # 先亮出「当前」，搜索/勾选这几秒里界面不会停在 0/1 不动
                emit(tag=tag, current=display, state="running")
                # 和发送链共用一把跨进程 UI 锁：每个联系人只占 ~2 秒，代聊的发送可以插空
                lock = s._acquire_ui(timeout=120)
                if lock is None:
                    ok, detail = False, "微信 UI 被占用（busy）"
                else:
                    try:
                        ok, detail = add_one(picker, query, expect, alias,
                                             unique_id=bool(alias or wxid))
                    finally:
                        s._release_ui(lock)
                stats["processed"] += 1
                if ok:
                    ticked.append(p)
                    log("  %3d/%d %-24s ok" % (stats["processed"], total, display[:24]))
                else:
                    failed_local.append((p, detail))
                    log("  %3d/%d %-24s FAIL %s"
                        % (stats["processed"], total, display[:24], detail))
                emit(tag=tag, current=display, state="running")
                time.sleep(random.uniform(1.0, 2.2))

            if is_cancelled():
                finish_picker(picker, commit=False)
                stats["cancelled"] = True
                for p, detail in failed_local:
                    state["failed"][_key_of(p)] = detail
                for p in ticked:
                    state["failed"][_key_of(p)] = "取消前已勾选但未提交"
                _save_state(state_path, state)
                break

            if ticked:
                closed = finish_picker(picker, commit=True)
                if closed:
                    after = wait_tag_members(acc["wxid"], tag, len(before_members) + len(ticked))
                    for p in ticked:
                        key = _key_of(p)
                        if p["username_resolved"] in after:
                            state["done"][key] = int(time.time())
                            state["failed"].pop(key, None)
                            stats["added"] += 1
                        else:
                            state["failed"][key] = "完成后面库里没有"
                            stats["failed"] += 1
                    log("  完成：勾选 %d，库里现有 %d 人" % (len(ticked), len(after)))
                else:
                    log("  完成按钮没生效，已取消本次标签")
                    finish_picker(picker, commit=False)
                    for p in ticked:
                        state["failed"][_key_of(p)] = "完成按钮没生效"
                        stats["failed"] += 1
            else:
                finish_picker(picker, commit=False)
                log("  没有成功勾选，已取消（未改标签）")
            for p, detail in failed_local:
                state["failed"][_key_of(p)] = detail
                stats["failed"] += 1
            _save_state(state_path, state)
        finally:
            p2 = _find_window_suffix(acc["pid"], "添加成员")
            if p2:
                finish_picker(p2["hwnd"], commit=False)
        stats["tags"].append({"tag": tag, "ticked": len(ticked),
                              "failed": len(failed_local),
                              "existing": len(before_members)})
        emit(tag=tag, current="", state="running")

    _save_state(state_path, state)
    emit(state="cancelled" if stats["cancelled"] else "done")
    return stats


def cmd_apply(args):
    acc = pick_account(args.account)
    rows, sheet = load_rows(args.excel, args.sheet, None)
    contacts, labels, members = load_contacts(acc["wxid"])
    plan = build_plan(rows, contacts, labels, members)
    todo = [p for p in plan if p["status"] == "to_add"]
    print("账号 %s，工作表 %s：待加 %d 行" % (acc["wxid"], sheet, len(todo)))
    if not todo:
        return
    if not args.limit and not args.yes:
        raise SystemExit("要写 %d 个联系人，确认后加 --yes（或先用 --limit 20 试一批）" % len(todo))

    state_path = args.state or default_state_path(args.excel, acc["wxid"])
    state = _load_state(state_path, args.fresh)
    if state.get("account") and state["account"] != acc["wxid"]:
        raise SystemExit("状态文件属于账号 %s，不是 %s（换账号请用 --state 另指一份）"
                         % (state["account"], acc["wxid"]))
    state["account"] = acc["wxid"]
    pending = [p for p in todo if not state["done"].get(_key_of(p))]
    if args.limit:
        pending = pending[:args.limit]
    if not pending:
        print("没有需要新加的（断点续传已全部完成）")
        return

    res = apply_core(acc, pending, state_path, state, set(labels.values()), log=print)
    fails = [(k, v) for k, v in state["failed"].items()
             if k in {_key_of(p) for p in pending}]
    if fails:
        print("\n失败 %d 个（重跑会再试；明细在状态文件里）：" % len(fails))
        for k, v in fails[:20]:
            print("  %s  %s" % (k.split("|")[0], v))
    print("\n完成：新增 %d，失败 %d%s" % (res["added"], res["failed"],
                                         "，已取消" if res["cancelled"] else ""))
    print("状态文件：%s（重跑会跳过已完成的）" % state_path)


# ---------------- 后台任务（MCP 用：父进程只负责起 worker，进度写文件） ----------------
#
# 为什么是**子进程**而不是线程：MCP server 的主线程还要继续处理别的工具调用，而
# wechat_core 的镜像缓存 / 账号覆盖都是进程级的全局状态。标签任务跑 30–60 分钟，
# 用线程会和主线程的读库互相踩。子进程有自己的全局状态，UI 锁仍是跨进程的，互不干扰。

_K32 = ctypes.WinDLL("kernel32", use_last_error=True) if os.name == "nt" else None
if _K32:
    _K32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_uint32]
    _K32.OpenProcess.restype = ctypes.c_void_p
    _K32.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
    _K32.CloseHandle.argtypes = [ctypes.c_void_p]


def _tag_root():
    p = os.path.join(os.path.expanduser("~"), ".lumii", "wechat-tags")
    os.makedirs(p, exist_ok=True)
    return p


def _jobs_dir():
    p = os.path.join(_tag_root(), "jobs")
    os.makedirs(p, exist_ok=True)
    return p


def _job_paths(job_id):
    d = _jobs_dir()
    return (os.path.join(d, job_id + ".json"),
            os.path.join(d, job_id + ".job.json"),
            os.path.join(d, job_id + ".cancel"),
            os.path.join(d, job_id + ".log"))


def _write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _acquire_job_lock():
    """跨进程只允许一个打标签任务（发送链那把 UI 锁是每个联系人一把，不是整段）。"""
    if msvcrt is None:
        return True
    path = os.path.join(_tag_root(), "job.lock")
    try:
        fh = open(path, "a+")
    except Exception:
        return None
    try:
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        return fh
    except OSError:
        fh.close()
        return None


def _release_job_lock(fh):
    if fh in (None, True):
        return
    try:
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
    except Exception:
        pass
    try:
        fh.close()
    except Exception:
        pass


def _pid_alive(pid):
    if not pid:
        return False
    if not _K32:
        return True
    h = _K32.OpenProcess(0x1000, False, int(pid))       # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return False
    code = ctypes.c_uint32()
    ok = _K32.GetExitCodeProcess(h, ctypes.byref(code))
    _K32.CloseHandle(h)
    return bool(ok) and code.value == 259                # STILL_ACTIVE


def _latest_job_id():
    d = _jobs_dir()
    files = [f for f in os.listdir(d) if f.endswith(".json") and not f.endswith(".job.json")]
    if not files:
        return None
    files.sort(key=lambda f: os.path.getmtime(os.path.join(d, f)), reverse=True)
    return files[0][:-5]


def _prune_jobs(keep=30):
    d = _jobs_dir()
    files = [f for f in os.listdir(d) if f.endswith(".json") and not f.endswith(".job.json")]
    files.sort(key=lambda f: os.path.getmtime(os.path.join(d, f)), reverse=True)
    for f in files[keep:]:
        jid = f[:-5]
        for p in _job_paths(jid):
            try:
                os.remove(p)
            except OSError:
                pass


def _spawn_worker(job_path, log_path):
    if getattr(sys, "frozen", False):
        args = [sys.executable, "--tag-worker", job_path]
    else:
        args = [sys.executable, os.path.abspath(__file__), "--tag-worker", job_path]
    flags = 0x08000000 if os.name == "nt" else 0        # CREATE_NO_WINDOW
    log = open(log_path, "ab")
    try:
        return subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log,
                                stderr=subprocess.STDOUT, close_fds=True,
                                creationflags=flags)
    finally:
        log.close()


def _err(code, detail, **extra):
    out = {"ok": False, "error_code": code, "detail": detail}
    out.update(extra)
    return out


def _mcp_prepare(account, excel, sheet, assignments):
    acc = pick_account(account)
    rows, sheet_name = load_rows(excel, sheet, assignments)
    contacts, labels, members = load_contacts(acc["wxid"])
    plan = build_plan(rows, contacts, labels, members)
    return acc, rows, sheet_name, contacts, labels, members, plan


def _exact_tag_row(lines, name):
    n = norm(name)
    return next((r for r in tag_rows(lines) if norm(r[4]) == n), None)


def db_label_names(account):
    """按 sort_order 返回标签名列表（只读本地解密镜像，用作界面操作的**真实结果**）。

    OCR 会把「临时测试A」读成「临时测讠」、把「未命名0」读成「未命芒」——拿 OCR 当
    成功判据会误报失败。界面写完会立刻落到 contact.db，这里回读数据库最可靠。
    """
    _rows, labels, _members = load_contacts(account)
    return list(labels.values())        # SQL 已按 sort_order_ 排序，dict 保序


# 删除标签后 contact_label 要等微信与服务器同步才清理（实测几分钟）。界面已经没了，
# 数据库还在——控制台会先把它藏起来，这里也按同一份名单过滤，否则按数据库序号
# 对位行坐标会整体错位（删一个标签后，下一个标签会点到上面一行）。
HIDDEN_PATH = os.path.join(os.path.expanduser("~"), ".lumii", "wechat-crm",
                           "hidden-labels.json")
_HIDDEN_TTL = 7 * 86400


def _hidden_map():
    try:
        return json.load(open(HIDDEN_PATH, encoding="utf-8"))
    except Exception:
        return {}


def _hidden_save(data):
    try:
        os.makedirs(os.path.dirname(HIDDEN_PATH), exist_ok=True)
        tmp = HIDDEN_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, HIDDEN_PATH)
    except Exception:
        pass


def hidden_set(account, name, on=True):
    """把「界面已删、数据库还没同步」的标签记下来（on=False 表示恢复显示）。"""
    data = _hidden_map()
    row = data.setdefault(account, {})
    if on:
        row[name] = int(time.time())
    else:
        row.pop(name, None)
    if not row:
        data.pop(account, None)
    _hidden_save(data)


def visible_label_names(account):
    """数据库标签名 - 已删除未同步的标签 = 界面上真正看得见的标签。"""
    names = db_label_names(account)
    hidden = _hidden_map().get(account) or {}
    if not hidden:
        return names
    now, have = time.time(), set(names)
    keep = {n: ts for n, ts in hidden.items() if n in have and now - ts < _HIDDEN_TTL}
    if keep != hidden:                    # 已同步 / 已过期 → 清掉，别永久藏真标签
        data = _hidden_map()
        data[account] = keep
        if not keep:
            data.pop(account, None)
        _hidden_save(data)
    return [n for n in names if n not in keep]


def _tag_anchors(lines):
    """标签列表的三个锚点：分组标题「标签」、「无标签」行、「新建标签」按钮。"""
    header = next((r for r in lines if _is_tag_row_label(norm(r[4]))), None)
    new = next((r for r in lines if _is_new_tag_button(norm(r[4]))), None)
    none = None
    if header:
        none = next((r for r in tag_rows(lines)
                     if header[1] < r[1] < (new[1] if new else 10 ** 9)
                     and norm(r[4]).startswith("无标")), None)
    return header, none, new


def _tag_row_height(none, lines):
    """标签行的行距：优先用 OCR 读到的两个相邻标签行反推，否则按文字高度估。

    这个值只用来判断「界面上到底有几行」，不能拿数据库标签数反推——删掉的标签
    在服务器同步前还留在 contact_label 里，但界面已经不显示了。
    """
    # 只数「无标签」和「新建标签」之间的行；下面的「最近群聊」也会落进 tag_rows，
    # 它和最后一个标签的间距会被当成行距（实测 80px），把可见行数算成 0。
    _h, _n, new = _tag_anchors(lines)
    limit = new[1] if new else 10 ** 9
    detected = sorted((r for r in tag_rows(lines)
                       if none[1] < r[1] < limit
                       and not norm(r[4]).startswith("无标")
                       and not _is_new_tag_button(norm(r[4]))),
                      key=lambda r: r[1])
    gaps = [b[1] - a[1] for a, b in zip(detected, detected[1:]) if 20 <= b[1] - a[1] <= 80]
    if gaps:
        return sorted(gaps)[len(gaps) // 2]
    return max(30.0, (none[3] - none[1]) * 2.8)


def _visible_label_count(lines):
    header, none, new = _tag_anchors(lines)
    if not none or not new:
        return None
    step = _tag_row_height(none, lines)
    n = int(round((new[1] - none[1]) / step)) - 1
    return n if n >= 0 else None


def _synth_tag_rows(lines, account):
    """OCR 读不出短标签（「打」「黑」「ai」这类会被整行丢掉）时，按数据库顺序算行位。

    微信标签列表按 `sort_order_` 排，顺序和 `contact_label` 一致；「无标签」和
    「新建标签」之间等距。优先要求「界面可见行数 == 数据库标签数」；短标签场景
    下 OCR 行距偶发偏差 ±1 时，仍允许对位（否则「ai」永远点不到）。
    """
    try:
        names = visible_label_names(account)
    except Exception:
        return []
    header, none, new = _tag_anchors(lines)
    if not none or not new or not names:
        return []
    vis = _visible_label_count(lines)
    if vis is None:
        return []
    if abs(vis - len(names)) > 1:
        return []
    # 以数据库标签数为准均分行距（短标签 OCR 丢字时 vis 可能偏）
    step = (new[1] - none[1]) / (len(names) + 1)
    if not 18 <= step <= 90:
        return []
    cy0 = none[1] + (none[3] - none[1]) / 2
    x0, x1 = none[0], max(none[2], none[0] + 80)
    return [(x0, int(cy0 + step * (i + 1) - 7),
             x1, int(cy0 + step * (i + 1) + 7), n)
            for i, n in enumerate(names)]


def newest_tag_row(lines):
    """新建后的标签一定在「新建标签」正上方一行（微信把新标签插在列表末尾）。"""
    header, none, new = _tag_anchors(lines)
    if not new or not none:
        return None
    step = _tag_row_height(none, lines)
    n = int(round((new[1] - none[1]) / step)) - 1
    if n < 1:                                # 一行标签都没有
        return None
    # 用「无标签」行中心 + n 个行距算最后一行；拿「新建标签」减半行距会差十几像素，
    # 点到行底边右键菜单出不来。
    cy = none[1] + (none[3] - none[1]) / 2 + step * n
    x0, x1 = none[0], max(none[2], none[0] + 80)
    return (x0, int(cy - 7), x1, int(cy + 7), "")


def resolve_tag_row(lines, name, account=None):
    """先在 OCR 里按全名/唯一前缀找；读不出来时按数据库顺序对位。

    对位只在目标行确实落在「无标签」和「新建标签」之间时启用——列表被滚动/截断
    时放弃，绝不猜。
    """
    row = find_tag_row(lines, name)
    if row or not account:
        return row
    try:
        names = visible_label_names(account)
    except Exception:
        return None
    if name not in names:
        return None
    rows = _synth_tag_rows(lines, account)
    if len(rows) != len(names):
        return None
    row = rows[names.index(name)]
    _header, none, new = _tag_anchors(lines)
    if none and row[3] <= none[1]:
        return None
    if new and row[1] >= new[1]:
        return None
    # 合成行和实际高亮行有重叠 → 用高亮框（新标签默认选中，行高估算常差十几像素）
    rect = selected_row_rect()
    if rect and rect[1] < row[3] and rect[3] > row[1]:
        return rect + (name,)
    return row


def _visible_tag_list(lines):
    """「标签」标题与「新建标签」之间的行，去掉首行「无标签」，按 y 排序。

    只用于删除后的界面验证（数据库在删除后要等服务器同步才更新），因此不做
    数据库对位；短标签可能读不出来，删除是否生效另看「新建标签」是否上移。
    """
    header, none, new = _tag_anchors(lines)
    if not header or not new:
        return []
    rows = [r for r in tag_rows(lines) if header[1] < r[1] < new[1]]
    if none:
        rows = [r for r in rows if r[1] != none[1]]
    return rows


def _mgr_state(acc):
    mgr = ensure_manager(acc)
    # 上次失败可能留下「标签不能为空」模态框；它在 PrintWindow 里不可见，却会挡住
    # 所有右键菜单。每次进管理窗口先清掉。
    _dismiss_empty_name(_pid_of(mgr), mgr)
    click_tags_tab(mgr)
    _ww, _wh, lines = _ocr(mgr, "mgr_tag_manage")
    return mgr, lines


def _db_wait(account, present=(), absent=(), tries=8):
    """等 contact.db 落地（界面写入是同步的，镜像刷新偶尔慢一两百毫秒）。"""
    for i in range(tries):
        try:
            names = set(db_label_names(account))
        except Exception:
            names = set()
        if all(n in names for n in present) and not any(n in names for n in absent):
            return True
        time.sleep(0.25)
    return False


def _tag_manage_error(e):
    if isinstance(e, SystemExit):
        return _err("bad_args", str(e))
    if isinstance(e, core.EnvError):
        return _err("env_not_ready", str(e))
    if isinstance(e, RuntimeError):
        return _err("ui_failed", str(e))
    return _err("internal_error", "%s: %s" % (type(e).__name__, e))


def mcp_tag_create(account=None, name=None):
    """在微信通讯录管理里新建一个标签（已存在则直接返回 existed）。"""
    name = str(name or "").strip()
    if not name:
        return _err("bad_args", "标签名不能为空")
    try:
        acc = pick_account(account)
        raw = db_label_names(acc["wxid"])
        if name in raw:
            if name in visible_label_names(acc["wxid"]):
                return {"ok": True, "name": name, "created": False, "existed": True}
            return _err("busy",
                        "标签「%s」刚删除，微信本地库还没同步；现在建同名会出两条记录"
                        % name, suggestion="等一分钟再建，或换一个名字")
        before = set(raw)
        mgr, _lines = _mgr_state(acc)
        create_tag(mgr, name, [], acc["wxid"])
        if not _db_wait(acc["wxid"], present=[name]):
            extra = [n for n in db_label_names(acc["wxid"]) if n not in before]
            raise RuntimeError("新建标签「%s」没落库（可能弹了「标签不能为空」）；"
                               "实际落库为 %s。工具不会自动删标签，请到标签列表人工检查"
                               % (name, "、".join(extra) or "无"))
        hidden_set(acc["wxid"], name, False)
        return {"ok": True, "name": name, "created": True, "existed": False}
    except Exception as e:                                  # noqa: BLE001
        return _tag_manage_error(e)


def mcp_tag_rename(account=None, old=None, new=None):
    """重命名标签（只按全名精确匹配；新旧名相同直接返回）。"""
    old, new = str(old or "").strip(), str(new or "").strip()
    if not old or not new:
        return _err("bad_args", "旧标签名和新标签名都不能为空")
    if old == new:
        return {"ok": True, "old": old, "new": new, "renamed": False}
    try:
        acc = pick_account(account)
        names = visible_label_names(acc["wxid"])
        if old not in names:
            return _err("target_not_found", "找不到标签「%s」" % old)
        if new in names:
            return _err("bad_args", "标签「%s」已经存在" % new)
        mgr, lines = _mgr_state(acc)
        row = resolve_tag_row(lines, old, acc["wxid"])
        if not row:
            return _err("target_not_found",
                        "界面上定位不到标签「%s」（列表被滚动或 OCR 读不出，先滚到可见再试）" % old)
        rename_tag(mgr, row, old, new)
        if not _db_wait(acc["wxid"], present=[new], absent=[old]):
            now = db_label_names(acc["wxid"])
            extra = [n for n in now if n not in names]
            return _err("ui_failed",
                        "改名没落库（旧名还在或新名没出现）；实际落库为 %s，"
                        "请手动检查标签列表" % ("、".join(extra) or "无"))
        hidden_set(acc["wxid"], old, False)
        hidden_set(acc["wxid"], new, False)
        return {"ok": True, "old": old, "new": new, "renamed": True}
    except Exception as e:                                  # noqa: BLE001
        return _tag_manage_error(e)


def mcp_tag_delete(account=None, name=None):
    """删除标签（只按全名精确匹配；会同时移除该标签下的成员关系）。"""
    name = str(name or "").strip()
    if not name:
        return _err("bad_args", "标签名不能为空")
    try:
        acc = pick_account(account)
        mgr, lines = _mgr_state(acc)
        row = resolve_tag_row(lines, name, acc["wxid"])
        if not row:
            return _err("target_not_found",
                        "找不到标签「%s」（或列表被滚动/OCR 读不出，先滚到可见再试）" % name)
        delete_tag(mgr, row, name)
        hidden_set(acc["wxid"], name, True)
        out = {"ok": True, "name": name, "deleted": True}
        try:
            if name in db_label_names(acc["wxid"]):
                out["note"] = "微信本地库要等服务器同步才清理这张标签；界面已删除，控制台会先隐藏它"
        except Exception:
            pass
        return out
    except Exception as e:                                  # noqa: BLE001
        return _tag_manage_error(e)


def mcp_plan(account=None, excel=None, sheet=None, assignments=None):
    """只读计划：不碰微信界面，不写标签。"""
    try:
        acc, rows, sheet_name, contacts, labels, members, plan = \
            _mcp_prepare(account, excel, sheet, assignments)
        summary = summarize_plan(plan, labels, members)
        if excel:
            report = os.path.splitext(excel)[0] + ".plan.csv"
        else:
            d = os.path.join(_tag_root(), "reports")
            os.makedirs(d, exist_ok=True)
            report = os.path.join(d, "plan-%s.csv" % time.strftime("%Y%m%d-%H%M%S"))
        write_report(plan, report)
        out = {"ok": True, "account": acc["wxid"], "sheet": sheet_name,
               "total": len(plan), "report_path": report}
        out.update(summary)
        return out
    except SystemExit as e:
        return _err("bad_args", str(e))
    except ValueError as e:
        return _err("bad_args", str(e))
    except core.EnvError as e:
        return _err("env_not_ready", str(e))
    except Exception as e:
        return _err("internal_error", "%s: %s" % (type(e).__name__, e))


def mcp_start(account=None, excel=None, sheet=None, assignments=None, limit=20,
              confirm=False, state=None, fresh=False):
    """起一个后台打标签任务。默认 limit=20 且必须 confirm=true；limit=0 表示全部。"""
    if not confirm:
        p = mcp_plan(account=account, excel=excel, sheet=sheet, assignments=assignments)
        if p.get("ok"):
            p.update({"dry_run": True, "need_confirm": True,
                      "hint": "确认后传 confirm=true 才会真正写微信；limit 默认 20，0=全部"})
        return p
    try:
        acc, rows, sheet_name, contacts, labels, members, plan = \
            _mcp_prepare(account, excel, sheet, assignments)
        todo = [p for p in plan if p["status"] == "to_add"]
        lim = 20 if limit is None else int(limit)
        if lim < 0:
            return _err("bad_args", "limit 必须 >= 0（0=全部）")
        state_path = state or default_state_path(excel, acc["wxid"], assignments)
        st = _load_state(state_path, fresh)
        if st.get("account") and st["account"] != acc["wxid"]:
            return _err("bad_args", "状态文件属于账号 %s，不是 %s（换账号请用 state 另指一份）"
                        % (st["account"], acc["wxid"]))
        st["account"] = acc["wxid"]
        pending = [p for p in todo if not st["done"].get(_key_of(p))]
        if lim:
            pending = pending[:lim]
        summary = summarize_plan(plan, labels, members)
        if not pending:
            return {"ok": True, "done": True, "account": acc["wxid"], "total": 0,
                    "state_path": state_path, "plan": summary}
        cur = _latest_job_id()
        if cur:
            js = _read_json(_job_paths(cur)[0])
            if js and js.get("state") in ("starting", "running") and _pid_alive(js.get("pid")):
                return _err("busy", "已有打标签任务在跑（%s），先 tag_status/tag_cancel" % cur,
                            job_id=cur)
        _prune_jobs()
        job_id = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
        status_path, job_path, cancel_path, log_path = _job_paths(job_id)
        _write_json(job_path, {
            "job_id": job_id, "account": acc["wxid"], "acc": acc,
            "pending": pending, "state_path": state_path,
            "known_tags": sorted(set(labels.values())), "cancel_path": cancel_path,
        })
        try:
            os.remove(cancel_path)
        except OSError:
            pass
        status = {"job_id": job_id, "state": "starting", "account": acc["wxid"],
                  "started": int(time.time()), "updated": int(time.time()),
                  "total": len(pending), "processed": 0, "added": 0, "failed": 0,
                  "tag": "", "current": "", "pid": None, "error": None,
                  "state_path": state_path, "log": []}
        _write_json(status_path, status)
        try:
            proc = _spawn_worker(job_path, log_path)
        except Exception as e:
            status.update({"state": "failed", "error": "启动 worker 失败：%s" % e})
            _write_json(status_path, status)
            return _err("internal_error", status["error"], job_id=job_id)
        status["pid"] = proc.pid
        _write_json(status_path, status)
        return {"ok": True, "job_id": job_id, "pid": proc.pid, "total": len(pending),
                "state_path": state_path, "plan": summary,
                "hint": "用 tag_status(job_id) 轮询；取消用 tag_cancel"}
    except SystemExit as e:
        return _err("bad_args", str(e))
    except ValueError as e:
        return _err("bad_args", str(e))
    except core.EnvError as e:
        return _err("env_not_ready", str(e))
    except Exception as e:
        return _err("internal_error", "%s: %s" % (type(e).__name__, e))


def mcp_status(job_id=None):
    jid = job_id or _latest_job_id()
    if not jid:
        return {"ok": True, "job": None}
    st = _read_json(_job_paths(jid)[0])
    if not st:
        return _err("bad_args", "找不到任务：%s" % jid)
    if st.get("state") in ("starting", "running") and st.get("pid") and not _pid_alive(st["pid"]):
        st["state"] = "interrupted"
        st["error"] = st.get("error") or "worker 进程已退出（被杀/崩溃），重跑会从断点继续"
        _write_json(_job_paths(jid)[0], st)
    return {"ok": True, "job": st}


def mcp_cancel(job_id=None):
    jid = job_id or _latest_job_id()
    if not jid:
        return {"ok": True, "job": None}
    st = _read_json(_job_paths(jid)[0])
    if not st:
        return _err("bad_args", "找不到任务：%s" % jid)
    if st.get("state") not in ("starting", "running"):
        return {"ok": True, "job": st, "note": "任务已经不在运行"}
    try:
        open(_job_paths(jid)[2], "w").close()
    except Exception as e:
        return _err("internal_error", "写取消标记失败：%s" % e)
    return {"ok": True, "job_id": jid,
            "note": "已请求取消；会在当前联系人完成后停下（未点完成的那一批不会提交）"}


def run_worker(job_path):
    """子进程入口：`python wechat_tags.py --tag-worker <job.json>` 或 MCP exe 的代工模式。"""
    job = _read_json(job_path)
    if not job:
        return 2
    jid = job["job_id"]
    status_path, job_path2, cancel_path, _log_path = _job_paths(jid)
    status = _read_json(status_path) or {
        "job_id": jid, "state": "starting", "total": len(job.get("pending") or []),
        "processed": 0, "added": 0, "failed": 0, "log": [],
    }

    lock = _acquire_job_lock()
    if msvcrt is not None and lock is None:
        status.update({"state": "failed", "error": "busy：另一个打标签任务在跑",
                       "updated": int(time.time())})
        _write_json(status_path, status)
        return 2
    status.update({"state": "running", "pid": os.getpid(), "updated": int(time.time())})
    _write_json(status_path, status)

    def log_fn(msg):
        status["updated"] = int(time.time())
        status.setdefault("log", []).append(msg[:300])
        if len(status["log"]) > 80:
            status["log"] = status["log"][-80:]
        _write_json(status_path, status)

    def on_progress(d):
        for k in ("processed", "total", "added", "failed", "tag", "current"):
            if k in d:
                status[k] = d[k]
        if d.get("state") in ("done", "cancelled", "failed"):
            status["state"] = d["state"]
        status["updated"] = int(time.time())
        _write_json(status_path, status)

    try:
        state = _load_state(job["state_path"])
        res = apply_core(job["acc"], job["pending"], job["state_path"], state,
                         set(job.get("known_tags") or []),
                         cancel_path=cancel_path, log=log_fn, on_progress=on_progress)
        status.update({"state": "cancelled" if res["cancelled"] else "done",
                       "processed": res["processed"], "added": res["added"],
                       "failed": res["failed"], "result": res, "error": None,
                       "updated": int(time.time())})
    except BaseException as e:
        # 自动化里大量用 SystemExit 报可读错误；它是 BaseException，只 catch Exception
        # 会让 worker 直接退出、状态永远停在 running（界面只能报“进程已退出”）。
        status.update({"state": "failed", "error": "%s: %s" % (type(e).__name__, e),
                       "traceback": traceback.format_exc()[-2000:],
                       "updated": int(time.time())})
    finally:
        _release_job_lock(lock)
        _write_json(status_path, status)
        try:
            os.remove(cancel_path)
        except OSError:
            pass
    return 0 if status["state"] == "done" else 1


def main():
    if "--tag-worker" in sys.argv:
        i = sys.argv.index("--tag-worker")
        if i + 1 >= len(sys.argv):
            raise SystemExit(2)
        raise SystemExit(run_worker(sys.argv[i + 1]))
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
