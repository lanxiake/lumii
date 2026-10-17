"""E6：`search_messages` 与盯梢一拍的真实成本分解 —— 决定 §9.4 / §9.10 值不值得做。

E1 已判：客户端的 `message_fts.db` 只覆盖 73.3% 的消息、且虚表要私有分词器 ⇒ 用不了，
只能自建索引。但**自建之前先量**：现在的慢到底慢在「解密/读行」还是「`_render` 逐条解码」？
两者解法完全不同（前者加缓存，后者换索引）。

同时量盯梢回路一拍（`poll`）与 `history`，对应 §9.10 把 tick 从 15s 降下来这件事。

只读。跑法：PYTHONIOENCODING=utf-8 python.exe probe_search_cost.py
"""
import statistics
import sys
import time

MCP = r"C:\myself\projects\my\open-source\lumii\apps\windows\resources\wechat-mcp"
sys.path.insert(0, MCP)

import wechat_core as wc                                            # noqa: E402

KW = "的"


def t(fn, n=1, label=""):
    xs = []
    r = None
    for _ in range(n):
        t0 = time.perf_counter()
        r = fn()
        xs.append((time.perf_counter() - t0) * 1000)
    print("  %-42s %s" % (label or getattr(fn, "__name__", "?"),
                          " / ".join("%.0fms" % x for x in xs)))
    return r, statistics.median(xs)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                               # noqa: BLE001
        pass
    t0 = time.perf_counter()
    root = wc.db_root()
    km = wc.keys(root)
    print("取密钥（冷）：%.0fms" % ((time.perf_counter() - t0) * 1000))

    print("\n--- 冷启动一次全量重建（_refresh）---")
    t(wc._refresh, 1, "_refresh() 全量重建")                         # noqa: SLF001

    print("\n--- 热路径 ---")
    t(lambda: wc.search_messages(KW), 3, "search_messages('%s') 全库" % KW)
    talkers = [tk for _tbl, tk in wc.talkers()][:80]
    if talkers:
        t(lambda: wc.search_messages(KW, talker=talkers[0]), 3,
          "search_messages(talker=%s)" % talkers[0])
    t(lambda: wc.history(talkers[0], 30) if talkers else None, 3, "history(%s, 30)" % (talkers[0] if talkers else "-"))
    newest = wc.poll(0, 20)["next_since_ts"]                         # 先跑一次拿最新水位
    t(lambda: wc.poll(newest, 20), 3, "poll(最新水位, 20)  ← 真实盯梢一拍")
    t(lambda: wc.unread(), 2, "unread()")
    t(lambda: wc.names(), 2, "names()")

    print("\n--- 分解 search_messages：读行 vs 渲染 ---")
    nm = wc.names()
    me = wc.self_wxid()
    pairs = [(tk, tbl) for tbl, tk in wc.talkers()]
    t0 = time.perf_counter()
    rows_all = []
    for tt, tbl in pairs:
        try:
            rows_all.append((tt, wc._rows_full(tbl, 3000)))         # noqa: SLF001
        except Exception:                                           # noqa: BLE001
            pass
    t_read = (time.perf_counter() - t0) * 1000
    nrows = sum(len(r) for _tt, r in rows_all)
    print("  %-42s %.0fms（%d 行 / %d 会话）" % ("_rows_full(scan=3000) 全部会话", t_read, nrows, len(rows_all)))
    t0 = time.perf_counter()
    n = 0
    for _tt, rows in rows_all:
        for ct, lt, content, s, _lid, _src, *_ in rows:
            if wc._render(lt, content):                              # noqa: SLF001
                n += 1
    t_render = (time.perf_counter() - t0) * 1000
    print("  %-42s %.0fms（%d 行）" % ("_render 逐条", t_render, nrows))
    print("  ⇒ 读行 %.0f%% / 渲染 %.0f%%" % (100 * t_read / (t_read + t_render),
                                              100 * t_render / (t_read + t_render)))

    print("\n--- 假如有「渲染后文本」列，纯 LIKE 要多久？（自建索引的收益上限）---")
    import sqlite3
    c = sqlite3.connect(":memory:")
    c.execute("create table m(talker text, lid int, ct int, txt text)")
    t0 = time.perf_counter()
    ins = []
    for tt, rows in rows_all:
        for ct, lt, content, _s, lid, *_ in rows:
            ins.append((tt, lid, ct, wc._render(lt, content)))       # noqa: SLF001
    print("  准备 %d 行（含渲染）：%.0fms" % (len(ins), (time.perf_counter() - t0) * 1000))
    t0 = time.perf_counter()
    c.executemany("insert into m values(?,?,?,?)", ins)
    c.commit()
    print("  灌入内存表：%.0fms" % ((time.perf_counter() - t0) * 1000))
    t0 = time.perf_counter()
    hit = c.execute("select count(*) from m where txt like ?", ("%" + KW + "%",)).fetchone()[0]
    print("  纯 LIKE '%s' 全表扫描：%.1fms（命中 %d）"
          % (KW, (time.perf_counter() - t0) * 1000, hit))


if __name__ == "__main__":
    main()
