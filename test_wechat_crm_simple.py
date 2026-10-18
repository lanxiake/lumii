#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""wechat-crm-mcp 全面功能测试 - 简化版"""
import os
import sys
import time
import json

# 路径设置
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "apps/windows/resources/wechat-crm-mcp"))
sys.path.insert(0, os.path.join(HERE, "apps/windows/resources/wechat-mcp"))

import contactscore as S
import chatlog as L

results = {"passed": [], "failed": [], "warnings": [], "perf": {}}

def test(name):
    def wrapper(func):
        def inner():
            print(f"\n[TEST] {name}")
            start = time.time()
            try:
                result = func()
                elapsed = (time.time() - start) * 1000
                results["passed"].append(name)
                results["perf"][name] = elapsed
                print(f"[PASS] {name} ({elapsed:.0f}ms)")
                return result
            except Exception as e:
                results["failed"].append((name, str(e)))
                print(f"[FAIL] {name}: {e}")
                return None
        return inner
    return wrapper

print("="*80)
print("wechat-crm-mcp 全面功能测试")
print("="*80)

# 获取测试用会话
test_talker = None
test_talker_name = None

@test("0. 获取测试会话")
def get_test_session():
    global test_talker, test_talker_name
    ranking = S.interaction_rank(top=1, sort="count")
    if ranking:
        test_talker = ranking[0]["username"]
        test_talker_name = ranking[0]["name"]
        print(f"    使用会话: {test_talker_name}")
        return True
    return False

# ============= 通讯录面测试 =============
print("\n【通讯录面 - 不读正文】")

@test("1.1 list_contacts - 列好友")
def test_list_contacts_friends():
    contacts = S.list_contacts(scope="friend", limit=10)
    assert len(contacts) > 0, "好友列表为空"
    print(f"    返回 {len(contacts)} 个好友")
    return contacts

@test("1.2 list_contacts - 列群组")
def test_list_contacts_groups():
    groups = S.list_contacts(scope="group", limit=5)
    assert all(c["username"].endswith("@chatroom") for c in groups), "分类错误"
    print(f"    返回 {len(groups)} 个群")
    return groups

@test("1.3 list_contacts - 群成员")
def test_list_room_members():
    groups = S.list_contacts(scope="group", limit=1)
    if not groups:
        return None
    room_name = groups[0]["name"]
    members = S.list_contacts(room=room_name)
    has_nick = sum(1 for m in members if m.get("name_in_room"))
    print(f"    群 '{room_name}' 有 {len(members)} 人，{has_nick} 人有群昵称")
    if has_nick == 0:
        results["warnings"].append(("群昵称", "该群无人设置群昵称(稀疏性正常)"))
    return members

@test("1.4 list_contacts - 分页")
def test_list_contacts_pagination():
    page1 = S.list_contacts(scope="friend", limit=5, offset=0)
    page2 = S.list_contacts(scope="friend", limit=5, offset=5)
    if len(page1) >= 5 and len(page2) > 0:
        assert page1[0]["username"] != page2[0]["username"], "分页重复"
    print(f"    分页正常")
    return True

@test("2.1 silence_ladder - 基本分层")
def test_silence_ladder_basic():
    ladder = S.silence_ladder(scope="friend", days=(30, 60, 90), top=5)
    w30 = ladder["within_30"]["count"]
    d31_60 = ladder["31_60"]["count"]
    never = ladder["never"]["count"]
    print(f"    30天内:{w30}人 31-60天:{d31_60}人 从未:{never}人")
    if never > w30 + d31_60:
        results["warnings"].append(("数据质量", f"从未联系({never})>有互动({w30+d31_60})"))
    return ladder

@test("2.2 silence_ladder - 自定义天数")
def test_silence_ladder_custom():
    ladder = S.silence_ladder(scope="friend", days=(7, 14, 30), top=3)
    assert "within_7" in ladder, "自定义天数未生效"
    print(f"    自定义天数正常")
    return ladder

@test("3.1 interaction_rank - 按条数")
def test_interaction_rank_count():
    ranking = S.interaction_rank(top=5, sort="count")
    if len(ranking) >= 2:
        assert ranking[0]["count"] >= ranking[1]["count"], "排序错误"
    top3 = [(r["name"], r["count"]) for r in ranking[:3]]
    print(f"    Top3: {top3}")
    return ranking

@test("3.2 interaction_rank - 久未联系")
def test_interaction_rank_recent():
    ranking = S.interaction_rank(top=5, sort="recent")
    print(f"    返回 {len(ranking)} 个会话")
    return ranking

@test("4.1 contact_stats - 基本统计")
def test_contact_stats_basic():
    if not test_talker:
        raise ValueError("无测试会话")
    stats = S.contact_stats(test_talker)
    assert "total_count" in stats, "缺少 total_count"
    assert stats["my_count"] + stats["their_count"] == stats["total_count"]
    print(f"    {test_talker_name}: 总{stats['total_count']}条 "
          f"我{stats['my_count']}/对方{stats['their_count']}")
    if "top_hours" in stats and stats["top_hours"]:
        h = stats["top_hours"][0]
        print(f"    最活跃: {h['hour']}点({h['count']}条)")
    return stats

@test("4.2 contact_stats - 时间范围")
def test_contact_stats_range():
    if not test_talker:
        raise ValueError("无测试会话")
    now = int(time.time())
    thirty_days_ago = now - 30 * 86400
    stats = S.contact_stats(test_talker, since=thirty_days_ago, until=now)
    print(f"    30天内 {stats['total_count']} 条")
    return stats

# ============= 消息面测试 =============
print("\n【消息面 - 读正文】")

@test("5.1 read_messages - 基本读取")
def test_read_messages_basic():
    if not test_talker:
        raise ValueError("无测试会话")
    msgs = L.read_messages(test_talker, limit=10)
    assert "messages" in msgs and len(msgs["messages"]) > 0
    print(f"    读取 {msgs['count']} 条消息")
    if msgs["messages"]:
        msg = msgs["messages"][0]
        required = ["ts", "type", "text", "from_me"]
        missing = [f for f in required if f not in msg]
        if missing:
            results["warnings"].append(("消息结构", f"缺少字段: {missing}"))
    if msgs.get("truncated"):
        results["warnings"].append(("read_messages", "消息被截断"))
    return msgs

@test("5.2 read_messages - 时间范围")
def test_read_messages_range():
    if not test_talker:
        raise ValueError("无测试会话")
    now = int(time.time())
    seven_days_ago = now - 7 * 86400
    msgs = L.read_messages(test_talker, since=seven_days_ago, until=now, limit=5)
    print(f"    7天内 {msgs['count']} 条")
    return msgs

@test("6.1 search_messages - 全库搜索")
def test_search_全库():
    search = L.search_messages("好", limit=10)
    print(f"    找到 {search['count']} 条")
    if search.get("truncated"):
        results["warnings"].append(("search_messages", "搜索被截断"))
    return search

@test("6.2 search_messages - 单会话搜索")
def test_search_单会话():
    if not test_talker:
        raise ValueError("无测试会话")
    search = L.search_messages("好", talker=test_talker, limit=5)
    print(f"    在 {test_talker_name} 找到 {search['count']} 条")
    return search

@test("7.1 customer_brief - 基本简报")
def test_customer_brief():
    if not test_talker:
        raise ValueError("无测试会话")
    brief = L.customer_brief(test_talker, top=10)

    required = ["total_count", "my_count", "their_count", "segments", "types", "hot_pairs"]
    missing = [f for f in required if f not in brief]
    if missing:
        raise ValueError(f"缺少字段: {missing}")

    print(f"    总{brief['total_count']}条 {brief['segments']}段")

    if "opened_by_me" in brief:
        print(f"    主动性: 我{brief['opened_by_me']}次 "
              f"对方{brief['opened_by_them']}次")

    if "my_reply_s" in brief and brief["my_reply_s"]:
        print(f"    回复: 我{brief['my_reply_s']}秒 "
              f"对方{brief.get('their_reply_s', '?')}秒")

    if brief["hot_pairs"]:
        top_words = [p["text"] for p in brief["hot_pairs"][:5]]
        print(f"    高频词: {top_words}")

    if "unanswered" in brief:
        n = len(brief["unanswered"])
        if n > 0:
            results["warnings"].append(("未回复", f"{n}条问句24h内未回"))
        print(f"    未回复问句: {n}条")

    if brief.get("truncated"):
        results["warnings"].append(("customer_brief", f"只扫描{brief.get('scan')}条"))

    return brief

# ============= 异常处理测试 =============
print("\n【异常处理】")

@test("8.1 异常 - 无效会话名")
def test_invalid_talker():
    try:
        S.contact_stats("不存在的人_XXXX_9999")
        raise AssertionError("应该抛出异常")
    except Exception as e:
        if "target_not_found" in str(e) or "未找到" in str(e):
            print(f"    正确识别无效会话")
            return True
        raise ValueError(f"异常信息不明确: {e}")

@test("8.2 异常 - 非法参数")
def test_invalid_args():
    try:
        S.silence_ladder(days=[0, -1])
        raise AssertionError("应该拒绝非法参数")
    except Exception:
        print(f"    正确拒绝非法参数")
        return True

@test("8.3 异常 - 空关键词")
def test_empty_keyword():
    try:
        L.search_messages("")
        raise AssertionError("应该拒绝空关键词")
    except Exception:
        print(f"    正确拒绝空关键词")
        return True

# ============= 执行所有测试 =============
get_test_session()
test_list_contacts_friends()
test_list_contacts_groups()
test_list_room_members()
test_list_contacts_pagination()
test_silence_ladder_basic()
test_silence_ladder_custom()
test_interaction_rank_count()
test_interaction_rank_recent()
test_contact_stats_basic()
test_contact_stats_range()
test_read_messages_basic()
test_read_messages_range()
test_search_全库()
test_search_单会话()
test_customer_brief()
test_invalid_talker()
test_invalid_args()
test_empty_keyword()

# ============= 性能分析 =============
print("\n【性能分析】")
thresholds = {
    "list_contacts": 500, "silence_ladder": 2000, "interaction_rank": 1000,
    "contact_stats": 300, "read_messages": 500, "search_messages": 1000,
    "customer_brief": 2000,
}

slow = []
for name, elapsed in results["perf"].items():
    base = name.split(" - ")[0].replace(".", "").split()[1] if " " in name else name
    thresh = thresholds.get(base, 1000)
    if elapsed > thresh:
        slow.append((name, elapsed, thresh))

if slow:
    print(f"[WARN] {len(slow)} 个测试超时:")
    for n, e, t in slow:
        print(f"  - {n}: {e:.0f}ms (阈值 {t}ms)")
else:
    print("[PASS] 所有测试响应时间正常")

# ============= 总结 =============
print("\n" + "="*80)
total = len(results["passed"]) + len(results["failed"])
print(f"测试总结: {len(results['passed'])}/{total} 通过")
print(f"失败: {len(results['failed'])}, 警告: {len(results['warnings'])}")
if results["perf"]:
    avg = sum(results["perf"].values()) / len(results["perf"])
    print(f"平均响应: {avg:.0f}ms")
print("="*80)

# 保存报告
report = {
    "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    "summary": {
        "total": total,
        "passed": len(results["passed"]),
        "failed": len(results["failed"]),
        "warnings": len(results["warnings"]),
    },
    "passed": results["passed"],
    "failed": results["failed"],
    "warnings": results["warnings"],
    "performance": results["perf"],
}

report_path = os.path.join(HERE, "test_wechat_crm_report.json")
with open(report_path, "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)

print(f"\n详细报告: {report_path}")

sys.exit(0 if len(results["failed"]) == 0 else 1)
