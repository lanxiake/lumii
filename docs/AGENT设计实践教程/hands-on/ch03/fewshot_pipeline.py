#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""实验 A：失败案例驱动的 few-shot 流水线（纯标准库，完全离线）。

对应第 3 章「便宜的替代路径」：失败案例 -> 错误分类学 -> 针对 top 错误类的
few-shot 纠正卡。方法学参照 ETGPO (arXiv:2602.00997)：先聚类全局失败模式，
再为最高频的少数几类生成"错误例 + 正例 + 一句话规则"，而不是逐条修补。

用法:
    python fewshot_pipeline.py runlog_sample.json [--top 3] [--outdir .]

输入: 运行日志 JSON（records 数组，含 id/input/output/expected/pass/error）
输出:
    控制台          —— 错误分类学统计表
    error_taxonomy.json —— 分类学机器可读结果
    fewshot_cards.md    —— top-N 错误类的 few-shot 纠正卡 + 可粘贴提示块
"""

import argparse
import json
import sys
from collections import Counter, OrderedDict
from pathlib import Path

# ---------------------------------------------------------------------------
# 1. 错误特征规则（错误分类学的"骨架"）
#    按顺序匹配 error 文本，命中即归类。真实项目里这一步可以换成 LLM 打标，
#    但规则版的好处是确定、可审计——先用规则跑通，再考虑升级。
#    rule 字段就是最终写进 few-shot 卡的"一句话规则"。
# ---------------------------------------------------------------------------
RULES = [
    {
        "label": "format_invalid_json",
        "name": "输出不是合法 JSON",
        "keywords": ["不是合法 json", "unterminated", "trailing comma",
                      "extra data", "single quotes", "无法解析"],
        "rule": "只输出一个严格合法的 JSON：双引号、无注释、无尾逗号，JSON 前后不附加任何文字。",
    },
    {
        "label": "date_format",
        "name": "日期格式/时区口径错误",
        "keywords": ["date 不符", "date mismatch"],
        "rule": "date 字段一律输出 YYYY-MM-DD 纯日期（北京时间口径），不带时间、时区、秒，也不用其他语言或分隔符写法。",
    },
    {
        "label": "amount_format",
        "name": "金额单位/精度错误",
        "keywords": ["amount 不符", "amount mismatch"],
        "rule": "amount 字段按原文照抄为两位小数的数字字符串：不换算成分/整数，不带货币符号和单位文字。",
    },
    {
        "label": "missing_field",
        "name": "字段遗漏或置空",
        "keywords": ["缺少字段", "missing field"],
        "rule": "input 中出现的信息必须逐字摘录到对应字段，禁止输出 null 或省略字段；只有原文确实没提供时才输出 null。",
    },
    {
        "label": "hallucination",
        "name": "抽取了原文没有的内容（幻觉）",
        "keywords": ["原文没有", "幻觉", "编造", "hallucinat"],
        "rule": "只做逐字摘录：原文没有的信息一律输出 null，不得填入默认值、客服电话等看似合理的内容。",
    },
    {
        "label": "refusal",
        "name": "不该拒绝时拒绝",
        "keywords": ["拒绝", "refus", "无法处理", "未输出 json"],
        "rule": "本任务是授权范围内的字段抽取：个人信息按字段要求原样摘录即可，这不是隐私违规，不要拒绝或解释，直接输出 JSON。",
    },
]

FALLBACK = {"label": "other", "name": "未归类", "rule": "人工复核该类样本，补充规则。"}


def classify(record):
    """按 error 文本给失败记录归类。"""
    text = (record.get("error") or "").lower()
    for r in RULES + [FALLBACK]:
        if any(k.lower() in text for k in r.get("keywords", [])):
            return r["label"]
    return FALLBACK["label"]


def pretty(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2)


def main():
    ap = argparse.ArgumentParser(description="失败案例 -> 错误分类学 -> few-shot 纠正卡")
    ap.add_argument("logfile", help="运行日志 JSON 路径")
    ap.add_argument("--top", type=int, default=3, help="为 top-N 错误类生成纠正卡（默认 3）")
    ap.add_argument("--outdir", default=".", help="输出目录（默认当前目录）")
    args = ap.parse_args()

    data = json.loads(Path(args.logfile).read_text(encoding="utf-8"))
    records = data["records"] if isinstance(data, dict) else data

    passed = [r for r in records if r.get("pass")]
    failed = [r for r in records if not r.get("pass")]
    if not failed:
        print("日志中没有失败案例，无需生成分类学。")
        return 0

    # --- 2. 失败聚类 -------------------------------------------------------
    buckets = OrderedDict((r["label"], []) for r in RULES)
    buckets[FALLBACK["label"]] = []
    for r in failed:
        buckets[classify(r)].append(r)
    buckets = OrderedDict((k, v) for k, v in buckets.items() if v)
    ordered = sorted(buckets.items(), key=lambda kv: (-len(kv[1]), list(buckets).index(kv[0])))

    meta_name = {r["label"]: r["name"] for r in RULES}
    meta_name[FALLBACK["label"]] = FALLBACK["name"]
    rule_of = {r["label"]: r["rule"] for r in RULES}
    rule_of[FALLBACK["label"]] = FALLBACK["rule"]

    # --- 3. 分类学统计输出 -------------------------------------------------
    print(f"总样本 {len(records)} | 通过 {len(passed)} | 失败 {len(failed)}"
          f"（失败率 {len(failed)/len(records):.0%}）\n")
    print("错误分类学（按失败占比排序）")
    print("-" * 64)
    print(f"{'错误类':<28}{'条数':>4}{'占失败':>8}   样本ID")
    taxonomy = []
    for label, items in ordered:
        share = len(items) / len(failed)
        ids = ", ".join(x["id"] for x in items[:6]) + (" …" if len(items) > 6 else "")
        print(f"{meta_name[label]:<26}{len(items):>4}{share:>8.0%}   {ids}")
        taxonomy.append({
            "label": label, "name": meta_name[label], "count": len(items),
            "share_of_failures": round(share, 3), "record_ids": [x["id"] for x in items],
            "rule": rule_of[label],
        })
    top3_share = sum(len(v) for _, v in ordered[:3]) / len(failed)
    print("-" * 64)
    print(f"提示：top-3 错误类覆盖了 {top3_share:.0%} 的失败样本——few-shot 卡只需先解决它们。\n")

    # --- 4. 为 top-N 错误类生成 few-shot 纠正卡 ----------------------------
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    cards_md = ["# few-shot 纠正卡（自动生成）\n",
                f"> 来源日志：`{args.logfile}`；失败 {len(failed)} 条，"
                f"聚类为 {len(buckets)} 类；以下为 top-{args.top} 错误类的纠正卡。\n",
                "> 结构参照 ETGPO（arXiv:2602.00997）：错误描述 + 错误例 + 正例 + 一句话规则。\n"]
    paste_block = []
    for rank, (label, items) in enumerate(ordered[:args.top], 1):
        bad = items[0]  # 取该类第一条失败记录做错误例
        good = json.loads(bad["expected"])
        card = [
            f"## 卡 {rank}：{meta_name[label]}（{len(items)} 条 / {len(items)/len(failed):.0%} 失败样本）\n",
            f"**规则（一句话）**：{rule_of[label]}\n",
            f"**错误例** `{bad['id']}`",
            "```json",
            bad["output"],
            "```",
            f"> 校验器反馈：{bad['error']}\n",
            "**正例**（同一输入的正确输出）",
            "```json",
            pretty(good),
            "```\n",
        ]
        cards_md += card
        paste_block.append(
            f"【{meta_name[label]}】\n输入：{bad['input']}\n"
            f"错误输出：{bad['output']}\n正确输出：{bad['expected']}\n"
            f"规则：{rule_of[label]}"
        )
        cards_md.append(
            f"### 粘贴用片段 {rank}（直接贴进系统提示词的\"常见错误对照\"一节）\n"
            "```\n" + paste_block[-1] + "\n```\n")

    (outdir / "fewshot_cards.md").write_text("\n".join(cards_md), encoding="utf-8")
    (outdir / "error_taxonomy.json").write_text(pretty({
        "log_file": args.logfile,
        "total": len(records), "passed": len(passed), "failed": len(failed),
        "taxonomy": taxonomy,
    }), encoding="utf-8")

    print(f"已写出: {outdir/'error_taxonomy.json'}  {outdir/'fewshot_cards.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
