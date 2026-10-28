# -*- coding: utf-8 -*-
"""自动回复控制面：规则、草稿审查队列、审计与统计。

**这里不产生 AI 回复，也不发消息**——回复由接入的 Agent 或控制台内置模型起草，
发送仍走 `send_text`。本模块只负责四件事：
1. `rules_*`：用户允许 AI 在什么范围内行动（模式/私聊群聊/黑白名单/静默时段/频率）；
2. `check()`：Agent 起草或发送前必须问一次，拿 `send_allowed`；
3. `draft_*`：草稿入队、人工改/批/拒，审计留痕；
4. `stats()`：给控制台出统计。

存储：`~/.lumii/wechat-autoreply/<wxid>/`（可用 `LUMII_WECHAT_AUTOREPLY` 覆盖根目录）。
每个微信号独立规则 / 草稿 / 审计；切换账号时读对应子目录。
"""
import os
import re
import shutil
import time
import uuid
from collections import Counter

import localstore

MODES = ("draft", "auto")          # draft=只出草稿；auto=允许自动发送
GROUP_MODES = ("off", "at_me", "all")
DRAFT_STATUS = ("pending", "approved", "rejected", "sent", "failed")

# v2 名单：每人一档，口径对齐 Lumii「渠道个人微信助手」的 channel-policy。
PEER_MODES = ("ignore", "notify", "draft", "auto")
PEER_TRIGGERS = ("all", "mention", "keyword", "mention_or_keyword")
NON_AGENT_MODES = ("ignore", "notify")     # 名单外的兜底只允许这两档
DEFAULT_COOLDOWN_S = 60
_HHMM = re.compile(r"^([01]?\d|2[0-3]):[0-5]\d$")

_ar_account = None  # 控制台 / 工具显式指定的账号；空则跟 wechat_core 当前账号


def set_account(account):
    """绑定自动回复存储到某个微信号；空串清除覆盖。"""
    global _ar_account
    _ar_account = (account or "").strip() or None


def current_account():
    """当前自动回复账号键。"""
    return _ar_account


def _safe_acct(s):
    return re.sub(r"[^0-9A-Za-z_@.\-]", "_", str(s or "").strip())[:80] or "_default"


def _resolve_account_key():
    """解析账号子目录名：显式 set_account > core 覆盖 > self_wxid > _default。"""
    if _ar_account:
        return _safe_acct(_ar_account)
    try:
        import wechat_core as _core
        o = _core.current_account_override()
        if o:
            return _safe_acct(o)
        me = _core.self_wxid()
        if me:
            return _safe_acct(me)
    except Exception:
        pass
    return "_default"


def ar_base_dir():
    """自动回复根目录（其下按 wxid 分子目录）。"""
    d = os.environ.get("LUMII_WECHAT_AUTOREPLY") or os.path.join(
        os.path.expanduser("~"), ".lumii", "wechat-autoreply")
    os.makedirs(d, exist_ok=True)
    return d


def _migrate_legacy(base, dest, key):
    """旧版扁平 rules.json → 账号子目录；只迁到当前登录号，其它账号从空白开始。"""
    legacy = os.path.join(base, "rules.json")
    if not os.path.isfile(legacy):
        return
    if os.path.isfile(os.path.join(dest, "rules.json")):
        return
    try:
        import wechat_core as _core
        me = _safe_acct(_core.self_wxid() or "")
        if me and me != "_default" and me != key:
            return
    except Exception:
        pass
    for name in ("rules.json", "drafts.json", "cooldowns.json", "audit.jsonl"):
        src = os.path.join(base, name)
        dst = os.path.join(dest, name)
        if os.path.isfile(src) and not os.path.isfile(dst):
            try:
                shutil.copy2(src, dst)
            except Exception:
                pass


def ar_dir():
    """当前账号的自动回复目录。"""
    base = ar_base_dir()
    key = _resolve_account_key()
    d = os.path.join(base, key)
    os.makedirs(d, exist_ok=True)
    _migrate_legacy(base, d, key)
    return d


def rules_path():
    return os.path.join(ar_dir(), "rules.json")


def drafts_path():
    return os.path.join(ar_dir(), "drafts.json")


def audit_path():
    return os.path.join(ar_dir(), "audit.jsonl")


def _err(code, detail, suggestion="", stage="autoreply"):
    return {"ok": False, "error_code": code, "detail": detail,
            "stage": stage, "suggestion": suggestion}


KB_TITLES_MAX = 10                 # 全局 / 名单行知识库标题上限


def _default_rules():
    return {
        "version": 1,              # 1=旧白/黑名单；2=每人一档名单（见 peers）
        "enabled": False,
        "mode": "draft",
        "private": True,
        "reply_self": False,       # 是否处理自己发的消息 / 自聊会话（本人 wxid、文件传输助手）
        "groups": "at_me",
        "whitelist": [],
        "blacklist": [],
        "default_mode": "ignore",  # v2：名单外的人 ignore=不处理 / notify=只提醒
        "peers": [],               # v2：{id,label,mode,trigger,keywords,kb_titles,cooldown_seconds}
        "quiet_hours": {"enabled": False, "start": "23:00", "end": "08:00"},
        "max_per_hour": 20,
        "max_per_day": 100,
        "kb_enabled": False,       # v3：回复时是否参考知识库（全局开关）
        "kb_titles": [],           # v3：全局最多 KB_TITLES_MAX 条；名单行可单独覆盖
        "updated": 0,
    }


def _is_self_talker(tk):
    """会话是否指向本人（自聊 / 文件传输助手）。"""
    lower = str(tk or "").strip().lower()
    if not lower:
        return False
    if lower == "filehelper":
        return True
    try:
        import wechat_core as _core
        me = str(_core.self_wxid() or "").strip().lower()
        if me and lower == me:
            return True
        if me:
            nm = str((_core.names() or {}).get(me) or "").strip().lower()
            if nm and lower == nm:
                return True
    except Exception:
        pass
    return False


def _norm_list(v):
    if isinstance(v, str):
        v = re.split(r"[\n,，;；]+", v)
    if not isinstance(v, (list, tuple)):
        return []
    out, seen = [], set()
    for x in v:
        s = str(x or "").strip()
        if s and s.lower() not in seen:
            seen.add(s.lower())
            out.append(s)
    return out


def _norm_peers(value):
    """校验并规范化 v2 名单；返回 (peers, err)。"""
    if not isinstance(value, (list, tuple)):
        return None, _err("bad_args", "peers 必须是数组")
    out, seen = [], set()
    for item in value:
        if not isinstance(item, dict):
            continue
        pid = str(item.get("id") or item.get("username") or item.get("target") or "").strip()
        if not pid:
            continue
        mode = str(item.get("mode") or "").strip()
        if mode not in PEER_MODES:
            return None, _err("bad_args", f"peers[{pid}] mode 必须是 {'/'.join(PEER_MODES)}")
        trigger = str(item.get("trigger") or "all").strip()
        if trigger not in PEER_TRIGGERS:
            return None, _err("bad_args",
                              f"peers[{pid}] trigger 必须是 {'/'.join(PEER_TRIGGERS)}")
        cd = item.get("cooldown_seconds")
        if cd in (None, ""):
            cd = None
        else:
            try:
                cd = max(0, int(cd))
            except (TypeError, ValueError):
                return None, _err("bad_args", f"peers[{pid}] cooldown_seconds 必须是整数")
        key = pid.lower()
        if key in seen:            # 同一个人只认第一条（与渠道策略一致）
            continue
        seen.add(key)
        out.append({
            "id": pid,
            "label": str(item.get("label") or "").strip(),
            "mode": mode,
            "trigger": trigger,
            "keywords": _norm_list(item.get("keywords")),
            "kb_titles": _norm_list(item.get("kb_titles"))[:KB_TITLES_MAX],
            "cooldown_seconds": cd,
        })
    return out, None


def _cooldown_path():
    return os.path.join(ar_dir(), "cooldowns.json")


def _cooldown_check(key, seconds):
    """距上次允许动作不足 `seconds` 秒 → 返回剩余秒数；否则 0。"""
    if not seconds:
        return 0
    data = localstore.read_json(_cooldown_path(), {}) or {}
    last = int((data or {}).get(key) or 0)
    left = seconds - (int(time.time()) - last)
    return max(0, left)


def _cooldown_touch(key):
    data = localstore.read_json(_cooldown_path(), {}) or {}
    if not isinstance(data, dict):
        data = {}
    data[key] = int(time.time())
    with localstore.FileLock(_cooldown_path()):
        localstore.write_json(_cooldown_path(), data)


def rules_get():
    data = localstore.read_json(rules_path(), None)
    out = _default_rules()
    if isinstance(data, dict):
        out.update({k: data[k] for k in out if k in data})
    return out


def rules_set(patch):
    if not isinstance(patch, dict):
        return _err("bad_args", "patch 必须是对象")
    cur = rules_get()
    unknown = set(patch) - set(cur) - {"action"}
    if unknown:
        return _err("bad_args", f"不认识的规则字段：{', '.join(sorted(unknown))}",
                    "按控制台表单的字段传")
    if "enabled" in patch:
        cur["enabled"] = bool(patch["enabled"])
    if "mode" in patch:
        if patch["mode"] not in MODES:
            return _err("bad_args", f"mode 必须是 {'/'.join(MODES)}")
        cur["mode"] = patch["mode"]
    if "private" in patch:
        cur["private"] = bool(patch["private"])
    if "reply_self" in patch:
        cur["reply_self"] = bool(patch["reply_self"])
    if "kb_enabled" in patch:
        cur["kb_enabled"] = bool(patch["kb_enabled"])
    if "kb_titles" in patch:
        cur["kb_titles"] = _norm_list(patch["kb_titles"])[:KB_TITLES_MAX]
    if "groups" in patch:
        if patch["groups"] not in GROUP_MODES:
            return _err("bad_args", f"groups 必须是 {'/'.join(GROUP_MODES)}")
        cur["groups"] = patch["groups"]
    if "whitelist" in patch:
        cur["whitelist"] = _norm_list(patch["whitelist"])
    if "blacklist" in patch:
        cur["blacklist"] = _norm_list(patch["blacklist"])
    if "peers" in patch:
        peers, err = _norm_peers(patch["peers"])
        if err:
            return err
        cur["peers"] = peers
    if "default_mode" in patch:
        dm = str(patch["default_mode"] or "").strip()
        if dm not in NON_AGENT_MODES:
            return _err("bad_args",
                        f"default_mode 只能是 {'/'.join(NON_AGENT_MODES)}",
                        "名单外的人只能设成「不处理」或「只提醒」")
        cur["default_mode"] = dm
    if "version" in patch:
        try:
            cur["version"] = 2 if int(patch["version"]) >= 2 else 1
        except (TypeError, ValueError):
            return _err("bad_args", "version 必须是 1 或 2")
    elif "peers" in patch or "default_mode" in patch:
        cur["version"] = 2          # 写了新名单就切到 v2
    elif "whitelist" in patch or "blacklist" in patch:
        cur["version"] = 1          # 老调用方写黑白名单，保持 v1 语义
    if "quiet_hours" in patch:
        q = patch["quiet_hours"]
        if not isinstance(q, dict):
            return _err("bad_args", "quiet_hours 必须是对象")
        start = str(q.get("start") or "23:00").strip()
        end = str(q.get("end") or "08:00").strip()
        if not _HHMM.match(start) or not _HHMM.match(end):
            return _err("bad_args", "静默时段要用 HH:MM（例如 23:00 / 08:00）")
        cur["quiet_hours"] = {"enabled": bool(q.get("enabled")), "start": start, "end": end}
    for k in ("max_per_hour", "max_per_day"):
        if k in patch:
            try:
                cur[k] = max(0, int(patch[k]))
            except (TypeError, ValueError):
                return _err("bad_args", f"{k} 必须是整数")
    cur["updated"] = int(time.time())
    with localstore.FileLock(rules_path()):
        localstore.write_json(rules_path(), cur)
    return {"rules": cur, "path": rules_path()}


def _minutes(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _in_quiet(q):
    if not q.get("enabled"):
        return False
    now = time.localtime()
    cur = now.tm_hour * 60 + now.tm_min
    start, end = _minutes(q["start"]), _minutes(q["end"])
    if start == end:
        return True
    if start < end:
        return start <= cur < end
    return cur >= start or cur < end


def _is_group(talker):
    return str(talker or "").endswith("@chatroom")


def _sent_since(since):
    return [d for d in _read_drafts()
            if d.get("status") == "sent" and int(d.get("sent_ts") or 0) >= since]


def _parse_whitelist_entry(entry):
    """解析白名单条目，支持 @mode:target 语法指定策略。
    返回 (target_lower, mode_override, groups_override)。

    示例：
      好友A           -> ("好友a", None, None)  # 使用全局策略
      @auto:好友B     -> ("好友b", "auto", None)  # 这个好友允许自动发送
      @draft:群X      -> ("群x", "draft", None)  # 这个群只出草稿
      @all:群Y        -> ("群y", None, "all")  # 这个群全部回复（不限@我）
      @auto,all:群Z   -> ("群z", "auto", "all")  # 自动发送且全部回复
    """
    s = str(entry or "").strip()
    if not s.startswith("@"):
        return (s.lower(), None, None)

    # 分离前缀和目标
    if ":" not in s:
        return (s.lower(), None, None)

    prefix, target = s.split(":", 1)
    prefix = prefix[1:].lower()  # 去掉 @
    target = target.strip()

    mode_override = None
    groups_override = None

    # 解析逗号分隔的策略
    for part in prefix.split(","):
        part = part.strip()
        if part in MODES:
            mode_override = part
        elif part in GROUP_MODES:
            groups_override = part

    return (target.lower(), mode_override, groups_override)


def _match_peer(peers, cands):
    """按 id / 备注名找名单条目；先出现的生效。"""
    for p in peers or []:
        keys = {str(p.get("id") or "").lower(), str(p.get("label") or "").lower()}
        if keys & cands:
            return p
    return None


def _trigger_reason(peer, group, at_me, text):
    """返回空串=通过；否则给 check 的 reason。私聊的 mention 等同于不过滤。"""
    tr = str(peer.get("trigger") or "all")
    if tr == "all":
        return ""
    if tr == "mention":
        return "" if (not group or at_me) else "not_at_me"
    keywords = [str(k).lower() for k in (peer.get("keywords") or []) if str(k).strip()]
    hit = bool(keywords) and any(k in str(text or "").lower() for k in keywords)
    if tr == "keyword":
        return "" if hit else "keyword_miss"
    # mention_or_keyword
    return "" if (not group or at_me or hit) else "not_at_me"


def check(talker, is_group=None, at_me=False, text=""):
    """Agent 起草/发送前的闸门。`send_allowed=false` 不代表不能出草稿。

    v2（`version>=2`）：名单每人一档 ignore/notify/draft/auto，可配触发条件
    （all/mention/keyword/mention_or_keyword）与冷却；名单外按 `default_mode`。
    v1（旧规则）：白名单支持 `@mode:target` / `@groups:target` 覆盖全局。"""
    tk = str(talker or "").strip()
    if not tk:
        return _err("bad_args", "talker 必填")
    rules = rules_get()
    group = _is_group(tk) if is_group is None else bool(is_group)
    lower = tk.lower()
    out = {"talker": tk, "is_group": group, "mode": rules["mode"],
           "allowed": False, "send_allowed": False, "reason": "", "rules": rules}
    if not rules["enabled"]:
        out["reason"] = "disabled"
        return out

    # 自聊 / 本人微信号：默认跳过，勾选 reply_self 才处理
    if _is_self_talker(tk) and not rules.get("reply_self"):
        out["reason"] = "self_skip"
        return out

    # 名单里既可以填 wxid/群号，也可以填界面上看到的显示名。
    # 群尤其需要：`talker` 是 `xxx@chatroom`，用户根本复制不到，几乎只会填群名。
    cands = {lower}
    try:
        import wechat_core as _core
        nm = _core.names().get(tk)
        if nm:
            cands.add(str(nm).lower())
    except Exception:
        pass

    v2 = int(rules.get("version") or 1) >= 2
    peer = None
    if v2:
        peer = _match_peer(rules.get("peers") or [], cands)
        if peer is None:
            if rules.get("default_mode") == "notify":
                out["reason"] = "notify_only"
            else:
                out["reason"] = "not_whitelisted"
            return out
        if peer["mode"] == "ignore":
            out["reason"] = "blacklisted"
            return out
        if peer["mode"] == "notify":
            out["reason"] = "notify_only"
            return out
        reason = _trigger_reason(peer, group, at_me, text)
        if reason:
            out["reason"] = reason
            return out
        effective_mode = peer["mode"]
        out["peer"] = {k: peer.get(k) for k in
                       ("id", "label", "mode", "trigger", "keywords", "kb_titles", "cooldown_seconds")}
        out["mode"] = effective_mode
    else:
        # 检查黑名单
        black = {x.lower() for x in rules["blacklist"]}
        if cands & black:
            out["reason"] = "blacklisted"
            return out

        # 解析白名单，提取针对此对象的策略覆盖
        parsed_white = [_parse_whitelist_entry(x) for x in rules["whitelist"]]
        white_targets = {target for target, _, _ in parsed_white}

        # 查找匹配的白名单条目
        mode_override = None
        groups_override = None
        for target, m_ovr, g_ovr in parsed_white:
            if target in cands:
                mode_override = m_ovr
                groups_override = g_ovr
                break

        # 白名单检查
        if white_targets and not (cands & white_targets):
            out["reason"] = "not_whitelisted"
            return out

        # 应用策略覆盖
        effective_mode = mode_override if mode_override else rules["mode"]
        effective_groups = groups_override if groups_override else rules["groups"]
        out["mode"] = effective_mode

        # 群聊/私聊检查（v2 的触发条件在上面已判过）
        if group:
            if effective_groups == "off":
                out["reason"] = "group_off"
                return out
            if effective_groups == "at_me" and not at_me:
                out["reason"] = "not_at_me"
                return out
        elif not rules["private"]:
            out["reason"] = "private_off"
            return out

    if v2 and not group and not rules["private"]:
        out["reason"] = "private_off"
        return out

    out["allowed"] = True

    # 静默时段检查
    if _in_quiet(rules["quiet_hours"]):
        out["reason"] = "quiet_hours"
        return out

    # 频率限制检查
    now = time.time()
    hour_n, day_n = len(_sent_since(now - 3600)), len(_sent_since(now - 86400))
    out["limits"] = {"hour_used": hour_n, "hour_max": rules["max_per_hour"],
                     "day_used": day_n, "day_max": rules["max_per_day"]}
    if rules["max_per_hour"] and hour_n >= rules["max_per_hour"]:
        out["reason"] = "hour_limit"
        return out
    if rules["max_per_day"] and day_n >= rules["max_per_day"]:
        out["reason"] = "day_limit"
        return out

    # v2：同一对象两次自动动作的最小间隔（缺省 60 秒，与渠道助手一致）
    if v2:
        cd = peer.get("cooldown_seconds")
        cd = DEFAULT_COOLDOWN_S if cd is None else int(cd)
        out["cooldown_seconds"] = cd
        key = str(peer.get("id") or "").lower()
        left = _cooldown_check(key, cd)
        if left:
            out["reason"] = "cooldown"
            out["retry_after"] = left
            return out
        _cooldown_touch(key)

    # 最终发送许可（根据有效模式）
    if effective_mode != "auto":
        out["reason"] = "draft_only"
        return out

    out["send_allowed"] = True
    out["reason"] = "ok"
    return out


def _read_drafts():
    data = localstore.read_json(drafts_path(), {"version": 1, "drafts": []}) or {}
    rows = data.get("drafts")
    return rows if isinstance(rows, list) else []


def _write_drafts(rows):
    localstore.write_json(drafts_path(), {"version": 1, "drafts": rows})


def _audit(kind, **fields):
    row = {"ts": int(time.time()), "kind": kind}
    row.update({k: v for k, v in fields.items() if v is not None})
    localstore.append_jsonl(audit_path(), row)
    return row


def draft_add(talker, draft, source_text="", account="", source_ts=0,
              model="", status="pending", error="", kind="reply", note=""):
    """入队一条待审草稿。

    kind=reply  —— AI/人工已起草，等人审查后发送；
    kind=unsure —— AI 不确定怎么回，或用户主动登记，等人参考历史后手写。
    """
    tk = str(talker or "").strip()
    text = str(draft or "").strip()
    kind = str(kind or "reply").strip() or "reply"
    if kind not in ("reply", "unsure"):
        return _err("bad_args", "kind 只能是 reply / unsure")
    if not tk:
        return _err("bad_args", "talker 必填")
    if kind == "reply" and not text:
        return _err("bad_args", "draft 不能为空", "先起草再入队")
    if kind == "unsure" and not text:
        text = "（待手写：请参考下方历史后填写回复）"
    if status not in ("pending", "sent", "failed"):
        return _err("bad_args", "add 的 status 只能是 pending/sent/failed",
                    "人工审查状态用 action=review 更新")
    now = int(time.time())
    row = {
        "id": "dr_" + uuid.uuid4().hex[:10],
        "talker": tk, "account": str(account or ""),
        "source_text": str(source_text or ""), "source_ts": int(source_ts or 0),
        "draft": text, "model": str(model or ""),
        "kind": kind, "note": str(note or "").strip(),
        "status": status, "created": now, "updated": now,
        "reviewed": 0, "sent_ts": now if status == "sent" else 0,
        "error": str(error or ""),
    }
    with localstore.FileLock(drafts_path()):
        rows = _read_drafts()
        rows.append(row)
        _write_drafts(rows)
    _audit("draft_" + status, id=row["id"], talker=tk, status=status, model=row["model"])
    return {"draft": row, "path": drafts_path()}


def draft_list(status="", limit=100):
    rows = _read_drafts()
    if status:
        if status not in DRAFT_STATUS:
            return _err("bad_args", f"status 必须是 {'/'.join(DRAFT_STATUS)} 之一")
        rows = [d for d in rows if d.get("status") == status]
    rows.sort(key=lambda d: (-int(d.get("created") or 0), d.get("id") or ""))
    total = len(rows)
    limit = int(limit or 0)
    if limit > 0:
        rows = rows[:limit]
    return {"count": len(rows), "total": total, "drafts": rows, "path": drafts_path()}


def draft_get(draft_id):
    did = str(draft_id or "").strip()
    for d in _read_drafts():
        if d.get("id") == did:
            return {"draft": d, "path": drafts_path()}
    return _err("not_found", f"草稿不存在：{did}")


def draft_review(draft_id, status, text=None, error=""):
    did = str(draft_id or "").strip()
    if status not in ("pending", "approved", "rejected", "sent", "failed"):
        return _err("bad_args", "review 的 status 只能是 pending/approved/rejected/sent/failed")
    with localstore.FileLock(drafts_path()):
        rows = _read_drafts()
        row = next((d for d in rows if d.get("id") == did), None)
        if not row:
            return _err("not_found", f"草稿不存在：{did}")
        if text is not None and str(text).strip():
            row["draft"] = str(text).strip()
        now = int(time.time())
        row["status"] = status
        row["updated"] = now
        row["reviewed"] = now
        if status == "sent":
            row["sent_ts"] = now
        if error:
            row["error"] = str(error)
        _write_drafts(rows)
    _audit("draft_" + status, id=did, talker=row.get("talker"),
           status=status, error=row.get("error") or None)
    return {"draft": row, "path": drafts_path()}


def draft_clear(confirm=False):
    if not confirm:
        return _err("bad_args", "清空草稿与审计须显式 confirm=true", "这是不可恢复操作")
    with localstore.FileLock(drafts_path()):
        n = len(_read_drafts())
        _write_drafts([])
    try:
        with localstore.FileLock(audit_path()):
            open(audit_path(), "w", encoding="utf-8").close()
    except OSError:
        pass
    return {"removed": n, "path": ar_dir()}


def audit_list(limit=100):
    rows = localstore.read_jsonl(audit_path(), limit=int(limit or 100))
    rows.reverse()
    return {"count": len(rows), "events": rows, "path": audit_path()}


def _today_start():
    t = time.localtime()
    return int(time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1)))


def stats(days=7):
    days = max(1, min(365, int(days or 7)))
    now = int(time.time())
    since = now - days * 86400
    rows = [d for d in _read_drafts() if int(d.get("created") or 0) >= since]
    by_status = Counter(d.get("status") or "unknown" for d in rows)
    sent = [d for d in rows if d.get("status") == "sent"]
    today0 = _today_start()
    by_day = Counter(time.strftime("%Y-%m-%d", time.localtime(int(d.get("sent_ts") or 0)))
                     for d in sent if int(d.get("sent_ts") or 0) >= since)
    by_talker = Counter(d.get("talker") or "" for d in sent).most_common(10)
    failures = Counter((d.get("error") or "未记录原因") for d in rows
                       if d.get("status") == "failed")
    return {
        "days": days, "since": since,
        "total": len(rows),
        "by_status": dict(by_status),
        "pending": by_status.get("pending", 0),
        "sent": len(sent),
        "sent_today": sum(1 for d in sent if int(d.get("sent_ts") or 0) >= today0),
        "sent_by_day": dict(sorted(by_day.items())),
        "sent_by_talker": [{"talker": k, "count": v} for k, v in by_talker],
        "failures": dict(failures),
        "audit": audit_list(20)["events"],
        "rules": rules_get(),
        "path": ar_dir(),
    }
