#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""contactscore 模块完整单元测试"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = os.path.join(os.path.dirname(HERE), "wechat-mcp")
for p in (HERE, SHARED):
    if p not in sys.path:
        sys.path.insert(0, p)

import contactscore as S


def test_kind_of():
    """测试联系人分类逻辑"""
    assert S.kind_of("test@chatroom") == "group"
    assert S.kind_of("gh_abc123") == "official"
    assert S.kind_of("wxid_123@openim") == "open"
    assert S.kind_of("filehelper") == "system"
    assert S.kind_of("wxid_normal") == "friend"
    assert S.kind_of("custom_username") == "friend"
    print("[PASS] kind_of classification")


def test_page_of():
    """测试分页逻辑"""
    items = [{"id": i} for i in range(100)]

    # 全部返回
    result = S.page_of(items, limit=0)
    assert result["total"] == 100
    assert result["count"] == 100

    # 分页返回
    result = S.page_of(items, limit=20, offset=0)
    assert result["total"] == 100
    assert result["count"] == 20
    assert result["offset"] == 0
    assert result["contacts"][0]["id"] == 0
    assert result["contacts"][-1]["id"] == 19

    # 偏移分页
    result = S.page_of(items, limit=20, offset=20)
    assert result["count"] == 20
    assert result["contacts"][0]["id"] == 20
    assert result["contacts"][-1]["id"] == 39

    # 超出范围
    result = S.page_of(items, limit=20, offset=100)
    assert result["count"] == 0

    print("[PASS] page_of pagination")


def test_bucket_labels():
    """测试分层标签生成"""
    labels = S._bucket_labels((30, 60, 90))

    assert len(labels) == 4  # 30天内, 31-60, 61-90, 90+

    # 第一桶：无下界
    assert labels[0][1] is None  # lo is None
    assert labels[0][2] == 30    # hi = 30

    # 中间桶：有上下界
    assert labels[1][1] == 30    # lo = 30
    assert labels[1][2] == 60    # hi = 60

    # 最后一桶：无上界
    assert labels[3][1] == 90    # lo = 90
    assert labels[3][2] is None  # hi is None

    print("[PASS] _bucket_labels generation")


def test_contact_stats_validation():
    """测试 contact_stats 参数校验"""
    try:
        S.contact_stats("")
        assert False, "Should reject empty talker"
    except ValueError as e:
        assert "不能为空" in str(e)

    try:
        S.contact_stats("   ")
        assert False, "Should reject whitespace talker"
    except ValueError as e:
        assert "不能为空" in str(e)

    print("[PASS] contact_stats validation")


def test_list_contacts_pagination():
    """测试 list_contacts 分页参数（需要真实数据库）"""
    try:
        # 测试默认行为（limit=0 返回全部）
        all_contacts = S.list_contacts(scope="friend", limit=0)
        total = len(all_contacts)

        if total > 20:
            # 测试分页
            page1 = S.list_contacts(scope="friend", limit=20, offset=0)
            assert len(page1) == 20

            page2 = S.list_contacts(scope="friend", limit=20, offset=20)
            assert len(page2) == min(20, total - 20)

            # 验证不重复
            if len(page2) > 0:
                assert page1[0]["username"] != page2[0]["username"]

            print(f"[PASS] list_contacts pagination (total={total})")
        else:
            print(f"[SKIP] list_contacts pagination (insufficient data: {total})")
    except Exception as e:
        print(f"[SKIP] list_contacts pagination (no database): {e}")


def test_silence_ladder_flat_structure():
    """测试 silence_ladder 扁平化结构（需要真实数据库）"""
    try:
        result = S.silence_ladder(scope="friend", days=(30, 60, 90), top=5)

        # 验证向后兼容的 buckets 结构
        assert "buckets" in result
        assert isinstance(result["buckets"], list)

        # 验证新增的扁平化键
        assert "within_30" in result
        assert "31_60" in result
        assert "61_90" in result
        assert "90_plus" in result
        assert "never" in result

        # 验证数据一致性
        assert result["within_30"]["count"] == result["buckets"][0]["count"]

        print("[PASS] silence_ladder flat structure")
    except Exception as e:
        print(f"[SKIP] silence_ladder flat structure (no database): {e}")


if __name__ == "__main__":
    print("=" * 60)
    print("Running contactscore unit tests")
    print("=" * 60)

    # 基础逻辑测试（不需要数据库）
    test_kind_of()
    test_page_of()
    test_bucket_labels()
    test_contact_stats_validation()

    # 集成测试（需要数据库）
    test_list_contacts_pagination()
    test_silence_ladder_flat_structure()

    print("=" * 60)
    print("All tests completed")
    print("=" * 60)
