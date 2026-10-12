"""archive 撤回判定单测（合成库，不碰微信）+ 真机打底冒烟。运行：python test_recall.py"""
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
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
    test_real_backfill()
    print("ALL PASS")
