"""E1（收尾）：`message_fts_v4_*_content` 的**覆盖范围** —— 决定 §9.4 能不能直接换过去。

已知：`_content` 有正文 + (session_id, message_local_id, create_time) 元数据；虚表与 `_idx` 用不了。
未知：它索引了**全部**消息，还是只有一部分？若只有一部分，直接换过去会**静默漏结果**。

对账三件事：
  ① session.db 里 `session_id`(整数) ↔ username 的映射在哪张表
  ② 主库各 `Msg_<md5>` 表的行数与 max(local_id)
  ③ FTS 覆盖的 (session→用户名, message_local_id) 是不是全量；缺的是哪一类消息

只读。跑法：PYTHONIOENCODING=utf-8 python.exe probe_fts_coverage.py
"""
import hashlib
import os
import sqlite3
import sys

MCP = r"C:\myself\projects\my\open-source\lumii\apps\windows\resources\wechat-mcp"
sys.path.insert(0, MCP)

import wechat_core as wc                                            # noqa: E402


def con(p):
    return sqlite3.connect("file:%s?mode=ro" % p.replace("\\", "/"), uri=True)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                               # noqa: BLE001
        pass
    root = wc.db_root()
    km = wc.keys(root)

    print("=" * 78)
    print("① session.db 里 session_id 怎么来的")
    s = con(wc._plain(km, root, "session/session.db"))               # noqa: SLF001
    for name, sql in s.execute("select name, sql from sqlite_master where type='table'"):
        print("  [%s] %s" % (name, (sql or "").replace("\n", " ")[:400]))
    cols = [r[1] for r in s.execute('pragma table_info("SessionTable")')]
    print("  SessionTable 列：%s" % cols)
    # 找整数 id 列
    for cand in ("session_id", "id", "sort_id", "sessionId"):
        if cand in cols:
            print("  → 候选 id 列：%s" % cand)
            for r in s.execute('select "%s", username from SessionTable limit 8' % cand):
                print("     ", r)
            break
    else:
        print("  → SessionTable 没有明显的整数 id 列；打印前 3 行全列：")
        for r in s.execute('select * from SessionTable limit 3'):
            print("     ", repr(r)[:400])
    s.close()

    print("\n" + "=" * 78)
    print("② 主库全量：各 Msg_<md5> 表")
    msg_rel = next((r.replace("\\", "/") for _k, r in km.values()
                    if os.path.basename(r).startswith("message_")), None)
    print("  主库 = %s" % msg_rel)
    m = con(wc._plain(km, root, msg_rel))                            # noqa: SLF001
    tbls = [r[0] for r in m.execute(
        "select name from sqlite_master where type='table' and name like 'Msg_%'")]
    total = 0
    per = {}
    for t in tbls:
        n, mn, mx = m.execute('select count(*), min(local_id), max(local_id) from "%s"' % t).fetchone()
        total += n
        per[t] = (n, mn, mx)
        print("     %s 行=%d local_id %s..%s" % (t, n, mn, mx))
    print("  主库消息总数 = %d（%d 张表）" % (total, len(tbls)))

    print("\n" + "=" * 78)
    print("③ FTS `_content` 覆盖对账")
    f = con(wc._plain(km, root, "message/message_fts.db"))           # noqa: SLF001
    ftabs = [r[0] for r in f.execute(
        "select name from sqlite_master where type='table' and name like 'message_fts_v4_%_content'")]
    fts_rows = []
    for t in sorted(ftabs):
        for sid, lid, ct, lt in f.execute(
                'select c4, c1, c6, c3 from "%s"' % t):
            fts_rows.append((sid, lid, ct, lt))
    print("  FTS 覆盖 %d 条" % len(fts_rows))
    print("  主库总 %d 条 ⇒ 覆盖率 %.1f%%" % (total, 100.0 * len(fts_rows) / total if total else 0))

    # 主库 (talker→md5 表名) 侧的 (md5, local_id) 全集合
    main_ids = set()
    for t in tbls:
        for (lid,) in m.execute('select local_id from "%s"' % t):
            main_ids.add((t, lid))
    fts_by_sid = {}
    for sid, lid, _ct, _lt in fts_rows:
        fts_by_sid.setdefault(sid, set()).add(lid)
    print("  FTS 里出现的 session_id：%s" % sorted(fts_by_sid))
    print("\n  各 session 的 FTS 条数 / 该 session_id 的 md5 表在不在主库：")
    for sid in sorted(fts_by_sid):
        # 主库表名 = Msg_<md5(username)>；这里反查：哪张表的行数与之吻合
        cand = [t for t, (n, _mn, _mx) in per.items() if len(fts_by_sid[sid]) == n]
        print("     session_id=%-4s FTS %4d 条   行数吻合的表=%s"
              % (sid, len(fts_by_sid[sid]), cand or "（无）"))

    # local_id 重合度：拿一个 FTS session 去比
    print("\n  抽样：FTS 中 session_id 最小的那个，它的 local_id 落在主库哪张表里")
    sid0 = min(fts_by_sid)
    ids0 = fts_by_sid[sid0]
    print("     session_id=%s 的 local_id 范围 %s..%s" % (sid0, min(ids0), max(ids0)))
    for t, (n, mn, mx) in per.items():
        if mn is None:
            continue
        ov = len(ids0 & set(range(mn, mx + 1)))
        if ov > len(ids0) * 0.5:
            print("     ← 与 %s 高度重合（%d/%d）" % (t, ov, len(ids0)))

    print("\n  local_type 分布（c3）：")
    dist = {}
    for _sid, _lid, _ct, lt in fts_rows:
        dist[lt] = dist.get(lt, 0) + 1
    for lt, n in sorted(dist.items(), key=lambda x: -x[1])[:15]:
        print("     local_type=%-12s %d 条" % (lt, n))

    print("\n  时间范围：%s .. %s" % (
        min(r[2] for r in fts_rows), max(r[2] for r in fts_rows)))
    for t in tbls:
        r = m.execute('select min(create_time), max(create_time) from "%s"' % t).fetchone()
        print("     主库 %s 时间 %s .. %s" % (t, r[0], r[1]))
    m.close()
    f.close()


if __name__ == "__main__":
    main()
