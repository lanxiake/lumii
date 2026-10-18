#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""chatlog 模块完整单元测试"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = os.path.join(os.path.dirname(HERE), "wechat-mcp")
for p in (HERE, SHARED):
    if p not in sys.path:
        sys.path.insert(0, p)

import chatlog as L


def test_type_label():
    """测试消息类型标签提取"""
    assert L.type_label(1, "Hello") == "文本"
    assert L.type_label(3, "[图片 12KB]") == "图片"
    assert L.type_label(43, "[视频 1.2MB]") == "视频"
    assert L.type_label(49, "[文件 document.pdf]") == "文件"
    assert L.type_label(10000, "[系统消息]") == "系统"
    assert L.type_label(999, "其他") == "其它"
    print("[PASS] type_label extraction")


def test_is_question():
    """测试问句判定"""
    assert L.is_question("你好吗？") == True
    assert L.is_question("你好吗?") == True
    assert L.is_question("能不能帮我一下") == True
    assert L.is_question("有没有时间") == True
    assert L.is_question("怎么做") == True
    assert L.is_question("为什么这样") == True
    assert L.is_question("多少钱") == True
    assert L.is_question("几点见面") == True

    # 负向测试
    assert L.is_question("你好") == False
    assert L.is_question("收到") == False
    assert L.is_question("") == False
    assert L.is_question("A" * 300) == False  # 超长消息

    print("[PASS] is_question detection")


def test_sessions_of():
    """测试对话分段"""
    # 时间戳，是否是我，文本，类型
    seq = [
        (1000, True, "Hi", 1),
        (1100, False, "Hello", 1),       # 100秒后，同一段
        (1200, True, "How are you", 1),  # 再100秒，同一段
        (3000, False, "Fine", 1),        # 1800秒后，新的一段
        (3100, True, "Good", 1),         # 100秒后，同一段
    ]

    sessions = L.sessions_of(seq, gap_s=1800)
    assert len(sessions) == 2
    assert sessions[0] == [0, 1, 2]  # 前三条
    assert sessions[1] == [3, 4]     # 后两条

    print("[PASS] sessions_of segmentation")


def test_hot_pairs():
    """测试高频词提取"""
    texts = [
        "这个产品怎么样",
        "产品价格是多少",
        "price is good",
        "产品质量不错",
    ]

    pairs = L.hot_pairs(texts, top=5)

    # 应该包含"产品"相关的2-gram
    pair_texts = [p["text"] for p in pairs]
    assert "产品" in pair_texts or "个产" in pair_texts
    assert "price" in pair_texts

    # 验证结构
    assert all("text" in p and "count" in p for p in pairs)
    assert pairs[0]["count"] >= pairs[-1]["count"]  # 降序

    print("[PASS] hot_pairs extraction")


def test_search_messages_validation():
    """测试 search_messages 参数校验"""
    try:
        L.search_messages("")
        assert False, "Should reject empty keyword"
    except ValueError as e:
        assert "不能为空" in str(e)

    try:
        L.search_messages("   ")
        assert False, "Should reject whitespace keyword"
    except ValueError as e:
        assert "不能为空" in str(e)

    print("[PASS] search_messages validation")


def test_read_messages_validation():
    """测试 read_messages 参数校验"""
    try:
        L.read_messages("")
        assert False, "Should reject empty talker"
    except ValueError as e:
        assert "不能为空" in str(e)

    try:
        L.read_messages("   ")
        assert False, "Should reject whitespace talker"
    except ValueError as e:
        assert "不能为空" in str(e)

    print("[PASS] read_messages validation")


def test_customer_brief_validation():
    """测试 customer_brief 参数校验"""
    try:
        L.customer_brief("")
        assert False, "Should reject empty talker"
    except ValueError as e:
        assert "不能为空" in str(e)

    try:
        L.customer_brief("   ")
        assert False, "Should reject whitespace talker"
    except ValueError as e:
        assert "不能为空" in str(e)

    print("[PASS] customer_brief validation")


def test_brief_from():
    """测试客户简报生成（纯函数测试）"""
    # 构造测试数据：时间戳，是否是我，文本，类型
    now = 1000000
    seq = [
        (now - 10000, False, "你好，有个问题？", 1),  # 对方开场，提问
        (now - 9900, True, "你好，请说", 1),         # 我回复（100秒）
        (now - 9800, False, "价格是多少", 1),        # 对方提问
        (now - 9700, True, "100元", 1),             # 我回复（100秒）
        (now - 7000, False, "好的谢谢", 1),          # 2700秒后，新段，对方开场
        (now - 100, True, "不客气", 1),              # 我回复（6900秒，超过24h判定）
    ]

    brief = L.brief_from(seq, top=10, now=now)

    # 验证基础统计
    assert brief["total_count"] == 6
    assert brief["my_count"] == 3
    assert brief["their_count"] == 3

    # 验证分段
    assert brief["segments"] >= 2

    # 验证主动性（对方开场2次，我开场0次）
    assert brief["opened_by_them"] == 2
    assert brief["opened_by_me"] == 0

    # 验证回复速度（中位数应该约100秒）
    assert brief["my_reply_s"] is not None

    # 验证消息类型
    assert "文本" in brief["types"]

    print("[PASS] brief_from generation")


if __name__ == "__main__":
    print("=" * 60)
    print("Running chatlog unit tests")
    print("=" * 60)

    # 纯函数测试（不需要数据库）
    test_type_label()
    test_is_question()
    test_sessions_of()
    test_hot_pairs()
    test_brief_from()

    # 参数校验测试
    test_search_messages_validation()
    test_read_messages_validation()
    test_customer_brief_validation()

    print("=" * 60)
    print("All tests completed")
    print("=" * 60)
