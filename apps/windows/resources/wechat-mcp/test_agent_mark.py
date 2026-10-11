# -*- coding: utf-8 -*-
"""Agent 代发标记（`msg_dict` 侧）自测：识别 / 剥离 / 先剥后截断。

跑法：`python test_agent_mark.py`（毫秒级，不碰微信、不碰真实库）。

为什么要它：这个标记是自聊会话里**唯一能把「助手代发」和「用户真发」分开的判据**
——那种会话里两者 `from_me` 都是真。三条失败模式全是**静默**的：
  ① 常量与客户端对不上（少一个零宽字符）⇒ 永远认不出 ⇒ 助手自己回自己；
  ② 忘了剥离 ⇒ 标记跟着正文进模型上下文、也进用户的会话历史；
  ③ 先截断再剥 ⇒ 超过 400 字的正文把末尾标记切掉 ⇒ 长消息永远认不出（**最容易漏的一条**）。
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


print("=== Agent 代发标记 ===")

# ① 常量必须与客户端 `wechat-watch-tick.ts` 的 AGENT_REPLY_MARKER 逐码位一致。
#    改任一侧都要同步改另一侧，否则这条防线整个失效（且不报错）。
check(
    "常量 = ZWSP/ZWNJ/ZWSP（与客户端 withAgentMarker 对齐）",
    [ord(c) for c in core.AGENT_MARK] == [0x200B, 0x200C, 0x200B],
    str([hex(ord(c)) for c in core.AGENT_MARK]),
)

# ② 剥得干净、正文一字不差
plain, hit = core.split_agent_mark("在的 有什么要办的" + core.AGENT_MARK)
check("带标记 → 认得出", hit is True)
check("带标记 → 正文原样", plain == "在的 有什么要办的", repr(plain))

plain2, hit2 = core.split_agent_mark("在的 有什么要办的")
check("不带标记 → 不误判", hit2 is False and plain2 == "在的 有什么要办的")

# ③ **先剥后截断**：长正文（>400 字）末尾的标记必须仍被认出。
#    这是最容易写错的一条——`_render(...)[:400]` 会把末尾切掉，先截断就永远认不出。
long_body = "很长的正文" * 90          # 450 字，越过 400 上限
d = core.msg_dict(1700000000, 1, long_body + core.AGENT_MARK, {}, talker="filehelper")
check("长正文（450 字）末尾标记仍认得出", d.get("agent_sent") is True)
check("长正文截断到 400 字以内", len(d["text"]) <= 400, str(len(d["text"])))
check("长正文里不残留标记", core.AGENT_MARK not in d["text"])

# ④ 普通消息不受影响：没有 agent_sent 字段（不是 False——省一个字段，客户端按真值判）
d2 = core.msg_dict(1700000000, 1, "普通消息", {}, talker="wxid_x")
check("普通消息不带 agent_sent 字段", "agent_sent" not in d2)
check("普通消息文本原样", d2["text"] == "普通消息", repr(d2["text"]))

print()
print("结果：" + ("全部通过" if not fails else f"{len(fails)} 项失败 -> {fails}"))
sys.exit(1 if fails else 0)
