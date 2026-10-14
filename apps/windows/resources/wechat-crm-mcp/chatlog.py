"""C · 客户分析 —— **消息层**：读正文 / 按范围检索 / 汇总一份客户简报。

`contactscore.py` 只管通讯录与时间戳算术（**从不读正文**）；本模块是它的补充面：
把**对话内容**也端上来，好让 Agent 在同一件产品里走完
「找出客户 → 看互动 → 读那段话 → 按话题搜 → 汇总」的闭环，不必去够另一个 MCP。

仍然**只读**，仍然**不替你下结论**：这里给的是**可核对的计数与原文**，
"这个客户值不值得跟"是你的模型的事。

⚠️ **和 contactscore 那条"读不到正文"的保证不是一回事**：本模块**会读到聊天正文**
（`read_messages` / `search_messages` 直接回原文；`customer_brief` 会做短语与问句统计）。
正文一律**只在本地处理、不外传**——这条没变。
"""
import os
import re
import sys
import time
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
_SHARED = os.path.join(os.path.dirname(HERE), "wechat-mcp")   # 共享基础层（零复制）
if _SHARED not in sys.path:
    sys.path.insert(0, _SHARED)

import wechat_core as core  # noqa: E402

_GAP_S = 1800            # 30 分钟不说话 = 新的一段对话（切段与"这算不算回复"共用这一个口径）
_REPLY_WINDOW_S = 86400  # 隔了一天以上再说话，不算回复（是新的一段，不是答案）
_SCAN = 5000             # 单会话默认最多扫多少条（超了如实报 truncated，不静默截断）


# ---------- 纯函数：喂假数据即可单测，不碰微信 ----------

def type_label(lt, text):
    """消息种类的**中文短标签** —— 从渲染文本里取，**不另抄一份映射表**。

    `_render` 是消息渲染的唯一入口，非文本给的形态就是 `[图片 12KB]` / `[引用] …` /
    `[转账] …`，取首个 `[...]` 里的词即可。另抄一张 `local_type → 名字` 的表，
    迟早会和 `describe_nontext` 分叉（那张表已经有 57=引用 被错标成直播的前科）。
    """
    if lt == 1:
        return "文本"
    if lt in (10000, 10002):
        return "系统"
    if text.startswith("["):
        end = text.find("]")
        if 0 < end <= 12:
            return text[1:end].split(" ")[0]     # `[图片 12KB]` → `图片`（尺寸是细节，不进标签）
    return "其它"


def sessions_of(seq, gap_s=_GAP_S):
    """按间隔切段 → `[[段内下标], ...]`。一段 = 一轮连续对话。"""
    out = []
    for i, (ct, _me, _t, _lt) in enumerate(seq):
        if out and ct - seq[out[-1][-1]][0] <= gap_s:
            out[-1].append(i)
        else:
            out.append([i])
    return out


def is_question(t):
    """像不像一句在等回答的话。**只认形态，不猜意图**（"在吗"也算问句，这是刻意的）。"""
    t = (t or "").strip()
    if not t or len(t) > 200:
        return False
    return t[-1] in "?？" or any(w in t for w in
                                 ("吗", "呢", "怎么", "为什么", "多少", "几点", "几号",
                                  "能不能", "有没有", "可以吗", "什么时候", "在哪", "如何"))


def _median(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else None


def hot_pairs(texts, top=15):
    """高频**二字组合**（中文 2-gram）+ 英文词 —— 客户在聊什么的**线索**。

    为什么不复用 `core._tokens`：它按 `[一-鿿]{2,}` 贪心切，一段没标点的话会**整句**成为
    一个"词"（"好的收到谢谢老板" ⇒ 一条），拿去数频次等于什么都没数。这里改切 2-gram。
    ⚠️ 2-gram 是**线索不是词表**（"的时"这种碎片也在里面），所以只取前 N 并附计数，
    由模型自己判断哪些是话题——**工具不给"话题"这种下结论的东西**。
    """
    c = Counter()
    for t in texts:
        for run in re.findall(r"[一-鿿]+|[A-Za-z]{2,}", t or ""):
            if run[0].isascii():
                c[run.lower()] += 1
            else:
                for i in range(len(run) - 1):
                    g = run[i:i + 2]
                    if g[0] not in core._STOP:      # 「的X / 了X / 是X」大多是切出来的碎片
                        c[g] += 1
    return [{"text": k, "count": v} for k, v in c.most_common(top)]


def brief_from(seq, top=15, now=0):
    """时间正序的 `[(ct, 是不是我, 文本, local_type)]` → **客户简报**（纯函数）。

    每一项都是可核对的数或原文，没有"意向分 / 关系分"这类把假设伪装成事实的东西。
    """
    now = now or int(time.time())
    n = len(seq)
    if not n:
        return {"count": 0, "from_me": 0, "from_other": 0}

    mine = [x for x in seq if x[1]]
    theirs = [x for x in seq if not x[1]]
    segs = sessions_of(seq)
    # 主动开场：每一段的第一条是谁说的。段数在客户分析里就是"来过几趟"。
    opened_by_me = sum(1 for s in segs if seq[s[0]][1])

    # 换手间隔只算**同一段内**的相邻两条：隔夜那两句没有因果关系，算进去就是编数。
    my_reply, their_reply = [], []
    for a, b in zip(seq, seq[1:]):
        if a[1] != b[1] and b[0] - a[0] <= _GAP_S:
            (their_reply if a[1] else my_reply).append(b[0] - a[0])

    # 没接的问句：对方提问后 **24 小时内**我没有发过任何一条（任何类型都算回）。
    nxt = [None] * n
    pos = None
    for i in range(n - 1, -1, -1):
        nxt[i] = pos
        if seq[i][1]:
            pos = i
    asked = [i for i, (_ct, m, t, lt) in enumerate(seq)
             if not m and lt == 1 and is_question(t)]
    unanswered = []
    for i in asked:
        j = nxt[i]
        if j is None or seq[j][0] - seq[i][0] > _REPLY_WINDOW_S:
            ct, _m, t, _lt = seq[i]
            unanswered.append({"ts": ct, "time": core._ts(ct), "text": t[:200]})

    hours = Counter(time.localtime(ct).tm_hour for ct, *_ in seq)
    types = Counter(type_label(lt, t) for _ct, _m, t, lt in seq)
    first, last = seq[0][0], seq[-1][0]
    return {
        "count": n, "from_me": len(mine), "from_other": len(theirs),
        "first_ts": first, "first": core._ts(first),
        "last_ts": last, "last": core._ts(last),
        "span_days": round((last - first) / 86400, 1) if last > first else 0,
        "silent_days": round((now - last) / 86400, 1),
        "segments": len(segs),
        "opened_by_me": opened_by_me, "opened_by_them": len(segs) - opened_by_me,
        "my_reply_s": _median(my_reply), "my_reply_n": len(my_reply),
        "their_reply_s": _median(their_reply), "their_reply_n": len(their_reply),
        "active_hours": {str(h): hours[h] for h in sorted(hours, key=lambda x: -hours[x])[:6]},
        "types": [{"type": k, "count": v} for k, v in types.most_common()],
        "asked": len(asked), "unanswered_count": len(unanswered),
        "unanswered": unanswered[-top:],          # 最近的 N 条（越近越该处理）
        "hot_pairs": hot_pairs([t for _ct, m, t, lt in seq if not m and lt == 1], top=top),
        "note": ("`segments` = 间隔超过 30 分钟算新的一段；回复间隔只算同一段内的换手"
                 "（中位数，秒）。`unanswered` = 对方提问后 **24 小时内**我没发过任何消息"
                 "（任何类型都算回了）——这是**形态判定**，不等于「他在催你」。"
                 f"`hot_pairs` 是对方正文的二字组合，只取前 {top} 条，是**线索不是词表**。"),
    }


# ---------- 取数：跨分片读正文 ----------

def _seq(talker, since=0, until=0, scan=_SCAN):
    """会话消息 → 时间正序的 `[(ct, 是不是我, 文本, local_type)]`，附 `truncated`。

    **不做"代聊代发"过滤**（`core._seq_of` 那样）：那些消息确实是以用户身份发出去的，
    滤掉它们会让"客户问了、助手答了"看起来像**没人回**——简报就撒了谎。
    """
    rows = core._rows_full(core.tbl_of(talker), int(scan) + 1,
                           since=int(since or 0), before=int(until or 0))
    trunc = len(rows) > scan
    rows = rows[:scan]
    me = core.self_wxid()
    seq = []
    # 同秒要按 `local_id` 再排一次：微信时间戳只到秒，不排会把同秒两条的先后配错
    for r in sorted(rows, key=lambda x: (x[0], x[4] if isinstance(x[4], int) else 0)):
        ct, lt, content, sender = r[0], r[1], r[2], r[3]
        seq.append((ct, bool(me) and sender == me, core._render(lt, content).strip(),
                    lt & 0xFFFFFFFF))
    return seq, trunc


def read_messages(talker, since=0, until=0, limit=200):
    """读某个会话的**正文**（非文本消息给一行摘要），**时间正序**（按阅读顺序，不是倒序）。

    窗口是 `[since, until]`，取**其中最近 `limit` 条**——和翻聊天记录的手感一致。
    撞到上限时 `truncated=true`：别把"这是最后一条"和"被截断了"当同一件事。
    """
    talker = core.talker_of(talker)
    rows = core._rows_full(core.tbl_of(talker), int(limit) + 1,
                           since=int(since or 0), before=int(until or 0))
    trunc = len(rows) > limit
    nm, me = core.names(), core.self_wxid()
    msgs = [core.msg_dict(ct, lt, content, nm, talker=talker, name=nm.get(talker, talker),
                          sender=s, me=me, local_id=lid, source=src,
                          packed=(rest[0] if rest else None))
            for ct, lt, content, s, lid, src, *rest in rows[:limit]]
    msgs.reverse()                     # `_rows_full` 出来是倒序
    core.attach_video(msgs)            # 视频要带 `video_path`，否则"搜到/读到却点不开"
    return {"talker": talker, "name": nm.get(talker, talker),
            "count": len(msgs), "truncated": trunc, "messages": msgs}


def search_messages(keyword, talker=None, since=0, until=0, limit=50):
    """在**指定范围**里按关键词检索正文：`talker` 给了就只搜那个会话，否则**全库**；
    再叠加 `since`/`until` 收窄时间段。

    直接复用共享层的检索实现，**不另写一份**：它已经把时间范围下推到 SQL（否则查老时间段
    会被更新的消息占满扫描窗、恒返回 0 且不报错），也如实上报 `truncated`——
    两份实现迟早会在这种细节上分叉。
    """
    return core.search_messages(keyword, talker=core.talker_of(talker) if talker else None,
                                since=int(since or 0), until=int(until or 0),
                                limit=int(limit or 50))


def customer_brief(talker, since=0, until=0, top=15, scan=_SCAN):
    """**会话的客户简报**：量 / 谁主动开场 / 回复速度 / 消息类型 / 高频组合 / 没接的问句。

    这是本产品**内容侧**的入口——想知道"这个客户最近在聊什么、我漏了什么"，
    一次调用拿到，不必先去读几百条原文。
    """
    talker = core.talker_of(talker)
    seq, trunc = _seq(talker, since, until, scan)
    d = brief_from(seq, top=int(top or 15))
    d.update({"talker": talker, "name": core.names().get(talker, talker),
              "scanned": int(scan), "truncated": trunc})
    return d
