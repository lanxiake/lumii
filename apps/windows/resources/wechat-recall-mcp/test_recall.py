"""archive 撤回判定单测（合成库，不碰微信）+ 真机打底冒烟。运行：python test_recall.py"""
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:                                # Windows 控制台常是 GBK：会话名里可能带编不出的字符（实测 U+00A0），
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # 不钉住 print 会抛错 → 测试**假失败**
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import archive as A

TALK = "room@chatroom"
_ORIG_LIVE = A.live_rows          # _stub_live 会覆盖它，真机冒烟前必须还原


def _make(rows):
    """建临时归档库并灌入 `(local_id, create_time, type, content)`。"""
    d = tempfile.mkdtemp(prefix="recall_")
    con = A.connect(os.path.join(d, "a.db"))
    A.capture(con, [(TALK, lid, ct, lt, "wxid_x", c) for lid, ct, lt, c in rows], seen_ts=1000)
    return con, d


def _stub_live(rows):
    """把 `live_rows` 换成合成的"当前库"：`(local_id, create_time, type, content)`。"""
    A.live_rows = lambda since=0, talker=None: iter(
        [(TALK, lid, ct, lt, "wxid_x", c) for lid, ct, lt, c in rows])


def test_capture_never_overwrites():
    """已归档的行**永不覆盖**——这是撤回能还原原文的前提。"""
    con, d = _make([(5, 100, 1, b"original")])
    A.capture(con, [(TALK, 5, 100, 1, "wxid_x", b"CHANGED")], seen_ts=2000)
    got = con.execute("select content from msg where local_id=5").fetchone()[0]
    assert got == b"original", got
    con.close(); shutil.rmtree(d, ignore_errors=True)
    print("ok capture_never_overwrites")


def test_no_change():
    con, d = _make([(1, 100, 1, b"hi"), (2, 200, 1, b"yo")])
    _stub_live([(1, 100, 1, b"hi"), (2, 200, 1, b"yo")])
    assert A.find_recalls(con) == [], "没变就不该报撤回"
    con.close(); shutil.rmtree(d, ignore_errors=True)
    print("ok no_change")


def test_recall_by_removal():
    """机制一：撤回/删除后该 local_id **整个消失**。"""
    con, d = _make([(1, 100, 1, b"hi"), (2, 200, 1, b"secret")])
    _stub_live([(1, 100, 1, b"hi")])                      # 2 没了
    r = A.find_recalls(con)
    assert len(r) == 1 and r[0]["local_id"] == 2 and r[0]["reason"] == "deleted", r
    assert r[0]["text"] == "secret", r[0]["text"]
    con.close(); shutil.rmtree(d, ignore_errors=True)
    print("ok recall_by_removal")


def test_recall_in_place():
    """机制二：原消息被**原地改写成系统消息**（local_id 不变、内容变了）。"""
    con, d = _make([(5, 100, 1, b"secret")])
    _stub_live([(5, 999, A.SYSTEM_LT, b"<sysmsg>revokemsg</sysmsg>")])
    r = A.find_recalls(con)
    assert len(r) == 1 and r[0]["reason"] == "recalled", r
    assert r[0]["text"] == "secret", "归档里应是**原文**"
    con.close(); shutil.rmtree(d, ignore_errors=True)
    print("ok recall_in_place")


def test_read_recall():
    con, d = _make([(7, 300, 1, b"deleted-content")])
    _stub_live([])
    rec = A.read_recall(con, TALK, 7)
    assert rec and rec["text"] == "deleted-content", rec
    assert A.read_recall(con, TALK, 999) is None
    con.close(); shutil.rmtree(d, ignore_errors=True)
    print("ok read_recall")


def test_shard_collision_no_false_positive():
    """同一 local_id 属于**两条不同消息**（跨分片撞号）：归档与当前库变体集合一致 → 不报。"""
    con, d = _make([(5, 100, 1, b"old-shard"), (5, 900, 1, b"new-shard")])
    _stub_live([(5, 100, 1, b"old-shard"), (5, 900, 1, b"new-shard")])
    assert A.find_recalls(con) == [], "变体集合相同就不该误报"
    con.close(); shutil.rmtree(d, ignore_errors=True)
    print("ok shard_collision_no_false_positive")


def test_watermark_and_gaps():
    con, d = _make([(1, 100, 1, b"a"), (2, 900, 1, b"b")])
    assert A.watermark(con) == 900
    con.execute("insert into gap(start_ts,end_ts) values(1000,2000)")
    con.commit()
    assert len(A.gaps(con)) == 1
    con.close(); shutil.rmtree(d, ignore_errors=True)
    print("ok watermark_and_gaps")


def test_find_recalls_limit():
    """`limit` 只管返回条数（0=不限）；截断与 total 交给工具侧，函数不替调用方做决定。"""
    con, d = _make([(1, 100, 1, b"a"), (2, 200, 1, b"b"), (3, 300, 1, b"c")])
    _stub_live([])                                          # 三条全没了
    assert len(A.find_recalls(con)) == 3, "默认不限"
    assert len(A.find_recalls(con, limit=2)) == 2
    con.close(); shutil.rmtree(d, ignore_errors=True)
    print("ok find_recalls_limit")


def test_prune_and_vacuum():
    """修剪：只删过期的；`0`/负数 = 一行都不删（默认就该是"永不删"）。"""
    now = int(time.time())
    con, d = _make([(1, now - 60 * 86400, 1, b"old"), (2, now - 100, 1, b"new")])
    assert A.prune(con, 0) == 0 and A.prune(con, -1) == 0, "0/负数必须是不修剪"
    assert A.stats(con)["archived"] == 2, A.stats(con)
    assert A.prune(con, 30) == 1, "只该删 60 天前那条（2 天内的那条要留着）"
    assert A.stats(con)["archived"] == 1
    A.vacuum(con)                                           # 压实后库还得能读
    assert A.stats(con)["archived"] == 1
    con.close(); shutil.rmtree(d, ignore_errors=True)
    print("ok prune_and_vacuum")


def test_full_scan_due():
    """全量对账判据：没打底 → 必须；打底后 24h 内 → 不必；超时 → 必须。"""
    import daemon
    con, d = _make([(1, 100, 1, b"hi")])
    now = 10 ** 9
    A.meta_set(con, "backfilled", "1")
    A.meta_set(con, "last_full", now - 10)
    assert not daemon.full_scan_due(con, now), "刚全量过就不该再来一次"
    assert daemon.full_scan_due(con, now, due_s=5)
    A.meta_set(con, "last_full", now - daemon.FULL_RESCAN_S - 1)
    assert daemon.full_scan_due(con, now), "超过 24h 必须回头全量"
    A.meta_set(con, "backfilled", "0")
    assert daemon.full_scan_due(con, now), "没打底过必须全量"
    con.close(); shutil.rmtree(d, ignore_errors=True)
    print("ok full_scan_due")


def test_note_gap_on_sleep():
    """上一拍距今超 3 个周期 → 记一条 gap。

    **休眠**不会让守护退出（`time.sleep` 只是被挂起），只在开机时查一次的话，睡过去那段就是
    静默漏记——所以这一查必须在每拍里也做。
    """
    import daemon
    con, d = _make([(1, 100, 1, b"hi")])
    assert A.gaps(con) == []
    A.meta_set(con, "last_tick", 1000)
    daemon.note_gap(con, 1000 + 30 * 3 + 1, 30)
    assert len(A.gaps(con)) == 1, A.gaps(con)
    A.meta_set(con, "last_tick", 2000)
    daemon.note_gap(con, 2000 + 30, 30)
    assert len(A.gaps(con)) == 1, "刚跳过一拍不该记缺口"
    con.close(); shutil.rmtree(d, ignore_errors=True)
    print("ok note_gap_on_sleep")


def test_real_talker_by_display_name():
    """真机只读冒烟（无微信库时跳过）：**显示名**必须解析成同一个 talker。

    这是 D 侧 P0 的回归：工具层原来 `resolve_talker(x) or x`，解析不出的名字会降级成
    "拿这个名字去比"→ `list_recalls` 回 0 条，看着就像"这个会话没有撤回"。
    端到端的接线（真 exe + 显示名）由 `verify/wechat-mcp/toolkit-live.py` 驱动验证。
    """
    try:
        root = A.core.db_root()
    except Exception as e:                                  # noqa: BLE001
        print(f"skip 显示名冒烟（取不到库: {e}）")
        return
    if not root or not os.path.isdir(root):
        print("skip 显示名冒烟（无数据目录）")
        return
    name = A.core.names().get("filehelper")
    if not name:
        print("skip 显示名冒烟（本机没有文件传输助手）")
        return
    assert A.core.talker_of(name) == "filehelper", "显示名必须解析成同一个 talker"
    try:
        A.core.talker_of("绝对不存在的会话xyz")
    except A.core.UnknownTalker:
        pass
    else:
        raise AssertionError("解析不出的会话名必须抛 UnknownTalker，不能静默返回 0 条")
    print(f"ok 显示名解析：{name} → filehelper；不存在的名字会被拒")


def test_real_backfill():
    """真机只读冒烟（无微信库时跳过）：打底后归档数 > 0，撤回数应为 0（刚打底）。"""
    d = tempfile.mkdtemp(prefix="recall_real_")
    A.live_rows = _ORIG_LIVE                                # 还原被 _stub_live 换掉的实现
    try:
        os.environ["LUMII_WECHAT_RECALL_DB"] = os.path.join(d, "a.db")
        try:
            A.core.db_root()
        except Exception as e:                              # noqa: BLE001
            print(f"skip 真机冒烟（取不到库: {e}）")
            return
        con = A.connect()
        n = A.capture(con, A.live_rows(), seen_ts=1000)
        st = A.stats(con)
        rec = A.find_recalls(con)
        assert n > 0 and st["archived"] == n, (n, st)
        assert rec == [], f"刚打底就报出 {len(rec)} 条撤回，判定有误：{rec[:2]}"
        print(f"ok 真机打底：归档 {n} 条 / {st['talkers']} 会话，撤回 0 条")
        con.close()
    finally:
        os.environ.pop("LUMII_WECHAT_RECALL_DB", None)
        shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    test_capture_never_overwrites()
    test_no_change()
    test_recall_by_removal()
    test_recall_in_place()
    test_read_recall()
    test_shard_collision_no_false_positive()
    test_watermark_and_gaps()
    test_find_recalls_limit()
    test_prune_and_vacuum()
    test_full_scan_due()
    test_note_gap_on_sleep()
    test_real_talker_by_display_name()
    test_real_backfill()
    print("ALL PASS")
