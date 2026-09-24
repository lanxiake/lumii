#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""single_vs_multi.py —— 第 5 章实践：单 Agent 基线 vs orchestrator + 2 worker

任务：对 corpus/ 下 10 篇虚构报道做"三家来源口径差异"汇总，同一任务分别用两种架构跑：

  A. 单 Agent 基线      ：一个循环干到底。每轮把「新资料 + 累计笔记」一起发给模型，
                          笔记有容量上限（模拟上下文预算），旧笔记会被挤出上下文。
  B. orchestrator+worker：orchestrator 只做两件事——派发任务（orchestrator 永远读不到
                          语料全文）、合并 worker 结论；2 个 worker 只读、只回结构化
                          要点，不回全文。

两种架构都统计：LLM 步数、token 估算（拆成 指令开销/语料读取/状态与交接/模型输出）、
以及对照内置 rubric 的要点覆盖数。

运行：
  python single_vs_multi.py            # 无 OPENAI_API_KEY 时自动进入桩模式
  python single_vs_multi.py --stub     # 强制桩模式（启发式抽取，不调 API）
  python single_vs_multi.py --verbose  # 打印每轮明细

真实模式环境变量（OpenAI 兼容接口）：
  OPENAI_API_KEY   必填
  OPENAI_BASE_URL  默认 https://api.openai.com/v1
  AGENT_MODEL      默认 gpt-4o-mini

桩模式说明见 README.md：它是"控制流与信息流"的教学模拟器，不是模型能力对比。
"""

import argparse
import json
import math
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS_DIR = os.path.join(HERE, "corpus")

# ---------------------------------------------------------------- 任务与评分标准

TASK = (
    "任务：汇总三家来源（官方 / 媒体 / 社区与学术）对『青云地铁 12 号线开通首月客流争议』的口径差异。"
    "以条目形式输出结论，每条不超过 40 字，必须覆盖："
    "各方给出的关键数字及其统计口径、数字对不上的原因（口径/预测基准/归因分歧）、"
    "以及第三方独立数据。不要复述原文长句。"
)

RUBRIC = [
    {"id": "R1", "desc": "官方口径：首月日均客运量 51.2 万人次（含换乘）", "kw": ["51.2"]},
    {"id": "R2", "desc": "媒体口径：日均进站量 38.4 万，不含换乘", "kw": ["38.4", "进站量"]},
    {"id": "R3", "desc": "预测基准之争：65 万是高峰日目标还是日均预测", "kw": ["65 万", "高峰日"]},
    {"id": "R4", "desc": "爬坡期论证：与 2 号线同期对比", "kw": ["2 号线", "爬坡"]},
    {"id": "R5", "desc": "归因分歧之一：接驳不畅 / 公交调整慢", "kw": ["接驳", "公交"]},
    {"id": "R6", "desc": "行业第三方：同类城市首月达成率与第 6 月 85% 规律", "kw": ["85%", "同类", "中位"]},
    {"id": "R7", "desc": "经营账本：投资/利息/补贴/运营亏损", "kw": ["189 亿", "利息保障", "2.6 亿", "2413 万", "运营亏损"]},
    {"id": "R8", "desc": "社区情绪：票价与行车间隔不满", "kw": ["间隔", "票价"]},
    {"id": "R9", "desc": "统计局独立数据：分担率 9.2%（抽样口径）", "kw": ["9.2", "分担率"]},
    {"id": "R10", "desc": "学术解释：四阶段法数据过时、岗位西移 17%", "kw": ["四阶段", "西移", "岗位", "17%"]},
]

# 桩模式打分用的“任务相关词”（启发式，见 README 局限一节）
TOPIC_TERMS = [
    "客流", "预测", "口径", "进站量", "分担率", "换乘", "爬坡", "间隔", "票价",
    "接驳", "公交", "利息", "补贴", "投资", "亏损", "人口", "岗位", "达成率",
    "高峰日", "日均", "通报", "数据", "缺口", "分歧", "审计", "中位", "同类",
]

# ---------------------------------------------------------------- 基础设施

def est_tokens(text):
    """粗估 token：1 个 CJK 字符≈1 token，1 个英文/数字词≈1.3 token。两侧同规则，相对比较有效。"""
    cjk = len(re.findall(r"[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]", text))
    ascii_words = len(re.findall(r"[A-Za-z0-9]+", text))
    return cjk + int(ascii_words * 1.3) + 1


def load_corpus():
    docs = []
    for fn in sorted(os.listdir(CORPUS_DIR)):
        if not fn.endswith(".txt"):
            continue
        with open(os.path.join(CORPUS_DIR, fn), encoding="utf-8") as f:
            raw = f.read()
        source = title = ""
        body_lines = []
        for line in raw.splitlines():
            if line.startswith("# source:"):
                source = line.split(":", 1)[1].strip()
            elif line.startswith("# title:"):
                title = line.split(":", 1)[1].strip()
            else:
                body_lines.append(line)
        docs.append({"name": fn, "source": source, "title": title,
                     "text": "\n".join(body_lines).strip()})
    return docs


DOCS_CACHE = None


def corpus():
    global DOCS_CACHE
    if DOCS_CACHE is None:
        DOCS_CACHE = load_corpus()
    return DOCS_CACHE


def split_sentences(text):
    parts = re.split(r"(?<=[。！？；\n])", text)
    return [p.strip() for p in parts if len(p.strip()) >= 8]


def norm_sent(s):
    return re.sub(r"[\s，。、；：！？“”\"'（）()【】\-—…]+", "", s)


def sentence_score(sent):
    """桩模式打分：任务词命中 + rubric 关键词重权 + 长句轻微惩罚。"""
    score = 0.0
    for t in TOPIC_TERMS:
        score += sent.count(t)
    for r in RUBRIC:
        for kw in r["kw"]:
            if kw in sent:
                score += 6.0
                break
    score -= max(0, (len(sent) - 80)) * 0.01
    return score


class Metrics:
    def __init__(self):
        self.steps = 0
        self.instr = 0      # 系统提示 + 任务描述 + 输出格式要求（结构性开销）
        self.corpus = 0     # 语料正文进入 prompt 的 token（含重复载入）
        self.state = 0      # 状态与交接：单 agent 重发笔记 / worker 结论回传合并
        self.completion = 0
        self.corpus_docs_seen = set()

    def record(self, instr_t, corpus_t, state_t, completion_t, doc_names=None):
        self.steps += 1
        self.instr += instr_t
        self.corpus += corpus_t
        self.state += state_t
        self.completion += completion_t
        for n in doc_names or []:
            self.corpus_docs_seen.add(n)

    @property
    def total(self):
        return self.instr + self.corpus + self.state + self.completion

    @property
    def coordination(self):
        """协调开销 = 指令/格式重发 + 状态与交接（干活 = 读语料 + 产出结论）。"""
        return self.instr + self.state

    @property
    def coord_ratio(self):
        return self.coordination / self.total if self.total else 0.0


def parse_findings(text, cap=None):
    """把模型输出解析成要点列表（容忍 JSON 数组、'- '、'1. '、裸行）。"""
    text = text.strip()
    try:
        m = re.search(r"\[.*\]", text, re.S)
        if m:
            arr = json.loads(m.group(0))
            items = [str(x).strip() for x in arr if str(x).strip()]
            return items[:cap] if cap else items
    except Exception:
        pass
    items = []
    for line in text.splitlines():
        line = re.sub(r"^[\-\*•①-⑩\d\.\)、\s]+", "", line).strip()
        if line:
            items.append(line)
    return items[:cap] if cap else items


def rubric_coverage(answer_text):
    hits = [r["id"] for r in RUBRIC if any(kw in answer_text for kw in r["kw"])]
    misses = [r["id"] for r in RUBRIC if r["id"] not in hits]
    return hits, misses


# ---------------------------------------------------------------- LLM 抽象

class LLM:
    """real：OpenAI 兼容 /chat/completions（urllib）；stub：本地启发式抽取。"""

    def __init__(self, mode):
        self.api_key = os.environ.get("OPENAI_API_KEY", "").strip()
        self.base = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        self.model = os.environ.get("AGENT_MODEL", "gpt-4o-mini")
        if mode == "real" and not self.api_key:
            sys.exit("需要 OPENAI_API_KEY 才能使用 --real；或去掉 --real 用桩模式。")
        self.stub = (mode == "stub") or (mode == "auto" and not self.api_key)

    def complete(self, system, user):
        """返回 (文本, prompt_tokens, completion_tokens)；桩模式由调用方自行生成。"""
        payload = json.dumps({
            "model": self.model,
            "temperature": 0,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
        }).encode("utf-8")
        req = urllib.request.Request(
            self.base + "/chat/completions", data=payload,
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + self.api_key})
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        text = data["choices"][0]["message"]["content"]
        usage = data.get("usage", {})
        return text, usage.get("prompt_tokens") or 0, usage.get("completion_tokens") or 0

    def record_real(self, m, instr, corpus_all, state_block, out_text, doc_names, pt, ct):
        """真实模式：API 给的是总 usage，按各部分估算比例拆桶，总量与 usage 对齐。"""
        ie, ce, se = est_tokens(instr), est_tokens(corpus_all), est_tokens(state_block)
        pe = max(1, ie + ce + se)
        scale = (pt or pe) / pe
        m.record(int(ie * scale), int(ce * scale), int(se * scale),
                 ct or est_tokens(out_text), doc_names)


# ---------------------------------------------------------------- 架构 A：单 Agent

SYSTEM_SINGLE = (
    "你是研究助理。分批阅读资料，把影响『口径差异』判断的关键事实压缩成不超过 40 字的笔记要点，"
    "优先保留数字、统计口径、归因与分歧，不要复述原文。"
)

SINGLE_BATCH = 4          # 每轮喂 4 篇
SINGLE_KEEP_PER_CALL = 3  # 每轮产出 3 条新笔记
SINGLE_NOTES_CAP = 7      # 笔记容量上限：模拟上下文预算，旧的会被挤出


def run_single(llm, docs, verbose=False):
    m = Metrics()
    notes = []
    batches = [docs[i:i + SINGLE_BATCH] for i in range(0, len(docs), SINGLE_BATCH)]
    for bi, batch in enumerate(batches, 1):
        task_block = TASK
        state_block = ("已有笔记：\n" + "\n".join("- " + n for n in notes)) if notes else ""
        corpus_texts = ["【%s｜%s】%s" % (d["title"], d["source"], d["text"]) for d in batch]
        user = "\n\n".join(x for x in [
            task_block, state_block,
            "本轮新资料：\n" + "\n\n".join(corpus_texts),
            "请输出本轮新增笔记要点（JSON 字符串数组，最多 %d 条）。" % SINGLE_KEEP_PER_CALL] if x)
        if llm.stub:
            pool = []
            seen = {norm_sent(n) for n in notes}
            for d in batch:
                for s in split_sentences(d["text"]):
                    if norm_sent(s) not in seen:
                        pool.append((sentence_score(s), "【%s】%s" % (d["name"][:2], s)))
            pool.sort(key=lambda x: -x[0])
            resp_lines = [p for _, p in pool[:SINGLE_KEEP_PER_CALL]]
            out_text = json.dumps(resp_lines, ensure_ascii=False)
            m.record(est_tokens(SYSTEM_SINGLE + task_block) + 30,
                     est_tokens("\n".join(corpus_texts)),
                     est_tokens(state_block),
                     est_tokens(out_text),
                     [d["name"] for d in batch])
        else:
            sysmsg = SYSTEM_SINGLE + "\n每轮输出 JSON 字符串数组，最多 %d 条。" % SINGLE_KEEP_PER_CALL
            out_text, pt, ct = llm.complete(sysmsg, user)
            resp_lines = parse_findings(out_text, cap=SINGLE_KEEP_PER_CALL)
            llm.record_real(m, sysmsg + task_block, "\n".join(corpus_texts),
                            state_block, out_text,
                            [d["name"] for d in batch], pt, ct)
        existing = {norm_sent(n) for n in notes}
        for line in resp_lines:
            if norm_sent(line) not in existing:
                notes.append(line)
                existing.add(norm_sent(line))
        notes = notes[-SINGLE_NOTES_CAP:]  # 上下文预算：挤出最旧的笔记
        if verbose:
            print("  [单agent 第%d轮] 本轮语料=%d篇 笔记=%d条 累计token=%d"
                  % (bi, len(batch), len(notes), m.total))
    return "\n".join("- " + n for n in notes), notes, m


# ---------------------------------------------------------------- 架构 B：orchestrator + 2 worker

SYSTEM_PLAN = (
    "你是多 agent 研究系统的 orchestrator。只做任务拆分：把资料分配给 2 个只读研究员，"
    "输出 JSON：{\"workers\":[{\"name\":\"...\",\"doc_ids\":[...],\"quota\":N,\"brief\":\"...\"}]}。"
    "分配原则：按上下文边界（来源阵营）拆，worker 之间无需共享信息；要点额度按语料篇数分配。"
)

SYSTEM_WORKER = (
    "你是只读研究员。只读资料、只输出结构化结论：JSON 字符串数组，每条≤40字，"
    "给出数字必须带口径，不回传原文段落，不做跨来源汇总（那是 orchestrator 的工作）。"
)

SYSTEM_MERGE = (
    "你是 orchestrator。合并各研究员的结论为最终答复：去重、对齐数字与口径，"
    "输出 JSON 字符串数组（最终要点），确保覆盖三方口径与分歧原因。"
)

OFFICIAL_PREFIX = {"01", "02", "03"}  # 桩模式拆分边界：官方阵营 vs 媒体/社区/学术


def _title(d):
    return d["title"] or d["name"]


def default_plan(docs):
    a_ids = [d["name"] for d in docs if d["name"][:2] in OFFICIAL_PREFIX]
    b_ids = [d["name"] for d in docs if d["name"][:2] not in OFFICIAL_PREFIX]
    return [{"name": "官方口径研究员", "doc_ids": a_ids, "quota": 5, "brief": "官方通报/发布会/统计口径"},
            {"name": "媒体与社区研究员", "doc_ids": b_ids, "quota": 7, "brief": "媒体/行业/社区/学术视角"}]


def stub_worker_findings(subset, quota):
    per_doc = max(1, math.ceil(quota / max(1, len(subset))))
    picked, seen = [], set()
    for d in subset:
        cands = sorted(split_sentences(d["text"]), key=sentence_score, reverse=True)[:per_doc]
        for s in cands:
            if norm_sent(s) in seen:
                continue
            seen.add(norm_sent(s))
            picked.append((sentence_score(s), "%s【%s】：%s" % (d["name"][:2], d["source"], s)))
    picked.sort(key=lambda x: -x[0])
    return [p for _, p in picked[:quota]]


def run_multi(llm, docs, verbose=False):
    m = Metrics()
    # 第 1 步：orchestrator 规划——prompt 里只有语料索引，没有正文
    index_text = "\n".join("- %s｜%s｜%s" % (d["name"], d["source"], _title(d)) for d in docs)
    plan_user = TASK + "\n\n可用语料索引：\n" + index_text
    if llm.stub:
        plan = default_plan(docs)
        plan_text = json.dumps(plan, ensure_ascii=False)
        m.record(est_tokens(SYSTEM_PLAN + TASK) + 60, 0,
                 est_tokens(index_text), est_tokens(plan_text))
    else:
        plan_text, pt, ct = llm.complete(SYSTEM_PLAN, plan_user)
        plan = None
        try:
            plan = json.loads(re.search(r"\{.*\}", plan_text, re.S).group(0))["workers"]
        except Exception:
            print("  [warn] orchestrator 规划解析失败，退回默认拆分")
        if not plan:
            plan = default_plan(docs)
        llm.record_real(m, SYSTEM_PLAN + TASK, "", index_text, plan_text, None, pt, ct)

    # 第 2 步：workers 只读检索并回结论（演示中串行发起，真实系统应并发）
    worker_reports = []
    for w in plan:
        subset = [d for d in docs if d["name"] in w["doc_ids"]]
        quota = int(w.get("quota", 5))
        brief = w.get("brief", "提炼口径相关事实")
        task_block = TASK
        format_block = SYSTEM_WORKER + "\n本次分工：%s 输出最多 %d 条。" % (brief, quota)
        corpus_texts = ["【%s｜%s】%s" % (_title(d), d["source"], d["text"]) for d in subset]
        if llm.stub:
            findings = stub_worker_findings(subset, quota)
            out_text = json.dumps(findings, ensure_ascii=False)
            m.record(est_tokens(task_block + format_block),
                     est_tokens("\n".join(corpus_texts)),
                     0, est_tokens(out_text), [d["name"] for d in subset])
        else:
            out_text, pt, ct = llm.complete(
                SYSTEM_WORKER + "\n分工：" + brief,
                task_block + "\n\n语料：\n\n" + "\n\n".join(corpus_texts))
            findings = parse_findings(out_text, cap=quota)
            llm.record_real(m, task_block + format_block, "\n".join(corpus_texts),
                            "", "\n".join(findings), [d["name"] for d in subset], pt, ct)
        worker_reports.append((w["name"], findings))
        if verbose:
            print("  [multi worker:%s] 语料%d篇 结论%d条 累计token=%d"
                  % (w["name"], len(subset), len(findings), m.total))

    # 第 3 步：orchestrator 合并——只读 worker 结论，仍然不读语料全文
    state_block = "\n\n".join("【%s 的结论】\n%s" % (nm, "\n".join(f))
                              for nm, f in worker_reports)
    if llm.stub:
        merged, seen = [], set()
        for _, fs in worker_reports:
            for f in fs:
                key = norm_sent(f)
                if key not in seen:
                    seen.add(key)
                    merged.append(f)
        final_lines = merged[:14]
        m.record(est_tokens(SYSTEM_MERGE + TASK) + 30, 0,
                 est_tokens(state_block),
                 est_tokens(json.dumps(final_lines, ensure_ascii=False)))
    else:
        out_text, pt, ct = llm.complete(SYSTEM_MERGE, TASK + "\n\n" + state_block)
        final_lines = parse_findings(out_text, cap=14)
        llm.record_real(m, SYSTEM_MERGE + TASK, "", state_block,
                        "\n".join(final_lines), None, pt, ct)
    if verbose:
        print("  [multi 合并] 最终要点%d条 累计token=%d" % (len(final_lines), m.total))
    return "\n".join("- " + l for l in final_lines), final_lines, m


# ---------------------------------------------------------------- 报告

def print_report(mode_name, res_single, res_multi, verbose):
    (ans_a, notes_a, m_a), (ans_b, notes_b, m_b) = res_single, res_multi
    hits_a, miss_a = rubric_coverage(ans_a)
    hits_b, miss_b = rubric_coverage(ans_b)
    n_docs = len(corpus())

    rows = [
        ("LLM 调用步数", m_a.steps, m_b.steps),
        ("总 token（估算）", m_a.total, m_b.total),
        ("  其中：指令/格式重发", m_a.instr, m_b.instr),
        ("  其中：语料读取", m_a.corpus, m_b.corpus),
        ("  其中：状态与交接(笔记重发/结论合并)", m_a.state, m_b.state),
        ("  其中：模型输出", m_a.completion, m_b.completion),
        ("协调开销占比(指令+状态)/总量", "%.1f%%" % (m_a.coord_ratio * 100),
         "%.1f%%" % (m_b.coord_ratio * 100)),
        ("语料实际读取覆盖率", "%d/%d 篇" % (len(m_a.corpus_docs_seen), n_docs),
         "%d/%d 篇" % (len(m_b.corpus_docs_seen), n_docs)),
        ("rubric 要点覆盖", "%d/%d" % (len(hits_a), len(RUBRIC)),
         "%d/%d" % (len(hits_b), len(RUBRIC))),
        ("未覆盖要点", ",".join(miss_a) or "无", ",".join(miss_b) or "无"),
    ]
    print("\n== 对比报告（模式：%s）==" % mode_name)
    print("%-40s | %-18s | %s" % ("指标", "单 Agent 基线", "orchestrator+worker"))
    print("-" * 86)
    for name, a, b in rows:
        print("%-40s | %-18s | %s" % (name, a, b))

    print("\n-- 单 Agent 最终答复（%d 条）--" % len(notes_a))
    for l in (notes_a if verbose else notes_a[:8]):
        print("  • " + l)
    print("\n-- orchestrator+worker 最终答复（%d 条）--" % len(notes_b))
    for l in (notes_b if verbose else notes_b[:8]):
        print("  • " + l)

    print("\n-- rubric 明细（✓=该架构最终答复覆盖）--")
    for r in RUBRIC:
        print("  %s 单%s 多%s  %s  [关键词: %s]" % (
            r["id"],
            "✓" if r["id"] in hits_a else "✗",
            "✓" if r["id"] in hits_b else "✗",
            r["desc"], "/".join(r["kw"])))


def main():
    ap = argparse.ArgumentParser(description="单 Agent vs orchestrator-worker 对照实验")
    ap.add_argument("--stub", action="store_true", help="强制桩模式（不调 API）")
    ap.add_argument("--real", action="store_true", help="强制真实 API（需 OPENAI_API_KEY）")
    ap.add_argument("--verbose", action="store_true", help="打印每轮明细与完整答复")
    args = ap.parse_args()

    mode = "stub" if args.stub else ("real" if args.real else "auto")
    llm = LLM(mode)
    docs = corpus()
    corpus_tok = sum(est_tokens(d["text"]) for d in docs)
    print("语料：%d 篇，正文约 %d token（估算）。模式：%s" % (
        len(docs), corpus_tok, "桩（启发式抽取）" if llm.stub else "真实 API: " + llm.model))

    res_single = run_single(llm, docs, args.verbose)
    res_multi = run_multi(llm, docs, args.verbose)
    print_report("桩模式，重点看控制流与信息流" if llm.stub else llm.model,
                 res_single, res_multi, args.verbose)


if __name__ == "__main__":
    main()
