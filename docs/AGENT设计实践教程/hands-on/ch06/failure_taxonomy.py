#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
失败分类学流水线（第 6 章 · 实验 A）
====================================
输入：runs_sample.json（60 条 agent 运行记录 + 记忆库）
输出：
  [1] 错误分类学统计     —— 类目由人/代码定义（TAXONOMY），不由模型自由发挥
  [2] RRR 风格指标排名   —— 每条被引用记忆的「被倚重次数 × 关联失败率」，揪出毒记忆
  [3] Top-3 错误类目的纠正卡（错误例 / 正例 / 规则 各一），写入 correction_cards.md

设计原则（对应正文）：
  - 类目与规则模板是工程师写死的 → §三「工程版路径」：错误分类学由人定义
  - 置信度 = 计数出来的民主，不是模型的自信 → §三 ExpeL 的 UPVOTE/DOWNVOTE 思想
  - 纠正卡只是候选，入库前必须过回归测试 → §六 设计守则（脚本会提示，不代做）
纯标准库、完全离线、结果确定可复现。
"""
import json
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNS_FILE = HERE / "runs_sample.json"
CARDS_FILE = HERE / "correction_cards.md"

# ---- 人工定义的错误分类学：类目 key -> (中文名, 一句话定义, 修正规则) ----
# 这是整条流水线的地基：先有人划的类目，才谈得上统计和纠正。
TAXONOMY = {
    "silent_empty_result": (
        "空结果被静默接受",
        "接口返回空列表时未做核对就当作『没有数据』上报。",
        "空结果必须三重核对：窗口是否覆盖数据源更新时间 / total 字段是否>0 / 换页重试一次。三关全过才允许报『无数据』。",
    ),
    "pagination_truncated": (
        "分页截断",
        "只处理了第一页就当作全量。",
        "列表类接口必须循环翻页直到 has_more=false；拉取条数必须与响应 total 字段核对，不一致即报错终止。",
    ),
    "time_window_misread": (
        "时间窗误读",
        "时区、边界或源更新时间理解错误导致窗口偏移。",
        "取数前必须先输出三要素：数据源更新时间、请求窗起点、请求窗终点（显式标注时区），再执行查询。",
    ),
    "schema_mismatch": (
        "结构不匹配",
        "字段命名/结构与接口文档或实际响应不一致。",
        "全量任务前先拉 1 条样本核对字段；解析结果为 None 的字段超过阈值即报警。",
    ),
    "hallucinated_tool": (
        "臆造工具",
        "调用了不存在或已下线的工具。",
        "工具清单以运行时注入列表为准；调用失败为 unknown tool 时禁止臆造重试，改为向用户报告能力缺口。",
    ),
    "duplicate_side_effect": (
        "重复副作用",
        "失败重试没有幂等键导致重复推送/重复写入。",
        "任何有副作用的调用必须携带幂等键；重跑前先查询当日是否已有成功记录。",
    ),
}

# 毒记忆判定阈值（RRR 风格指标的工程化参数，可调）
MIN_REFS = 4        # 至少被倚重这么多次才参与判定
MIN_FAIL_RATE = 0.6  # 关联失败率下限
FLAG_SCORE = 4.0     # 综合分下限：score = refs × fail_rate


def load():
    data = json.loads(RUNS_FILE.read_text(encoding="utf-8"))
    return data["memories"], data["runs"]


def taxonomy_report(runs):
    failures = [r for r in runs if not r["success"]]
    print("=" * 62)
    print("[1] 错误分类学统计（类目由 TAXONOMY 常量定义，共 %d 类）" % len(TAXONOMY))
    print("=" * 62)
    print(f"总运行 {len(runs)} 条 | 失败 {len(failures)} 条 | 失败率 {len(failures)/len(runs):.0%}\n")
    by_cat = defaultdict(list)
    unknown = []
    for r in failures:
        if r["error_type"] in TAXONOMY:
            by_cat[r["error_type"]].append(r)
        else:
            unknown.append(r)
    rows = sorted(by_cat.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    for cat, items in rows:
        name, definition, _ = TAXONOMY[cat]
        refs = [r["referenced_memory_id"] for r in items if r["referenced_memory_id"]]
        top_ref = defaultdict(int)
        for m in refs:
            top_ref[m] += 1
        top_s = "、".join(f"{m}×{c}" for m, c in sorted(top_ref.items(), key=lambda kv: -kv[1])[:3]) or "—"
        print(f"  {name}（{cat}）: {len(items)} 次，占失败 {len(items)/len(failures):.0%}")
        print(f"    定义：{definition}")
        print(f"    关联记忆：{top_s}")
    if unknown:
        print(f"  ⚠ 未分类 {len(unknown)} 条 → 分类学需要人工扩充类目（这是人的工作，不是模型的）")
    return rows


def rrr_report(memories, runs):
    print()
    print("=" * 62)
    print("[2] RRR 风格指标：被倚重次数 × 关联失败率")
    print("=" * 62)
    stats = defaultdict(lambda: {"refs": 0, "fail": 0})
    for r in runs:
        m = r["referenced_memory_id"]
        if not m:
            continue
        stats[m]["refs"] += 1
        if not r["success"]:
            stats[m]["fail"] += 1
    rows = []
    mem_text = {m["memory_id"]: m for m in memories}
    for mid, s in stats.items():
        rate = s["fail"] / s["refs"] if s["refs"] else 0.0
        score = s["refs"] * rate
        poisoned = s["refs"] >= MIN_REFS and rate >= MIN_FAIL_RATE and score >= FLAG_SCORE
        rows.append((mid, s["refs"], s["fail"], rate, score, poisoned))
    rows.sort(key=lambda x: (-x[4], x[0]))
    print(f"判定阈值：refs≥{MIN_REFS} 且 失败率≥{MIN_FAIL_RATE:.0%} 且 综合分≥{FLAG_SCORE}\n")
    print(f"  {'记忆':10}{'引用':>5}{'失败':>5}{'失败率':>8}{'综合分':>8}  判定")
    for mid, refs, fail, rate, score, poisoned in rows:
        tag = "☠ 毒记忆（建议下线，走人工复核）" if poisoned else "正常"
        print(f"  {mid:10}{refs:>5}{fail:>5}{rate:>8.0%}{score:>8.1f}  {tag}")
    for mid, refs, fail, rate, score, poisoned in rows:
        if poisoned:
            m = mem_text.get(mid, {})
            print(f"\n  ☠ {mid} 内容：「{m.get('text','?')}」")
            print(f"     来源：{m.get('source','?')}（create_from: {m.get('created_from_run','-')}）"
                  f" —— 一次失败换来的『解释』，此后每次都赢。")
    return rows


def correction_cards(rows, runs):
    print()
    print("=" * 62)
    print("[3] Top-3 错误类目 → few-shot 纠正卡（候选，待回归验证）")
    print("=" * 62)
    cards = []
    by_family = defaultdict(list)
    for r in runs:
        by_family[r["task_family"]].append(r)
    for cat, items in rows[:3]:
        name, definition, rule = TAXONOMY[cat]
        bad = items[0]
        good = next((r for r in by_family[bad["task_family"]] if r["success"]), None)
        card = {
            "category": f"{name}（{cat}）",
            "bad": bad,
            "good": good,
            "rule": rule,
        }
        cards.append(card)
        print(f"\n◆ 卡片：{card['category']}")
        print(f"  [错误例 {bad['run_id']}] {bad['trace_snippet']}")
        if good:
            print(f"  [正例 {good['run_id']}] {good['trace_snippet']}")
        print(f"  [规则] {rule}")
    lines = ["# 纠正卡（自动生成候选 · 未验证）", "",
             "> 由 failure_taxonomy.py 生成。每张卡 = 1 错误例 + 1 正例 + 1 条人工规则。",
             "> 入库前置条件（第 6 章守则）：① 规则经人工确认；② 用本数据集回归重跑，",
             "> 确认目标类目失败下降且无新类目上升；③ 卡片带证据指针（run_id）。", ""]
    for c in cards:
        lines.append(f"## {c['category']}")
        lines.append(f"- 错误例 `{c['bad']['run_id']}`：{c['bad']['trace_snippet']}")
        if c["good"]:
            lines.append(f"- 正例 `{c['good']['run_id']}`：{c['good']['trace_snippet']}")
        lines.append(f"- 规则：{c['rule']}")
        lines.append("")
    CARDS_FILE.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n纠正卡已写入：{CARDS_FILE.name}")
    print("下一步（人工）：确认规则 → 把卡片注入提示词 → 用同一批任务回归重跑 → 通过才入库。")


def main():
    memories, runs = load()
    rows = taxonomy_report(runs)
    rrr_report(memories, runs)
    correction_cards(rows, runs)


if __name__ == "__main__":
    main()
