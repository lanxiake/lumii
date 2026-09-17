#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""实验 B：规则引擎 + 命中集预览（"四件套"最小可用版，纯标准库、完全离线）

四件套：
  1) 规则对象化 —— 规则是可校验的 JSON 对象：field / op / value / action / priority / log
  2) 命中集预览 —— 落库前先算「每条规则命中哪些资讯、冲突会怎么裁」，零副作用
  3) 显式优先级链 —— 冲突按 priority 裁决；同优先级平局**不自动裁决**，显式上报
  4) 规则日志   —— 每次 apply 追加 JSONL：plan_hash / 决策规则 / 命中项 / 裁决轨迹

外加两条从 Terraform plan / CloudFormation change set / ArgoCD diffing 借来的不变式：
  ② apply 执行的是被审过的那一份（plan_hash 对不上就拒绝执行，而不是重新生成）
  ③ 结果写回同一条记录（日志里的 plan_hash 能和 plan 文件对上，可回溯）

命令：
  python rule_engine.py                    # 完整演示：校验 → 预览 → 计划 → 应用 → 日志 → 盲选对照
  python rule_engine.py validate
  python rule_engine.py preview            # 只打印，一个字都不写盘（真·零副作用）
  python rule_engine.py plan --out plan_preview.json
  python rule_engine.py apply plan_preview.json
  python rule_engine.py blind              # 没有预览的世界：按插入顺序、首条命中即生效
  python rule_engine.py log --tail 12
  python rule_engine.py demo-invalid       # 坏规则怎么被 schema 挡在门外

本机若 PATH 里的 python 是坏的空壳，请用
  C:/Users/75791/.lumii/runtimes/bin/python rule_engine.py
或任何你自己的 python3（3.8+，只用标准库）。
"""

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path

ALLOWED_FIELDS = {"title", "source", "category", "shares"}
ALLOWED_OPS = {"contains", "not_contains", "equals", "not_equals", "in", "not_in", "gt", "lt", "regex"}
ALLOWED_ACTIONS = {"push", "mute"}
REQUIRED_KEYS = ("id", "field", "op", "value", "action", "priority")


# ---------------- 第 1 件套：规则对象化 + 校验 ----------------

def validate_rule(rule):
    errs = []
    for k in REQUIRED_KEYS:
        if k not in rule:
            errs.append("缺字段 %s" % k)
    if errs:
        return errs
    if rule["field"] not in ALLOWED_FIELDS:
        errs.append("未知字段 %r（可用：%s）" % (rule["field"], "/".join(sorted(ALLOWED_FIELDS))))
    if rule["op"] not in ALLOWED_OPS:
        errs.append("未知操作符 %r" % rule["op"])
    if rule["action"] not in ALLOWED_ACTIONS:
        errs.append("未知动作 %r（只能是 push/mute）" % rule["action"])
    if not isinstance(rule["priority"], int):
        errs.append("priority 必须是整数，收到 %r" % (rule["priority"],))
    op, v = rule["op"], rule["value"]
    if op in ("gt", "lt") and not isinstance(v, (int, float)):
        errs.append("%s 的 value 必须是数字" % op)
    if op in ("in", "not_in") and not isinstance(v, list):
        errs.append("%s 的 value 必须是数组" % op)
    if op == "regex":
        try:
            re.compile(v)
        except Exception as e:
            errs.append("正则无法编译：%s" % e)
    return errs


def rule_hits(rules, news):
    hits = {}
    for r in rules:
        hits[r["id"]] = [n["id"] for n in news if matches(r, n)]
    return hits


def matches(rule, item):
    if rule["field"] not in item:
        return False
    x, op, v = item[rule["field"]], rule["op"], rule["value"]
    if op == "contains":
        return v in str(x)
    if op == "not_contains":
        return v not in str(x)
    if op == "equals":
        return x == v
    if op == "not_equals":
        return x != v
    if op == "in":
        return x in v
    if op == "not_in":
        return x not in v
    if op == "gt":
        return isinstance(x, (int, float)) and x > v
    if op == "lt":
        return isinstance(x, (int, float)) and x < v
    if op == "regex":
        return re.search(v, str(x)) is not None
    return False


# ---------------- 哈希：让"被审过的那一份"可被指认 ----------------

def canon(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def sha(obj):
    return hashlib.sha256(canon(obj)).hexdigest()[:16]


# ---------------- 第 3 件套：显式优先级链 + 冲突裁决 ----------------

def decide(rules_sorted, item, default_action):
    """返回 (action, decided_by_ids, trace, unresolved)

    trace 按优先级顺序记录每条命中的规则，这是日志里最重要的字段。
    """
    trace = [{"rule": r["id"], "name": r["name"], "action": r["action"], "priority": r["priority"]}
             for r in rules_sorted if matches(r, item)]
    if not trace:
        return default_action, [], [], False
    top = trace[0]["priority"]
    first = [t for t in trace if t["priority"] == top]
    actions = {t["action"] for t in first}
    if len(actions) > 1:
        # 同优先级、动作相反：不猜，交给兜底并显式上报 —— 这条必须有人来看
        return default_action, [t["rule"] for t in first], trace, True
    return first[0]["action"], [t["rule"] for t in first], trace, False


def build_plan(data):
    news, rules = data["news"], data["rules"]
    default_action = data.get("default_action", "push")
    order = sorted(rules, key=lambda r: (r["priority"], str(r["id"])))
    hits = rule_hits(rules, news)

    decisions, conflicts, unresolved = [], [], []
    effective = {r["id"]: 0 for r in rules}
    for n in news:
        action, by, trace, unres = decide(order, n, default_action)
        for b in by:
            effective[b] += 1
        d = {"id": n["id"], "title": n["title"], "action": action,
             "decided_by": by, "trace": trace, "unresolved": unres,
             "via": "rule" if trace else "default"}
        decisions.append(d)
        if len({t["action"] for t in trace}) > 1:
            conflicts.append({"item": n["id"], "title": n["title"], "trace": trace,
                              "resolved_action": action, "unresolved": unres})
        if unres:
            unresolved.append(n["id"])

    shadowed = [{"rule": r["id"], "name": r["name"], "matched": len(hits[r["id"]]),
                 "effective": effective[r["id"]]}
                for r in rules if hits[r["id"]] and effective[r["id"]] == 0]

    plan = {
        "version": 1,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "default_action": default_action,
        "priority_chain": [{"rule": r["id"], "name": r["name"], "action": r["action"],
                            "priority": r["priority"]} for r in order],
        "rule_hits": [{"id": r["id"], "name": r["name"], "action": r["action"],
                       "priority": r["priority"], "matched": hits[r["id"]]}
                      for r in rules],
        "shadowed_rules": shadowed,
        "conflicts": conflicts,
        "unresolved": unresolved,
        "decisions": decisions,
        "rules_hash": sha(rules),
        "data_hash": sha(news),
    }
    plan["plan_hash"] = sha({k: v for k, v in plan.items() if k != "generated_at"})
    return plan


# ---------------- 输出 ----------------

def print_preview(plan, news_by_id):
    print("=" * 78)
    print("第 1 件套 · 规则对象化与校验")
    print("=" * 78)
    print("优先级链（数字越小越优先）：" + "  >  ".join(
        "%s(%s,p%d)" % (c["rule"], c["action"], c["priority"]) for c in plan["priority_chain"]))
    print("兜底动作：%s" % plan["default_action"])

    print("\n" + "=" * 78)
    print("第 2 件套 · 命中集预览（零副作用：不写库、不改 feed、不调用任何模型）")
    print("=" * 78)
    for rh in plan["rule_hits"]:
        ids = rh["matched"]
        print("%-4s %-14s %-5s p%-3d 命中 %2d 条：%s"
              % (rh["id"], rh["name"], rh["action"], rh["priority"], len(ids),
                 " ".join(ids) if ids else "（一条都没命中 —— 这条规则是死的）"))

    print("\n" + "=" * 78)
    print("第 3 件套 · 冲突裁决（同一批资讯被多条规则判成相反动作）")
    print("=" * 78)
    if not plan["conflicts"]:
        print("无冲突。")
    for c in plan["conflicts"]:
        print("\n%s  %s" % (c["item"], c["title"][:36]))
        for t in c["trace"]:
            print("    p%-3d %-4s %-5s %s" % (t["priority"], t["rule"], t["action"], t["name"]))
        print("    → 裁决：%s%s" % (c["resolved_action"],
                                    "（平局，未自动裁决，落兜底 —— 需要人看一眼）" if c["unresolved"] else ""))

    if plan["shadowed_rules"]:
        print("\n被完全遮蔽的规则（命中过，但一次都没生效）：")
        for s in plan["shadowed_rules"]:
            print("    %s %s：命中 %d 条，生效 0 次" % (s["rule"], s["name"], s["matched"]))

    n_push = sum(1 for d in plan["decisions"] if d["action"] == "push")
    n_mute = len(plan["decisions"]) - n_push
    n_def = sum(1 for d in plan["decisions"] if d["via"] == "default")
    print("\n预览汇总：共 %d 条资讯 → 推 %d 条 / 静音 %d 条；其中 %d 条走兜底，%d 条平局未决。"
          % (len(plan["decisions"]), n_push, n_mute, n_def, len(plan["unresolved"])))
    print("plan_hash = %s（规则哈希 %s / 数据哈希 %s）"
          % (plan["plan_hash"], plan["rules_hash"], plan["data_hash"]))


def print_log(path, tail):
    if not path.exists():
        print("还没有日志文件：%s（先跑 plan + apply）" % path)
        return
    lines = path.read_text(encoding="utf-8").splitlines()
    print("规则日志 %s（共 %d 条记录，显示末尾 %d 条）" % (path.name, len(lines), min(tail, len(lines))))
    for ln in lines[-tail:]:
        rec = json.loads(ln)
        if rec.get("kind") == "apply_summary":
            print("  [%s] APPLY plan_hash=%s → 推 %d / 静音 %d"
                  % (rec["ts"][:19], rec["plan_hash"], rec["push"], rec["mute"]))
        else:
            print("  [%s] %-6s %s 由 %s 决定 轨迹=%s%s"
                  % (rec["ts"][:19], rec["item"], rec["action"], ",".join(rec["decided_by"]) or "-",
                     "->".join(t["rule"] + ":" + t["action"] for t in rec["trace"]) or "(兜底)",
                     "  <<< 平局未决" if rec.get("unresolved") else ""))


# ---------------- 第 4 件套：规则日志 + 不变式 ②③ ----------------

def apply_plan(plan, log_path):
    ts = datetime.now().isoformat(timespec="seconds")
    with log_path.open("a", encoding="utf-8") as f:
        for d in plan["decisions"]:
            f.write(json.dumps({"kind": "decision", "ts": ts, "plan_hash": plan["plan_hash"],
                                "item": d["id"], "action": d["action"], "decided_by": d["decided_by"],
                                "trace": d["trace"], "unresolved": d["unresolved"]},
                               ensure_ascii=False) + "\n")
        f.write(json.dumps({"kind": "apply_summary", "ts": ts, "plan_hash": plan["plan_hash"],
                            "rules_hash": plan["rules_hash"], "data_hash": plan["data_hash"],
                            "push": sum(1 for d in plan["decisions"] if d["action"] == "push"),
                            "mute": sum(1 for d in plan["decisions"] if d["action"] == "mute")},
                           ensure_ascii=False) + "\n")


def blind_decide(rules, item):
    """没有预览、没有优先级链的世界：按插入顺序，第一条命中就生效。"""
    for r in rules:
        if matches(r, item):
            return r["action"], r["id"]
    return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", nargs="?", default="demo",
                    choices=["demo", "validate", "preview", "plan", "apply", "blind", "log", "demo-invalid"])
    ap.add_argument("plan_file", nargs="?", default="plan_preview.json")
    ap.add_argument("--data", default=str(Path(__file__).with_name("rules_sample.json")))
    ap.add_argument("--out", default="plan_preview.json")
    ap.add_argument("--log", default="rule_log.jsonl")
    ap.add_argument("--tail", type=int, default=10)
    args = ap.parse_args()

    data = json.loads(Path(args.data).read_text(encoding="utf-8"))
    news, rules = data["news"], data["rules"]
    news_by_id = {n["id"]: n for n in news}
    log_path = Path(args.log)

    if args.cmd == "validate":
        ok = True
        for r in rules:
            errs = validate_rule(r)
            print("%-4s %s" % (r.get("id", "?"), "OK" if not errs else "; ".join(errs)))
            ok = ok and not errs
        print("校验%s" % ("全部通过" if ok else "：存在不合规规则，已拒绝入库"))
        return 0 if ok else 1

    if args.cmd == "demo-invalid":
        bad_rules = list(rules) + [
            {"id": "R7", "name": "长文降权", "field": "words", "op": "gt", "value": 3000,
             "action": "mute", "priority": 15},                     # 字段不存在
            {"id": "R8", "name": "关键词", "field": "title", "op": "startswidh", "value": "快讯",
             "action": "mute", "priority": 25},                     # 操作符拼错
            {"id": "R9", "name": "别家号", "field": "source", "op": "in", "value": "小号A",
             "action": "hide", "priority": 12},                     # value 类型 + action 非法
        ]
        probe = {"news": news, "rules": bad_rules, "default_action": data.get("default_action", "push")}
        print("注入 3 条坏规则后的校验结果：")
        rejected = []
        for r in bad_rules:
            errs = validate_rule(r)
            if errs:
                rejected.append(r["id"])
            print("  %-4s %s" % (r["id"], "OK" if not errs else "拒绝：" + "; ".join(errs)))
        print("\n被拒规则不参与裁决（也不会静默降级成「永远不命中」）：%s" % ", ".join(rejected))
        print("对照：如果不校验，R7 会因为字段 words 不存在而永远不命中 —— 用户以为规则生效了，其实从没生效。")
        return 0

    plan = build_plan(data)

    if args.cmd == "preview":
        print_preview(plan, news_by_id)
        print("\n（本次运行没有写任何文件。plan/apply 才会落盘。）")
        return 0

    if args.cmd == "plan":
        print_preview(plan, news_by_id)
        Path(args.out).write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
        print("\n已把这份预览固化为可审、可执行的计划：%s（plan_hash=%s）" % (args.out, plan["plan_hash"]))
        return 0

    if args.cmd == "apply":
        pf = Path(args.plan_file)
        if not pf.exists():
            print("找不到计划文件 %s —— 先跑 plan。" % pf)
            return 2
        loaded = json.loads(pf.read_text(encoding="utf-8"))
        stored_hash = loaded.get("plan_hash")
        selfcheck = sha({k: v for k, v in loaded.items() if k not in ("generated_at", "plan_hash")})
        if selfcheck != stored_hash:
            print("拒绝执行：计划文件本身被改动过（内容指纹对不上存好的 plan_hash）。")
            print("  文件里的 plan_hash = %s ｜ 按内容重算 = %s" % (stored_hash, selfcheck))
            print("  对应不变式②：审过的那一份被偷偷编辑过就不能执行 —— 哪怕只改一个字符。")
            return 2
        fresh = build_plan(data)
        if loaded.get("rules_hash") != fresh["rules_hash"] or loaded.get("data_hash") != fresh["data_hash"]:
            print("拒绝执行：规则或资讯池在计划生成后发生了变化（漂移）。")
            print("  计划：rules %s / data %s" % (loaded.get("rules_hash"), loaded.get("data_hash")))
            print("  当前：rules %s / data %s" % (fresh["rules_hash"], fresh["data_hash"]))
            print("  对应不变式②：不能「顺手重新生成一份再执行」，要么重新审一遍，要么停下来。")
            return 2
        apply_plan(loaded, log_path)
        print("已执行被审过的那一份：plan_hash=%s → 写入 %s" % (stored_hash, log_path.name))
        print_log(log_path, args.tail)
        return 0

    if args.cmd == "blind":
        print("盲选模式：规则按插入顺序、首条命中即生效；没有预览、没有冲突报告、没有日志。")
        print("-" * 78)
        proper = {d["id"]: d for d in plan["decisions"]}
        diffs = []
        blind_effective = {r["id"]: 0 for r in rules}
        for n in news:
            act, rid = blind_decide(rules, n)
            if rid:
                blind_effective[rid] += 1
            p = proper[n["id"]]["action"]
            bact = act or data.get("default_action", "push")
            if bact != p:
                diffs.append((n, bact, rid, p))
        print("两种实现的 feed 差异（%d / %d 条）：" % (len(diffs), len(news)))
        for n, bact, rid, pact in diffs:
            print("  %-4s 盲选=%-5s（%s 先命中）  正确=%-5s（%s）  %s"
                  % (n["id"], bact, rid, pact, ",".join(proper[n["id"]]["decided_by"]) or "default",
                     n["title"][:28]))
        print("\n盲选模式下用户「看不见」的东西：")
        for s in plan["shadowed_rules"]:
            print("  · %s %s 命中 %d 条却一次都没生效（被更早/更靠前的规则吞掉）"
                  % (s["rule"], s["name"], s["matched"]))
        if plan["unresolved"]:
            print("  · %d 条平局资讯（%s）没有任何提示，静默落进 feed"
                  % (len(plan["unresolved"]), ",".join(plan["unresolved"])))
        print("  · 上面 %d 条决策差异，用户在 feed 里只能靠「怎么又没推／怎么又推了」反推" % len(diffs))
        print("\n结论：没有命中集预览，用户只能通过整体 feed 的分数变化去猜哪条规则生效了 ——")
        print("      而整体分数是十几条规则叠在一起的输出，一次只能改一条、改完还看不出因果。")
        print("      这就是「规则被训歪」的唯一来源：反馈信号和规则之间没有可归因的通路。")
        return 0

    if args.cmd == "log":
        print_log(log_path, args.tail)
        return 0

    # demo
    for r in rules:
        errs = validate_rule(r)
        if errs:
            print("规则 %s 不合规，已拒绝：%s" % (r["id"], "; ".join(errs)))
            return 1
    print_preview(plan, news_by_id)
    out = Path(args.out)
    out.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n" + "=" * 78)
    print("不变式①②③④ 走一遍：预览零副作用 → 固化计划 → 执行被审过的那一份 → 结果写回同一条记录")
    print("=" * 78)
    print("已固化计划：%s（plan_hash=%s）" % (out, plan["plan_hash"]))
    loaded = json.loads(out.read_text(encoding="utf-8"))
    if loaded["plan_hash"] != build_plan(data)["plan_hash"]:
        print("计划已过期，拒绝执行。")
        return 2
    apply_plan(loaded, log_path)
    print("已应用：plan_hash=%s → %s" % (loaded["plan_hash"], log_path.name))
    print_log(log_path, args.tail)
    print("\n" + "=" * 78)
    print("对照实验：把同一份规则交给「没有预览」的实现，feed 会长什么样")
    print("=" * 78)
    return main_blind(news, rules, plan, data)


def main_blind(news, rules, plan, data):
    proper = {d["id"]: d for d in plan["decisions"]}
    diffs = []
    for n in news:
        act, rid = blind_decide(rules, n)
        p = proper[n["id"]]["action"]
        if (act or data.get("default_action", "push")) != p:
            diffs.append((n, act or data.get("default_action", "push"), rid, p))
    print("决策差异 %d / %d 条：" % (len(diffs), len(news)))
    for n, bact, rid, pact in diffs:
        print("  %-4s 盲选=%-5s（%s 先命中）  正确=%-5s（%s）  %s"
              % (n["id"], bact, rid, pact, ",".join(proper[n["id"]]["decided_by"]) or "default",
                 n["title"][:28]))
    for s in plan["shadowed_rules"]:
        print("  被吞掉的规则：%s %s 命中 %d 条，生效 0 次" % (s["rule"], s["name"], s["matched"]))
    if plan["unresolved"]:
        print("  平局未决：%s（正确实现会显式上报，盲选实现静默）" % ",".join(plan["unresolved"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
