"""
小红书定时发布时段推荐。

根据内容类型、工作日/周末，推荐最佳发布时间点。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass

if sys.platform == "win32":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
from datetime import datetime, timedelta
from typing import Any


# 内容类型定义（与 SKILL.md 中「内容目标」对应）
CONTENT_TYPE_LABELS: dict[str, str] = {
    "knowledge": "干货类",
    "food": "美食/探店类",
    "beauty": "美妆/穿搭类",
    "lifestyle": "情感/生活类",
    "general": "通用",
}

# 中文别名 → 标准类型键
CONTENT_TYPE_ALIASES: dict[str, str] = {
    "干货": "knowledge",
    "教程": "knowledge",
    "职场": "knowledge",
    "学习": "knowledge",
    "知识": "knowledge",
    "技术": "knowledge",
    "美食": "food",
    "探店": "food",
    "餐厅": "food",
    "外卖": "food",
    "测评": "food",
    "美妆": "beauty",
    "穿搭": "beauty",
    "种草": "beauty",
    "护肤": "beauty",
    "时尚": "beauty",
    "情感": "lifestyle",
    "生活": "lifestyle",
    "vlog": "lifestyle",
    "治愈": "lifestyle",
    "故事": "lifestyle",
    "通用": "general",
    "娱乐": "general",
    "搞笑": "general",
    "活动": "general",
    "招聘": "general",
}

# 通用黄金时段（小时:分钟）
GOLDEN_SLOTS: list[tuple[int, int, str]] = [
    (7, 30, "早高峰通勤，适合干货与轻量图文"),
    (8, 30, "上班路上，职场/学习方法曝光佳"),
    (12, 30, "午休放松，美食/娱乐内容受欢迎"),
    (13, 0, "午休尾声，轻松内容仍有效"),
    (19, 30, "下班后黄金流量开启"),
    (20, 30, "晚间活跃高峰，深度内容曝光高"),
    (21, 30, "睡前刷机时段，情感/教程均适用"),
]

WEEKDAY = 0
WEEKEND = 1
FRIDAY_EVENING = 2


@dataclass
class SlotRule:
    """单条时段推荐规则。"""

    hour: int
    minute: int
    day_kind: int  # WEEKDAY | WEEKEND | FRIDAY_EVENING
    reason: str
    priority: int = 5


def normalize_content_type(raw: str) -> str:
    """将用户输入或别名规范为标准内容类型键。"""
    key = raw.strip().lower()
    if key in CONTENT_TYPE_LABELS:
        return key
    for alias, ctype in CONTENT_TYPE_ALIASES.items():
        if alias in raw or raw in alias:
            return ctype
    return "general"


def _rules_for_type(content_type: str) -> list[SlotRule]:
    """按内容类型返回时段规则列表。"""
    if content_type == "knowledge":
        return [
            SlotRule(8, 0, WEEKDAY, "工作日早高峰，上班路上充电阅读", 10),
            SlotRule(20, 0, WEEKDAY, "工作日晚间，睡前学习时间", 9),
            SlotRule(21, 0, WEEKDAY, "工作日深夜学习党活跃", 8),
            SlotRule(22, 0, WEEKDAY, "晚自习后推送学习方法", 7),
            SlotRule(15, 0, WEEKEND, "周末下午，整块时间读长文", 10),
            SlotRule(16, 0, WEEKEND, "周末午后，深度干货收藏率高", 9),
            SlotRule(17, 0, WEEKEND, "周末傍晚，自律/计划类内容佳", 8),
        ]
    if content_type == "food":
        return [
            SlotRule(12, 0, WEEKDAY, "工作日午休，干饭人必刷", 10),
            SlotRule(18, 0, WEEKDAY, "下班纠结吃什么，勾起食欲", 9),
            SlotRule(20, 0, FRIDAY_EVENING, "周五晚发周末周边美食攻略", 10),
            SlotRule(10, 0, WEEKEND, "周末上午 brunch 推荐", 9),
            SlotRule(11, 30, WEEKEND, "周末早午餐探店", 8),
        ]
    if content_type == "beauty":
        return [
            SlotRule(19, 0, WEEKDAY, "晚间休闲，日常妆容/通勤穿搭", 9),
            SlotRule(20, 0, WEEKDAY, "下班后颜值内容吸引力强", 10),
            SlotRule(21, 0, WEEKDAY, "晚间放松，美妆种草黄金档", 10),
            SlotRule(19, 0, WEEKEND, "周末晚间，妆容教程曝光高", 9),
            SlotRule(20, 0, WEEKEND, "周末休闲刷颜值内容", 9),
        ]
    if content_type == "lifestyle":
        return [
            SlotRule(22, 0, WEEKDAY, "深夜情感故事，易引发共鸣", 10),
            SlotRule(23, 0, WEEKDAY, "深夜树洞时段", 9),
            SlotRule(0, 30, WEEKDAY, "凌晨情感/成长感悟", 7),
            SlotRule(14, 0, WEEKEND, "周末午后生活碎片", 10),
            SlotRule(15, 0, WEEKEND, "悠闲午后治愈系 Vlog", 9),
            SlotRule(16, 0, WEEKEND, "周末下午茶时光", 8),
        ]
    # general：叠加黄金时段
    rules: list[SlotRule] = []
    for h, m, reason in GOLDEN_SLOTS:
        rules.append(SlotRule(h, m, WEEKDAY, reason, 6))
        rules.append(SlotRule(h, m, WEEKEND, reason, 6))
    return rules


def _day_kind(dt: datetime) -> int:
    """判断日期属于工作日、周末还是周五晚间场景。"""
    if dt.weekday() >= 5:
        return WEEKEND
    if dt.weekday() == 4:
        return FRIDAY_EVENING
    return WEEKDAY


def _rule_matches(rule: SlotRule, dt: datetime) -> bool:
    """判断规则是否适用于给定日期。"""
    kind = _day_kind(dt)
    if rule.day_kind == FRIDAY_EVENING:
        return kind == FRIDAY_EVENING
    if rule.day_kind == WEEKEND:
        return dt.weekday() >= 5
    if rule.day_kind == WEEKDAY:
        return dt.weekday() < 5
    return True


def _format_schedule(dt: datetime) -> str:
    """格式化为 CDP/CLI 使用的定时字符串。"""
    return dt.strftime("%Y-%m-%d %H:%M")


def recommend_schedule_times(
    content_type: str = "general",
    from_time: datetime | None = None,
    count: int = 5,
    min_hours_ahead: int = 1,
) -> list[dict[str, Any]]:
    """
    推荐接下来若干天的最佳定时发布时间。

    Args:
        content_type: 内容类型键或中文别名
        from_time: 基准时间，默认当前
        count: 返回推荐条数
        min_hours_ahead: 最早可定时的小时数（小红书通常要求未来一段时间）

    Returns:
        [{schedule, datetime, weekday, content_type, reason, priority}, ...]
    """
    ctype = normalize_content_type(content_type)
    now = from_time or datetime.now()
    earliest = now + timedelta(hours=min_hours_ahead)
    rules = _rules_for_type(ctype)
    candidates: list[tuple[int, datetime, str]] = []

    for day_offset in range(14):
        base = (now + timedelta(days=day_offset)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        for rule in rules:
            if not _rule_matches(rule, base):
                continue
            slot_dt = base.replace(hour=rule.hour, minute=rule.minute)
            if slot_dt < earliest:
                continue
            candidates.append((rule.priority, slot_dt, rule.reason))

    # 按优先级降序、时间升序去重
    candidates.sort(key=lambda x: (-x[0], x[1]))
    seen: set[str] = set()
    results: list[dict[str, Any]] = []
    weekday_names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

    for priority, slot_dt, reason in candidates:
        key = _format_schedule(slot_dt)
        if key in seen:
            continue
        seen.add(key)
        results.append(
            {
                "schedule": key,
                "datetime": slot_dt.isoformat(timespec="minutes"),
                "weekday": weekday_names[slot_dt.weekday()],
                "content_type": ctype,
                "content_type_label": CONTENT_TYPE_LABELS.get(ctype, ctype),
                "reason": reason,
                "priority": priority,
            }
        )
        if len(results) >= count:
            break

    return results


def get_golden_hours_summary() -> dict[str, Any]:
    """返回通用黄金时段说明（供 SKILL 展示）。"""
    return {
        "morning": {"range": "07:00-09:00", "tip": "通勤刷机，干货/轻量图文"},
        "noon": {"range": "12:00-14:00", "tip": "午休放松，美食/娱乐/搞笑"},
        "evening": {"range": "19:00-23:00", "tip": "黄金流量巅峰，深度干货/视频/情感"},
        "by_type": {
            "knowledge": "工作日 8:00、20-22:00；周末 15-17:00",
            "food": "工作日 12:00、18:00；周末周五晚/周六 10:00",
            "beauty": "每日 19-21:00；节日/季节内容提前 1-2 周",
            "lifestyle": "工作日 22:00-01:00；周末 14-16:00",
        },
    }


def seasonal_beauty_note(keywords: str = "") -> str | None:
    """美妆/季节限定内容的提前布局提示。"""
    seasonal = {
        "圣诞": "建议 12 月初发布",
        "新年": "建议 12 月中下旬发布",
        "春节": "建议节前 2-3 周发布",
        "情人节": "建议 2 月初发布",
        "夏季": "建议 5 月开始预热防晒",
        "防晒": "建议 5 月开始预热",
        "秋冬": "建议 9-10 月发布",
    }
    for kw, note in seasonal.items():
        if kw in keywords:
            return note
    return None


def main() -> None:
    """CLI：输出推荐时段 JSON 或人类可读列表。"""
    parser = argparse.ArgumentParser(description="小红书定时发布时段推荐")
    parser.add_argument(
        "--type",
        "-t",
        default="general",
        help="内容类型：knowledge/food/beauty/lifestyle/general 或中文别名（干货/美食/种草等）",
    )
    parser.add_argument("--count", "-n", type=int, default=5, help="推荐条数")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    parser.add_argument("--summary", action="store_true", help="输出黄金时段摘要")
    parser.add_argument("--keywords", default="", help="标题/正文关键词（季节美妆提示）")
    args = parser.parse_args()

    if args.summary:
        print(json.dumps(get_golden_hours_summary(), ensure_ascii=False, indent=2))
        return

    ctype = normalize_content_type(args.type)
    recs = recommend_schedule_times(content_type=ctype, count=args.count)
    note = seasonal_beauty_note(args.keywords) if ctype == "beauty" else None

    if args.json:
        out: dict[str, Any] = {
            "content_type": ctype,
            "content_type_label": CONTENT_TYPE_LABELS.get(ctype, ctype),
            "recommendations": recs,
        }
        if note:
            out["seasonal_note"] = note
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return

    label = CONTENT_TYPE_LABELS.get(ctype, ctype)
    print(f"【{label}】推荐定时发布时间（接下来 {args.count} 个时段）：\n")
    for i, r in enumerate(recs, 1):
        print(f"{i}. {r['schedule']}（{r['weekday']}）— {r['reason']}")
    if note:
        print(f"\n📌 季节/节日提示：{note}")
    print("\n使用方式：将选定时间写入 publish-options.json 的 schedule 字段，"
          "或传 --schedule \"YYYY-MM-DD HH:MM\" 给发布脚本。")


if __name__ == "__main__":
    main()
