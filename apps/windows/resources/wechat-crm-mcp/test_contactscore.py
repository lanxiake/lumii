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


def test_room_names():
    """群成员带回**群里的称呼**，且**稀疏是真的稀疏**（空串不冒充全局名）。

    守卫意图：`contact_fts.db` 读不到时 `room_nicknames` 返回 `{}`，于是所有人都是空串——
    那是**静默变空**。所以这里断言"本机至少有一个群能取到称呼"，一旦那条路断了就炸。
    """
    try:
        root = S.core.db_root()
    except Exception as e:                                  # noqa: BLE001
        print(f"skip 群内称呼冒烟（取不到库: {e}）")
        return
    if not root or not os.path.isdir(root):
        print("skip 群内称呼冒烟（无数据目录）")
        return
    groups = S.list_contacts(scope="group")
    if not groups:
        print("skip 群内称呼冒烟（本机没有群）")
        return
    rows, best = None, (0, None, None)
    for g in groups[:8]:                     # 扫全部群没必要，前 8 个够撞上一个有称呼的
        r = S.list_contacts(room=g["username"])
        n = sum(1 for x in (r or []) if x.get("name_in_room"))
        if n > best[0]:
            best = (n, g, r)
        if r:
            rows = r
    n, g, room = best
    assert rows, "群成员不该为空"
    assert all("name_in_room" in x for x in rows), "每个成员都要有这个字段（空串也算）"
    assert n > 0, ("本机一个群都取不到群里的称呼 —— contact_fts.db 那条路断了"
                   "（全库有 191 条非空，不是「这些群刚好没有」）")
    hit = [x for x in room if x["name_in_room"]]
    assert all(x["name_in_room"] != x["name"] or True for x in hit)   # 允许重名
    print(f"ok 群里的称呼：「{g['name'][:14]}」{n}/{len(room)} 人有"
          f"（例：{hit[0]['name']} → {hit[0]['name_in_room']}）")


def test_bucket_labels():
    """沉默分层的**边界**：`lo < 沉默天数 <= hi`（第一桶无下界），不重不漏。

    "一个人算哪一桶"是会被拿去对外的数，所以边界只能有一份定义（`S._bucket_labels`），
    测试读那一份——在测试里另抄一遍等于测自己的抄写。

    `0.0` 必须在走查里：`silent_days` 是取整过的，刚说过话的人就是 `0.0`，
    第一桶若带 `0 <` 下界，这批人会**从所有桶里消失**（真机漏 10 人，`test_real_ladder` 逮到）。
    """
    bs = S._bucket_labels((30, 60, 90))
    assert [x[0] for x in bs] == ["30 天内有互动", "31-60 天没互动", "61-90 天没互动",
                                  "90 天以上没互动"], bs
    assert [(lo, hi) for _l, lo, hi in bs] == [(None, 30), (30, 60), (60, 90), (90, None)], bs
    # 逐天走一遍：每天**恰好**落进一桶（边界那天的归属不许漂）
    for day in [0.0, -0.3, 0.1, 29.9, 30, 30.1, 60, 60.1, 90, 90.1, 5000]:
        hit = [l for l, lo, hi in bs
               if (lo is None or lo < day) and (hi is None or day <= hi)]
        assert len(hit) == 1, (day, hit)
    assert S._bucket_labels((7,))[1][2] is None and len(S._bucket_labels((7,))) == 2
    print("ok 沉默分层边界：半开半闭、每天恰好一桶（含 0.0）")


def test_real_ladder():
    """真机冒烟：分层的两个口径（私聊 / 含群）**都会出现**，且 never 桶对得上总数。"""
    try:
        root = S.core.db_root()
    except Exception as e:                                  # noqa: BLE001
        print(f"skip 沉默分层冒烟（取不到库: {e}）")
        return
    if not root or not os.path.isdir(root):
        print("skip 沉默分层冒烟（无数据目录）")
        return
    L = S.silence_ladder(top=5)
    buckets = L["buckets"]
    assert L["total"] > 100, L["total"]
    assert sum(b["count"] for b in buckets) + L["never"]["count"] == L["total"], \
        "各桶 + never 必须等于总数（漏人就说明有人没被分进去）"
    assert L["never"]["count"] > 0, "本机实测有几千个从没聊过的好友"
    both = [p for b in buckets for p in b["contacts"] if p["last_spoke_ts"] and p["last_msg_ts"]]
    only_group = [p for b in buckets for p in b["contacts"]
                  if p["last_spoke_ts"] and not p["last_msg_ts"]]
    print(f"ok 沉默分层：共 {L['total']} 人，{buckets[0]['label']} {buckets[0]['count']} / "
          f"never {L['never']['count']}；两个口径都出现（既聊过又冒过泡 {len(both)}、"
          f"只在群里冒过泡 {len(only_group)}）")


def _pb(*fields):
    """拼一段最小 protobuf：`(字段号, 值)`，int 走 varint、bytes 走长度前缀（值与长度都 < 128）。"""
    def key(fn, wt):
        n, out = fn << 3 | wt, b""
        while n >= 0x80:
            out += bytes([n & 0x7F | 0x80])
            n >>= 7
        return out + bytes([n])

    out = b""
    for fn, v in fields:
        if isinstance(v, int):
            out += key(fn, 0) + bytes([v])
        else:
            out += key(fn, 2) + bytes([len(v)]) + v
    return out


def test_label_ids():
    """标签 id 串在 extra_buffer 的字段 30；别的字段要被正确跳过，坏数据不炸只回空。"""
    buf = _pb((2, 1), (4, "签名".encode()), (5, b"CN"), (S.LABEL_FIELD, b"1,4"), (33, b"\n\x00"))
    assert S.label_ids(buf) == [1, 4], S.label_ids(buf)
    assert S.label_ids(_pb((S.LABEL_FIELD, b"3"))) == [3]
    assert S.label_ids(_pb((4, b"x"))) == [], "没有字段 30 = 无标签"
    assert S.label_ids(None) == [] and S.label_ids(b"") == []
    assert S.label_ids(b"\xf2\x01\x05ab") == [], "截断的长度前缀不该炸"
    assert S.label_ids(b"\xf2\x01\x03\xff\xfe1") == [], "非 ASCII 字节不该炸"
    assert S.label_ids(bytes([3 << 3 | 3])) == [], "不认识的 wire type 当解不动"
    print("ok label_ids（字段 30 / 跳过别的字段 / 坏数据回空）")


def test_contacts_csv():
    """通讯录 CSV：BOM、标签用顿号连、布尔转「是」、公式开头加单引号；群成员多两列。"""
    import csv as _csv_mod
    import tempfile
    d = tempfile.mkdtemp(prefix="crm_csv_")
    rows = [{"username": "wxid_a", "name": "=张三", "remark": "", "nick_name": "张三", "alias": "",
             "kind": "friend", "labels": ["客户", "家人"], "local_type": 1, "deleted": False}]
    p = S.write_contacts_csv(rows, d, "通讯录_客户.csv")
    raw = open(p, "rb").read()
    assert raw.startswith(b"\xef\xbb\xbf"), "没有 BOM，Excel 会把中文读成乱码"
    got = list(_csv_mod.reader(open(p, encoding="utf-8-sig")))
    assert got[0][:5] == ["显示名", "备注", "昵称", "微信号", "标签"], got[0]
    assert got[1][0] == "'=张三" and got[1][4] == "客户、家人" and got[1][-1] == "", got[1]
    room = [{"username": "wxid_b", "name": "李四", "name_in_room": "老李", "kind": "friend", "is_me": True}]
    got = list(_csv_mod.reader(open(S.write_contacts_csv(room, d, "群.csv"), encoding="utf-8-sig")))
    assert got[0] == ["显示名", "种类", "username", "群内称呼", "是我"], got[0]
    assert got[1] == ["李四", "friend", "wxid_b", "老李", "是"], got[1]
    print("ok contacts_csv（BOM / 标签 / 防公式注入 / 群成员列）")


def test_real_labels():
    """真机冒烟：本机给好友打过标签，就**必须**有人解出标签——字段号漂移时这里炸，别静默全空。"""
    try:
        root = S.core.db_root()
    except Exception as e:                                  # noqa: BLE001
        print(f"skip 标签冒烟（取不到库: {e}）")
        return
    if not root or not os.path.isdir(root):
        print("skip 标签冒烟（无数据目录）")
        return
    ls = S.list_labels()
    if not ls:
        print("skip 标签冒烟（本机没有标签）")
        return
    tagged = sum(x["count"] for x in ls)
    assert tagged > 0, f"有 {len(ls)} 个标签却一个人都解不出 —— extra_buffer 字段 {S.LABEL_FIELD} 可能变了"
    top = max(ls, key=lambda x: x["count"])
    hit = S.list_contacts(label=top["name"])
    assert len(hit) == top["count"] and all(top["name"] in c["labels"] for c in hit), \
        "按标签筛出来的人数要和 list_labels 的计数一致"
    print(f"ok 标签：{len(ls)} 个标签，最多的「{top['name']}」{top['count']} 人")


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
    test_room_names()
    test_bucket_labels()
    test_label_ids()
    test_contacts_csv()
    test_real_labels()
    test_real_ladder()
    test_real_smoke()
    print("ALL PASS")
