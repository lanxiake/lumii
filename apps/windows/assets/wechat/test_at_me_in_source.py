"""at_me_in_source：群 @ 判定必须同时认 CDATA 与裸 atuserlist。

本机群库实测（2026-10-29）：201 条带 atuserlist 的 source 里，
约 1/3 是 `<atuserlist><![CDATA[wxid]]></atuserlist>`，约 2/3 是
`<atuserlist>wxid</atuserlist>`（无 CDATA）。只认前者时，「只回 @我」会漏掉
大多数真 @，看起来像触发条件没生效。
"""

from __future__ import annotations

import unittest

import wechat_core


class AtMeInSourceTest(unittest.TestCase):
    """覆盖 msgsource 里两种 atuserlist 写法与 @所有人。"""

    def test_plain_atuserlist_counts_as_at_me(self):
        """无 CDATA 的写法（本机约 2/3）必须命中。"""
        src = "<msgsource><atuserlist>wxid_me</atuserlist></msgsource>"
        self.assertTrue(wechat_core.at_me_in_source(src, "wxid_me"))
        self.assertFalse(wechat_core.at_me_in_source(src, "wxid_other"))

    def test_cdata_atuserlist_still_works(self):
        """CDATA 写法不能回归。"""
        src = "<msgsource><atuserlist><![CDATA[wxid_me,wxid_friend]]></atuserlist></msgsource>"
        self.assertTrue(wechat_core.at_me_in_source(src, "wxid_me"))
        self.assertTrue(wechat_core.at_me_in_source(src, "wxid_friend"))
        self.assertFalse(wechat_core.at_me_in_source(src, "wxid_other"))

    def test_notify_all_counts_as_at_me(self):
        """@所有人 写的是 notify@all，也应叫醒「只回 @我」的闸门。"""
        src = "<msgsource><atuserlist>notify@all</atuserlist></msgsource>"
        self.assertTrue(wechat_core.at_me_in_source(src, "wxid_me"))

    def test_empty_or_missing_is_false(self):
        self.assertFalse(wechat_core.at_me_in_source("", "wxid_me"))
        self.assertFalse(wechat_core.at_me_in_source("<msgsource/>", "wxid_me"))
        self.assertFalse(wechat_core.at_me_in_source("<atuserlist>wxid_me</atuserlist>", ""))


if __name__ == "__main__":
    unittest.main()
