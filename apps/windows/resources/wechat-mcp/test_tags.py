# -*- coding: utf-8 -*-
"""wechat_tags.py 的纯函数自测（不碰微信、不碰真实库）。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wechat_tags as t

N = 0


def ck(name, cond, detail=""):
    global N
    N += 1
    print(("  [PASS] " if cond else "  [FAIL] ") + name + (("  " + detail) if detail and not cond else ""))
    assert cond, name


def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def test_label_ids():
    raw = b"1,4"
    # field 8 varint 2, then field 30 length-delimited "1,4"（key 也要用 varint 编码）
    buf = varint((8 << 3) | 0) + varint(2) + varint((30 << 3) | 2) + varint(len(raw)) + raw
    ck("label_ids 解出 1,4", t._label_ids(buf) == [1, 4])
    ck("label_ids 空 buffer", t._label_ids(b"") == [])
    ck("label_ids 坏数据不抛", t._label_ids(b"\xff") == [])


def test_tag_rows():
    lines = [(38, 250, 66, 262, "随 意"),
             (38, 370, 120, 383, "琥 珀 家 长 （ 57 ）"),
             (38, 410, 120, 423, "未 命 名"),
             (38, 450, 120, 463, "未 命 名 1 （ 0 ）"),
             (40, 490, 114, 503, "新 建 标 签")]
    ck("精确命中", t.find_tag_row(lines, "随意")[4] == "随 意")
    ck("计数 OCR 读花也能命中", t.find_tag_row(lines, "琥珀家长")[4].startswith("琥 珀"))
    ck("前缀歧义时不猜（未命名）", t.find_tag_row(lines, "未命名")[4] == "未 命 名")
    ck("不存在的标签返回 None", t.find_tag_row(lines, "家人") is None)


def test_match():
    contacts = [
        {"username": "wxid_a", "display": "小王", "remark": "", "nick": "小王",
         "alias": "wang1", "kind": "friend", "local_type": 1, "deleted": False,
         "labels": [], "taggable": True},
        {"username": "wxid_b", "display": "同名", "remark": "", "nick": "同名",
         "alias": "", "kind": "friend", "local_type": 1, "deleted": False,
         "labels": [], "taggable": True},
        {"username": "wxid_c", "display": "同名", "remark": "", "nick": "同名",
         "alias": "", "kind": "friend", "local_type": 1, "deleted": False,
         "labels": [], "taggable": True},
        {"username": "wxid_s", "display": "陌生人", "remark": "", "nick": "陌生人",
         "alias": "str1", "kind": "friend", "local_type": 3, "deleted": False,
         "labels": [], "taggable": False},
    ]
    idx = t.index_contacts(contacts)
    c, why = t.match_row({"username": "", "alias": "wang1", "name": ""}, idx)
    ck("按微信号唯一命中", c and c["username"] == "wxid_a", why)
    c, why = t.match_row({"username": "", "alias": "", "name": "同名"}, idx)
    ck("同名好友不猜", c is None and "同名" in why, why)
    c, why = t.match_row({"username": "wxid_s", "alias": "", "name": ""}, idx)
    ck("username 优先", c and c["username"] == "wxid_s")


def test_plan():
    contacts = [
        {"username": "wxid_a", "display": "小王", "remark": "", "nick": "小王",
         "alias": "wang1", "kind": "friend", "local_type": 1, "deleted": False,
         "labels": ["客户"], "taggable": True},
        {"username": "wxid_s", "display": "陌生人", "remark": "", "nick": "陌生人",
         "alias": "str1", "kind": "friend", "local_type": 3, "deleted": False,
         "labels": [], "taggable": False},
    ]
    labels = {1: "客户"}
    members = {"客户": {"wxid_a"}}
    rows = [
        {"row": 2, "group": "客户", "username": "wxid_a", "alias": "", "name": "小王"},
        {"row": 3, "group": "客户", "username": "wxid_s", "alias": "", "name": "陌生人"},
        {"row": 4, "group": "", "username": "wxid_a", "alias": "", "name": ""},
    ]
    plan = t.build_plan(rows, contacts, labels, members)
    ck("已有标签", plan[0]["status"] == "already", plan[0])
    ck("陌生人不可打标签", plan[1]["status"] == "not_taggable", plan[1])
    ck("空分组", plan[2]["status"] == "no_group", plan[2])


def test_selected_count():
    lines = [(630, 54, 720, 65, "已 选 择 1 个 联 累 人")]
    ck("已选择计数", t.selected_count(lines) == 1)
    ck("没有计数返回 None", t.selected_count([]) is None)


def main():
    for fn in (test_label_ids, test_tag_rows, test_match, test_plan, test_selected_count):
        print(fn.__name__)
        fn()
    print("\n%d/%d 通过" % (N, N))


if __name__ == "__main__":
    main()
