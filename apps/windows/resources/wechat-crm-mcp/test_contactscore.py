"""contactscore 单测（kind_of 纯函数 + 真机只读冒烟）。运行：python test_contactscore.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:                                # Windows 控制台常是 GBK：会话名里可能带编不出的字符（实测 U+00A0），
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # 不钉住 print 会抛错 → 测试**假失败**
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import contactscore as S


def test_kind_of():
    # 后缀是硬规则——`local_type` 实测语义不干净，所以分类只认后缀/名单
    assert S.kind_of("45395822028@chatroom") == "group"
    assert S.kind_of("25984981965024569@open") == "open"
    assert S.kind_of("gh_b2a8d5914481") == "official"
    assert S.kind_of("wxid_6003660035211") == "friend"
    assert S.kind_of("zhangsan1990") == "friend"           # 自定义用户名也是好友
    assert S.kind_of("filehelper") == "system"
    assert S.kind_of("notifymessage") == "system"
    assert S.kind_of("") == "friend"                       # 空串不炸
    print("ok kind_of")


def test_real_smoke():
    """真机只读冒烟（无微信库时跳过）。"""
    try:
        root = S.core.db_root()
    except Exception as e:                                  # noqa: BLE001
        print(f"skip 真机冒烟（取不到库: {e}）")
        return
    if not root or not os.path.isdir(root):
        print("skip 真机冒烟（无数据目录）")
        return

    friends = S.list_contacts(scope="friend")
    groups = S.list_contacts(scope="group")
    official = S.list_contacts(scope="official")
    assert friends and groups, (len(friends), len(groups))
    print(f"ok 通讯录：好友 {len(friends)} / 群 {len(groups)} / 公众号 {len(official)}")

    room = S.list_contacts(room=groups[0]["username"])
    assert room, "群成员不该为空"
    print(f"ok 群成员：{groups[0]['name'][:12]} 共 {len(room)} 人")

    stats = S.contact_stats(groups[0]["username"])
    assert stats["count"] >= 1 and stats["first_ts"] <= stats["last_ts"], stats
    print(f"ok 会话统计：{stats['name'][:12]} {stats['count']} 条"
          f"（我 {stats['from_me']} / 对方 {stats['from_other']}，沉默 {stats['silent_days']} 天）")

    rank = S.interaction_rank(top=5)
    assert rank and rank[0]["count"] >= rank[-1]["count"], rank
    stale = S.interaction_rank(top=3, sort="recent")
    assert len(stale) == 3
    print(f"ok 排行：top1 {rank[0]['name'][:12]} {rank[0]['count']} 条")


if __name__ == "__main__":
    test_kind_of()
    test_real_smoke()
    print("ALL PASS")
