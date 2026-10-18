"""跨分片 `local_id` 撞号的回归测试（合成库，不碰微信）。

背景（2026-10-18 真机实测）：`local_id` **只在单个 `message_N.db` 内唯一**——每个分片各自
从 1 自增，同一会话跨分片撞号是常态（本机实测 3694 处）。旧实现 `_message_by_id` 返回**第一个**
命中，于是 `read_image` / `transcribe_voice` 可能拿到另一条消息：实测 2024 年的语音（lid=4）
被解析成 2026 年的「撤回了一条消息」（也是 lid=4），转写直接 not_found。

运行：python test_collision.py
"""
import os
import shutil
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import wechat_core as core

TALKER = "test@chatroom"
TBL = core.tbl_of(TALKER)
COLS = ("create_time", "local_type", "message_content", "real_sender_id",
        "local_id", "source", "packed_info_data")


def _shard(path, rows):
    con = sqlite3.connect(path)
    con.execute(f"create table [{TBL}] ({', '.join(COLS)})")
    for ct, lt, content, lid in rows:
        con.execute(f"insert into [{TBL}] values (?,?,?,?,?,?,?)",
                    (ct, lt, content, 0, lid, None, None))
    con.commit()
    con.close()


def _patch(paths):
    """把 core 的缓存指向合成分片；返回还原函数。"""
    saved = {n: getattr(core, n) for n in
             ("_cache", "_refresh", "names", "self_wxid", "attach_voice", "attach_image")}
    core._cache = {"msg": list(paths), "tables": {p: {TBL} for p in paths},
                   "senders": {p: {} for p in paths}}
    core._refresh = lambda: None
    core.names = lambda: {}
    core.self_wxid = lambda: "me"

    def fake_voice(msgs, talker=None):
        for m in msgs:
            m["voice_path"] = "fake.silk"      # 模拟音频还在（真实实现挂解密后的本地路径）

    core.attach_voice = fake_voice
    core.attach_image = lambda *a, **k: None

    def restore():
        for n, v in saved.items():
            setattr(core, n, v)
    return restore


def test_voice_prefers_type_over_newest():
    """没有 ts 时：同 lid 的语音与系统消息并存 → 必须挑语音，而不是"最新那条"。"""
    d = tempfile.mkdtemp(prefix="collision_")
    try:
        p1, p2 = os.path.join(d, "s1.db"), os.path.join(d, "s2.db")
        _shard(p1, [(100, 34, b"voice", 4)])            # 老分片：语音
        _shard(p2, [(900, 10000, b"system", 4)])        # 新分片：系统消息（更"新"）
        restore = _patch([p1, p2])
        try:
            m = core.voice_message(TALKER, 4)
            assert m and m["type"] == 34 and m["ts"] == 100, m
        finally:
            restore()
    finally:
        shutil.rmtree(d, ignore_errors=True)
    print("ok voice_prefers_type_over_newest")


def test_ts_locks_exact_shard_row():
    """给了 ts：两条同 lid 的语音分属不同分片 → 必须精确取到 ts 指定的那条。"""
    d = tempfile.mkdtemp(prefix="collision_")
    try:
        p1, p2 = os.path.join(d, "s1.db"), os.path.join(d, "s2.db")
        _shard(p1, [(100, 34, b"old-voice", 4)])
        _shard(p2, [(900, 34, b"new-voice", 4)])
        restore = _patch([p1, p2])
        try:
            old = core.voice_message(TALKER, 4, ts=100)
            new = core.voice_message(TALKER, 4, ts=900)
            assert old and old["ts"] == 100, old
            assert new and new["ts"] == 900, new
            assert core.voice_message(TALKER, 4, ts=12345) is None, "ts 不存在时必须 not_found"
        finally:
            restore()
    finally:
        shutil.rmtree(d, ignore_errors=True)
    print("ok ts_locks_exact_shard_row")


def test_image_not_fooled_by_other_shard():
    """同 lid 在别的分片是图片、本分片不是 → 不带 ts 时按 type=3 挑，挑不到才报 not_image。"""
    d = tempfile.mkdtemp(prefix="collision_")
    try:
        p1, p2 = os.path.join(d, "s1.db"), os.path.join(d, "s2.db")
        _shard(p1, [(100, 3, b"img", 4)])
        _shard(p2, [(900, 10000, b"system", 4)])
        restore = _patch([p1, p2])
        old_key = core._image_key_cached
        core._image_key_cached = lambda: False       # 与机器是否抓过 key 无关
        try:
            m, why = core.image_message(TALKER, 4)
            # 没抓过图片 key → 命中图片后返回 no_key；关键是**不能**报 not_image
            assert why == "no_key", f"应命中图片消息后报 no_key，实际 {why!r}"
        finally:
            core._image_key_cached = old_key
            restore()
    finally:
        shutil.rmtree(d, ignore_errors=True)
    print("ok image_not_fooled_by_other_shard")


def test_history_limit_zero_no_crash():
    """`limit=0` 不能炸：返回空页（旧实现 `min()` 空迭代器抛 ValueError）。"""
    saved = {n: getattr(core, n) for n in ("_rows_full", "tbl_of", "names", "self_wxid",
                                            "attach_voice", "attach_image", "attach_video")}
    core._rows_full = lambda *a, **k: []
    core.tbl_of = lambda t: TBL
    core.names = lambda: {}
    core.self_wxid = lambda: "me"
    core.attach_voice = core.attach_image = core.attach_video = lambda *a, **k: None
    try:
        out = core.history(TALKER, 0, 0)
        assert out["count"] == 0 and out["messages"] == [], out
        assert "cursor" not in out, out
    finally:
        for n, v in saved.items():
            setattr(core, n, v)
    print("ok history_limit_zero_no_crash")


if __name__ == "__main__":
    test_voice_prefers_type_over_newest()
    test_ts_locks_exact_shard_row()
    test_image_not_fooled_by_other_shard()
    test_history_limit_zero_no_crash()
    print("ALL PASS")
