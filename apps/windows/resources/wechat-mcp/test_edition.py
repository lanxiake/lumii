# -*- coding: utf-8 -*-
"""档位（lite/pro/plus）切分离线自测：同一次运行里分别按各档位加载 server.py，核对工具集、门控与引导词。

跑法：`python test_edition.py`（本机可用 `%USERPROFILE%\\.lumii\\runtimes\\python-embed\\python.exe`）。
不碰微信、不发消息、不需要微信在跑——纯模块级断言，秒级完成。

为什么要它：档位是**构建期**注入的，源码跑起来永远是 pro，两个档位的差异在开发机上**看不见**。
没有这条护栏，把 `PRO_ONLY_TOOLS` 写漏、或只从 `TOOLS` 删掉忘了拦 `handle_tools_call`，
都不会有任何报错——直到 lite 版发出去。
"""
import importlib
import os
import sys
import types

SRC = os.path.dirname(os.path.abspath(__file__))
if SRC not in sys.path:
    sys.path.insert(0, SRC)

PRO_ONLY = {"read_image", "transcribe_voice", "wechat_digest", "wechat_distill_state",
            "wechat_distill_clear", "wechat_profile_save", "wechat_profile_get"}

fails = []


def check(label, cond, extra=""):
    print(("  OK  " if cond else "  FAIL") + f"  {label}" + (f"  [{extra}]" if extra else ""))
    if not cond:
        fails.append(label)


def load(edition):
    """按指定档位加载 server 模块（`edition` 走 sys.modules 注入，等价于构建期写 edition.py）。"""
    for name in ("server", "wechat_core", "wechat_sender", "wechat_hook",
                 "wechat_image", "wxkey4", "wxread4"):
        sys.modules.pop(name, None)
    mod = types.ModuleType("edition")
    mod.EDITION = edition
    sys.modules["edition"] = mod
    return importlib.import_module("server")


print("=== lite（基础版）===")
lite = load("lite")
names = {t["name"] for t in lite.TOOLS}
check("工具数 = 13", len(names) == 13, f"got {len(names)}")   # 12 + list_accounts（多开）
check("无 pro 工具泄漏", not (names & PRO_ONLY), f"leak {names & PRO_ONLY}")
check("DISPATCH 仍是全集（拦调用靠 handle_tools_call）",
      "wechat_digest" in lite.DISPATCH and "read_image" in lite.DISPATCH)
check("引导词无蒸馏段", "蒸馏（用户/好友知识与行为）" not in lite.INSTRUCTIONS)
check("引导词无 read_image / transcribe_voice",
      "read_image" not in lite.INSTRUCTIONS and "transcribe_voice" not in lite.INSTRUCTIONS)
check("引导词不含 voice_path 的 pro 写法", "SILK 文件。用 `transcribe_voice" not in lite.INSTRUCTIONS)
check("引导词标明基础版不解析", "本档（基础版）不解析图片与语音" in lite.INSTRUCTIONS)
stripped = lite._strip_media({"messages": [{"text": "t", "image_path": "p", "voice_path": "v"}]})
check("_strip_media 剥掉媒体路径", stripped["messages"][0] == {"text": "t"}, str(stripped["messages"][0]))
check("非 messages 载荷安全", lite._strip_media({"count": 0}) == {"count": 0})

print("=== pro（高级版）===")
pro = load("pro")
pnames = {t["name"] for t in pro.TOOLS}
check("工具数 = 20", len(pnames) == 20, f"got {len(pnames)}")   # 19 + list_accounts（多开）
check("pro 工具齐全", PRO_ONLY <= pnames, f"missing {PRO_ONLY - pnames}")
check("引导词含蒸馏段", "蒸馏（用户/好友知识与行为）" in pro.INSTRUCTIONS)
check("引导词含 read_image", "read_image" in pro.INSTRUCTIONS)
check("旧文案已修（不再说密钥不在磁盘上）",
      "密钥不在磁盘上" not in pro.INSTRUCTIONS and "密钥不在磁盘上" not in lite.INSTRUCTIONS)
kept = pro._strip_media({"messages": [{"text": "t", "image_path": "p", "voice_path": "v"}]})
check("pro 不裁剪媒体", kept["messages"][0].get("image_path") == "p")

print("=== plus（增强版）===")
plus = load("plus")
xnames = {t["name"] for t in plus.TOOLS}
check("工具数 = 20（与 pro 同集）", len(xnames) == 20, f"got {len(xnames)}")
check("pro 工具齐全", PRO_ONLY <= xnames, f"missing {PRO_ONLY - xnames}")
check("引导词含 hook 发送段", "发送后端（增强版专属）" in plus.INSTRUCTIONS)
check("引导词含 pro 媒体段", "read_image" in plus.INSTRUCTIONS)
kept_plus = plus._strip_media({"messages": [{"text": "t", "image_path": "p", "voice_path": "v"}]})
check("plus 不裁剪媒体", kept_plus["messages"][0].get("image_path") == "p")
check("plus 的安装标识独立", plus.INSTALL_SPEC["product"] == "wechat-mcp-plus",
      plus.INSTALL_SPEC["product"])
check("plus 技能包存在", os.path.isfile(plus.INSTALL_SPEC["skill"] + os.sep + "SKILL.md"))

print()
print("结果：" + ("全部通过" if not fails else f"{len(fails)} 项失败 -> {fails}"))
sys.exit(1 if fails else 0)
