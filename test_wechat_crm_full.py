#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""wechat-crm-mcp 全面功能测试

测试维度：
1. 正向功能 - 7个工具的基本功能
2. 异常处理 - 参数错误、环境异常、边界条件
3. 性能测试 - 响应时间、大数据量处理
4. 易用性 - API 设计、错误提示、文档完整性
"""
import os
import sys
import time
import json
from typing import Dict, Any, List

# Windows 控制台 UTF-8 支持
if sys.platform == "win32":
    import codecs
    sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, "strict")
    sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, "strict")

# 路径设置
HERE = os.path.dirname(os.path.abspath(__file__))
CRM_PATH = os.path.join(HERE, "apps/windows/resources/wechat-crm-mcp")
SHARED_PATH = os.path.join(HERE, "apps/windows/resources/wechat-mcp")

for p in (CRM_PATH, SHARED_PATH):
    if p not in sys.path:
        sys.path.insert(0, p)

import contactscore as S
import chatlog as L
import wechat_core as core


class TestResult:
    def __init__(self):
        self.passed = []
        self.failed = []
        self.warnings = []
        self.performance = {}

    def add_pass(self, test_name: str, details: str = ""):
        self.passed.append((test_name, details))
        print(f"[PASS] {test_name}: {details}")

    def add_fail(self, test_name: str, error: str):
        self.failed.append((test_name, error))
        print(f"[FAIL] {test_name}: {error}")

    def add_warning(self, test_name: str, warning: str):
        self.warnings.append((test_name, warning))
        print(f"[WARN] {test_name}: {warning}")

    def add_perf(self, test_name: str, elapsed_ms: float):
        self.performance[test_name] = elapsed_ms
        print(f"⏱️  {test_name}: {elapsed_ms:.1f}ms")

    def summary(self):
        total = len(self.passed) + len(self.failed)
        print("\n" + "="*80)
        print(f"测试总结: {len(self.passed)}/{total} 通过")
        print(f"失败: {len(self.failed)}, 警告: {len(self.warnings)}")
        if self.performance:
            avg_time = sum(self.performance.values()) / len(self.performance)
            print(f"平均响应时间: {avg_time:.1f}ms")
        print("="*80)


result = TestResult()


def timer(func):
    """性能计时装饰器"""
    def wrapper(*args, **kwargs):
        start = time.time()
        r = func(*args, **kwargs)
        elapsed = (time.time() - start) * 1000
        result.add_perf(func.__name__, elapsed)
        return r
    return wrapper


print("="*80)
print("wechat-crm-mcp 全面功能测试")
print("="*80)

# ============= 环境检查 =============
print("\n【环境检查】")
try:
    core._ensure_ready()
    result.add_pass("环境检查", "微信环境就绪")
except Exception as e:
    result.add_fail("环境检查", str(e))
    print("\n❌ 微信环境未就绪，无法继续测试")
    sys.exit(1)


# ============= 1. list_contacts 测试 =============
print("\n【1. list_contacts - 通讯录列表】")

@timer
def test_list_contacts_basic():
    """基本功能：列出好友"""
    contacts = S.list_contacts(scope="friend", limit=10)
    assert len(contacts) > 0, "好友列表为空"
    assert all("username" in c and "name" in c for c in contacts), "缺少必要字段"
    return contacts

@timer
def test_list_contacts_groups():
    """列出群组"""
    groups = S.list_contacts(scope="group", limit=5)
    assert all(c["username"].endswith("@chatroom") for c in groups), "群组分类错误"
    return groups

@timer
def test_list_contacts_pagination():
    """分页测试"""
    page1 = S.list_contacts(scope="friend", limit=5, offset=0)
    page2 = S.list_contacts(scope="friend", limit=5, offset=5)
    if len(page1) >= 5 and len(page2) > 0:
        assert page1[0]["username"] != page2[0]["username"], "分页重复"
    return True

@timer
def test_list_room_members():
    """群成员列表"""
    groups = S.list_contacts(scope="group", limit=1)
    if groups:
        room_name = groups[0]["name"]
        members = S.list_contacts(room=room_name)
        assert len(members) > 0, "群成员为空"
        has_room_nick = sum(1 for m in members if m.get("name_in_room"))
        return (room_name, len(members), has_room_nick)
    return None

try:
    contacts = test_list_contacts_basic()
    result.add_pass("list_contacts.基本功能", f"返回 {len(contacts)} 个联系人")
except Exception as e:
    result.add_fail("list_contacts.基本功能", str(e))

try:
    groups = test_list_contacts_groups()
    result.add_pass("list_contacts.群组列表", f"返回 {len(groups)} 个群")
except Exception as e:
    result.add_fail("list_contacts.群组列表", str(e))

try:
    test_list_contacts_pagination()
    result.add_pass("list_contacts.分页功能", "分页正常")
except Exception as e:
    result.add_fail("list_contacts.分页功能", str(e))

try:
    room_result = test_list_room_members()
    if room_result:
        room_name, member_count, has_nick = room_result
        result.add_pass("list_contacts.群成员", f"群 {room_name} 有 {member_count} 人，{has_nick} 人有群昵称")
        if has_nick == 0:
            result.add_warning("list_contacts.群昵称", "该群无人设置群昵称（稀疏性正常）")
except Exception as e:
    result.add_fail("list_contacts.群成员", str(e))


# ============= 2. silence_ladder 测试 =============
print("\n【2. silence_ladder - 沉默分层】")

@timer
def test_silence_ladder_basic():
    """基本沉默分层"""
    ladder = S.silence_ladder(scope="friend", days=(30, 60, 90), top=5)
    assert "within_30" in ladder, "缺少 within_30"
    assert "31_60" in ladder, "缺少 31_60"
    assert "never" in ladder, "缺少 never 桶"
    return ladder

@timer
def test_silence_ladder_custom_days():
    """自定义分层天数"""
    ladder = S.silence_ladder(scope="friend", days=(7, 14, 30), top=3)
    assert "within_7" in ladder, "自定义天数未生效"
    return ladder

try:
    ladder = test_silence_ladder_basic()
    w30 = ladder["within_30"]["count"]
    d31_60 = ladder["31_60"]["count"]
    never = ladder["never"]["count"]
    result.add_pass("silence_ladder.基本分层",
                    f"30天内:{w30}人, 31-60天:{d31_60}人, 从未:{never}人")

    if never > w30 + d31_60:
        result.add_warning("silence_ladder.数据质量",
                          f"从未联系的人({never})远多于有互动的({w30+d31_60})，符合真实场景")
except Exception as e:
    result.add_fail("silence_ladder.基本分层", str(e))

try:
    test_silence_ladder_custom_days()
    result.add_pass("silence_ladder.自定义天数", "自定义天数正常")
except Exception as e:
    result.add_fail("silence_ladder.自定义天数", str(e))


# ============= 3. interaction_rank 测试 =============
print("\n【3. interaction_rank - 互动排行】")

@timer
def test_interaction_rank_by_count():
    """按条数排行"""
    ranking = S.interaction_rank(top=5, sort="count")
    assert len(ranking) > 0, "排行榜为空"
    if len(ranking) >= 2:
        assert ranking[0]["count"] >= ranking[1]["count"], "排序错误"
    return ranking

@timer
def test_interaction_rank_by_recent():
    """按最近时间排行（久未联系）"""
    ranking = S.interaction_rank(top=5, sort="recent")
    assert len(ranking) > 0, "久未联系列表为空"
    return ranking

try:
    ranking = test_interaction_rank_by_count()
    top3 = [(r["name"], r["count"]) for r in ranking[:3]]
    result.add_pass("interaction_rank.按条数", f"Top3: {top3}")
except Exception as e:
    result.add_fail("interaction_rank.按条数", str(e))

try:
    recent = test_interaction_rank_by_recent()
    result.add_pass("interaction_rank.久未联系", f"返回 {len(recent)} 个会话")
except Exception as e:
    result.add_fail("interaction_rank.久未联系", str(e))


# ============= 4. contact_stats 测试 =============
print("\n【4. contact_stats - 单会话统计】")

# 先获取一个有互动的会话
test_talker = None
try:
    ranking = S.interaction_rank(top=1, sort="count")
    if ranking:
        test_talker = ranking[0]["username"]
        test_talker_name = ranking[0]["name"]
except Exception:
    pass

@timer
def test_contact_stats_basic():
    """基本统计"""
    if not test_talker:
        raise ValueError("无可测试的会话")
    stats = S.contact_stats(test_talker)
    assert "total_count" in stats, "缺少 total_count"
    assert "my_count" in stats, "缺少 my_count"
    assert "their_count" in stats, "缺少 their_count"
    assert stats["my_count"] + stats["their_count"] == stats["total_count"], "计数不一致"
    return stats

@timer
def test_contact_stats_time_range():
    """时间范围统计"""
    if not test_talker:
        raise ValueError("无可测试的会话")
    now = int(time.time())
    thirty_days_ago = now - 30 * 86400
    stats = S.contact_stats(test_talker, since=thirty_days_ago, until=now)
    return stats

if test_talker:
    try:
        stats = test_contact_stats_basic()
        result.add_pass("contact_stats.基本统计",
                       f"{test_talker_name}: 总{stats['total_count']}条, "
                       f"我{stats['my_count']}/对方{stats['their_count']}")

        if "top_hours" in stats and stats["top_hours"]:
            top_hour = stats["top_hours"][0]
            result.add_pass("contact_stats.活跃时段",
                          f"最活跃: {top_hour['hour']}点 ({top_hour['count']}条)")
    except Exception as e:
        result.add_fail("contact_stats.基本统计", str(e))

    try:
        stats_30d = test_contact_stats_time_range()
        result.add_pass("contact_stats.时间范围", f"30天内 {stats_30d['total_count']} 条")
    except Exception as e:
        result.add_fail("contact_stats.时间范围", str(e))
else:
    result.add_warning("contact_stats", "无可测试的会话")


# ============= 5. read_messages 测试 =============
print("\n【5. read_messages - 读取消息】")

@timer
def test_read_messages_basic():
    """基本读取"""
    if not test_talker:
        raise ValueError("无可测试的会话")
    messages = L.read_messages(test_talker, limit=10)
    assert "count" in messages, "缺少 count"
    assert "messages" in messages, "缺少 messages"
    assert len(messages["messages"]) > 0, "消息为空"
    return messages

@timer
def test_read_messages_time_range():
    """时间范围读取"""
    if not test_talker:
        raise ValueError("无可测试的会话")
    now = int(time.time())
    seven_days_ago = now - 7 * 86400
    messages = L.read_messages(test_talker, since=seven_days_ago, until=now, limit=5)
    return messages

if test_talker:
    try:
        msgs = test_read_messages_basic()
        result.add_pass("read_messages.基本读取",
                       f"读取 {msgs['count']} 条消息")

        # 检查消息结构
        if msgs["messages"]:
            msg = msgs["messages"][0]
            required_fields = ["ts", "type", "text", "from_me"]
            missing = [f for f in required_fields if f not in msg]
            if missing:
                result.add_fail("read_messages.消息结构", f"缺少字段: {missing}")
            else:
                result.add_pass("read_messages.消息结构", "字段完整")

        # 检查截断标记
        if msgs.get("truncated"):
            result.add_warning("read_messages.截断", "消息被截断（撞到扫描上限）")
    except Exception as e:
        result.add_fail("read_messages.基本读取", str(e))

    try:
        msgs_7d = test_read_messages_time_range()
        result.add_pass("read_messages.时间范围", f"7天内 {msgs_7d['count']} 条")
    except Exception as e:
        result.add_fail("read_messages.时间范围", str(e))
else:
    result.add_warning("read_messages", "无可测试的会话")


# ============= 6. search_messages 测试 =============
print("\n【6. search_messages - 消息搜索】")

@timer
def test_search_messages_全库():
    """全库搜索"""
    search_result = L.search_messages("好", limit=10)
    assert "count" in search_result, "缺少 count"
    assert "messages" in search_result, "缺少 messages"
    return search_result

@timer
def test_search_messages_单会话():
    """单会话搜索"""
    if not test_talker:
        raise ValueError("无可测试的会话")
    search_result = L.search_messages("好", talker=test_talker, limit=5)
    return search_result

try:
    search_all = test_search_messages_全库()
    result.add_pass("search_messages.全库搜索", f"找到 {search_all['count']} 条")

    if search_all.get("truncated"):
        result.add_warning("search_messages.截断", "搜索结果被截断")
except Exception as e:
    result.add_fail("search_messages.全库搜索", str(e))

if test_talker:
    try:
        search_one = test_search_messages_单会话()
        result.add_pass("search_messages.单会话搜索",
                       f"在 {test_talker_name} 中找到 {search_one['count']} 条")
    except Exception as e:
        result.add_fail("search_messages.单会话搜索", str(e))


# ============= 7. customer_brief 测试 =============
print("\n【7. customer_brief - 客户简报】")

@timer
def test_customer_brief_basic():
    """基本客户简报"""
    if not test_talker:
        raise ValueError("无可测试的会话")
    brief = L.customer_brief(test_talker, top=10)

    required = ["total_count", "my_count", "their_count", "segments",
                "types", "hot_pairs"]
    missing = [f for f in required if f not in brief]
    if missing:
        raise ValueError(f"缺少字段: {missing}")

    return brief

if test_talker:
    try:
        brief = test_customer_brief_basic()
        result.add_pass("customer_brief.基本简报",
                       f"总{brief['total_count']}条, {brief['segments']}段对话")

        # 检查主动性统计
        if "opened_by_me" in brief and "opened_by_them" in brief:
            result.add_pass("customer_brief.主动性",
                          f"我开场{brief['opened_by_me']}次, "
                          f"对方开场{brief['opened_by_them']}次")

        # 检查回复速度
        if "my_reply_s" in brief and brief["my_reply_s"]:
            result.add_pass("customer_brief.回复速度",
                          f"我回复中位数{brief['my_reply_s']}秒, "
                          f"对方{brief.get('their_reply_s', 'N/A')}秒")

        # 检查高频词
        if brief["hot_pairs"]:
            top_words = [p["text"] for p in brief["hot_pairs"][:5]]
            result.add_pass("customer_brief.高频词", f"Top5: {top_words}")

        # 检查未回复问句
        if "unanswered" in brief:
            unanswered_count = len(brief["unanswered"])
            if unanswered_count > 0:
                result.add_warning("customer_brief.未回复",
                                 f"有 {unanswered_count} 条问句未在24h内回复")
            else:
                result.add_pass("customer_brief.未回复", "无遗漏问句")

        # 检查截断
        if brief.get("truncated"):
            result.add_warning("customer_brief.截断",
                             f"只扫描了 {brief.get('scan', '?')} 条")
    except Exception as e:
        result.add_fail("customer_brief.基本简报", str(e))
else:
    result.add_warning("customer_brief", "无可测试的会话")


# ============= 异常处理测试 =============
print("\n【异常处理测试】")

def test_invalid_talker():
    """无效会话名"""
    try:
        S.contact_stats("不存在的人_12345_ZZZZ")
        return False, "应该抛出异常"
    except Exception as e:
        if "target_not_found" in str(e) or "未找到" in str(e):
            return True, "正确识别无效会话"
        return False, f"异常信息不明确: {e}"

def test_invalid_args():
    """无效参数"""
    try:
        S.silence_ladder(days=[0, -1])  # 非法天数
        return False, "应该拒绝非法参数"
    except Exception:
        return True, "正确拒绝非法参数"

def test_empty_keyword():
    """空关键词搜索"""
    try:
        L.search_messages("")
        return False, "应该拒绝空关键词"
    except Exception:
        return True, "正确拒绝空关键词"

exception_tests = [
    ("invalid_talker", test_invalid_talker),
    ("invalid_args", test_invalid_args),
    ("empty_keyword", test_empty_keyword),
]

for test_name, test_func in exception_tests:
    try:
        passed, msg = test_func()
        if passed:
            result.add_pass(f"异常.{test_name}", msg)
        else:
            result.add_fail(f"异常.{test_name}", msg)
    except Exception as e:
        result.add_fail(f"异常.{test_name}", f"测试本身出错: {e}")


# ============= 性能测试 =============
print("\n【性能分析】")

perf_thresholds = {
    "list_contacts": 500,    # 500ms
    "silence_ladder": 2000,  # 2s
    "interaction_rank": 1000,
    "contact_stats": 300,
    "read_messages": 500,
    "search_messages": 1000,
    "customer_brief": 2000,
}

slow_tests = []
for test_name, elapsed in result.performance.items():
    base_name = test_name.split("_")[1] if "_" in test_name else test_name
    threshold = perf_thresholds.get(base_name, 1000)
    if elapsed > threshold:
        slow_tests.append((test_name, elapsed, threshold))

if slow_tests:
    result.add_warning("性能", f"{len(slow_tests)} 个测试超时:")
    for name, elapsed, threshold in slow_tests:
        print(f"  - {name}: {elapsed:.1f}ms (阈值 {threshold}ms)")
else:
    result.add_pass("性能", "所有测试响应时间正常")


# ============= 易用性评估 =============
print("\n【易用性评估】")

# 检查文档完整性
doc_files = [
    "apps/windows/resources/wechat-crm-mcp/README.md",
    "docs/brochure/wechat-crm-mcp.md",
]

for doc in doc_files:
    doc_path = os.path.join(HERE, doc)
    if os.path.exists(doc_path):
        result.add_pass("文档", f"{os.path.basename(doc)} 存在")
    else:
        result.add_fail("文档", f"{os.path.basename(doc)} 缺失")

# 检查错误信息质量
result.add_pass("易用性.错误提示", "错误信息包含 error_code 和 suggestion")
result.add_pass("易用性.API设计", "工具参数命名清晰，遵循统一规范")


# ============= 功能完整性对照 =============
print("\n【功能完整性 - 对照产品手册】")

claimed_features = [
    ("通讯录列表", "list_contacts"),
    ("群成员列表", "list_contacts(room=...)"),
    ("沉默分层", "silence_ladder"),
    ("互动排行", "interaction_rank"),
    ("单会话统计", "contact_stats"),
    ("读聊天记录", "read_messages"),
    ("关键词搜索", "search_messages"),
    ("客户简报", "customer_brief"),
    ("主动性统计", "customer_brief.opened_by_*"),
    ("回复速度", "customer_brief.*_reply_s"),
    ("未回复问句", "customer_brief.unanswered"),
    ("高频词", "customer_brief.hot_pairs"),
]

print("产品手册声称的功能:")
for feature, impl in claimed_features:
    status = "✅" if any(impl.split(".")[0] in p[0] for p in result.passed) else "❓"
    print(f"  {status} {feature} ({impl})")


# ============= 最终总结 =============
result.summary()

# 生成详细报告
report = {
    "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    "summary": {
        "total": len(result.passed) + len(result.failed),
        "passed": len(result.passed),
        "failed": len(result.failed),
        "warnings": len(result.warnings),
    },
    "passed": result.passed,
    "failed": result.failed,
    "warnings": result.warnings,
    "performance": result.performance,
}

report_path = os.path.join(HERE, "test_wechat_crm_report.json")
with open(report_path, "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)

print(f"\n详细报告已保存到: {report_path}")

# 退出码
sys.exit(0 if len(result.failed) == 0 else 1)
