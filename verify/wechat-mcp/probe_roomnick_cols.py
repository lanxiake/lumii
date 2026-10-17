# -*- coding: utf-8 -*-
"""`chatroom_member_fts_v3_content` 到底哪一列是群内昵称（c0 大量为空，先查清再写代码）。"""
import os
import shutil
import sqlite3
import sys

sys.path.insert(0, r"C:\myself\projects\my\open-source\lumii\apps\windows\resources\wechat-mcp")
import wechat_core as wc                                            # noqa: E402


def mirror(rel):
    try:
        m = wc._mirror(rel)                                         # noqa: SLF001
        m.refresh()
        return m.out
    except PermissionError:
        shutil.rmtree(wc.MIRROR_DIR, ignore_errors=True)
        os.makedirs(wc.MIRROR_DIR, exist_ok=True)
        m = wc._mirror(rel)                                         # noqa: SLF001
        m.refresh()
        return m.out


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                               # noqa: BLE001
        pass
    fts = mirror("contact/contact_fts.db")
    f = sqlite3.connect("file:%s?mode=ro" % fts.replace(os.sep, "/"), uri=True)

    print("--- content 表的列 ---")
    for t in ("chatroom_member_fts_v3_content", "chatroom_member_fts_v3_aux",
              "chatroom_member_fts_v3_data"):
        cols = [r[1] for r in f.execute('pragma table_info("%s")' % t)]
        print("  %-36s %s" % (t, cols))
    print("--- 虚表 v3 / v3_aux 定义 ---")
    for name, sql in f.execute("select name, sql from sqlite_master where name like "
                              "'chatroom_member_fts_v3%' and sql is not null"):
        print("  %s → %s" % (name, (sql or "")[:300]))
    print("--- content 原始 8 行 repr ---")
    for r in f.execute("select * from chatroom_member_fts_v3_content limit 8"):
        print("   %r" % (r,))
    print("--- aux 原始 6 行 repr（虚表真正存内容的地方）---")
    for r in f.execute("select * from chatroom_member_fts_v3_aux limit 6"):
        print("   %r" % (r,))

    n_all = n_nick = 0
    for (c0,) in f.execute("select c0 from chatroom_member_fts_v3_content"):
        n_all += 1
        n_nick += 1 if (c0 or "").strip() else 0
    print("c0 非空 = %d / %d (%.1f%%)" % (n_nick, n_all, 100.0 * n_nick / max(1, n_all)))
    print("--- 非空样例 10 条 ---")
    for r in f.execute("select c0, c1, c2 from chatroom_member_fts_v3_content "
                       "where trim(c0) <> '' limit 10"):
        print("   %r" % (r,))
    f.close()


if __name__ == "__main__":
    main()
