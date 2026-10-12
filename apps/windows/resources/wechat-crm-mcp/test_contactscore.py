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


def test_contacts_paging():
    """翻页：`limit`/`offset` 切片 + `total` 报总数。

    本机好友 2500+ 条，默认不掐一次就是 415 KB 灌进模型上下文——所以默认 200 且必须报 `total`，
    不然调用方看不出"只有 200 个人"还是"被截断了"。
    """
    rows = [{"username": f"u{i}", "name": f"n{i}"} for i in range(5)]
    p = S.page_of(rows, 200)
    assert p["total"] == 5 and p["count"] == 5, p            # 5 条 < 默认 200 → 全给
    p = S.page_of(rows, 2)
    assert (p["total"], p["count"], p["offset"]) == (5, 2, 0), p
    p = S.page_of(rows, 2, 4)
    assert p["count"] == 1 and [c["name"] for c in p["contacts"]] == ["n4"], p
    p = S.page_of(rows, 0, 0)
    assert p["count"] == 5 and p["total"] == 5, "limit=0 = 全部"
    p = S.page_of(rows, 2, None)                             # offset 缺省/None 当 0
    assert p["offset"] == 0 and p["count"] == 2, p
    print("ok contacts_paging")


def test_unknown_talker_raises():
    """解析不出的会话名必须**抛**，不能静默回 `count: 0`——"0 条"与"你俩没聊过"分不出来。"""
    try:
        root = S.core.db_root()
    except Exception as e:                                  # noqa: BLE001
        print(f"skip 未知会话冒烟（取不到库: {e}）")
        return
    if not root or not os.path.isdir(root):
        print("skip 未知会话冒烟（无数据目录）")
        return
    try:
        S.contact_stats("绝对不存在的会话xyz")
    except S.core.UnknownTalker:
        pass
    else:
        raise AssertionError("解析不出的会话名必须抛 UnknownTalker")
    name = S.core.names().get("filehelper")
    if name:
        assert S.contact_stats(name)["count"] == S.contact_stats("filehelper")["count"], \
            "显示名与 username 必须等价"
        print(f"ok 未知会话被拒 + 显示名等价（{name}）")
    else:
        print("ok 未知会话被拒")


def test_room_members():
    """群成员：**包含自己**且 `is_me` 是真的；群**显示名**与群号必须等价。"""
    try:
        root = S.core.db_root()
    except Exception as e:                                  # noqa: BLE001
        print(f"skip 群成员冒烟（取不到库: {e}）")
        return
    if not root or not os.path.isdir(root):
        print("skip 群成员冒烟（无数据目录）")
        return
    groups = S.list_contacts(scope="group")
    if not groups:
        print("skip 群成员冒烟（本机没有群）")
        return
    g = groups[0]
    room = S.list_contacts(room=g["username"])
    assert room and any(r["is_me"] for r in room), f"{g['name'][:12]} 的成员里该有自己的那条"
    if S.core.resolve_talker(g["name"]) == g["username"]:
        assert S.list_contacts(room=g["name"]) == room, "群显示名与群号必须等价"
    print(f"ok 群成员：{g['name'][:12]} 共 {len(room)} 人（含自己，is_me 有效）")


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
    test_contacts_paging()
    test_unknown_talker_raises()
    test_room_members()
    test_real_smoke()
    print("ALL PASS")
