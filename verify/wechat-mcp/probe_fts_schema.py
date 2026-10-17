"""E1：客户端自带的 `*_fts.db` 里到底有什么？（只读）

报告 §9.4 的判据：如果 `message_fts.db` 里是**能直接查的 FTS5 虚表**，MCP 的
`search_messages` 就该改走它，而不是自己全表扫 + Python 逐条解码。

复用 MCP 现成的解密路径（`wechat_core._plain`），它已经处理了 WAL 重放与陈旧 WAL 回退。
**全程只读**：只复制到临时镜像目录再解密，不碰微信原始文件。

跑法：
  PYTHONIOENCODING=utf-8 "~/.lumii/runtimes/python-embed/python.exe" probe_fts_schema.py
"""
import os
import sqlite3
import sys

MCP = r"C:\myself\projects\my\open-source\lumii\apps\windows\resources\wechat-mcp"
sys.path.insert(0, MCP)

import wechat_core as wc                                            # noqa: E402


def dump(rel, plain):
    print("\n" + "=" * 78)
    print("### %s  →  %s  (%.1f KB)" % (rel, plain, os.path.getsize(plain) / 1024))
    c = sqlite3.connect("file:%s?mode=ro" % plain.replace("\\", "/"), uri=True)
    rows = c.execute(
        "select type, name, tbl_name, sql from sqlite_master order by type, name").fetchall()
    for typ, name, tbl, sql in rows:
        print("  [%s] %s" % (typ, name))
        if sql:
            print("      " + sql.replace("\n", "\n      "))
    # 逐表看列 + 行数 + 抽样
    for typ, name, _tbl, _sql in rows:
        if typ not in ("table", "view"):
            continue
        try:
            n = c.execute('select count(*) from "%s"' % name).fetchone()[0]
        except Exception as e:                                      # noqa: BLE001
            print("      count(%s) 失败：%s" % (name, e))
            continue
        cols = [r[1] for r in c.execute('pragma table_info("%s")' % name)]
        print("      → %s 行=%d 列=%s" % (name, n, cols))
        if n:
            try:
                for r in c.execute('select * from "%s" limit 2' % name):
                    print("        样例：" + repr(r)[:300])
            except Exception as e:                                  # noqa: BLE001
                print("        抽样失败：%s" % e)
    c.close()


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                               # noqa: BLE001
        pass
    root = wc.db_root()
    print("数据根目录：%s" % root)
    km = wc.keys(root)
    rels = sorted(r.replace("\\", "/") for _k, r in km.values())
    print("取到密钥的库（%d 个）：" % len(rels))
    for r in rels:
        print("   ", r)

    targets = [r for r in rels if os.path.basename(r).endswith("_fts.db")]
    if not targets:
        print("\n!! 没有 *_fts.db —— §9.4 的路线①（直接查）不成立，只能自建索引")
        return
    for rel in targets:
        try:
            dump(rel, wc._plain(km, root, rel))                     # noqa: SLF001
        except Exception as e:                                      # noqa: BLE001
            print("\n### %s 解密失败：%r" % (rel, e))


if __name__ == "__main__":
    main()
