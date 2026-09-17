#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""实验 A：轻量事件去重（纯标准库、完全离线）

复现生产系统（GDELT / Event Registry / NewsBlur）事件层的最小骨架：
  1) 标题归一化
  2) 集合相似度 + 时间窗双约束（文章-事件 ≤18h、事件存活 ≤36h）
  3) 两遍聚类：第一遍把新文章吸收进已有事件（只跟事件「最近 3 篇」比），
     剩下的第二遍两两建边取连通分量，作为新事件
  4) 阈值扫描，输出漏并 vs 误并的对照；并给出一张「同一条数据、三种表示」的对照表

三种相似度表示（这是本实验最重要的一半）：
  tok   词级重合系数（拉丁/数字整体成 token，中文按字）—— 默认，中文下可用
  jac3  字符 3-gram Jaccard —— 对英文/长文本的朴素移植，中文下几乎不合任何东西
  ovl3  字符 3-gram 重合系数 —— 长度不对称时比 Jaccard 宽容

运行：
  python event_dedup.py                      # 默认 tok / 0.7，含阈值扫描与表示对照
  python event_dedup.py --metric jac3        # 看朴素移植怎么塌掉
  python event_dedup.py --threshold 0.5      # 换阈值看漏并/误并
  python event_dedup.py --data mynews.json

本机若 PATH 里的 python 是坏的空壳，请用
  C:/Users/75791/.lumii/runtimes/bin/python event_dedup.py
或任何你自己的 python3（3.8+，只用标准库）。
"""

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

# --------- 线上存活参数（B 级证据：生产系统的存活值，不是学术最优值）---------
DEFAULT_THRESHOLD = 0.7       # NewsBlur 公开披露的相似度阈值（在它自己的英文表示上）
MAX_ARTICLE_EVENT_GAP_H = 18  # 文章与事件最近一条的时间差上限
EVENT_LIFETIME_H = 36         # 事件被继续追加的存活窗口
RECENT_WINDOW = 3             # 事件侧只看最近 N 篇（真系统是对这 N 篇做向量滑动平均）
SWEEP = (0.5, 0.6, 0.7, 0.8)
METRICS = ("tok", "jac3", "ovl3")


# ---------------- 1. 归一化 ----------------

PREFIX_RE = re.compile(r"^(快讯丨|快讯|独家丨|独家|重磅[:：]|突发丨|视频丨)+")
REPOST_RE = re.compile(r"（转载[^）]*）|\(转载[^)]*\)")
KEEP_RE = re.compile(r"[^0-9a-z\u4e00-\u9fff.]+")
TOKEN_RE = re.compile(r"[a-z]+|\d+(?:\.\d+)?|.")


def normalize(title: str) -> str:
    """去栏目前缀、去转载注记、转小写、去空白与中文标点。

    故意把空白全去掉：中文没有词边界，保留空格会让「GPT-5 发布」和「GPT-5发布」
    变成两个分布。代价是英文词边界消失（见 README 的"已知偏差"）。
    """
    t = title.strip().lower()
    t = REPOST_RE.sub("", t)
    t = PREFIX_RE.sub("", t)
    t = t.replace("“", "").replace("”", "").replace('"', "").replace("——", "")
    return KEEP_RE.sub("", t)


def char_ngrams(text: str, n: int = 3) -> frozenset:
    if len(text) < n:
        return frozenset([text]) if text else frozenset()
    return frozenset(text[i:i + n] for i in range(len(text) - n + 1))


def tokens(text: str) -> frozenset:
    """拉丁词/数字整体成一个 token，其余（中文）按单字。"""
    return frozenset(TOKEN_RE.findall(text))


# ---------------- 2. 相似度 ----------------

def jaccard(a, b) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / float(len(a | b))


def overlap(a, b) -> float:
    """重合系数 |A∩B| / min(|A|,|B|)：短标题被长标题包含时不至于被判成不像。"""
    if not a or not b:
        return 0.0
    return len(a & b) / float(min(len(a), len(b)))


def make_rep(title: str, metric: str):
    n = normalize(title)
    if metric == "tok":
        return tokens(n)
    if metric == "jac3":
        return char_ngrams(n, 3)
    if metric == "ovl3":
        return char_ngrams(n, 3)
    raise ValueError(metric)


def sim(a, b, metric: str) -> float:
    if metric == "tok":
        # 词级重合 + 长度护栏：短到 4 token 以下的标题没有投票权（避免"快讯"两字吸走全场）
        if min(len(a), len(b)) < 4:
            return 0.0
        return overlap(a, b)
    return jaccard(a, b) if metric == "jac3" else overlap(a, b)


# ---------------- 3. 两遍聚类 ----------------

class Event:
    __slots__ = ("eid", "members", "recent", "first", "latest")

    def __init__(self, eid, art, metric):
        self.eid = eid
        self.members = [art["id"]]
        self.recent = [art["_rep"]][-RECENT_WINDOW:]   # 只保留最近 RECENT_WINDOW 篇
        self.first = art["_t"]
        self.latest = art["_t"]

    def add(self, art):
        self.members.append(art["id"])
        self.recent = (self.recent + [art["_rep"]])[-RECENT_WINDOW:]
        self.latest = max(self.latest, art["_t"])

    def best_sim(self, art, metric):
        return max((sim(art["_rep"], r, metric) for r in self.recent), default=0.0)

    def alive(self, art):
        gap = (art["_t"] - self.latest).total_seconds() / 3600.0
        age = (art["_t"] - self.first).total_seconds() / 3600.0
        return gap <= MAX_ARTICLE_EVENT_GAP_H and age <= EVENT_LIFETIME_H


def cluster(articles, threshold=DEFAULT_THRESHOLD, metric="tok", round_size=6):
    """模拟定时抓取：每轮来 round_size 篇。

    每轮内部就是生产系统的两遍：
      第一遍 拿新文章去比已有事件（存活窗口内），能吸收就吸收 —— 稳态下这一步吃掉大多数流量
      第二遍 本轮剩下的文章两两建边取连通分量，每个分量是一个新事件
    """
    arts = sorted(articles, key=lambda a: (a["_t"], a["id"]))
    events = []
    stats = {"pass1": 0, "pass2": 0, "seed": 0}

    for start in range(0, len(arts), max(1, round_size)):
        batch = arts[start:start + round_size]

        # ---- 第一遍：吸收进已有事件 ----
        leftovers = []
        for art in batch:
            best, best_sim = None, 0.0
            for ev in events:
                if not ev.alive(art):
                    continue
                s = ev.best_sim(art, metric)
                if s >= threshold and s > best_sim:
                    best, best_sim = ev, s
            if best is not None:
                best.add(art)
                art["_via"] = ("pass1", best.eid, best_sim)
                stats["pass1"] += 1
            else:
                leftovers.append(art)

        # ---- 第二遍：剩余两两建边取连通分量 ----
        parent = {a["id"]: a["id"] for a in leftovers}
        link_sim = {}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for i in range(len(leftovers)):
            for j in range(i + 1, len(leftovers)):
                a, b = leftovers[i], leftovers[j]
                if abs((b["_t"] - a["_t"]).total_seconds()) / 3600.0 > MAX_ARTICLE_EVENT_GAP_H:
                    continue
                s = sim(a["_rep"], b["_rep"], metric)
                if s >= threshold:
                    rx, ry = find(a["id"]), find(b["id"])
                    if rx != ry:
                        parent[ry] = rx
                    if link_sim.get(b["id"], 0.0) < s:
                        link_sim[b["id"]] = s

        groups = {}
        for a in leftovers:
            groups.setdefault(find(a["id"]), []).append(a)

        for members in groups.values():
            members.sort(key=lambda a: a["_t"])
            ev = Event("E%03d" % (len(events) + 1), members[0], metric)
            members[0]["_via"] = ("pass2-new", ev.eid, 0.0)
            stats["seed"] += 1
            for m in members[1:]:
                ev.add(m)
                m["_via"] = ("pass2", ev.eid, link_sim.get(m["id"], 0.0))
                stats["pass2"] += 1
            events.append(ev)

    cluster.stats = stats
    return events


# ---------------- 4. 评估 ----------------

def all_pairs(arts):
    ids = [a["id"] for a in arts]
    return [(ids[i], ids[j]) for i in range(len(ids)) for j in range(i + 1, len(ids))]


def evaluate(arts, events, threshold, metric):
    cid = {m: ev.eid for ev in events for m in ev.members}
    by_id = {a["id"]: a for a in arts}
    should, merged, missed, false = [], 0, [], []
    for x, y in all_pairs(arts):
        ax, ay = by_id[x], by_id[y]
        same_cluster = cid.get(x) == cid.get(y)
        if ax["truth"] == ay["truth"]:
            if ax["expect"] == "merge" and ay["expect"] == "merge":
                should.append((x, y))
                if same_cluster:
                    merged += 1
                else:
                    missed.append((x, y))
        elif same_cluster:
            false.append((x, y))
    recall = merged / len(should) if should else 0.0
    prec = merged / float(merged + len(false)) if (merged + len(false)) else 1.0
    return {"threshold": threshold, "metric": metric, "events": len(events),
            "should_pairs": len(should), "merged": merged, "missed": len(missed),
            "false_pairs_list": false, "false_merges": len(false),
            "recall": recall, "precision": prec, "missed_list": missed}


def metric_table(arts, threshold=DEFAULT_THRESHOLD):
    print("\n" + "#" * 78)
    print("# 同一批数据、阈值都固定 %.2f，只换相似度表示 —— 阈值是不可移植的" % threshold)
    print("#" * 78)
    print("%-8s %-10s %-10s %-8s %-8s" % ("表示", "事件数", "合并的对数", "召回率", "精确率"))
    for m in METRICS:
        for a in arts:
            a["_rep"] = make_rep(a["title"], m)
        evs = cluster(arts, threshold, m)
        r = evaluate(arts, evs, threshold, m)
        merged_pairs = sum(len(e.members) * (len(e.members) - 1) // 2 for e in evs)
        print("%-8s %-10d %-10d %-8.2f %-8.2f" % (m, r["events"], merged_pairs, r["recall"], r["precision"]))


def report(arts, events, metric, threshold):
    by_id = {a["id"]: a for a in arts}
    print("\n" + "=" * 78)
    print("聚类明细 ｜ metric=%s ｜ 阈值 %.2f ｜ 文章-事件 ≤ %dh ｜ 事件存活 ≤ %dh ｜ 事件侧最近 %d 篇"
          % (metric, threshold, MAX_ARTICLE_EVENT_GAP_H, EVENT_LIFETIME_H, RECENT_WINDOW))
    print("=" * 78)
    for ev in sorted(events, key=lambda e: e.first):
        reps = [by_id[m] for m in ev.members]
        truths = {r["truth"] for r in reps}
        flag = "" if len(truths) == 1 else "   <<< 误并：混进了 %d 个不同事件" % len(truths)
        print("\n[事件 %s] %s ｜ %d 个来源 ｜ truth=%s%s"
              % (ev.eid, reps[0]["_t"].strftime("%m-%d %H:%M"), len(reps), "/".join(sorted(truths)), flag))
        for r in reps:
            via, _, s = r["_via"]
            print("    %-4s %-10s sim=%.2f  %-22s %s" % (r["id"], via, s, r["source"], r["title"][:32]))

    print("\n--- 设计内漏并（样本里 expect != merge 的条目：它们合并不了是设计，不是 bug） ---")
    cid = {m: ev.eid for ev in events for m in ev.members}
    for a in arts:
        if a["expect"] == "merge":
            continue
        best_ev, best_s = None, 0.0
        for ev in events:
            if a["id"] in ev.members:
                continue
            s = ev.best_sim(a, metric)
            if s > best_s:
                best_ev, best_s = ev, s
        if a["expect"] == "miss-local":
            why = "强本地语境稿：字面重合太低（生产系统宁可让它单列一条）"
        else:
            host = [ev for ev in events if a["id"] in ev.members]
            if host:
                why = "竟然被合并了（检查时间窗实现）"
            else:
                why = "被时间窗拦截：比事件最新一条晚太久"
        print("  %s %-30s 最相近事件=%-6s sim=%.2f ｜ %s"
              % (a["id"], a["title"][:24], best_ev.eid if best_ev else "-", best_s, why))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(Path(__file__).with_name("news_sample.json")))
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    ap.add_argument("--metric", default="tok", choices=METRICS)
    args = ap.parse_args()

    arts = json.loads(Path(args.data).read_text(encoding="utf-8"))
    for a in arts:
        a["_t"] = datetime.fromisoformat(a["published"])

    # L1（同稿转载）先看一眼：归一化后字面全同的是文档层去重，不该由事件层负责
    print("L1 同稿转载检测（归一化后字面全同）：")
    seen = {}
    for a in sorted(arts, key=lambda x: x["_t"]):
        k = normalize(a["title"])
        if k in seen:
            print("  %s 与 %s 归一化后完全相同：%s" % (seen[k], a["id"], a["title"][:30]))
        else:
            seen[k] = a["id"]

    # 阈值扫描
    print("\n" + "#" * 78)
    print("# 阈值扫描 ｜ metric=%s ｜ %d 条模拟标题" % (args.metric, len(arts)))
    print("#" * 78)
    print("%-8s %-8s %-10s %-8s %-8s %-8s %-8s %-16s %s"
          % ("阈值", "事件数", "应合并对", "已合并", "漏并", "误并", "召回率", "pass1/2/新种", "精确率"))
    for t in SWEEP:
        for a in arts:
            a["_rep"] = make_rep(a["title"], args.metric)
        evs = cluster(arts, t, args.metric)
        r = evaluate(arts, evs, t, args.metric)
        st = cluster.stats
        print("%-8.2f %-8d %-10d %-8d %-8d %-8d %-8.2f %-16s %.2f"
              % (t, r["events"], r["should_pairs"], r["merged"], r["missed"],
                 r["false_merges"], r["recall"],
                 "%d/%d/%d" % (st["pass1"], st["pass2"], st["seed"]), r["precision"]))
    print("""
读法：阈值往下调，"已合并"涨、"误并"迟早也涨；往上调，"误并"清零但"漏并"涨。
生产系统停在 0.7 附近不是因为它最优，而是因为两种错误的骂声不对称：
漏并 = 用户看到两条重复（烦）；误并 = 用户丢了一条新闻 + 来源被吞（事故）。""")

    metric_table(arts, DEFAULT_THRESHOLD)

    for a in arts:
        a["_rep"] = make_rep(a["title"], args.metric)
    evs = cluster(arts, args.threshold, args.metric)
    r = evaluate(arts, evs, args.threshold, args.metric)
    report(arts, evs, args.metric, args.threshold)
    print("\n汇总：metric=%s 阈值 %.2f → %d 篇文章 → %d 个事件；应合并对 %d，合并 %d，漏并 %d，误并对 %d"
          % (args.metric, args.threshold, len(arts), r["events"], r["should_pairs"],
             r["merged"], r["missed"], r["false_merges"]))
    st = cluster.stats
    tot = max(1, st["pass1"] + st["pass2"] + st["seed"])
    print("两遍聚类的分工：第一遍吸收 %d 篇（%.0f%%），第二遍里 %d 篇并进新种子，%d 篇成为新事件种子。"
          % (st["pass1"], 100.0 * st["pass1"] / tot, st["pass2"], st["seed"]))
    print("NewsBlur 公开说法是稳态下第一遍吸收 70-80%；本模拟每轮只来 6 篇、事件还没养肥，")
    print("所以第一遍占比会明显低于这个数字 —— 事件越成熟、增量越小，第一遍吃掉的份额越高。")
    if r["missed_list"]:
        print("漏并对（前 12 个）：" + ", ".join("%s/%s" % p for p in r["missed_list"][:12]))
    if r["false_pairs_list"]:
        print("误并对：" + ", ".join("%s/%s" % p for p in r["false_pairs_list"]))
    print("\n关键事实：每个事件都带着 N 个来源（见上面每簇的来源列表），没有任何一篇文章被删除。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
