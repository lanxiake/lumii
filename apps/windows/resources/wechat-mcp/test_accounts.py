# -*- coding: utf-8 -*-
"""多账号路由的自检：账号切换 / 窗口 fail-closed / 工具 schema / hook 按账号匹配。

不碰真实微信：只替换 `list_accounts` 与 `wxinstances.window_for_account`。
跑法：python test_accounts.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import wechat_core as core
import wechat_sender as sender
import wechat_hook
import wxinstances
import server

failed = 0


def check(name, cond, detail=""):
    global failed
    if cond:
        print(f"  ✅ {name}")
    else:
        failed += 1
        print(f"  ❌ {name} {detail}")


# ---------------------------------------------------------------- 1. 路径解析
p = r"\Device\HarddiskVolume3\Users\u\Documents\xwechat_files\wxid_abc123_1a2b\db_storage\message\message_0.db"
m = wxinstances._WXID_RE.search(p)
check("从数据目录路径解析 wxid", bool(m) and m.group(1) == "wxid_abc123", m.group(1) if m else "None")

# ---------------------------------------------------------------- 2. 账号切换
orig_accounts = core.list_accounts
core.list_accounts = lambda: [
    {"wxid": "wxid_a", "dir": "wxid_a_0001", "root": "R_A", "source": "test"},
    {"wxid": "wxid_b", "dir": "wxid_b_0002", "root": "R_B", "source": "test"},
]
try:
    core.set_account("wxid_b")
    check("set_account 选中 b", core.db_root() == "R_B", core.db_root())
    core.set_account("wxid_a")
    check("set_account 选中 a", core.db_root() == "R_A", core.db_root())
    core.set_account(None)
    check("清空后回到默认（第一个账号）", core.db_root() == "R_A", core.db_root())
    core.set_account("wxid_ghost")
    try:
        core.db_root()
        check("未知账号必须报错", False)
    except core.EnvError:
        check("未知账号必须报错", True)
finally:
    core.set_account(None)
    core.list_accounts = orig_accounts

# ---------------------------------------------------------------- 2.5 镜像/显示名
check("镜像文件带账号前缀",
      core._acct_tag(r"C:\Users\u\xwechat_files\wxid_abc123_1a2b\db_storage") == "wxid_abc123_1a2b")
check("无账号路径有兜底", core._acct_tag("R_A") == "default")

orig_names = core.names
core.names = lambda: {"wxid_a": "阿A"}
try:
    check("显示名从 names 表取", server._display_name("wxid_a") == "阿A",
          server._display_name("wxid_a"))
    check("未知会话回退原 id", server._display_name("wxid_zzz") == "wxid_zzz")
finally:
    core.names = orig_names

# ---------------------------------------------------------------- 3. 窗口 fail-closed
orig_window = wxinstances.window_for_account
wxinstances.window_for_account = lambda acc, hidden=False: {"wxid_a": 111, "wxid_b": 222}.get(acc, 0)
try:
    check("按账号选窗口 a", sender.find_main_hwnd(account="wxid_a") == 111)
    check("按账号选窗口 b", sender.find_main_hwnd(account="wxid_b") == 222)
    check("未知账号不回退（返回 0）", sender.find_main_hwnd(account="wxid_ghost") == 0)
    with sender.target(account="wxid_b"):
        check("上下文里的账号生效", sender.find_main_hwnd() == 222)
finally:
    wxinstances.window_for_account = orig_window

# ---------------------------------------------------------------- 4. 工具 schema
names = {t["name"] for t in server.TOOLS}
check("提供 list_accounts", "list_accounts" in names)
for tool in ("list_sessions", "read_history", "poll_new", "send_text", "send_file", "reply_to"):
    item = next(t for t in server.TOOLS if t["name"] == tool)
    props = item["inputSchema"].get("properties", {})
    check(f"{tool} 接受 account", "account" in props)

# ---------------------------------------------------------------- 5. hook 按账号匹配
orig_endpoints = wechat_hook.endpoints
wechat_hook.endpoints = lambda refresh=False: [
    {"url": "http://a", "wxid": "wxid_a", "nickname": "A"},
    {"url": "http://b", "wxid": "wxid_b", "nickname": "B"},
]
try:
    ep, err = wechat_hook._match("filehelper", account="wxid_b")
    check("hook 按账号选中 b", err is None and ep["url"] == "http://b", err or ep)
    ep, err = wechat_hook._match("filehelper", account="wxid_ghost")
    check("hook 未知账号不广播", ep is None and "没有找到账号" in (err or ""), err)
finally:
    wechat_hook.endpoints = orig_endpoints

print(f"\n合计：失败 {failed}")
sys.exit(1 if failed else 0)
