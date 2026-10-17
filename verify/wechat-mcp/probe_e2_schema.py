"""E2 + E1 收尾：一次只读探针，回答四个还没定论的问题。

1. **检索能不能换成客户端自己的 FTS**（报告 §9.4）：`message_fts_v4_*_content` 覆盖了主库的
   多少条、覆盖的是哪一类消息、session_id 怎么映射回 username。
2. **视频/文件的 md5 → 本地文件名映射**（报告 §9.8）：`hardlink.db` / `message_resource.db` /
   `media_0.db` 里有没有同构的表。
3. **群内昵称**（四件套设计 §8 backlog）：`contact_fts.db` 的
   `chatroom_member_fts_v3(acontent=a_group_remark, room_id, member_id)` 是不是就是群内称呼，
   room_id/member_id 怎么映射回 username。
4. **联系人检索字段**：`contact_fts_v5_content.c0` 的 `\x08` 分段到底是什么。

全程只读：只复制到临时镜像目录再解密，不碰微信原始文件。
跑法：PYTHONIOENCODING=utf-8 ~/.lumii/runtimes/python-embed/python.exe probe_e2_schema.py
"""
import os
import re
import shutil
import sqlite3
import sys

MCP = r"C:\myself\projects\my\open-source\lumii\apps\windows\resources\wechat-mcp"
sys.path.insert(0, MCP)

import wechat_core as wc                                            # noqa: E402


def con(p):
    return sqlite3.connect("file:%s?mode=ro" % p.replace("\\", "/"), uri=True)


def plain(km, root, rel):
    """解密一次；目标被占用时清掉镜像目录重来（Windows os.replace 的已知坑）。"""
    try:
        return wc._plain(km, root, rel)                             # noqa: SLF001
    except PermissionError:
        d = wc.MIRROR_DIR
        if os.path.isdir(d):
            shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d, exist_ok=True)
        return wc._plain(km, root, rel)                             # noqa: SLF001


def shape(rel, km, root, limit=4):
    print("\n" + "=" * 78)
    print("### %s" % rel)
    c = con(plain(km, root, rel))
    rows = c.execute("select type, name, sql from sqlite_master order by type, name").fetchall()
    for typ, name, sql in rows:
        if typ == "table" and sql and "VIRTUAL TABLE" not in sql.upper():
            print("  [table] %s" % name)
            print("      " + sql.replace("\n", "\n      ")[:900])
    for typ, name, _sql in rows:
        if typ != "table":
            continue
        try:
            n = c.execute('select count(*) from "%s"' % name).fetchone()[0]
        except Exception as e:                                      # noqa: BLE001
            print("      %-34s 读不了（%s）" % (name, str(e)[:60]))
            continue
        cols = [r[1] for r in c.execute('pragma table_info("%s")' % name)]
        print("  → %-34s 行=%-7d 列=%s" % (name, n, cols))
        if n and limit:
            for r in c.execute('select * from "%s" limit %d' % (name, limit)):
                print("       " + repr(r)[:260])
    c.close()          # ⚠️ 必须关：留着连接会让后面同库的 _plain 在 os.replace 上 PermissionError
    return None


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                               # noqa: BLE001
        pass
    root = wc.db_root()
    km = wc.keys(root)
    rels = {os.path.basename(r).lower(): r.replace("\\", "/") for _k, r in km.values()}
    print("数据根目录：%s" % root)

    # ---------- ① 检索：FTS 覆盖率 ----------
    print("\n" + "#" * 78)
    print("# ① message_fts 覆盖了主库的多少")
    print("#" * 78)
    main_rel = next(v for k, v in rels.items() if re.match(r"^message_\d+\.db$", k))
    fts_rel = rels["message_fts.db"]
    print("主库 = %s ；FTS 库 = %s" % (main_rel, fts_rel))
    m = con(plain(km, root, main_rel))
    per = {}
    for t, in m.execute("select name from sqlite_master where type='table' and name like 'Msg_%'"):
        n, mn, mx = m.execute('select count(*), min(local_id), max(local_id) from "%s"' % t).fetchone()
        per[t] = (n, mn, mx)
    total = sum(v[0] for v in per.values())
    print("主库消息总数 = %d（%d 张 Msg_* 表）" % (total, len(per)))

    f = con(plain(km, root, fts_rel))
    id2name = {r[0]: r[1] for r in f.execute("select rowid, username from name2id")}
    print("FTS 库 name2id %d 条，样例 rowid→username：%s"
          % (len(id2name), list(id2name.items())[:3]))
    by_sid = {}
    dist = {}
    tmin, tmax = None, None
    for t, in f.execute("select name from sqlite_master where type='table' "
                        "and name like 'message_fts_v4_%_content'"):
        for lid, ct, lt, sid in f.execute('select c1, c6, c3, c4 from "%s"' % t):
            by_sid.setdefault(sid, set()).add(lid)
            dist[lt] = dist.get(lt, 0) + 1
            tmin = ct if tmin is None else min(tmin, ct)
            tmax = ct if tmax is None else max(tmax, ct)
    covered = sum(len(v) for v in by_sid.values())
    print("FTS 覆盖 %d 条 / 主库 %d 条 ⇒ %.1f%%" % (covered, total, 100.0 * covered / total if total else 0))
    print("时间范围 %s .. %s" % (tmin, tmax))
    print("local_type 分布（前 12）：%s" % sorted(dist.items(), key=lambda x: -x[1])[:12])
    print("\n逐 session 对账（FTS 的 local_id 集合 vs 对应 Msg_<md5> 表）：")
    for sid in sorted(by_sid):
        name = id2name.get(sid, "?")
        tbl = "Msg_" + wc.tbl_of(name) if hasattr(wc, "tbl_of") else None
        n, mn, mx = per.get(tbl, (None, None, None))
        ids = by_sid[sid]
        print("  session_id=%-4s %-28s FTS %5d 条 local_id %s..%s ｜ 主库表 %s 行=%s %s..%s"
              % (sid, name[:28], len(ids), min(ids), max(ids), tbl, n, mn, mx))
    m.close()
    f.close()

    # ---------- ② 视频/文件 md5 → 本地文件名 ----------
    print("\n" + "#" * 78)
    print("# ② 媒体/文件映射表")
    print("#" * 78)
    for rel in ("hardlink/hardlink.db", "message/message_resource.db",
                "message/weclaw.db"):
        if rel in rels.values():
            shape(rel, km, root)
    shape("message/media_0.db", km, root)

    # ---------- ③ 群内昵称 ----------
    print("\n" + "#" * 78)
    print("# ③ 群内昵称（contact_fts.db → chatroom_member_fts_v3）")
    print("#" * 78)
    cf = con(plain(km, root, rels["contact_fts.db"]))
    cid2name = {r[0]: r[1] for r in cf.execute("select rowid, username from name2id")}
    n_mem = cf.execute("select count(*) from chatroom_member_fts_v3_content").fetchone()[0]
    print("chatroom_member_fts_v3_content 行=%d ；name2id 行=%d" % (n_mem, len(cid2name)))
    for r in cf.execute("select c0, c1, c2 from chatroom_member_fts_v3_content limit 6"):
        print("   昵称=%-14s room_id=%s(%s) member_id=%s(%s)"
              % (r[0], r[1], cid2name.get(r[1], "?")[:24], r[2], cid2name.get(r[2], "?")[:24]))
    print("  群里人数 top5：%s" % cf.execute(
        "select c1, count(*) c from chatroom_member_fts_v3_content "
        "group by c1 order by c desc limit 5").fetchall())
    print("  同一个人在不同群的名字不同？样例 member 出现于多个群：%s" % cf.execute(
        "select c2, count(*) c, group_concat(c0, '|') from chatroom_member_fts_v3_content "
        "group by c2 having c > 1 limit 5").fetchall())
    # 群成员总数对账：主通讯录
    ct = con(plain(km, root, rels["contact.db"]))
    for t, in ct.execute("select name from sqlite_master where type='table' "
                         "and name in ('chatroom_member','chat_room','contact_label','contact')"):
        n = ct.execute('select count(*) from "%s"' % t).fetchone()[0]
        cols = [r[1] for r in ct.execute('pragma table_info("%s")' % t)]
        print("  contact.db %-18s 行=%-6d 列=%s" % (t, n, cols))
    print("  contact_label 内容：%s" % ct.execute("select * from contact_label limit 8").fetchall())
    ct.close()

    # ---------- ④ 联系人检索字段 ----------
    print("\n" + "#" * 78)
    print("# ④ contact_fts_v5_content 的字段构成")
    print("#" * 78)
    for r, in cf.execute("select c0 from contact_fts_v5_content limit 10"):
        print("   %r  →  split: %s" % (r[:80], [x for x in (r or "").split("\x08") if x]))
    print("  contact.db 前 6 人的 (nick_name, remark, alias, city)（对账 c0 里的段）：")
    ct2 = con(plain(km, root, rels["contact.db"]))
    cols = [r[1] for r in ct2.execute('pragma table_info("contact")')]
    keep = [c for c in ("username", "nick_name", "remark", "alias", "city", "local_type") if c in cols]
    for r in ct2.execute('select %s from contact limit 6' % ",".join('"%s"' % c for c in keep)):
        print("   ", r)
    ct2.close()
    cf.close()

    # ---------- ⑤ hardlink 表 → 磁盘路径 ----------
    print("\n" + "#" * 78)
    print("# ⑤ `*_hardlink_info_v4` 能不能定位到磁盘上的真实文件")
    print("#" * 78)
    user_dir = os.path.dirname(root.rstrip("\\/"))          # …\<wxid>_<hex>
    on_disk = {}
    for sub in ("msg/file", "msg/video", "msg/attach"):
        base = os.path.join(user_dir, sub.replace("/", os.sep))
        for mth in (os.listdir(base) if os.path.isdir(base) else []):
            d = os.path.join(base, mth)
            if not os.path.isdir(d):
                continue
            for f in os.listdir(d):
                on_disk.setdefault(f.lower(), []).append(os.path.join(sub, mth, f))
    print("磁盘上 msg/{file,video,attach} 共 %d 个文件" % len(on_disk))
    for rel, key in (("hardlink/hardlink.db", "file_hardlink_info_v4"),
                     ("hardlink/hardlink.db", "video_hardlink_info_v4"),
                     ("hardlink/hardlink.db", "image_hardlink_info_v4")):
        h = con(plain(km, root, rel))
        rows = h.execute('select md5, file_name, file_size, dir1, dir2 from "%s"' % key).fetchall()
        hit = [r for r in rows if r[1].lower() in on_disk]
        print("\n  %s：%d 行 → 磁盘命中 %d（%.1f%%）"
              % (key, len(rows), len(hit), 100.0 * len(hit) / len(rows) if rows else 0))
        for r in rows[:3]:
            print("     dir1=%-3s dir2=%-3s 大小=%-9s %s → %s"
                  % (r[3], r[4], r[2], r[1][:52], on_disk.get(r[1].lower(), ["（磁盘上没有）"])[0]))
        miss = [r for r in rows if r[1].lower() not in on_disk][:3]
        for r in miss:
            print("     ✗ 未命中 dir1=%-3s dir2=%-3s 大小=%-9s %s" % (r[3], r[4], r[2], r[1][:52]))
        # dir1/dir2 与月目录的对应
        corr = sorted({(r[3], (on_disk.get(r[1].lower()) or ["?\\?\\?"])[0].replace("/", "\\").split("\\")[1])
                       for r in hit})
        print("     (dir1, 命中的月目录) 对照：%s" % corr[:12])
        h.close()


if __name__ == "__main__":
    main()
