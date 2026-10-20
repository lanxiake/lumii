# -*- coding: utf-8 -*-
"""plus 档的 hook 发送后端（可选）。

**只做发送**：读消息仍走 `wechat_core` 的 SQLCipher 直读。hook 的收益是不抢前台、
毫秒级、可同时服务多个微信实例；代价是需要往微信进程里注入 DLL，版本升级后要重适配。

接口约定（与 aixed/WeChat-Hook 对齐，任意 hook 实现都可接）：

    POST /SendTextMsg      {"wxidorgid": <talker>, "msg": <text>}      -> {"ret": 0}
    POST /SendImgMsg       {"wxidorgid": <talker>, "path": <path>}     -> {"ret": 0}
    POST /SendFileMsg      {"wxidorgid": <talker>, "path": <path>}     -> {"ret": 0}   # 扩展
    POST /GetSelfProfile   {}                                          -> {"wxid": ...}
    POST /GetContactList   {}   -> {"ret": 0, "contacts": [{"wxid": ..., "name": ...}]}  # 扩展

`/GetContactList` 是**多账号自动匹配的前提**：hook 侧不实现时，只有单实例能用。
匹配不到时本模块**报错，绝不广播**——广播会把同一条消息发给多个账号。

端点来源（按优先级）：
1. 环境变量 `WECHAT_HOOK_ENDPOINTS`（逗号分隔）
2. `~/.lumii/wechat-mcp/hook.json`：`{"endpoints": ["http://127.0.0.1:30001", ...]}`
3. 扫描 `127.0.0.1:30001..30010`（aixed 的默认端口；多开时自行加端口）

**回退边界**：只有「没有任何端点响应」才返回 None 让调用方走 UIA。
一旦把请求发出去，超时/无响应一律按 `send_not_confirmed` 返回——可能已经发出去了，
再回退 UIA 就是给好友发第二遍。
"""
import hashlib
import json
import os
import random
import socket
import time
import urllib.error
import urllib.request

CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".lumii", "wechat-mcp", "hook.json")
SCAN_PORTS = range(30001, 30011)
PROBE_TIMEOUT = 0.4       # 扫描/健康检查：只探活，不发送
SEND_TIMEOUT = 35         # 单次发送：必须长于 hook 侧 30s 的 CGI 完成等待，
                          # 否则慢网络会把「已发出」误判成 send_not_confirmed
_CACHE_TTL = 60.0

# 防封号节流（按账号）。这些门限挡的是「最像营销号」的行为，不是反检测：
# 注入本身可被检测，真正能自保的是账号与操作习惯（见 README）。
MIN_INTERVAL = float(os.environ.get("WECHAT_HOOK_MIN_INTERVAL", "3.0"))
MINUTE_LIMIT = int(os.environ.get("WECHAT_HOOK_MINUTE_LIMIT", "20"))
DAILY_LIMIT = int(os.environ.get("WECHAT_HOOK_DAILY_LIMIT", "200"))
SIMILAR_WINDOW = 600.0    # 同一段话 10 分钟内发给多少个不同的人
SIMILAR_TARGETS = int(os.environ.get("WECHAT_HOOK_SIMILAR_TARGETS", "8"))

_cache = {"at": 0.0, "endpoints": []}
_state = {}


def _post(base, path, payload, timeout):
    """POST JSON。返回解析后的对象；连接失败返回 None；HTTP 错误抛异常。"""
    url = base.rstrip("/") + path
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return json.loads(raw.decode("utf-8")) if raw else {}


def _base_urls():
    raw = (os.environ.get("WECHAT_HOOK_ENDPOINTS") or "").strip()
    if raw:
        return [u.strip().rstrip("/") for u in raw.split(",") if u.strip()]
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            conf = json.load(f)
        rows = conf.get("endpoints") or []
        urls = []
        for row in rows:
            url = row.get("url") if isinstance(row, dict) else row
            if url:
                urls.append(str(url).strip().rstrip("/"))
        if urls:
            return urls
    except (OSError, ValueError):
        pass
    return [f"http://127.0.0.1:{p}" for p in SCAN_PORTS]


def _probe(base):
    """探测一个端点；不是 hook 服务/未登录都返回 None。"""
    try:
        me = _post(base, "/GetSelfProfile", {}, PROBE_TIMEOUT)
    except (urllib.error.URLError, socket.timeout, OSError, ValueError):
        return None
    if not isinstance(me, dict) or not (me.get("wxid") or me.get("nickname")):
        return None
    return {"url": base, "wxid": me.get("wxid") or "", "nickname": me.get("nickname") or ""}


def endpoints(refresh=False):
    """当前可用的 hook 端点（带 60s 缓存）。"""
    import time
    now = time.time()
    if not refresh and _cache["endpoints"] and now - _cache["at"] < _CACHE_TTL:
        return _cache["endpoints"]
    rows = []
    for base in _base_urls():
        ep = _probe(base)
        if ep:
            rows.append(ep)
    _cache.update(at=now, endpoints=rows)
    return rows


def _running_accounts():
    """本机正在运行的微信账号集合（用于「单端点 + 多实例」的安全闸门）。

    枚举失败返回空集合：此时**不知道**有没有别的实例，保持原有行为（不阻断单实例）。
    拿得到却有多号时绝不能猜——省略 `account` 就会从错误账号发出。
    """
    try:
        import wxinstances
        return {r["wxid"] for r in wxinstances.instances() if r.get("wxid")}
    except Exception:
        return set()


def _contacts(ep):
    """取某个实例的联系人 wxid 集合；不支持该扩展接口时返回 None。"""
    try:
        r = _post(ep["url"], "/GetContactList", {}, PROBE_TIMEOUT * 5)
    except Exception:
        return None
    if not isinstance(r, dict):
        return None
    rows = r.get("contacts") or r.get("data") or []
    if not isinstance(rows, list):
        return None
    out = set()
    for row in rows:
        if isinstance(row, dict):
            v = row.get("wxid") or row.get("userName") or row.get("username")
            if v:
                out.add(str(v))
    return out


def _match(talker, account=None):
    """按 talker（可选再加 account）找目标实例。返回 (ep, None) 或 (None, 失败详情)。"""
    eps = endpoints()
    if not eps:
        return None, "没有可用的 hook 端点"
    if account:
        hit = [ep for ep in eps if ep.get("wxid") == account]
        if len(hit) == 1:
            return hit[0], None
        # 单个端点且拿不到 wxid（hook 未实现 /GetSelfProfile 的完整字段）：只能信它
        if not hit and len(eps) == 1 and not eps[0].get("wxid"):
            return eps[0], None
        names = "、".join(e.get("wxid") or e.get("nickname") or e["url"] for e in eps)
        return None, f"没有找到账号 {account} 的 hook 端点（已发现：{names}）"
    if len(eps) == 1:
        if not account:
            # 单端点 ≠ 单实例：本机可能还开着另一个（没注入 hook 的）微信。
            # 那种情况下省略 account 会**默认从这个唯一端点发出**——读的是 A、发的是 B。
            ep_wxid = eps[0].get("wxid")
            live = _running_accounts()
            if ep_wxid:
                others = live - {ep_wxid}
            else:
                # 老 hook 不报 wxid：只有能确认"本机就一个号"时才敢用
                others = live if len(live) > 1 else set()
            if others:
                return None, (
                    "本机有多个微信实例在运行，但只发现一个 hook 端点"
                    f"（{ep_wxid or eps[0]['url']}）；省略 account 可能从错误账号发出。"
                    f"请显式传 account（运行中：{'、'.join(sorted(live))}）")
        return eps[0], None
    hit = []
    unknown = []
    for ep in eps:
        c = _contacts(ep)
        if c is None:
            unknown.append(ep)
        elif talker in c:
            hit.append(ep)
    if len(hit) == 1:
        return hit[0], None
    if not hit and unknown:
        return None, ("同时有多个微信实例，但 hook 端点不支持 /GetContactList，"
                      "无法按 talker 自动匹配（请让 hook 侧实现该扩展接口，"
                      "或只保留一个实例）")
    if len(hit) > 1:
        names = "、".join(e.get("nickname") or e.get("wxid") or e["url"] for e in hit)
        return None, f"talker 同时属于多个账号（{names}），无法自动选择"
    return None, f"所有 hook 实例里都没有这个会话（{len(eps)} 个实例）"


def _risk_guard(account, talker, text):
    """按账号限速 + 拦截短时间同内容群发。返回 None 表示放行，否则返回失败 dict。

    注：注入本身就可能被检测；这里只管「行为像不像人」。发送失败不重试、
    不广播，也是防封号的一部分——重复投递比慢一点危险得多。
    """
    now = time.time()
    st = _state.setdefault(account, {"last": 0.0, "minute": [], "day": "",
                                     "count": 0, "texts": {}})
    today = time.strftime("%Y-%m-%d")
    if st["day"] != today:
        st.update(day=today, count=0)
    if st["count"] >= DAILY_LIMIT:
        return {"ok": False, "via": "hook", "error_code": "risk_limited",
                "detail": f"该账号今天已发 {st['count']} 条，达到防封号上限 {DAILY_LIMIT}"}
    st["minute"] = [t for t in st["minute"] if now - t < 60]
    if len(st["minute"]) >= MINUTE_LIMIT:
        return {"ok": False, "via": "hook", "error_code": "risk_limited",
                "detail": f"该账号一分钟内已发 {MINUTE_LIMIT} 条，请降低频率"}
    key = hashlib.sha1(text.encode("utf-8")).hexdigest()
    seen = {k: v for k, v in st["texts"].get(key, {}).items() if now - v < SIMILAR_WINDOW}
    st["texts"][key] = seen
    if talker not in seen and len(seen) >= SIMILAR_TARGETS:
        return {"ok": False, "via": "hook", "error_code": "risk_limited",
                "detail": f"同一段话 10 分钟内已发给 {len(seen)} 个不同会话，"
                          f"再发会像群发营销（上限 {SIMILAR_TARGETS}）"}
    wait = MIN_INTERVAL - (now - st["last"])
    if wait > 0:
        time.sleep(wait + random.uniform(0, MIN_INTERVAL * 0.3))
    st["last"] = time.time()
    st["minute"].append(st["last"])
    st["count"] += 1
    seen[talker] = st["last"]
    return None


def _send(talker, path, payload, account=None):
    ep, err = _match(talker, account=account)
    if not ep:
        if not endpoints():
            # 一个 hook 都没起来：没发出去，调用方可以安全回退 UIA
            return {"_fallback": True, "detail": err}
        # 有实例但路由不了（多个微信之间选不出唯一账号）：**不能回退 UIA**——
        # 窗口投递分不清账号，可能把消息发给另一个微信。
        return {"ok": False, "via": "hook", "error_code": "target_not_found", "detail": err}
    account = ep.get("wxid") or ep.get("nickname") or ep["url"]
    blocked = _risk_guard(account, talker, str(payload.get("msg") or payload.get("path") or ""))
    if blocked:
        blocked["account"] = account
        return blocked
    try:
        r = _post(ep["url"], path, payload, SEND_TIMEOUT)
    except urllib.error.HTTPError as e:
        # ⚠️ HTTPError 是 URLError 的子类，必须放在前面。
        # 404/405/501 = 端点**没受理**这个发送类型（老 hook 只有 /SendTextMsg）：
        # 明确没发出去，可以安全回退窗口投递。其它状态码可能已经发了一半，按未确认处理。
        if e.code in (404, 405, 501):
            return {"_fallback": True,
                    "detail": f"hook 不支持 {path}（HTTP {e.code}），改走窗口投递"}
        return {"ok": False, "via": "hook", "error_code": "send_not_confirmed",
                "detail": f"hook 发送未确认（HTTP {e.code}）；可能已经发出，先读库确认",
                "account": ep.get("wxid") or ep.get("nickname")}
    except (urllib.error.URLError, socket.timeout, OSError, ValueError) as e:
        # 请求可能已经到了微信进程：按「未确认」处理，**不回退、不重试**
        return {"ok": False, "via": "hook", "error_code": "send_not_confirmed",
                "detail": f"hook 发送未确认（{type(e).__name__}: {e}）；可能已经发出，先读库确认",
                "account": ep.get("wxid") or ep.get("nickname")}
    ret = r.get("ret", r.get("status", 0)) if isinstance(r, dict) else 0
    if ret not in (0, "0", None):
        return {"ok": False, "via": "hook", "error_code": "send_unconfirmed",
                "detail": f"hook 返回失败：{r.get('retmsg') or r.get('desc') or ret}",
                "account": ep.get("wxid") or ep.get("nickname")}
    return {"ok": True, "via": "hook", "error_code": None,
            "detail": f"已通过 hook 发送（账号 {ep.get('nickname') or ep.get('wxid') or ep['url']}）",
            "account": ep.get("wxid") or ep.get("nickname")}


def try_send_text(talker, text, account=None):
    """返回 None = 没有 hook 可用（调用方可回退 UIA）；否则返回结果 dict。"""
    return _send(talker, "/SendTextMsg", {"wxidorgid": talker, "msg": text}, account=account)


def try_send_file(talker, path, account=None):
    return _send(talker, "/SendFileMsg", {"wxidorgid": talker, "path": path}, account=account)


def status():
    """排障用：当前发现的实例。"""
    return {"config": CONFIG_PATH, "endpoints": endpoints(refresh=True)}
