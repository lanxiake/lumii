# -*- coding: utf-8 -*-
"""群内昵称的**全部**候选来源，谁覆盖谁先看清（FTS 只覆盖 9.6%）。

`chatroom_member_fts_v3` 的列定义已定死语义：`a_group_remark` = 群内称呼（群备注），
但 1980 行里只有 191 行非空。所以先问：**剩下的 90% 有没有别的地方放？**

候选：contact.db 的 `chat_room` / `chatroom_member` 列；message_*.db 里有没有成员表。
只读；跑法：PYTHONIOENCODING=utf-8 python probe_roomnick_sources.py
"""
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


def ro(p):
    return sqlite3.connect("file:%s?mode=ro" % p.replace(os.sep, "/"), uri=True)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                               # noqa: BLE001
        pass
    cdb = mirror("contact/contact.db")
    mdb = mirror("message/message_0.db")
    c = ro(cdb)
    print("=== contact.db 里带 room/member 的表 ===")
    for t, sql in c.execute("select name, sql from sqlite_master where type='table'"):
        if "room" not in t.lower() and "member" not in t.lower():
            continue
        n = c.execute('select count(*) from "%s"' % t).fetchone()[0]
        print("  %-34s 行=%-6d %s" % (t, n, (sql or "").replace("\n", " ")[:300]))
        if n:
            cols = [r[1] for r in c.execute('pragma table_info("%s")' % t)]
            keep = [x for x in cols if x not in ("ext_buffer", "extra_buffer")][:14]
            for r in c.execute('select %s from "%s" limit 3'
                               % (",".join('"%s"' % x for x in keep), t)):
                print("       %r" % (r,))
    c.close()

    print("\n=== message_0.db 里带 room/member 的表 ===")
    m = ro(mdb)
    for t, sql in m.execute("select name, sql from sqlite_master where type='table'"):
        if "room" not in t.lower() and "member" not in t.lower():
            continue
        n = m.execute('select count(*) from "%s"' % t).fetchone()[0]
        print("  %-34s 行=%-6d %s" % (t, n, (sql or "").replace("\n", " ")[:200]))
        if n:
            cols = [r[1] for r in m.execute('pragma table_info("%s")' % t)]
            keep = [x for x in cols if "buffer" not in x][:12]
            for r in m.execute('select %s from "%s" limit 3'
                               % (",".join('"%s"' % x for x in keep), t)):
                print("       %r" % (r,))
    m.close()


if __name__ == "__main__":
    main()
