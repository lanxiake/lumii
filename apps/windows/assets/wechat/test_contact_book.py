"""contact_book：挑人候选来自通讯录（好友 + 群），不是会话。

合成一份 contact.db，只验证过滤与模糊查询这一层——真实库的列名/形状由真机冒烟兜。
"""

from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest

import wechat_core


_ROWS = [
    ("wxid_me", "我", "", "", 1, 0),
    ("wxid_mama", "妈妈昵称", "妈妈", "", 1, 0),
    ("12345@chatroom", "家人群", "", "", 0, 0),
    ("gh_official", "某公众号", "", "", 1, 0),
    ("filehelper", "文件传输助手", "", "", 0, 0),
    ("wxid_stranger", "群里的陌生人", "", "", 3, 0),
    ("wxid_deleted", "删掉的人", "", "", 1, 1),
    ("wxid_alias", "", "", "aliased", 1, 0),
]


class ContactBookTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.db = os.path.join(self.dir, "contact.db")
        con = sqlite3.connect(self.db)
        con.execute(
            "create table contact (id integer primary key, username text, nick_name text,"
            " remark text, alias text, local_type integer, delete_flag integer)")
        con.executemany(
            "insert into contact (username, nick_name, remark, alias, local_type, delete_flag)"
            " values (?,?,?,?,?,?)", _ROWS)
        con.commit()
        con.close()
        self._orig = (wechat_core._refresh, wechat_core.self_wxid, wechat_core._cache["contact"])
        wechat_core._refresh = lambda: None
        wechat_core.self_wxid = lambda root=None: "wxid_me"
        wechat_core._cache["contact"] = self.db

    def tearDown(self):
        refresh, self_wxid, self._orig_contact = self._orig
        wechat_core._refresh = refresh
        wechat_core.self_wxid = self_wxid
        wechat_core._cache["contact"] = self._orig_contact

    def test_filters_non_people_and_keeps_groups(self):
        book = wechat_core.contact_book()
        ids = [c["talker"] for c in book["contacts"]]
        # 自己 / 公众号 / 系统号 / 陌生人(local_type=3) / 已删除 都不出现
        for gone in ("wxid_me", "gh_official", "filehelper", "wxid_stranger", "wxid_deleted"):
            self.assertNotIn(gone, ids)
        # 好友与群在；显示名「备注 > 昵称 > 别名 > id」
        by_id = {c["talker"]: c for c in book["contacts"]}
        self.assertEqual(by_id["wxid_mama"]["name"], "妈妈")
        self.assertEqual(by_id["wxid_alias"]["name"], "aliased")
        self.assertEqual(by_id["12345@chatroom"]["kind"], "group")
        self.assertEqual(book["self"], {"talker": "wxid_me", "name": "我"})

    def test_keyword_is_fuzzy_and_hits_alias(self):
        names = [c["name"] for c in wechat_core.contact_book(keyword="妈妈")["contacts"]]
        self.assertEqual(names, ["妈妈"])
        # 备注、昵称、别名、wxid 任意一段命中都算；大小写不敏感
        self.assertEqual(
            [c["talker"] for c in wechat_core.contact_book(keyword="ALIAS")["contacts"]],
            ["wxid_alias"])
        self.assertEqual(
            [c["talker"] for c in wechat_core.contact_book(keyword="家人")["contacts"]],
            ["12345@chatroom"])


if __name__ == "__main__":
    unittest.main()
