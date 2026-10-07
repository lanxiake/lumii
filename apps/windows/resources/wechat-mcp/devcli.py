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
  python devcli.py search <关键词> [talker] | unread | accounts | stats
  python devcli.py selftest                   只读自检：环境 + 会话 + 一次历史读取

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
    c = sqlite3.connect(core._cache["msg"])
    tabs = [r[0] for r in c.execute(
        "select name from sqlite_master where type='table' and name like 'Msg_%'")]
    hits = []
    for t in tabs:
        for _ct, co in c.execute(f"select create_time, message_content from [{t}]"):
            if marker in core.decode(co):
                hits.append(t)
    c.close()
    _out({"marker": marker, "tables_scanned": len(tabs), "hits": hits})
    return 0 if not hits else 0  # 扫描本身总是成功；命中与否看 hits


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


def cmd_selftest():
    ok = True
    st = core.sessions()
    _out({"step": "sessions", "count": len(st), "names": [s["name"] for s in st]})
    if st:
        t = st[0]["talker"]
        h = core.history(t, 3)
        _out({"step": "history", "talker": t, "count": h["count"]})
    try:
        import wechat_sender as S
        env = S.check_env()
        _out({"step": "env", "ok": env["ok"], "reason": env["reason"], "size": env["size"], "dpi": env["dpi"]})
        ok = env["ok"]
    except Exception as e:
        _out({"step": "env", "error": str(e)[:200]})
        ok = False
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
    if cmd == "unread":
        return cmd_unread()
    if cmd == "accounts":
        return cmd_accounts()
    if cmd == "stats":
        return cmd_stats()
    if cmd == "selftest":
        return cmd_selftest()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
