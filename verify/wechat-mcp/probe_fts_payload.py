"""E1（续）：`*_fts.db` 的 `_content` / `_idx` 里到底存了什么？—— 决定 §9.4 走哪条路。

背景：虚表用了微信自研分词器 `MMFtsTokenizer`，本机 sqlite3 查不了（no such tokenizer）。
但 `message_fts_v4_*` **没写 `content=`** ⇒ 自包含 ⇒ 有 `_content` 实体表，列名就是源列名。
`_idx.term` 也是明文。所以要用这份索引，可能根本不需要那个 tokenizer。

判据：
  A. `_content.c0` 是不是消息正文 → 是 ⇒ **MCP 可以直接 SELECT 它做检索**（路线①）
  B. `_idx.term` 的分词粒度 → 决定查询词要怎么切
  C. 覆盖多少条 / 与 `message_0.db` 的 Msg_* 表是否一致 → 决定要不要回退自建索引

只读。跑法：PYTHONIOENCODING=utf-8 python.exe probe_fts_payload.py [关键词]
"""
import os
import sqlite3
import sys

MCP = r"C:\myself\projects\my\open-source\lumii\apps\windows\resources\wechat-mcp"
sys.path.insert(0, MCP)

import wechat_core as wc                                            # noqa: E402

KW = sys.argv[1] if len(sys.argv) > 1 else "的"


def con(p):
    return sqlite3.connect("file:%s?mode=ro" % p.replace("\\", "/"), uri=True)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                               # noqa: BLE001
        pass
    root = wc.db_root()
    km = wc.keys(root)
    rel = "message/message_fts.db"
    p = wc._plain(km, root, rel)                                    # noqa: SLF001
    c = con(p)

    print("=" * 78)
    print("A) 自包含的 message_fts_v4_* —— `_content` 里是不是正文？")
    for t in [r[0] for r in c.execute(
            "select name from sqlite_master where type='table' and name like 'message_fts_v4_%_content'")]:
        n = c.execute('select count(*) from "%s"' % t).fetchone()[0]
        mx = c.execute('select max(c6) from "%s"' % t).fetchone()[0]
        print("\n  %s  行数=%d  max(create_time)=%s" % (t, n, mx))
        for r in c.execute('select * from "%s" order by id desc limit 4' % t):
            print("     ", repr(r)[:400])
        # 关键词命中数（纯 LIKE，不需要 tokenizer）
        hit = c.execute('select count(*) from "%s" where c0 like ?' % t, ("%" + KW + "%",)).fetchone()[0]
        print("      LIKE '%%%s%%' 命中 %d 条" % (KW, hit))
        for r in c.execute('select c1,c4,c5,c6,c0 from "%s" where c0 like ? limit 3' % t,
                           ("%" + KW + "%",)):
            print("         命中样例 local_id=%s session=%s sender=%s ct=%s  %r"
                  % (r[0], r[1], r[2], r[3], r[4][:120]))

    print("\n" + "=" * 78)
    print("B) 外部内容表的图片索引：ImgFtsAux*V0.acontent 是什么？")
    for t in [r[0] for r in c.execute(
            "select name from sqlite_master where type='table' and name like 'ImgFtsAux%V0'")]:
        n = c.execute('select count(*) from "%s"' % t).fetchone()[0]
        print("\n  %s 行数=%d" % (t, n))
        for r in c.execute('select acontent, message_local_id, session_id, create_time '
                           'from "%s" limit 3' % t):
            print("     ", repr(r)[:300])

    print("\n" + "=" * 78)
    print("C) `_idx.term` 的分词粒度（MMFtsTokenizer 的产物）")
    for t in ("message_fts_v4_0_idx", "ImgFts0V0_idx"):
        try:
            rows = c.execute('select term from "%s" limit 40' % t).fetchall()
        except Exception as e:                                      # noqa: BLE001
            print("  %s: %s" % (t, e)); continue
        print("\n  %s 前 40 个 term：" % t)
        print("     " + " | ".join(str(r[0]) for r in rows))
        n = c.execute('select count(distinct term) from "%s"' % t).fetchone()[0]
        print("     去重 term 总数=%d" % n)

    print("\n" + "=" * 78)
    print("D) 与主库对账：`_content` 覆盖了多少条消息")
    tabs = [r[0] for r in c.execute(
        "select name from sqlite_master where type='table' and name like 'message_fts_v4_%_content'")]
    tot = sum(c.execute('select count(*) from "%s"' % t).fetchone()[0] for t in tabs)
    print("  自包含分片：%s ⇒ 合计 %d 条" % (tabs, tot))
    aux = [r[0] for r in c.execute(
        "select name from sqlite_master where type='table' and name like 'ImgFtsAux%V0'")]
    if aux:
        it = sum(c.execute('select count(*) from "%s"' % t).fetchone()[0] for t in aux)
        print("  图片识别文本：%s ⇒ 合计 %d 条" % (aux, it))
    for t in ("ImgFtsV0", "ImgRangeV0", "deleteImgFtsV0", "ImgTableInfo"):
        try:
            print("  %s 行数=%d" % (t, c.execute('select count(*) from "%s"' % t).fetchone()[0]))
        except Exception:                                           # noqa: BLE001
            pass
    c.close()


if __name__ == "__main__":
    main()
