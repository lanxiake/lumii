#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
实验 A：工具选择混淆离线实验（纯标准库，Python 3.8+）
====================================================
对比两种工具面配置的 top-1 选择准确率与工具块 token 估算：
  full       —— 40 个工具全量暴露（含多组语义近似对）
  converged  —— 按语义聚类收敛到 18 个工具（带 action 参数的合并）

两种"选择器"：
  heuristic  —— TF-IDF 词面重叠（离线，默认）。这是对 LLM 行为的粗糙模拟，
                用于观察"语义干扰"现象，不用于精确复现任何论文数字。
  llm        —— 若设置了 LLM_API_KEY（或 OPENAI_API_KEY），走 OpenAI 兼容
                /chat/completions 真实调用模型选工具。

用法：
  python tool_confusion_experiment.py            # 启发式模式，打印报告
  python tool_confusion_experiment.py --mode llm # 强制 LLM 模式（无 key 则报错）
  python tool_confusion_experiment.py --json out.json
"""
import json
import math
import os
import re
import sys
import urllib.request
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
DATASET = os.path.join(HERE, "tools_dataset.json")


# ---------------------------------------------------------------- 基础工具
def tokenize(text):
    """英文按单词（拆 snake_case），中文按单字+相邻二元组。粗糙但对词面干扰足够。"""
    text = text.lower()
    toks = []
    for m in re.finditer(r"[a-z][a-z0-9_]*", text):
        toks.extend([t for t in m.group(0).split("_") if len(t) > 1])
    cjk_runs = re.findall(r"[\u4e00-\u9fff]+", text)
    for run in cjk_runs:
        toks.extend(list(run))
        toks.extend(run[i : i + 2] for i in range(len(run) - 1))
    return [t for t in toks if len(t) > 1 or "一" <= t <= "鿿"]


def est_tokens(text):
    """粗估 token：中文每字≈1 token，英文词≈1.3 token。只用于两配置间的相对比较。"""
    cjk = len(re.findall(r"[\u4e00-\u9fff]", text))
    ascii_words = len(re.findall(r"[A-Za-z0-9_.:%/-]{2,}", text))
    return int(round(cjk + ascii_words * 1.3))


def tool_text(t):
    """把工具定义渲染成选择器实际会读到的文本。"""
    params = "; ".join(f"{k}:{v}" for k, v in t.get("params", {}).items())
    return f"{t['name']} {t.get('desc','')} {params}"


def render_tool_block(tools):
    """模拟进入 system prompt 的工具 JSON 块（用于 token 估算）。"""
    out = []
    for t in tools:
        out.append(json.dumps({"name": t["name"], "description": t.get("desc", ""), "parameters": t.get("params", {})}, ensure_ascii=False))
    return "\n".join(out)


# ---------------------------------------------------------------- TF-IDF 启发式选择器
class HeuristicSelector:
    def __init__(self, tools):
        self.tools = tools
        self.docs = [Counter(tokenize(tool_text(t))) for t in tools]
        n = len(self.docs)
        df = Counter()
        for d in self.docs:
            df.update(d.keys())
        self.idf = {w: math.log((n + 1) / (c + 1)) + 1 for w, c in df.items()}
        self.vecs = [self._vec(d) for d in self.docs]

    def _vec(self, counter):
        v = {w: c * self.idf.get(w, math.log(len(self.docs) + 1) + 1) for w, c in counter.items()}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        return {w: x / norm for w, x in v.items()}

    def rank(self, query, k=3):
        q = self._vec(Counter(tokenize(query)))
        scores = []
        for i, v in enumerate(self.vecs):
            s = sum(wt * v[w] for w, wt in q.items() if w in v)
            scores.append((s, i))
        scores.sort(reverse=True)
        return [(self.tools[i]["name"], s) for s, i in scores[:k]]


# ---------------------------------------------------------------- LLM 选择器（可选）
class LLMSelector:
    """OpenAI 兼容接口。环境变量：LLM_API_KEY / OPENAI_API_KEY，LLM_BASE_URL，LLM_MODEL。"""

    def __init__(self, tools):
        self.tools = tools
        self.key = os.environ.get("LLM_API_KEY") or os.environ.get("OPENAI_API_KEY")
        self.base = (os.environ.get("LLM_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
        self.model = os.environ.get("LLM_MODEL", "gpt-4o-mini")
        if not self.key:
            raise RuntimeError("未设置 LLM_API_KEY / OPENAI_API_KEY，无法使用 llm 模式")

    def rank(self, query, k=3):
        catalog = "\n".join(f"- {t['name']}: {t.get('desc','')}" for t in self.tools)
        sysmsg = (
            "你是工具路由器。只从给定工具中选一个最合适的，输出严格 JSON："
            '{"tool": "<工具名>", "args": {...}}。不要输出其他文字。'
        )
        user = f"可用工具：\n{catalog}\n\n用户请求：{query}"
        body = json.dumps({
            "model": self.model,
            "temperature": 0,
            "messages": [{"role": "system", "content": sysmsg}, {"role": "user", "content": user}],
        }).encode("utf-8")
        req = urllib.request.Request(
            self.base + "/chat/completions", data=body,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.key}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read().decode("utf-8"))
            content = data["choices"][0]["message"]["content"]
            m = re.search(r"\{[\s\S]*\}", content)
            pick = json.loads(m.group(0))["tool"] if m else content.strip()
            valid = {t["name"] for t in self.tools}
            if pick in valid:
                return [(pick, 1.0)] + [(t["name"], 0.0) for t in self.tools if t["name"] != pick][: k - 1]
        except Exception as e:  # noqa: BLE001 - 演示脚本，失败记为该题错误
            print(f"  [llm 调用失败，记为错误] {e}", file=sys.stderr)
        return [("__error__", 0.0)] * k


# ---------------------------------------------------------------- 收敛配置
def _short_desc(d, lim=44):
    """收敛后的真实做法：成员描述压缩去重，但必须保留每个 action 的关键词——
    压得太狠会让选择器（或模型）连『该走哪个工具族』都判不准。lim 可调，试 24 复现『收敛有代价』。"""
    head = d
    return head[:lim]


def build_converged(dataset):
    tools = {t["name"]: t for t in dataset["tools"]}
    converged = []
    for grp in dataset["converged"]:
        members = [tools[m] for m in grp["members"]]
        actions = [m.split("_", 1)[-1] if m.startswith(grp["name"] + "_") else m for m in grp["members"]]
        # action 名取成员名的短语义尾巴，读起来更接近真实设计
        desc = grp["note"] + " 按 action 路由：" + "；".join(
            f"action={a}：{_short_desc(m['desc'])}" for a, m in zip(actions, members))
        merged_params = {"action": "enum：" + "|".join(actions)}
        for m in members:  # 同名参数去重（path/content 这类公共参数只出现一次）
            for k, v in m.get("params", {}).items():
                merged_params.setdefault(k, v)
        freqs = {m.get("freq", "low") for m in members}
        converged.append({
            "name": grp["name"], "desc": desc, "params": merged_params,
            "cluster": grp["name"], "freq": "high" if "high" in freqs else ("mid" if "mid" in freqs else "low"),
            "_members": set(grp["members"]),
        })
    for name in dataset["kept_solo"]:
        t = dict(tools[name])
        t["_members"] = {name}
        converged.append(t)
    return converged


# ---------------------------------------------------------------- 评测
def evaluate(selector, dataset, config_tools, name_of=None):
    """top1 / top3 准确率 + 簇内混淆统计。config_tools: 实际暴露的工具列表。"""
    gold_tool = {t["name"]: t for t in dataset["tools"]}
    members = {}
    for t in config_tools:
        for m in t.get("_members", [t["name"]]):
            members[m] = t["name"]
    top1 = top3 = 0
    intra, extra = [], []
    for req in dataset["requests"]:
        gold = req["gold"]
        gold_in_cfg = members.get(gold, gold)
        ranked = selector.rank(req["query"], k=3)
        names = [n for n, _ in ranked]
        ok1 = names and names[0] == gold_in_cfg
        ok3 = gold_in_cfg in names
        top1 += ok1
        top3 += ok3
        if not ok1:
            pred = names[0] if names else "?"
            pred_gold = members.get(gold_tool.get(pred, {}).get("name", ""), pred) if pred in gold_tool else pred
            same_cluster = (gold_tool.get(pred, {}) or {}).get("cluster") and \
                gold_tool.get(pred, {}).get("cluster") == (gold_tool.get(gold, {}) or {}).get("cluster")
            rec = {"id": req["id"], "query": req["query"], "gold": gold_in_cfg, "pred": pred}
            (intra if same_cluster else extra).append(rec)
    return {"config": name_of or "tools", "n_tools": len(config_tools),
            "block_tokens": est_tokens(render_tool_block(config_tools)),
            "top1": top1, "top3": top3, "n": len(dataset["requests"]),
            "intra": intra, "extra": extra}


def evaluate_lazy(selector, dataset, full_tools, resident_n=None, top_k=6):
    """配置三：渐进披露（Tool Search 式）。常驻高频工具 + 每题检索 top-k 候选注入。
    若 gold 没被检索进候选，模型永远看不到它——这就是 ToolRet 警告的『检索层失误』。"""
    tools = {t["name"]: dict(t, _members={t["name"]}) for t in full_tools}
    resident = [t for t in full_tools if t.get("freq") == "high"]
    top1 = top3 = 0
    intra, extra = [], []
    tok_sum = 0
    for req in dataset["requests"]:
        ranked_all = selector.rank(req["query"], k=len(full_tools))
        subset = {t["name"] for t in resident}
        subset |= {n for n, _ in ranked_all[:top_k]}
        tok_sum += est_tokens(render_tool_block([tools[n] for n in subset]))
        gold = req["gold"]
        names = [n for n, _ in ranked_all if n in subset]  # 模型只能从注入的子集里选
        ok1 = names and names[0] == gold
        top1 += ok1
        top3 += gold in names[:3]
        if not ok1 and names:
            pred = names[0]
            same_cluster = tools.get(pred, {}).get("cluster") == tools.get(gold, {}).get("cluster") and tools.get(pred, {}).get("cluster")
            rec = {"id": req["id"], "query": req["query"], "gold": gold, "pred": pred + ("(未被检索到)" if gold not in subset else "")}
            (intra if same_cluster else extra).append(rec)
    n = len(dataset["requests"])
    return {"config": "lazy(渐进披露)", "n_tools": len(full_tools),
            "block_tokens": int(tok_sum / n),  # 平均每题实际注入的工具块
            "top1": top1, "top3": top3, "n": n, "intra": intra, "extra": extra}


def main():
    mode = "heuristic"
    if "--mode" in sys.argv:
        mode = sys.argv[sys.argv.index("--mode") + 1]
    dataset = json.load(open(DATASET, encoding="utf-8"))
    full = [dict(t, _members={t["name"]}) for t in dataset["tools"]]
    conv = build_converged(dataset)

    print("=" * 72)
    print("实验 A：工具选择混淆离线实验")
    print(f"数据集：{len(dataset['tools'])} 个合成工具 / {len(dataset['requests'])} 条请求")
    print("=" * 72)

    results = []
    lazy_sel = None
    for cfg in (full, conv):
        label = "full(40 全量暴露)" if cfg is full else "converged(18 收敛后)"
        sel = LLMSelector(cfg) if mode == "llm" else HeuristicSelector(cfg)
        r = evaluate(sel, dataset, cfg, label)
        results.append(r)
        if cfg is full:
            lazy_sel = sel if mode != "llm" else None
        print(f"\n### {label}")
        print(f"  工具数           : {r['n_tools']}")
        print(f"  工具块 token 估算: {r['block_tokens']}")
        print(f"  top-1 准确率     : {r['top1']}/{r['n']} = {r['top1']/r['n']:.0%}")
        print(f"  top-3 命中率     : {r['top3']}/{r['n']} = {r['top3']/r['n']:.0%}")
        print(f"  top-1 错误中·同语义簇混淆: {len(r['intra'])} 例；跨簇混淆: {len(r['extra'])} 例")
        for e in r["intra"]:
            print(f"    [簇内] {e['id']} 「{e['query'][:22]}…」 gold={e['gold']} 误选={e['pred']}")
        for e in r["extra"]:
            print(f"    [跨簇] {e['id']} 「{e['query'][:22]}…」 gold={e['gold']} 误选={e['pred']}")

    if lazy_sel is not None:
        r = evaluate_lazy(lazy_sel, dataset, full)
        results.append(r)
        print(f"\n### {r['config']}：高频常驻 + 每题检索 top-6 注入")
        print(f"  可见工具数       : {r['n_tools']}（但平均每题只注入子集）")
        print(f"  平均注入 token   : {r['block_tokens']}")
        print(f"  top-1 准确率     : {r['top1']}/{r['n']} = {r['top1']/r['n']:.0%}")
        print(f"  top-3 命中率     : {r['top3']}/{r['n']} = {r['top3']/r['n']:.0%}")
        print(f"  top-1 错误中·同语义簇混淆: {len(r['intra'])} 例；跨簇: {len(r['extra'])} 例")
        for e in r["intra"]:
            print(f"    [簇内] {e['id']} 「{e['query'][:22]}…」 gold={e['gold']} 误选={e['pred']}")
        for e in r["extra"]:
            print(f"    [跨簇] {e['id']} 「{e['query'][:22]}…」 gold={e['gold']} 误选={e['pred']}")

    base = results[0]
    print("\n### 对比（以 full 为基线）")
    print(f"{'配置':<28}{'工具数':>6}{'token':>8}{'top-1':>8}{'同簇混淆':>10}")
    for r in results:
        print(f"{r['config']:<28}{r['n_tools']:>6}{r['block_tokens']:>8}{r['top1']/r['n']:>8.0%}{len(r['intra']):>10}")

    print("\n解读提示：")
    print("  1) 收敛配置把『选错双胞胎工具』变成『传错 action 参数』，同簇混淆归零；")
    print("     但注意 token 几乎没降（词面合并不是省 token 的手段）——token 大头在 lazy 列，")
    print("     省 token 靠按需加载（Anthropic 报告的 85% 减少来自渐进披露，不是合并）。")
    print("  2) 工具级准确率会被『gold 变族』机械抬高——action 参数错误请用 --mode llm 单独度量。")
    print("  3) 渐进披露大幅省 token，但语义干扰一个不少，且 gold 检索不到就直接错——")
    print("     这正是 ToolRet 指出的检索层风险；高频工具必须常驻兜底。")
    print("  4) 把 _short_desc 的 lim 从 44 改到 24 再跑一次，观察收敛描述压太狠的代价。")
    if "--json" in sys.argv:
        out = sys.argv[sys.argv.index("--json") + 1]
        json.dump(results, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"\n已写出 {out}")


if __name__ == "__main__":
    main()
