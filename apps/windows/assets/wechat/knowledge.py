# -*- coding: utf-8 -*-
"""本地知识库：给 Agent 与控制台共用的白盒条目。

存 `~/.lumii/wechat-kb/kb.json`（可用 `LUMII_WECHAT_KB` 覆盖）。条目规模是几百到几千，
检索用**子串匹配**而不是 SQLite FTS5：中文默认分词对用户输入不友好，而这点数据线性扫足够。
`ponytail:` 线性扫全量条目；上万条再换索引。

条目不是原始聊天记录，而是**从蒸馏/对话里提炼出的可复用知识**：
话术、业务事实、联系人偏好、禁忌、群规则等。原始正文仍只在微信库里。
"""
import json
import os
import re
import time
import uuid

import localstore

KINDS = ("style", "fact", "faq", "rule", "contact", "other")
_SCOPES = ("global", "self")

# 预置的常见场景知识：用户第一次打开知识库时一键载入，理解「知识库是 AI 回复时要参考的文件」。
# 每条的 content 都是结构化的：先给「使用场景」，再给「规则要点」，最后给「示例/禁忌」。
PRESETS = [
    {
        "title": "回复口吻",
        "kind": "style", "scope": "global",
        "content": "【用途】所有代聊回复默认按此口吻输出。\n\n"
                   "【要点】\n"
                   "- 简短自然，像平时微信聊天，不端着、不官方腔；\n"
                   "- 一句话能说清不用两句，不堆形容词、不喊口号；\n"
                   "- 收尾用「好」「行」这类轻语气词，不用「收到」「感谢您的信任」；\n"
                   "- 需要拒绝时先给理由再给替代方案。\n\n"
                   "【反例】「尊敬的客户，感谢您的咨询，我们将竭诚为您服务。」\n"
                   "【正例】「这个我可以，明早给你报价单。」",
    },
    {
        "title": "标准报价口径",
        "kind": "fact", "scope": "global",
        "content": "【用途】客户问到价格时按此口径回复。改成本人真实价格后再启用。\n\n"
                   "【要点】\n"
                   "- 基础服务 500 元/月起，含一次现场评估；\n"
                   "- 加急 3 天内交付，加收 30%；\n"
                   "- 报价前先确认需求范围，口头不拍板；\n"
                   "- 报完跟一句「我先按这个范围写个清单，你确认后再下订」。\n\n"
                   "【禁忌】不问范围就报一口价；承诺固定工期（实际取决于排期）。",
    },
    {
        "title": "发货与退换货",
        "kind": "faq", "scope": "global",
        "content": "【用途】被问到物流 / 退换货时按此答复。\n\n"
                   "【要点】\n"
                   "- 发货：48 小时内发出（预售除外）；\n"
                   "- 退换货：7 天无理由，运费自付；\n"
                   "- 保修：1 年，人为损坏不在保修内；\n"
                   "- 不确定的规则，回「我确认一下再回你」，不猜。\n\n"
                   "【禁忌】把预售款当现货报；承诺「肯定能退」之前没看是否拆封。",
    },
    {
        "title": "禁忌话题",
        "kind": "rule", "scope": "global",
        "content": "【用途】代聊全程遵守的底线，任何回复都不得越界。\n\n"
                   "【要点】\n"
                   "- 不聊政治、不聊他人隐私、不评价同行；\n"
                   "- 不承诺做不到的事；价格以书面报价为准，不口头拍板；\n"
                   "- 客户情绪激动时先接住再谈事：「理解，咱们一件一件来」；\n"
                   "- 被问及公司机密 / 客户隐私，礼貌回绝：「这个不方便说」。\n\n"
                   "【重点】宁可少说也不编造；没有依据的事实一律不确认。",
    },
    {
        "title": "客户跟进节奏",
        "kind": "contact", "scope": "self",
        "content": "【用途】提醒自己（和 AI）在什么时候跟进、什么时候别催。\n\n"
                   "【要点】\n"
                   "- 报价后 3 天没回，主动问一次；\n"
                   "- 对方说「再看看」就放一放，不再催；\n"
                   "- 重要客户记生日和常聊话题，重提旧事拉近距离；\n"
                   "- 已成交客户每周回访一次，问使用情况。\n\n"
                   "【禁忌】连续两天追问同一件事；对方已明确拒绝后仍反复跟进。",
    },
    {
        "title": "预约与改期",
        "kind": "fact", "scope": "global",
        "content": "【用途】客户要预约 / 改时间时按此处理。\n\n"
                   "【要点】\n"
                   "- 预约需至少提前 1 天，晚 8 点后不再接次日早场；\n"
                   "- 改期需提前 4 小时通知，否则视为爽约；\n"
                   "- 爽约 2 次进灰名单，不再接受线上预约；\n"
                   "- 确认时间后把「日期 + 时段 + 事项」复述一遍再结束。\n\n"
                   "【禁忌】口头答应后忘记同步日程；临时加塞挤掉已有安排。",
    },
    {
        "title": "收款与开票",
        "kind": "rule", "scope": "global",
        "content": "【用途】涉及钱和发票的回复，比普通话术更谨慎。\n\n"
                   "【要点】\n"
                   "- 收款前先发价格 + 服务范围清单，客户确认后再收；\n"
                   "- 收款码 / 账号只发官方渠道，不转发陌生人给过来的二维码；\n"
                   "- 开票：确认抬头后 3 个工作日内开出，电子票为主；\n"
                   "- 到账确认以银行 / 平台通知为准，不凭客户口头「已转」。\n\n"
                   "【禁忌】先收款后补清单；代收第三方款项；口头承诺发票类型。",
    },
]


def kb_dir():
    d = os.environ.get("LUMII_WECHAT_KB") or os.path.join(
        os.path.expanduser("~"), ".lumii", "wechat-kb")
    os.makedirs(d, exist_ok=True)
    return d


def kb_path():
    return os.path.join(kb_dir(), "kb.json")


def _err(code, detail, suggestion="", stage="knowledge"):
    return {"ok": False, "error_code": code, "detail": detail,
            "stage": stage, "suggestion": suggestion}


def _read():
    data = localstore.read_json(kb_path(), {"version": 1, "entries": []}) or {}
    entries = data.get("entries")
    return entries if isinstance(entries, list) else []


def _write(entries):
    localstore.write_json(kb_path(), {"version": 1, "entries": entries})


def _norm_scope(scope):
    s = str(scope or "").strip()
    return s or "global"


def _norm_tags(tags):
    if isinstance(tags, str):
        tags = re.split(r"[,，;；\s]+", tags)
    if not isinstance(tags, (list, tuple)):
        return []
    out, seen = [], set()
    for t in tags:
        t = str(t or "").strip()
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _summary(e, include_content=True):
    """返回条目摘要。`include_content=False` 时只返回元数据，用于目录列表。"""
    base = {k: e.get(k) for k in ("id", "scope", "kind", "title", "tags", "source",
                                   "enabled", "created", "updated")}
    return base | {"content": e.get("content", "")} if include_content else base


def _match_scope(entry_scope, scope=""):
    """`scope=""` 不过滤；`global`/`self` 精确匹配；其余按会话名/账号精确匹配。"""
    s = str(scope or "").strip()
    if not s:
        return True
    if s in _SCOPES:
        return entry_scope == s
    return entry_scope == s


def kb_search(query="", scope="", talker="", include_disabled=False, limit=50, include_content=False):
    """列出/检索条目。`talker` 会同时命中 global、self 和该会话的条目。
    `include_content=False` 时只返回元数据（用于目录），`True` 时返回完整条目（用于检索）。"""
    q = str(query or "").strip().lower()
    talker = str(talker or "").strip()
    rows = []
    for e in _read():
        if not include_disabled and not e.get("enabled", True):
            continue
        es = e.get("scope") or "global"
        if scope and not _match_scope(es, scope):
            continue
        if talker and es not in ("global", "self", talker):
            continue
        if q:
            blob = " ".join([str(e.get("title") or ""), str(e.get("content") or ""),
                             " ".join(e.get("tags") or [])]).lower()
            if q not in blob:
                continue
        rows.append(e)
    rows.sort(key=lambda x: (-int(x.get("updated") or 0), str(x.get("title") or "")))
    total = len(rows)
    limit = int(limit or 0)
    if limit > 0:
        rows = rows[:limit]
    return {"count": len(rows), "total": total, "entries": [_summary(e, include_content) for e in rows],
            "path": kb_path()}


def kb_get(entry_id):
    eid = str(entry_id or "").strip()
    if not eid:
        return _err("bad_args", "缺少 id", "先 kb_search 拿到条目 id")
    for e in _read():
        if e.get("id") == eid:
            return {"entry": e, "path": kb_path()}
    return _err("not_found", f"知识库条目不存在：{eid}", "先 kb_search 确认 id")


def kb_save(entry):
    """新增或更新；`id` 为空则新建。整条覆盖，不做字段级 patch。"""
    if not isinstance(entry, dict):
        return _err("bad_args", "entry 必须是对象")
    title = str(entry.get("title") or "").strip()
    content = str(entry.get("content") or "").strip()
    if not title and not content:
        return _err("bad_args", "标题和内容至少填一个", "写一条能复用的知识")
    scope = _norm_scope(entry.get("scope"))
    kind = str(entry.get("kind") or "fact").strip()
    if kind not in KINDS:
        return _err("bad_args", f"kind 必须是 {', '.join(KINDS)} 之一")
    now = int(time.time())
    with localstore.FileLock(kb_path()):
        entries = _read()
        eid = str(entry.get("id") or "").strip()
        old = next((e for e in entries if e.get("id") == eid), None) if eid else None
        if eid and not old:
            return _err("not_found", f"要更新的条目不存在：{eid}", "留空 id 可以新建")
        item = {
            "id": eid or ("kb_" + uuid.uuid4().hex[:10]),
            "scope": scope,
            "kind": kind,
            "title": title or content[:24],
            "content": content,
            "tags": _norm_tags(entry.get("tags")),
            "source": str(entry.get("source") or "manual"),
            "enabled": bool(entry.get("enabled", True)),
            "created": int(old.get("created") or now) if old else now,
            "updated": now,
        }
        if old:
            entries[entries.index(old)] = item
        else:
            entries.append(item)
        _write(entries)
    return {"entry": item, "path": kb_path()}


def kb_delete(entry_id=None, everything=False):
    """删一条；清空必须显式 `everything=True`（防误清）。"""
    eid = str(entry_id or "").strip()
    with localstore.FileLock(kb_path()):
        entries = _read()
        if eid:
            left = [e for e in entries if e.get("id") != eid]
            if len(left) == len(entries):
                return _err("not_found", f"知识库条目不存在：{eid}", "刷新后再试")
            _write(left)
            return {"removed": [eid], "remaining": len(left), "path": kb_path()}
        if not everything:
            return _err("bad_args", "需给 id 删单条，或显式 everything=true 清空全部",
                        "这是防误清，不是参数写错")
        _write([])
        return {"removed": len(entries), "remaining": 0, "path": kb_path()}


def kb_context(talker="", query="", limit=8):
    """给模型/Agent 取一组最相关的启用条目（global + self + 当前会话）。"""
    scopes = {"global", "self"}
    tk = str(talker or "").strip()
    if tk:
        scopes.add(tk)
    q = str(query or "").strip().lower()
    rows = []
    for e in _read():
        if not e.get("enabled", True) or (e.get("scope") or "global") not in scopes:
            continue
        if q:
            blob = " ".join([str(e.get("title") or ""), str(e.get("content") or ""),
                             " ".join(e.get("tags") or [])]).lower()
            if q not in blob:
                continue
        rows.append(e)
    rows.sort(key=lambda x: (-int(x.get("updated") or 0), str(x.get("title") or "")))
    return rows[:int(limit or 8)]


def kb_presets_load(confirm=False):
    """把预置场景条目写入知识库（已有的同标题不重复写入）。"""
    if not confirm:
        return _err("bad_args", "载入预置知识须显式 confirm=true", "这是写操作")
    with localstore.FileLock(kb_path()):
        entries = _read()
        have = {e.get("title") for e in entries}
        added = 0
        for preset in PRESETS:
            if preset["title"] in have:
                continue
            now = int(time.time())
            entries.append({
                "id": "kb_" + uuid.uuid4().hex[:10],
                "scope": preset["scope"], "kind": preset["kind"],
                "title": preset["title"], "content": preset["content"],
                "tags": [], "source": "preset",
                "enabled": True, "created": now, "updated": now,
            })
            added += 1
        if added:
            _write(entries)
    return {"added": added, "path": kb_path()}


def kb_import_file(path, scope="", confirm=False):
    """从 JSON 文件导入知识库条目（保留原文）。"""
    if not confirm:
        return _err("bad_args", "导入须显式 confirm=true", "这是写操作")
    p = str(path or "").strip()
    if not os.path.isfile(p):
        return _err("not_found", f"文件不存在：{p}", "先导出或放一份 JSON 过来")
    try:
        data = json.load(open(p, encoding="utf-8"))
    except Exception as exc:
        return _err("bad_file", f"文件不是合法 JSON：{type(exc).__name__}: {exc}")
    rows = data.get("entries") if isinstance(data, dict) else data
    if not isinstance(rows, list):
        return _err("bad_file", "JSON 里没有 entries 数组", "结构：{\"entries\": [...]}")
    with localstore.FileLock(kb_path()):
        entries = _read()
        added = 0
        for item in rows:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or "").strip()
            content = str(item.get("content") or "").strip()
            if not title and not content:
                continue
            es = str(item.get("scope") or scope or "global").strip()
            kind = str(item.get("kind") or "fact").strip()
            if kind not in KINDS:
                kind = "fact"
            now = int(time.time())
            entries.append({
                "id": "kb_" + uuid.uuid4().hex[:10],
                "scope": es, "kind": kind,
                "title": title, "content": content,
                "tags": _norm_tags(item.get("tags")),
                "source": str(item.get("source") or "import"),
                "enabled": item.get("enabled", True) is not False,
                "created": now, "updated": now,
            })
            added += 1
        if added:
            _write(entries)
    return {"imported": added, "path": kb_path()}


def kb_export_file(path="", scopes=()):
    """导出知识库全部（或指定 scope）条目到 JSON 文件；没给 path 就写到知识库目录。"""
    entries = _read()
    if scopes:
        want = {str(s).strip() for s in scopes if str(s).strip()}
        entries = [e for e in entries if (e.get("scope") or "global") in want]
    out_path = str(path or "").strip() or os.path.join(
        kb_dir(), "kb-export-%s.json" % time.strftime("%Y%m%d-%H%M%S"))
    try:
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        tmp = out_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "entries": entries}, f,
                      ensure_ascii=False, indent=2)
        os.replace(tmp, out_path)
    except OSError as exc:
        return _err("export_failed", f"{type(exc).__name__}: {exc}",
                    "换一个有写权限的路径")
    return {"path": out_path, "count": len(entries)}
