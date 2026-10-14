"""chatlog 单测（简报/切段/问句判定等纯函数 + 真机只读冒烟）。跑法：python test_chatlog.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:                                # Windows 控制台常是 GBK：会话名里可能带编不出的字符，
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # 不钉住 print 会抛错 → 假失败
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import chatlog as L


def test_type_label():
    """标签**从渲染文本里取**，不另抄映射表——另抄一份迟早和 `describe_nontext` 分叉。"""
    assert L.type_label(1, "你好") == "文本"
    assert L.type_label(10000, "你撤回了一条消息") == "系统"     # 系统消息渲染后**不带括号**
    assert L.type_label(10002, "") == "系统"
    assert L.type_label(3, "[图片 12KB]") == "图片"
    assert L.type_label(49, "[引用] 你在干嘛 ← 张三: 在吗") == "引用"
    assert L.type_label(34, "[语音 11.3 秒]") == "语音"
    assert L.type_label(999, "没见过的形态") == "其它"
    print("ok type_label")


def test_sessions_of():
    """切段：间隔**恰好** 30 分钟算同一段（`<=`），多一秒就是新的一段。"""
    seq = [(0, True, "a", 1), (L._GAP_S, False, "b", 1), (L._GAP_S * 2 + 1, True, "c", 1)]
    assert L.sessions_of(seq) == [[0, 1], [2]], L.sessions_of(seq)
    assert L.sessions_of([]) == []
    print("ok sessions_of")


def test_is_question():
    assert L.is_question("在吗") and L.is_question("这个多少钱") and L.is_question("然后呢")
    assert L.is_question("能便宜点？")
    assert not L.is_question("好的收到") and not L.is_question("")
    assert not L.is_question("x" * 300), "超长的段落里有'吗'字不算问句（那是文章，不是提问）"
    print("ok is_question")


def test_hot_pairs():
    """2-gram：整句无标点也要切得开（`core._tokens` 会贪心成一整句，数频次等于没数）。"""
    got = {h["text"] for h in L.hot_pairs(["价格多少", "价格能不能低点"])}
    assert "价格" in got, got
    assert "的时" not in {h["text"] for h in L.hot_pairs(["好的时候"])}, "全虚词的组合别端上来"
    assert {h["text"] for h in L.hot_pairs(["hello world"])} == {"hello", "world"}
    print("ok hot_pairs")


def test_brief_from():
    """简报：谁主动开场、回复中位数、没接的问句——都在**合成数据**上逐项对账。"""
    seq = [
        (1000, True, "你好", 1),             # 第一段我开场
        (1060, False, "价格多少", 1),        # 问句，60 秒后我回了
        (1120, True, "100元", 1),
        (1200, False, "能便宜点吗", 1),
        (9000, False, "在吗", 1),            # 隔了 7800 秒 → 新的一段（对方开场）；没接
    ]
    d = L.brief_from(seq, top=5, now=9100)
    assert (d["count"], d["from_me"], d["from_other"]) == (5, 2, 3), d
    assert d["segments"] == 2 and d["opened_by_me"] == 1 and d["opened_by_them"] == 1, d
    # 隔段那对（1200→9000）**不能**算进回复时间，否则中位数就是编的
    assert (d["my_reply_s"], d["my_reply_n"]) == (60, 1), d
    assert (d["their_reply_s"], d["their_reply_n"]) == (80, 2), d
    assert d["asked"] == 3, d                             # 三句问句：价格多少 / 能便宜点吗 / 在吗
    # 「价格多少」60 秒内被我回了 ⇒ **不算**没接；另两句之后我一句没说 ⇒ 算
    assert d["unanswered_count"] == 2, d
    assert [u["ts"] for u in d["unanswered"]] == [1200, 9000], d
    assert d["types"] == [{"type": "文本", "count": 5}], d
    assert sum(d["active_hours"].values()) == 5, d
    assert d["silent_days"] == 0.0, d                     # now 给死，不依赖真实时钟
    assert L.brief_from([])["count"] == 0                 # 空会话不炸
    print("ok brief_from（开场/回复中位数/没接的问句 都对上账）")


def test_real_smoke():
    """真机只读冒烟：简报与正文都真的读得出来，且顺序是**时间正序**。"""
    try:
        root = L.core.db_root()
    except Exception as e:                                  # noqa: BLE001
        print(f"skip 真机冒烟（取不到库: {e}）")
        return
    if not root or not os.path.isdir(root):
        print("skip 真机冒烟（无数据目录）")
        return

    name = L.core.names().get("filehelper") or "文件传输助手"
    try:
        d = L.customer_brief(name, top=5)
    except L.core.UnknownTalker:
        print("skip 真机冒烟（本机没有文件传输助手）")
        return
    assert d["count"] > 0, d
    assert d["from_me"] + d["from_other"] == d["count"], d
    assert d["types"] and sum(t["count"] for t in d["types"]) == d["count"], d
    assert d["opened_by_me"] + d["opened_by_them"] == d["segments"], d
    print(f"ok 简报：{d['name'][:10]} {d['count']} 条 / {d['segments']} 段"
          f"（我开场 {d['opened_by_me']}）/ 没接的问句 {d['unanswered_count']}"
          f" / 类型 {[t['type'] for t in d['types']][:4]}")

    rm = L.read_messages(name, limit=30)
    ts = [m["ts"] for m in rm["messages"]]
    assert ts == sorted(ts), "读正文必须**时间正序**（倒序会让人把对话读反）"
    assert all("text" in m and "from_me" in m for m in rm["messages"]), rm
    print(f"ok 读正文：{len(ts)} 条，最早 {rm['messages'][0]['time']}，truncated={rm['truncated']}")

    hits = L.search_messages("你", talker=name, limit=5)
    assert hits["count"] >= 0 and "messages" in hits, hits
    print(f"ok 检索：范围内命中 {hits['count']} 条（truncated={hits['truncated']}）")


if __name__ == "__main__":
    test_type_label()
    test_sessions_of()
    test_is_question()
    test_hot_pairs()
    test_brief_from()
    test_real_smoke()
    print("ALL PASS")
