# -*- coding: utf-8 -*-
"""非文本消息的**标签**自测（`describe_nontext` / `_LINK_KINDS`）。

跑法：`python test_render_labels.py`（毫秒级，不碰微信、不碰真实库）。

为什么要它：这些标签是**代聊模型读消息时唯一的性质线索**——它看到的是
`[引用] 你在干嘛` 而不是原始 XML，标签错了模型就判错消息性质，而且**不会报错**。

已出过事的一条（2026-10-11）：`appmsg <type>57` 被标成 `[直播]`，实际是**引用回复**。
扫全库 84 条 type=57 的消息，**每一条**的 XML 都带 `<refermsg>`（引用的原文+时间+发送者），
没有例外。于是每一条引用回复在模型眼里都成了「有人发了直播」。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import wechat_core as core  # noqa: E402

fails = []


def check(label, cond, extra=""):
    if not cond:
        fails.append(label)
    print(("  OK  " if cond else "  FAIL") + f"  {label}" + (f"  [{extra}]" if extra else ""))


def appmsg(kind, title="标题", extra=""):
    """造一条 appmsg 的 XML（与微信落库的形状一致：lt=49 时正文就是这段 XML）。"""
    return (f'<msg><appmsg appid="" sdkver="0"><title>{title}</title><des></des>'
            f'<type>{kind}</type>{extra}</appmsg></msg>')


REFER = ("<refermsg><content>你先说说</content><createtime>1791708109</createtime>"
         "<fromusr>wxid_x</fromusr></refermsg>")

print("=== 非文本标签 ===")

# ① 本次修的那条：57 = 引用（不是直播）
out = core.describe_nontext(49, appmsg(57, "在的 有什么要办的", REFER))
check("appmsg type=57 → [引用]（不是 [直播]）", out.startswith("[引用]"), out[:40])
check("引用那条的正文跟着标签走", "在的 有什么要办的" in out, out[:40])
check("全库证据：57 恒带 refermsg（回归时别改回 57:直播）", 57 not in (62, 63) and core._LINK_KINDS[57] == "引用",
      str(core._LINK_KINDS.get(57)))

# ② 相邻的几个标签没被这次改动带歪
for kind, want in ((5, "链接"), (6, "文件"), (19, "聊天记录"), (33, "小程序"),
                   (44, "视频号"), (62, "拍一拍"), (87, "群公告"),
                   (2000, "转账"), (2001, "红包")):
    out = core.describe_nontext(49, appmsg(kind, "样例"))
    check(f"appmsg type={kind} → [{want}]", out.startswith(f"[{want}]"), out[:40])

# ③ 认不出的类型仍走兜底「链接」——**不能**因为加了新标签就让未知类型变成空白
out = core.describe_nontext(49, appmsg(9999, "未知类型样例"))
check("未知 appmsg type → 兜底 [链接]（不吞消息）", out.startswith("[链接]"), out[:40])

# ④ 无 title 时标签本身仍在（消息不能被吞掉）
out = core.describe_nontext(49, appmsg(57, ""))
check("无 title 时仍给出 [引用]", out.startswith("[引用]"), out[:40])

print()
print("结果：" + ("全部通过" if not fails else f"{len(fails)} 项失败 -> {fails}"))
sys.exit(1 if fails else 0)
