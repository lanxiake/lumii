# -*- coding: utf-8 -*-
"""切片 2 的前置实测：C1 群内昵称可不可用、C2 沉默分层的数据面长什么样。

三个问题，都是写代码前必须先用真库回答的：
  ① `contact_fts.db.chatroom_member_fts_v3_content` 的 (c0,c1,c2) 到底是不是
     (群内昵称, 群id, 成员id)，**用我自己的群**对一遍名（猜错会张冠李戴）。
  ② 覆盖率：我所在的群里，成员有多少比例**有**群内昵称？——没有的比例决定 UI 怎么标"缺失"。
  ③ C2：好友里"从来没聊过"的有多少人（现在 `interaction_rank` 完全看不见他们），
     以及有消息的那些人按 30/60/90 天分层的分布。

只读：只复制到临时镜像再解密，不碰微信原始文件。
跑法：PYTHONIOENCODING=utf-8 ~/.lumii/runtimes/python-embed/python.exe probe_c1_c2.py
"""
import os
import shutil
import sqlite3
import sys
import time

MCP = r"C:\myself\projects\my\open-source\lumii\apps\windows\resources\wechat-mcp"
CRM = r"C:\myself\projects\my\open-source\lumii\apps\windows\resources\wechat-crm-mcp"
sys.path.insert(0, MCP)
sys.path.insert(0, CRM)

import contactscore as C                                            # noqa: E402
import wechat_core as wc                                            # noqa: E402


def ro(path):
    return sqlite3.connect("file:%s?mode=ro" % path.replace("\\", "/"), uri=True)


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

    # ⚠️ 所有会触发镜像刷新的调用**先做完**，再开连接（Windows 不能替换已打开的文件）
    fts = mirror("contact/contact_fts.db")
    cdb = mirror("contact/contact.db")
    wc._refresh()                                                   # noqa: SLF001
    names, me = wc.names(), wc.self_wxid()
    tables = {t for sh, ts in wc._cache["tables"].items() for t in ts}   # noqa: SLF001

    # ---------- ① + ② 群内昵称 ----------
    print("#" * 78)
    print("# ① 群内昵称：字段语义 / 覆盖 / 命中率")
    print("#" * 78)
    f = ro(fts)
    t = [r[0] for r in f.execute(
        "select name from sqlite_master where type='table' and name like 'chatroom_member_fts%'")]
    print("FTS 表：%s" % t)
    id2name = dict(f.execute("select rowid, username from name2id"))
    nick = {}
    for c0, c1, c2 in f.execute("select c0, c1, c2 from chatroom_member_fts_v3_content"):
        nick.setdefault(id2name.get(c1, "?%s" % c1), {})[id2name.get(c2, "?%s" % c2)] = c0
    print("chatroom_member_fts_v3_content → %d 个群 / %d 条称呼"
          % (len(nick), sum(len(v) for v in nick.values())))
    print("id2name 覆盖 %d 个 id" % len(id2name))

    c = ro(cdb)
    disp = {u: (r or n or u) for u, r, n in
            c.execute("select username, remark, nick_name from contact")}
    idof = {i: u for i, u in c.execute("select id, username from contact")}
    print("contact.db：%d 人 ｜ chatroom_member %d 行"
          % (disp and len(disp) or 0, c.execute("select count(*) from chatroom_member").fetchone()[0]))

    groups = [u for u in disp if u.endswith("@chatroom")]
    hit_g = [g for g in groups if nick.get(g)]
    print("我在 %d 个群，其中有群内昵称数据的 %d 个（%.1f%%）"
          % (len(groups), len(hit_g), 100.0 * len(hit_g) / max(1, len(groups))))

    tot = hitn = 0
    rows_per_group = []
    for g in hit_g:
        members = [idof.get(m) for (m,) in
                   c.execute("select member_id from chatroom_member where room_id="
                             "(select id from contact where username=?)", (g,))]
        members = [m for m in members if m]
        # ⚠️ 覆盖率要数**非空**的 c0：1980 行是"每个成员一行"，不是"每人都有群内昵称"。
        # 用行数算覆盖率会得出 100% 的假象（我第一版就是这么错的）。
        h = sum(1 for m in members if (nick.get(g, {}).get(m) or "").strip())
        tot += len(members); hitn += h
        rows_per_group.append((g, h, len(members)))
    print("成员维度：%d 人次里 %d 有**非空**群内昵称（%.1f%%）"
          % (tot, hitn, 100.0 * hitn / max(1, tot)))
    print("  按群看非空率（top/bottom 各 4）：")
    for g, h, n in sorted(rows_per_group, key=lambda x: -x[1] / max(1, x[2]))[:4]:
        print("     高 %-30s %d/%d" % (disp.get(g, g)[:30], h, n))
    for g, h, n in sorted(rows_per_group, key=lambda x: x[1] / max(1, x[2]))[:4]:
        print("     低 %-30s %d/%d" % (disp.get(g, g)[:30], h, n))

    print("\n抽样 4 个群（群内昵称 vs 全局显示名），**自己判一眼有没有张冠李戴**：")
    for g in sorted(hit_g, key=lambda x: -len(nick[x]))[:4]:
        print("  群「%s」 %d 条称呼：" % (disp.get(g, g)[:28], len(nick[g])))
        for u, n in list(nick[g].items())[:5]:
            print("     群内=%-16s 全局=%-16s 同一个人? %s"
                  % (n[:16], disp.get(u, u)[:16], u in disp))
    # 反例：群内昵称与自己无关的情况（id 解错会表现为大量 '?xxx'）
    bad = [u for v in nick.values() for u in v if u.startswith("?")]
    print("  解析不出的 id：%d 个（0 才说明 name2id 全覆盖）" % len(bad))
    c.close(); f.close()

    # ---------- ③ C2 沉默分层 ----------
    print("\n" + "#" * 78)
    print("# ② C2 沉默分层的数据面")
    print("#" * 78)
    friends = [u for u in disp if C.kind_of(u) == "friend"]
    withmsg = [u for u in friends if wc.tbl_of(u) in tables]
    print("好友 %d 人 ｜ 其中有消息会话的 %d ｜ **从没聊过的 %d**（现在完全不可见）"
          % (len(friends), len(withmsg), len(friends) - len(withmsg)))
    now = int(time.time())
    buckets = {"0-7天": 0, "8-30天": 0, "31-60天": 0, "61-90天": 0, "90天以上": 0}
    for u in withmsg:
        tbl = wc.tbl_of(u)
        last = 0
        for sh in wc._cache["msg"]:                                 # noqa: SLF001
            if tbl not in wc._cache["tables"].get(sh, ()):          # noqa: SLF001
                continue
            con = ro(sh)
            try:
                r = con.execute('select max(create_time) from [%s]' % tbl).fetchone()
                last = max(last, (r and r[0]) or 0)
            finally:
                con.close()
        d = (now - last) / 86400 if last else 9999
        for k, hi in (("0-7天", 7), ("8-30天", 30), ("31-60天", 60), ("61-90天", 90)):
            if d <= hi:
                buckets[k] += 1
                break
        else:
            buckets["90天以上"] += 1
    print("按最后互动时间分层：%s" % buckets)
    print("（'从没聊过'那 %d 人是**跨产品可用**的分层素材，但要注意：没聊过 ≠ 不是客户，"
          "只报原话与时间戳，判断归 LLM）" % (len(friends) - len(withmsg)))


if __name__ == "__main__":
    main()
