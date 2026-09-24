# -*- coding: utf-8 -*-
"""实验 B：检索打分演示（离线，零依赖，不调任何 API）。

复刻 Generative Agents（arXiv:2304.03442, UIST'23）的检索打分：
    score = alpha * recency + beta * importance + gamma * relevance
三个分量先各自 min-max 归一化到 [0,1] 再线性加权（论文中 alpha=beta=gamma=1）。

与论文的三处近似（论文用真嵌入，本实验为了离线）：
  * recency    —— 论文按 sandbox 游戏小时做指数衰减（衰减因子 0.995）；
                  本实验按"天"做半衰期衰减 0.5 ** (age_days / half_life_days)。
  * relevance  —— 论文用 embedding 余弦相似度；本实验用词元重叠（Jaccard）。
                  中文按二元组切分、ASCII 按单词切分，够演示了。
  * importance —— 论文在写入时让 LLM 打 1-10 分；本实验直接读样例数据里的字段。

目的：让你亲眼看到"该检索的记忆检索不到"是怎么发生的，
以及改权重怎么把它捞回来、又会把什么别的东西带进来。

运行：
    python retrieval_demo.py                     # 跑内置三组对照实验
    python retrieval_demo.py "你的查询" --topk 5 # 任意查询
    python retrieval_demo.py "查询" --wr 2 --wi 0.5 --wg 0.5 --half-life 7
"""
import argparse
import json
import math
import os
import re
import sys
from datetime import datetime, timezone

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ASCII_RE = re.compile(r"[a-z0-9_]+")
CJK_RE = re.compile(r"[\u4e00-\u9fff]+")


def tokenize(text):
    """ASCII 按单词；CJK 连续段按二元组（长度 1 时保留单字）。"""
    toks = set()
    t = text.lower()
    for w in ASCII_RE.findall(t):
        toks.add(w)
    for run in CJK_RE.findall(t):
        if len(run) == 1:
            toks.add(run)
        else:
            for i in range(len(run) - 1):
                toks.add(run[i:i + 2])
    return toks


def parse_iso(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def jaccard(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / float(len(a | b))


def minmax(vals):
    lo, hi = min(vals), max(vals)
    if hi - lo < 1e-9:
        return [0.0 for _ in vals]
    return [(v - lo) / (hi - lo) for v in vals]


class Retriever:
    def __init__(self, memories, now, half_life_days=14.0):
        self.mems = memories
        self.now = now
        self.half_life = half_life_days
        self.tokens = [tokenize(m["text"]) for m in memories]
        self.age_days = [max(0.0, (now - parse_iso(m["created_at"])).total_seconds() / 86400.0)
                         for m in memories]
        # 分量原值（recency / importance 与查询无关，预先算好）
        rec_raw = [0.5 ** (a / self.half_life) for a in self.age_days]
        imp_raw = [m["importance"] / 10.0 for m in memories]
        # 与论文一致：每个分量在本批次内 min-max 归一化
        self.rec_n = minmax(rec_raw)
        self.imp_n = minmax(imp_raw)

    def search(self, query, wr=1.0, wi=1.0, wg=1.0, topk=5):
        q = tokenize(query)
        rel_raw = [jaccard(q, t) for t in self.tokens]
        rel_n = minmax(rel_raw)
        rows = []
        for i, m in enumerate(self.mems):
            s = wr * self.rec_n[i] + wi * self.imp_n[i] + wg * rel_n[i]
            rows.append({
                "id": m["id"], "age_d": self.age_days[i], "imp": m["importance"],
                "rec": self.rec_n[i], "impn": self.imp_n[i], "rel": rel_n[i],
                "score": s, "text": m["text"],
            })
        rows.sort(key=lambda r: r["score"], reverse=True)
        return rows[:topk], rows

    def rank_of(self, all_rows, mem_id):
        for i, r in enumerate(all_rows):
            if r["id"] == mem_id:
                return i + 1
        return None


def print_table(rows, gold=None, topk=5):
    print("  %-4s %-7s %4s %6s %6s %6s %7s  %s"
          % ("rank", "id", "age", "rec", "imp", "rel", "score", "text"))
    shown = rows[:topk]
    gold_row = next((r for r in rows if gold and r["id"] == gold), None)
    gold_rank = None if gold_row is None else rows.index(gold_row) + 1
    for i, r in enumerate(rows):
        if i < topk or (gold and r["id"] == gold):
            mark = " <== GOLD" if gold and r["id"] == gold else ""
            print("  %-4d %-7s %4.0fd %6.3f %6.3f %6.3f %7.3f  %s%s"
                  % (i + 1, r["id"], r["age_d"], r["rec"], r["impn"], r["rel"], r["score"],
                     r["text"][:26] + ("…" if len(r["text"]) > 26 else ""), mark))
            if i == topk - 1 and gold_row is not None and gold_rank and gold_rank > topk:
                print("  %-4s %-7s %4s %6s %6s %6s %7s" % ("...", "", "", "", "", "", ""))
    if gold:
        hit = "命中(top%d 内)" % topk if gold_rank and gold_rank <= topk else "!! 未命中：排第 %s" % gold_rank
        print("  -> gold=%s %s" % (gold, hit))
    return gold_rank


def run_scenarios(data, args):
    now = parse_iso(data["now"])
    mems = data["memories"]
    half_life = args.half_life
    profiles = [
        ("A 论文默认 alpha=beta=gamma=1", dict(wr=1.0, wi=1.0, wg=1.0)),
        ("B 近期偏好型 wr=2.5（新消息优先的系统）", dict(wr=2.5, wi=0.7, wg=0.7)),
        ("C 事实优先型 wg=2.5/wi=1.5（台账/档案型系统）", dict(wr=0.3, wi=1.5, wg=2.5)),
    ]
    ret = Retriever(mems, now, half_life_days=half_life)
    print("NOW=%s  记忆条数=%d  半衰期=%.0fd" % (data["now"], len(mems), half_life))
    print("（各分量已按论文做法在本批次内 min-max 归一化）")
    for gq in data["gold_queries"]:
        print("\n================ 查询: %r ================" % gq["query"])
        print("观察点：%s" % gq["why"])
        for name, w in profiles:
            print("\n[%s]" % name)
            topk = args.topk
            _, rows = ret.search(gq["query"], topk=topk, **w)
            print_table(rows, gold=gq["gold"], topk=topk)


def main():
    ap = argparse.ArgumentParser(description="Generative Agents 检索打分离线演示")
    ap.add_argument("query", nargs="?", help="任意查询词；不填则跑内置演示")
    ap.add_argument("--wr", type=float, default=1.0, help="recency 权重")
    ap.add_argument("--wi", type=float, default=1.0, help="importance 权重")
    ap.add_argument("--wg", type=float, default=1.0, help="relevance 权重")
    ap.add_argument("--half-life", type=float, default=14.0, help="recency 半衰期（天）")
    ap.add_argument("--topk", type=int, default=5)
    ap.add_argument("--data", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                   "sample_memories.json"))
    args = ap.parse_args()

    with open(args.data, "r", encoding="utf-8") as f:
        data = json.load(f)

    if args.query:
        now = parse_iso(data["now"])
        ret = Retriever(data["memories"], now, half_life_days=args.half_life)
        _, rows = ret.search(args.query, wr=args.wr, wi=args.wi, wg=args.wg, topk=len(rows_of(data)))
        print_table(rows, topk=args.topk)
    else:
        run_scenarios(data, args)


def rows_of(data):
    return data["memories"]


if __name__ == "__main__":
    main()
