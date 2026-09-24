# -*- coding: utf-8 -*-
"""实验 A：文件台账记忆系统（纯 Python 标准库，离线可跑）。

对应第 2 章的工程判据：
  1. 台账用 JSON 而非 Markdown（Anthropic harness 实践：模型改坏 JSON 的概率低于 Markdown）；
  2. 每条带状态字段（state/passes，源自 Anthropic feature list 的 passes 字段）；
  3. agent 只准改状态字段——由 apply_agent_patch / agent_replace_document 强制（校验器拒绝越权写）；
  4. 计数语义 ADD / UPVOTE / DOWNVOTE（源自 ExpeL 的 insight 池操作）；
  5. 非破坏性失效：supersede/invalidation 只写 superseded_at 时间戳，永不删除条目
     （源自 Zep/Graphiti 的 bi-temporal 边失效：设 t_invalid，而非删边）；
  6. 结论必须挂 evidence 指针（源自 Generative Agents 反思带被引记忆编号）。

运行：
    python ledger.py demo        # 跑内置演示
    python ledger.py validate ledger.json   # 校验一个台账文件
"""
import json
import sys
from datetime import datetime, timezone

try:  # Windows 控制台默认 GBK，防止中文输出崩溃
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ---------------------------------------------------------------- schema 定义
# 注意：这里刻意用手写的校验器而不是引入 jsonschema 依赖——实验要保证零依赖。

REQUIRED_FIELDS = [
    "id", "ns", "text", "state", "passes",
    "created_at", "updated_at", "upvotes", "downvotes",
    "evidence", "supersedes", "superseded_at",
]

FIELD_TYPES = {
    "id": str, "ns": str, "text": str, "state": str, "passes": bool,
    "created_at": str, "updated_at": str, "upvotes": int, "downvotes": int,
    "evidence": list, "supersedes": (str, type(None)),
    "superseded_at": (str, type(None)),
}

ALLOWED_STATES = {"open", "done", "blocked", "rejected", "superseded"}

# agent 只准改这些字段；其余字段（id/ns/created_at/supersedes/superseded_at）
# 属于"账本结构"，只有 harness（代码）能写。
AGENT_MUTABLE_FIELDS = {"state", "passes", "upvotes", "downvotes", "evidence"}

# downvote 净票数低于此阈值 -> 标记 rejected（不删除）
REJECT_VOTE_FLOOR = -2


class LedgerViolationError(Exception):
    """agent 的写入请求违反台账纪律时抛出。"""


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_doc():
    return {"version": 1, "entries": []}


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save(doc, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")


def _find(doc, entry_id):
    for e in doc["entries"]:
        if e["id"] == entry_id:
            return e
    raise KeyError("entry not found: %s" % entry_id)


# ---------------------------------------------------------------- 写操作（harness 侧）

def add_entry(doc, text, ns, evidence=None, state="open"):
    """ADD：新增一条台账（计数语义之一，ExpeL）。永不覆盖同 id。"""
    if any(e["text"] == text for e in doc["entries"]):
        return None  # 幂等：完全相同内容不重复入库
    ts = now_iso()
    seq = len(doc["entries"]) + 1
    entry = {
        "id": "L%03d" % seq,
        "ns": ns,
        "text": text,
        "state": state,
        "passes": False,
        "created_at": ts,
        "updated_at": ts,
        "upvotes": 0,
        "downvotes": 0,
        "evidence": list(evidence or []),
        "supersedes": None,
        "superseded_at": None,
    }
    doc["entries"].append(entry)
    return entry


def supersede(doc, old_id, text, ns, evidence=None):
    """非破坏性失效（Zep 式）：旧条目只写 superseded_at，新条目记录 supersedes。

    历史永远可回放：想知道"当时为什么那么做"，旧条目还在。
    """
    old = _find(doc, entry_id=old_id)
    if old["superseded_at"] is not None:
        raise LedgerViolationError("entry %s 已失效，不能重复失效" % old_id)
    ts = now_iso()
    old["superseded_at"] = ts
    old["state"] = "superseded"
    old["updated_at"] = ts
    entry = add_entry(doc, text, ns, evidence)
    entry["supersedes"] = old_id
    return entry


# ---------------------------------------------------------------- 写操作（agent 侧，全部过校验器）

def apply_agent_patch(doc, entry_id, patch):
    """agent 唯一的合法更新入口：只能改 AGENT_MUTABLE_FIELDS 里的状态字段。

    这就是"agent 只准改状态字段"被代码强制的地方——不是靠提示词恳求，
    而是越权字段直接抛 LedgerViolationError。
    """
    illegal = set(patch.keys()) - AGENT_MUTABLE_FIELDS
    if illegal:
        raise LedgerViolationError(
            "拒绝：agent 无权修改字段 %s（可变字段仅限 %s）"
            % (sorted(illegal), sorted(AGENT_MUTABLE_FIELDS))
        )
    e = _find(doc, entry_id)
    if e["superseded_at"] is not None:
        raise LedgerViolationError("拒绝：entry %s 已失效，写它没有意义且会污染历史" % entry_id)
    if "state" in patch and patch["state"] not in ALLOWED_STATES:
        raise LedgerViolationError("拒绝：非法 state=%r" % patch["state"])
    if "passes" in patch and not isinstance(patch["passes"], bool):
        raise LedgerViolationError("拒绝：passes 必须是布尔值")
    if "evidence" in patch and (
        not isinstance(patch["evidence"], list)
        or any(not isinstance(x, str) for x in patch["evidence"])
    ):
        raise LedgerViolationError("拒绝：evidence 必须是指针字符串列表")
    e.update(patch)
    e["updated_at"] = now_iso()
    return e


def vote(doc, entry_id, delta):
    """UPVOTE / DOWNVOTE：只动计数；负到阈值标 rejected，绝不删除。"""
    e = _find(doc, entry_id)
    if delta > 0:
        e["upvotes"] += 1
    else:
        e["downvotes"] += 1
    e["updated_at"] = now_iso()
    score = e["upvotes"] - e["downvotes"]
    if score <= REJECT_VOTE_FLOOR and e["state"] in ("open", "done"):
        e["state"] = "rejected"
    return e


def agent_replace_document(doc, proposed):
    """模拟 agent 交回"整本台账"的情形：逐条比对，发现删条目/改结构字段就拒绝。

    对应实践：哪怕模型直接改文件，写路径上也有一道结构闸门。
    """
    if not isinstance(proposed, dict) or "entries" not in proposed:
        raise LedgerViolationError("拒绝：提交物不是合法台账文档")
    old_by_id = {e["id"]: e for e in doc["entries"]}
    new_ids = [e.get("id") for e in proposed["entries"]]
    if len(new_ids) != len(set(new_ids)):
        raise LedgerViolationError("拒绝：存在重复 id")
    for oid, old in old_by_id.items():
        match = [e for e in proposed["entries"] if e.get("id") == oid]
        if not match:
            raise LedgerViolationError("拒绝：条目 %s 被删除（失效必须走 supersede，不允许删行）" % oid)
        newe = match[0]
        for f in set(old.keys()) - AGENT_MUTABLE_FIELDS:
            if old[f] != newe.get(f, old[f]):
                raise LedgerViolationError("拒绝：非状态字段 %s.%s 被改动" % (oid, f))
    return proposed


# ---------------------------------------------------------------- 校验器

def validate_document(doc):
    """全量 schema 校验：类型、必填、枚举、引用完整性。返回 (errors, warnings)。"""
    errors, warnings = [], []
    if not isinstance(doc, dict) or not isinstance(doc.get("entries"), list):
        return (["顶层必须是 {version, entries:[...]}"], [])
    seen = set()
    for i, e in enumerate(doc["entries"]):
        where = "entries[%s]" % e.get("id", "#%d" % i)
        for f in REQUIRED_FIELDS:
            if f not in e:
                errors.append("%s 缺必填字段 %s" % (where, f))
        for f, t in FIELD_TYPES.items():
            if f in e and not isinstance(e[f], t):
                errors.append("%s 字段 %s 类型应为 %s，实际 %s" % (where, f, t, type(e[f]).__name__))
        if e.get("id") in seen:
            errors.append("%s id 重复" % where)
        seen.add(e.get("id"))
        if e.get("state") and e["state"] not in ALLOWED_STATES:
            errors.append("%s state=%r 不在枚举内" % (where, e["state"]))
        if e.get("supersedes") and e["supersedes"] not in seen:
            # supersedes 也可能指向后面才出现的条目，这里宽松些：全量再查一次
            if all(x["id"] != e["supersedes"] for x in doc["entries"]):
                errors.append("%s supersedes 指向不存在的 %s" % (where, e["supersedes"]))
        if e.get("supersedes") and any(
            x.get("supersedes") == e.get("id") for x in doc["entries"]
        ):
            warnings.append("%s 与它 supersedes 的目标互相指向，检查是否成环" % where)
        if e.get("superseded_at") is not None and e.get("state") not in ("superseded", "rejected"):
            warnings.append("%s 已写失效时间但 state=%r（建议置 superseded）" % (where, e.get("state")))
        if isinstance(e.get("evidence"), list) and len(e["evidence"]) == 0 and e.get("passes"):
            warnings.append("%s passes=true 但 evidence 为空——状态必须可被证据支撑" % where)
    return errors, warnings


# ---------------------------------------------------------------- 读视图

def active_view(doc):
    """派生视图：只含未失效且未被否决的条目。注意——台账是派生视图，原始日志不在这。"""
    return [e for e in doc["entries"]
            if e["superseded_at"] is None and e["state"] != "rejected"]


def show(doc, title=""):
    if title:
        print("\n== %s ==" % title)
    for e in doc["entries"]:
        flag = " [失效@%s]" % e["superseded_at"] if e["superseded_at"] else ""
        votes = "+%d/-%d" % (e["upvotes"], e["downvotes"])
        ev = ",".join(e["evidence"]) if e["evidence"] else "-"
        print("  %s (%s)%s state=%-10s passes=%-5s %s ev=[%s] :: %s"
              % (e["id"], e["ns"], flag, e["state"], e["passes"], votes, ev, e["text"]))


# ---------------------------------------------------------------- 演示

def demo():
    doc = new_doc()
    print("### 1) ADD：系统写入三条领域经验（带证据指针）")
    add_entry(doc, "web_search 被日历/导航类页面污染；可靠路径是直接抓 36氪 快讯列表页",
              ns="/agent/info-curator/lessons", evidence=["run:2026-09-12T08:00Z#3"])
    add_entry(doc, "cron 执行实例默认无历史，跨执行连续性只能靠台账显式注入",
              ns="/agent/info-curator/lessons", evidence=["bridge-context-compactor.ts:408"])
    add_entry(doc, "维护 Agent 工具面 31 个，已超 Anthropic 提示的 30-50 警告区下沿，需收敛到 <20",
              ns="/agent/keeper/lessons", evidence=["definitions.ts"])
    show(doc, "初始台账")

    print("\n### 2) agent 合法写：只改状态字段 passes/state")
    apply_agent_patch(doc, "L002", {"passes": True, "state": "done"})
    show(doc, "L002 置 done/passes=true")

    print("\n### 3) agent 越权写：试图改 id / 偷加字段 -> 被代码拒绝")
    for bad in [{"id": "L999"}, {"text": "篡改原文", "passes": True}]:
        try:
            apply_agent_patch(doc, "L001", bad)
        except LedgerViolationError as ex:
            print("  [拦截] %s" % ex)

    print("\n### 4) agent 交回整本台账但删掉了一行 -> 被结构闸门拒绝")
    import copy
    tampered = copy.deepcopy(doc)
    tampered["entries"] = [e for e in tampered["entries"] if e["id"] != "L001"]
    try:
        agent_replace_document(doc, tampered)
    except LedgerViolationError as ex:
        print("  [拦截] %s" % ex)

    print("\n### 5) UPVOTE / DOWNVOTE：负到阈值标 rejected，不删除")
    vote(doc, "L003", +1)
    for _ in range(3):
        vote(doc, "L001", -1)
    show(doc, "投票后（L001 已 rejected，但仍在账上）")

    print("\n### 6) supersede：新事实取代旧事实，旧条目只写失效时间戳")
    supersede(doc, "L003", "工具面已收敛：维护 Agent 从 31 个降到 18 个（memory_*/wiki_* 已合并）",
              ns="/agent/keeper/lessons", evidence=["definitions.ts@v2"])
    show(doc, "失效语义：L003 仍在账上，只是带 superseded_at")

    print("\n### 7) 全量 schema 校验")
    errors, warnings = validate_document(doc)
    print("  errors=%d warnings=%d" % (len(errors), len(warnings)))
    for w in warnings:
        print("  warn: %s" % w)

    print("\n### 8) 派生视图（agent 每轮实际被注入的只有这些）")
    act = active_view(doc)
    for e in act:
        print("  %s [%s] %s" % (e["id"], e["state"], e["text"]))
    print("\n共 %d 条在账，%d 条活跃；历史条目永远可回放。"
          % (len(doc["entries"]), len(act)))
    save(doc, "ledger.json")
    print("演示台账已写入 ledger.json")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or args[0] == "demo":
        demo()
    elif args[0] == "validate":
        d = load(args[1])
        errs, warns = validate_document(d)
        for x in errs:
            print("ERROR: %s" % x)
        for x in warns:
            print("WARN: %s" % x)
        print("校验完成：errors=%d warnings=%d" % (len(errs), len(warns)))
        sys.exit(1 if errs else 0)
    else:
        print(__doc__)
