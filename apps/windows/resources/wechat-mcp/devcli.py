"""devcli —— 微信 MCP 的自检 / 调试命令行（跑固定动作，不经过 LLM）。

用途：把「常规动作」固化成脚本，供人/测试直接驱动与断言，不必每次都让 Agent 走一遍。

用法：
  python devcli.py status                     环境检查（进程/窗口/可见/最小化/前台/尺寸·DPI）
  python devcli.py sessions                   列出会话（name + talker）
  python devcli.py history <talker> [n] [before_ts]    读历史（正序；before_ts 翻更早一页）
  python devcli.py scan <marker>              全库扫描文本（验证「没发出去」/「发到了哪」）
  python devcli.py send <talker> <text> [--yes]   发文本；默认 dry-run，--yes 才真发
  python devcli.py sendfile <talker> <path> [--yes]  发图片/文件/视频/音频（剪贴板粘贴；默认 dry-run）
  python devcli.py reply <talker> <quote> <text> [--yes]  引用回复（quote=被引用消息文字；默认 dry-run）
  python devcli.py search <关键词> [talker] | digest [talker] [limit] | profile [scope] | state [scope] [ts] | clear [scope] [--all] | unread | accounts | stats
  python devcli.py watch [since_ts] [--ticks N] [--interval S]  增量盯消息（默认 1 拍；N>1 则连续盯）
  python devcli.py selftest                   只读自检：依赖 + 数据目录 + 会话 + 实时读取耗时

退出码：0 成功 / 1 操作失败 / 2 参数错误。
"""
import json
import os
import sqlite3
import sys

# stdout 固定 UTF-8：Windows 下默认走 GBK，调用方按 UTF-8 解码会把中文变成乱码
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import wechat_core as core  # noqa: E402


def _out(obj):
    print(json.dumps(obj, ensure_ascii=False))


def cmd_status():
    import wechat_sender as S
    st = S.check_env()
    _out(st)
    return 0


def cmd_sessions():
    _out(core.sessions())
    return 0


def cmd_history(talker, n=10, before_ts=0):
    t = core.resolve_talker(talker) or talker
    _out(core.history(t, int(n), int(before_ts)))
    return 0


def cmd_scan(marker):
    core._refresh()
    seen, hits = set(), []
    for p in core._cache["msg"]:                 # 遍历**全部分片**
        c = sqlite3.connect(p)
        for t in core._cache["tables"].get(p, ()):
            seen.add(t)
            for _ct, co in c.execute(f"select create_time, message_content from [{t}]"):
                if marker in core.decode(co):
                    hits.append(t)
        c.close()
    _out({"marker": marker, "tables_scanned": len(seen), "hits": sorted(set(hits))})
    return 0


def cmd_send(talker, text, real=False):
    import wechat_sender as S
    t = core.resolve_talker(talker) or talker
    ok, detail = S.send_text(text, t, dry_run=not real, verbose=True)
    _out({"ok": ok, "detail": detail, "dry_run": not real, "talker": t})
    return 0 if ok else 1


def cmd_sendfile(talker, path, real=False):
    import wechat_sender as S
    t = core.resolve_talker(talker) or talker
    ok, detail = S.send_attachment(path, t, dry_run=not real, verbose=True)
    _out({"ok": ok, "detail": detail, "dry_run": not real, "talker": t, "path": path})
    return 0 if ok else 1


def cmd_reply(talker, quote, text, real=False):
    """引用回复：<talker> <quote=被引用消息文字> <text=正文>；默认 dry-run，--yes 才真发。"""
    import wechat_sender as S
    t = core.resolve_talker(talker) or talker
    ok, detail = S.reply_text(quote, text, t, dry_run=not real, verbose=True)
    _out({"ok": ok, "detail": detail, "dry_run": not real, "talker": t, "quote": quote})
    return 0 if ok else 1


def cmd_search(kw, talker=None, n=10):
    t = (core.resolve_talker(talker) or talker) if talker else None
    _out(core.search_messages(kw, t, limit=int(n)))
    return 0


def cmd_unread():
    _out(core.unread())
    return 0


def cmd_digest(talker=None, limit=500):
    """蒸馏统计（确定性、只读、本地）：<talker> 可选，不给则全局。"""
    t = (core.resolve_talker(talker) or talker) if talker else None
    _out(core.digest(t, int(limit)))
    return 0


def cmd_profile(scope=None):
    """列出已产出的画像，或读回指定 scope 的画像（self / 会话名 / wxid）。"""
    s = None
    if scope and scope not in ("self", "me", "我", "本人"):
        s = core.resolve_talker(scope) or scope
    _out(core.profile_get(s))
    return 0


def cmd_state(scope=None, ts=None):
    """蒸馏水位：无 ts 读取；有 ts 写入（增量蒸馏用）。"""
    _out(core.set_distill_state(scope or "self", int(ts)) if ts is not None
         else core.distill_state(scope))
    return 0


def cmd_clear(scope=None, everything=False):
    """一键清除蒸馏产物：<scope>=self/会话名 删单个；--all 清空全部。"""
    if scope and scope not in ("self", "me", "我", "本人"):
        scope = core.resolve_talker(scope) or scope
    _out(core.distill_clear(scope, everything=everything))
    return 0


def cmd_accounts():
    """列出本机微信账号数据目录与当前生效账号（多账号选择用 LUMII_WECHAT_ACCOUNT）。"""
    try:
        active = core.self_wxid()
    except Exception:
        active = None
    _out({"active": active, "accounts": core.list_accounts()})
    return 0


def cmd_stats():
    """汇总 metrics.jsonl：各操作次数/成功率/P50/P90 耗时。"""
    import json
    import os as _os
    p = _os.path.join(core.WORK, "metrics.jsonl")
    if not _os.path.exists(p):
        _out({"error": "暂无指标（还没跑过发送）"})
        return 0
    rows = []
    for ln in open(p, encoding="utf-8"):
        try:
            rows.append(json.loads(ln))
        except Exception:
            pass
    agg = {}
    for r in rows:
        agg.setdefault(r["op"], []).append(r)
    out = {}
    for op, rs in agg.items():
        ms = sorted(x["ms"] for x in rs)
        out[op] = {"n": len(rs), "ok": sum(1 for x in rs if x["ok"]),
                   "p50_ms": ms[len(ms) // 2], "p90_ms": ms[min(len(ms) - 1, int(len(ms) * 0.9))]}
    _out(out)
    return 0


def cmd_watch(since=None, ticks=1, interval=3.0):
    """增量盯消息：每拍打一行 JSON（新消息 + 读取耗时 + 快路径复用情况）。

    用法：
      python devcli.py watch                 # 从现在开始，打一拍
      python devcli.py watch --ticks 20 --interval 3   # 连续盯 1 分钟
      python devcli.py watch 1791441000      # 从指定 Unix 秒开始补看
    """
    import time as _t
    since = int(since) if since is not None else int(_t.time())
    rc = 0
    for i in range(max(1, int(ticks))):
        t0 = _t.perf_counter()
        core._refresh()
        t_ref = (_t.perf_counter() - t0) * 1000
        t0 = _t.perf_counter()
        try:
            r = core.poll(since)
        except Exception as e:
            _out({"tick": i, "error": str(e)[:300]})
            rc = 1
            break
        t_poll = (_t.perf_counter() - t0) * 1000
        since = r["next_since_ts"]
        newest = r["messages"][-1]["ts"] if r["messages"] else None
        _out({"tick": i, "now": int(_t.time()), "count": r["count"],
              "from_others": sum(1 for m in r["messages"] if not m.get("from_me")),
              "newest_ts": newest,
              "lag_s": (int(_t.time()) - newest) if newest else None,
              "refresh_ms": round(t_ref, 1), "poll_ms": round(t_poll, 1),
              "stats": r.get("stats"),
              "messages": [{"ts": m["ts"], "name": m.get("name"), "from_me": m.get("from_me"),
                            "text": m["text"][:120]} for m in r["messages"][:20]]})
        if i + 1 < int(ticks):
            _t.sleep(max(0.2, float(interval)))
    return rc


def cmd_selftest():
    ok = True
    d = core.deps()
    _out({"step": "deps", "pycryptodome": d["pycryptodome"], "zstandard": d["zstandard"], "ok": d["ok"]})
    ok = ok and d["ok"]
    try:
        accts = core.list_accounts()
        _out({"step": "accounts", "count": len(accts),
              "active": accts[0]["wxid"] if accts else None,
              "root": accts[0]["root"] if accts else None,
              "all": [a["wxid"] for a in accts]})
        ok = ok and bool(accts)
    except Exception as e:
        _out({"step": "accounts", "error": str(e)[:200]})
        ok = False
    try:
        accts = core.list_accounts()
        if accts:
            import os as _os
            f = _os.path.join(accts[0]["root"], "message", "message_0.db")
            s = _os.stat(f)
            _out({"step": "message_0.db", "size_mb": round(s.st_size / 1048576, 1),
                  "mtime": int(s.st_mtime),
                  "wal_mb": round(_os.path.getsize(f + "-wal") / 1048576, 1)
                  if _os.path.exists(f + "-wal") else 0})
    except Exception as e:
        _out({"step": "message_0.db", "error": str(e)[:200]})
    try:
        import time as _t
        t0 = _t.perf_counter()
        core._refresh()
        cold = (_t.perf_counter() - t0) * 1000
        t0 = _t.perf_counter()
        core._refresh()
        warm = (_t.perf_counter() - t0) * 1000
        t0 = _t.perf_counter()
        st = core.sessions()
        sess = (_t.perf_counter() - t0) * 1000
        _out({"step": "read_timing", "first_refresh_ms": round(cold, 1),
              "cached_refresh_ms": round(warm, 1), "sessions_ms": round(sess, 1)})
        _out({"step": "sessions", "count": len(st), "names": [s["name"] for s in st][:20]})
        if st:
            t = st[0]["talker"]
            h = core.history(t, 3)
            _out({"step": "history", "talker": t, "count": h["count"]})
    except Exception as e:
        _out({"step": "read", "error": str(e)[:300]})
        ok = False
    try:
        import wechat_sender as S
        env = S.check_env()
        _out({"step": "env", "ok": env["ok"], "reason": env["reason"], "size": env["size"], "dpi": env["dpi"]})
    except Exception as e:
        _out({"step": "env", "error": str(e)[:200]})
    return 0 if ok else 1


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    cmd = argv[0]
    if cmd == "status":
        return cmd_status()
    if cmd == "sessions":
        return cmd_sessions()
    if cmd == "history" and len(argv) >= 2:
        return cmd_history(argv[1], argv[2] if len(argv) > 2 else 10,
                           argv[3] if len(argv) > 3 else 0)
    if cmd == "scan" and len(argv) >= 2:
        return cmd_scan(argv[1])
    if cmd == "send" and len(argv) >= 3:
        return cmd_send(argv[1], argv[2], real="--yes" in argv)
    if cmd == "sendfile" and len(argv) >= 3:
        return cmd_sendfile(argv[1], argv[2], real="--yes" in argv)
    if cmd == "reply" and len(argv) >= 4:
        return cmd_reply(argv[1], argv[2], argv[3], real="--yes" in argv)
    if cmd == "search" and len(argv) >= 2:
        return cmd_search(argv[1], argv[2] if len(argv) > 2 else None)
    if cmd == "digest":
        return cmd_digest(argv[1] if len(argv) > 1 else None, argv[2] if len(argv) > 2 else 500)
    if cmd == "profile":
        return cmd_profile(argv[1] if len(argv) > 1 else None)
    if cmd == "state":
        return cmd_state(argv[1] if len(argv) > 1 else None, argv[2] if len(argv) > 2 else None)
    if cmd == "clear":
        return cmd_clear(None, everything=True) if "--all" in argv else cmd_clear(argv[1] if len(argv) > 1 else None)
    if cmd == "unread":
        return cmd_unread()
    if cmd == "accounts":
        return cmd_accounts()
    if cmd == "stats":
        return cmd_stats()
    if cmd == "watch":
        since = argv[1] if len(argv) > 1 and not argv[1].startswith("--") else None
        ticks = argv[argv.index("--ticks") + 1] if "--ticks" in argv else 1
        interval = argv[argv.index("--interval") + 1] if "--interval" in argv else 3.0
        return cmd_watch(since, ticks, interval)
    if cmd == "selftest":
        return cmd_selftest()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
