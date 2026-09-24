#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""实验 B：人设 A/B 测试模板（纯标准库）。

对同一批题目，用三种系统提示词（无 persona / 专家 persona / 超长 persona）
分别跑一遍，输出准确率对比表。目的不是复现论文，而是把"人设实验该怎么设计"
跑通一遍：同题目、同温度、同模型、逐题判分、报告与基线的差值。

两种模式:
    stub  —— 默认。不调任何 API，用写死的确定性函数模拟三种人设的答题结果，
             用于先看懂实验设计与报表形态。**桩里的数字是模拟的，别当结论。**
    api   —— 真实调用 OpenAI 兼容接口（/chat/completions），由环境变量配置:
             OPENAI_API_BASE   默认 https://api.openai.com/v1
             OPENAI_API_KEY    必填
             OPENAI_MODEL      默认 gpt-4o-mini

用法:
    python persona_ab.py                 # 桩模式
    python persona_ab.py --mode api      # 真实调用
    python persona_ab.py --out persona_ab_results.md
"""

import argparse
import json
import os
import re
import sys
import urllib.request

# ---------------------------------------------------------------------------
# 题库：12 道单选题（自建题目，避开版权；均为可机械判分的客观题）
# 真实实验里，把这里换成你的业务评测集，并保证"机械可判定"。
# ---------------------------------------------------------------------------
QUESTIONS = [
    {"id": 1,  "q": "光在真空中的速度约为每秒多少公里？", "opts": ["30万", "3万", "300万", "3000"], "gold": "A"},
    {"id": 2,  "q": "一个三角形三个内角之和（平面几何）为？", "opts": ["90度", "180度", "270度", "360度"], "gold": "B"},
    {"id": 3,  "q": "水的化学式是？", "opts": ["CO2", "O2", "H2O", "NaCl"], "gold": "C"},
    {"id": 4,  "q": "1 到 100 所有整数之和为？", "opts": ["5000", "5050", "5100", "4950"], "gold": "B"},
    {"id": 5,  "q": "地球上面积最大的大洋是？", "opts": ["大西洋", "印度洋", "北冰洋", "太平洋"], "gold": "D"},
    {"id": 6,  "q": "ASCII 码用几个比特表示一个字符（经典版）？", "opts": ["7", "8", "16", "32"], "gold": "A"},
    {"id": 7,  "q": "'所有的猫都是哺乳动物，汤姆是猫' 能推出？", "opts": ["汤姆会游泳", "汤姆是哺乳动物", "汤姆怕狗", "无法确定"], "gold": "B"},
    {"id": 8,  "q": "二进制 1011 对应十进制？", "opts": ["9", "11", "13", "15"], "gold": "B"},
    {"id": 9,  "q": "人体最大的器官是？", "opts": ["肝脏", "大脑", "皮肤", "肺"], "gold": "C"},
    {"id": 10, "q": "《蒙娜丽莎》的作者是？", "opts": ["梵高", "达·芬奇", "毕加索", "莫奈"], "gold": "B"},
    {"id": 11, "q": "标准大气压下水的沸点是？", "opts": ["90°C", "95°C", "100°C", "110°C"], "gold": "C"},
    {"id": 12, "q": "HTTP 状态码 404 表示？", "opts": ["服务器内部错误", "未授权", "重定向", "资源未找到"], "gold": "D"},
]

# ---------------------------------------------------------------------------
# 三种系统提示词。注意长度差异本身就是实验变量之一
# （PRISM arXiv:2603.18507 把 persona 长度作为独立变量研究）。
# ---------------------------------------------------------------------------
VARIANTS = [
    ("baseline", "你是一个严谨的答题助手。只输出选项字母（A/B/C/D），不要解释。"),
    ("expert",
     "你是一位横跨物理学、数学、化学、生物、地理、艺术史与计算机科学的资深专家，"
     "拥有二十年研究与教学经验，以精确和严谨著称。请输出选项字母（A/B/C/D），不要解释。"),
    ("expert_long",
     "你是业界公认的顶尖通才学者。你自幼展现出超凡的记忆力与逻辑推理能力，少年时期即在全国学科竞赛中"
     "屡获金牌，随后在世界一流学府完成本硕博连读，博士研究方向为认知科学与复杂系统。postdoc 期间你参与"
     "了多个跨学科重大科研项目，并在顶级期刊发表了百余篇论文。你曾受邀为多国科学院提供政策咨询，也长期"
     "担任国际学科奥林匹克竞赛的命题组成员，深谙出题人的思维陷阱与常见误导项设计。你的同事们评价你'从不"
     "在事实性问题上犯错'，你的学生们则说你讲解时最讨厌含糊其辞的答案。你信奉'科学的尊严在于精确'这一信条，"
     "任何回答在你这里都会经过三重审查：定义审查、量纲审查与反例审查。现在，请你以这位资深专家的身份作答，"
     "输出选项字母（A/B/C/D），不要解释。"),
]

# ---------------------------------------------------------------------------
# 桩模型：确定性模拟。数字全部是编造的，仅用于演示"人设可能带来负增益"
# 这类实验长什么样（方向取自 Zheng et al. 与 PRISM 的公开结论）。
# ---------------------------------------------------------------------------
STUB_WRONG = {
    "baseline": set(),
    "expert": {7},           # 专家人设错 1 题
    "expert_long": {7, 8, 11},  # 超长人设错更多题（模拟"越长越伤"方向）
}


def ask_api(system_prompt, question):
    """调用 OpenAI 兼容接口，返回 (字母答案 或 None, 原始文本)。"""
    base = os.environ.get("OPENAI_API_BASE", "https://api.openai.com/v1").rstrip("/")
    key = os.environ.get("OPENAI_API_KEY")
    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    if not key:
        raise RuntimeError("缺少 OPENAI_API_KEY 环境变量（桩模式无需该变量）")
    user = question["q"] + "\n" + "\n".join(
        f"{chr(65 + i)}. {opt}" for i, opt in enumerate(question["opts"]))
    body = json.dumps({
        "model": model, "temperature": 0, "max_tokens": 8,
        "messages": [{"role": "system", "content": system_prompt},
                     {"role": "user", "content": user}],
    }).encode("utf-8")
    req = urllib.request.Request(
        base + "/chat/completions", data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    text = payload["choices"][0]["message"]["content"].strip()
    m = re.search(r"[ABCD]", text)
    return (m.group(0) if m else None), text


def ask_stub(variant, question):
    """桩模式：按 STUB_WRONG 表给出对/错答案，输出仍保持确定性。"""
    if question["id"] in STUB_WRONG.get(variant, set()):
        wrong_idx = (ord(question["gold"]) - 65 + 1) % 4
        return chr(65 + wrong_idx), "(stub)"
    return question["gold"], "(stub)"


def run(variant_name, system_prompt, mode):
    rows = []
    for q in QUESTIONS:
        if mode == "api":
            ans, raw = ask_api(system_prompt, q)
        else:
            ans, raw = ask_stub(variant_name, q)
        rows.append({"id": q["id"], "gold": q["gold"], "ans": ans, "ok": ans == q["gold"], "raw": raw})
    return rows


def main():
    ap = argparse.ArgumentParser(description="人设 A/B 测试模板")
    ap.add_argument("--mode", choices=["stub", "api"], default="stub")
    ap.add_argument("--out", default="persona_ab_results.md")
    args = ap.parse_args()

    if args.mode == "stub":
        print("!!! 桩模式：结果由确定性函数模拟，数字是编造的，"
              "只用于演示实验设计与报表形态。 !!!\n")

    print("系统提示词长度（字符）: " +
          " | ".join(f"{name}={len(sp)}" for name, sp in VARIANTS))
    print(f"题目数: {len(QUESTIONS)}（真实实验建议 >=100 条，并报告差值的抽样波动）\n")

    results, lines = {}, []
    lines.append("# 人设 A/B 测试结果\n")
    if args.mode == "stub":
        lines.append("> **桩模式**：下表数字为模拟，仅演示形态。\n")
    lines.append(f"- 模式: {args.mode} | 题目数: {len(QUESTIONS)} | 温度: 0\n")
    lines.append("| 变体 | 正确数 | 准确率 | 相对 baseline |")
    lines.append("|---|---|---|---|")

    for name, sp in VARIANTS:
        rows = run(name, sp, args.mode)
        results[name] = rows
        correct = sum(1 for r in rows if r["ok"])
        results.setdefault("_acc", {})[name] = correct / len(rows)

    base_acc = results["_acc"]["baseline"]
    for name, sp in VARIANTS:
        rows = results[name]
        correct = sum(1 for r in rows if r["ok"])
        acc = correct / len(rows)
        delta = "" if name == "baseline" else f"{(acc - base_acc) * 100:+.1f}pp"
        print(f"{name:<14} {correct:>2}/{len(rows)}  acc={acc:.1%}  {delta}")
        lines.append(f"| {name} | {correct}/{len(rows)} | {acc:.1%} | {delta or '—'} |")

    # 逐题明细：重点看"基线对而人设错"的题——人设伤害就藏在这些题里
    lines.append("\n## 逐题明细（✓ 对 / ✗ 错）\n")
    lines.append("| 题号 | 正确答案 | baseline | expert | expert_long |")
    lines.append("|---|---|---|---|---|")
    for i, q in enumerate(QUESTIONS):
        cells = []
        for name, _ in VARIANTS:
            r = results[name][i]
            cells.append("✓" if r["ok"] else f"✗({r['ans']})")
        lines.append(f"| {q['id']} | {q['gold']} | {cells[0]} | {cells[1]} | {cells[2]} |")

    hurt = [q["id"] for i, q in enumerate(QUESTIONS)
            if results["baseline"][i]["ok"] and not results["expert_long"][i]["ok"]]
    lines.append(f"\n基线答对但超长人设答错的题: {hurt or '无'}。"
                 f"这就是 Zheng et al.（arXiv:2311.10054）与 PRISM（arXiv:2603.18507）"
                 f"反复观察到的现象：人设不带来能力，只改变行为分布——有时改坏。\n")

    with open(args.out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"\n报告已写出: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
