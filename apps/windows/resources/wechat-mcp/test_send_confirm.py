# -*- coding: utf-8 -*-
"""发送落地校验（`_wait_new_message`）自测：认的是**我们自己发的那条**，不是"有新消息"。

跑法：`python test_send_confirm.py`（毫秒级，不碰微信、不碰真实库）。

为什么要它：这道校验是「看着发出去了、其实发到别处」的最后一道闸门，它的**假成功**最致命
——对方在我们发送的窗口里恰好回一句，旧判据（只看时间戳）就判「已发送」，而我们那条可能
压根没出去，消息静默丢失、调用方还以为成了。下面第一条用例就是钉住这个假成功。
失败模式全是静默的，且都要跑满 25 秒超时才暴露，靠手工试不出来。
"""
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import wechat_core as core      # noqa: E402
import wechat_sender as ws      # noqa: E402

fails = []


def check(label, cond, extra=""):
    if not cond:
        fails.append(label)
    print(("  OK  " if cond else "  FAIL") + f"  {label}" + (f"  [{extra}]" if extra else ""))


class FakeCore:
    """只替掉 `history`；`split_agent_mark` 用真的（它正是被测逻辑的一部分）。"""

    def __init__(self, msgs):
        self._msgs = msgs

    def history(self, talker, n):
        return {"messages": self._msgs[:n]}

    split_agent_mark = staticmethod(core.split_agent_mark)


class FakeTime:
    """假钟：`sleep` 推进时间 ⇒ 超时行为可测且瞬时（否则每个用例白等 25 秒）。"""

    def __init__(self):
        self.t = 0.0

    def time(self):
        return self.t

    def sleep(self, s):
        self.t += s


def run(msgs, since_ts, like=None, timeout=6):
    real_core, real_time = ws.core, ws.time
    ws.core, ws.time = FakeCore(msgs), FakeTime()
    try:
        return ws._wait_new_message("filehelper", since_ts, like, timeout=timeout)   # noqa: SLF001
    finally:
        ws.core, ws.time = real_core, real_time


TXT = "七份都收好了，分了两处"
MARKED = core.with_agent_mark(TXT)

print("=== 发送落地校验：认我们自己发的那条 ===")

# ① **本次修复的核心**：对方在我们发送的窗口里回话 ⇒ 绝不算成功（旧判据会谎报已发送）
check("对方回话不算我们发成功（旧判据在这里假成功）",
      run([{"ts": 200, "from_me": False, "sender": "wxid_x", "text": "在吗"}], 100, TXT) is False)

# ② 指纹：正文末尾的零宽标记落库后 = agent_sent
check("带 agent_sent 指纹的新消息 ⇒ 成功",
      run([{"ts": 200, "agent_sent": True, "from_me": True, "text": TXT}], 100, TXT) is True)

# ③ 调用方传的是**打过标记**的 text（send_text 出口就是这样）⇒ 内部要先剥标记再比
check("like 带 AGENT_MARK 也能匹配（内部先剥标记）",
      run([{"ts": 200, "agent_sent": True, "from_me": True, "text": TXT}], 100, MARKED) is True)

# ④ 标记被客户端吞掉时靠 from_me + 正文兜底
check("无标记但 from_me 且正文一致 ⇒ 成功",
      run([{"ts": 200, "from_me": True, "text": TXT}], 100, TXT) is True)

# ⑤ fail-closed：from_me 为真但正文对不上（同秒里另一条）⇒ 不认，继续等
check("from_me 但正文不一致 ⇒ 不成功（fail-closed）",
      run([{"ts": 200, "from_me": True, "text": "另一句话"}], 100, TXT) is False)

# ⑥ 比基线还老的指纹不算数（那是上一次代发的）
check("比基线老的 agent_sent 不算",
      run([{"ts": 50, "agent_sent": True, "from_me": True, "text": TXT}], 100, TXT) is False)

# ⑦ 长正文：msg_dict 截到 400 字，只比前 400
long_txt = "字" * 500
check("超 400 字正文按前 400 比",
      run([{"ts": 200, "agent_sent": True, "text": long_txt[:400]}], 100, long_txt) is True)

# ⑧ 附件：没有正文可打标记，用 from_me
check("附件：from_me 的新消息 ⇒ 成功",
      run([{"ts": 200, "from_me": True, "text": "[图片]"}], 100, None) is True)
check("附件：对方发的不算"
      , run([{"ts": 200, "from_me": False, "text": "[图片]"}], 100, None) is False)

# ⑨ 退化路径：sender 解析不出来（from_me 字段整个缺席）⇒ 退回时间戳判据，保住发送能力
check("附件：from_me 整个缺席时退回时间戳判据",
      run([{"ts": 200, "text": "[图片]"}], 100, None) is True)
check("附件：from_me 存在但为假时不退化",
      run([{"ts": 200, "from_me": False, "text": "[图片]"}], 100, None) is False)

# ⑩ 基线取不到（history 抛异常 ⇒ _talker_latest_ts 返回 0）⇒ 不能因此判失败
check("基线为 0 时仍能确认",
      run([{"ts": 200, "agent_sent": True, "text": TXT}], 0, TXT) is True)

print()
if fails:
    print("FAILED %d 项：%s" % (len(fails), " / ".join(fails)))
    sys.exit(1)
print("全部通过")
