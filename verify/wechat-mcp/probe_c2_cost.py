# -*- coding: utf-8 -*-
"""C2 的真实形状：只数 1:1 会话根本不够（本机 2520 好友里只有 45 个有 1:1 会话），
真正该数的是「**这个人最后一次说话是什么时候**」——跨全部会话（含群）。

这一跑回答三件事：
  ① 全库消息总量、以及"按发送者聚合最后时间"的耗时（C2 能不能实时做，还是要落缓存）；
  ② 换成"发送者维度"之后，有多少人有活动（对比 1:1 视角的 45）；
  ③ 顺带补上群内昵称的**非空**覆盖率（上一跑被 sed 截掉了）。

只读；跑法：PYTHONIOENCODING=utf-8 python probe_c2_cost.py
"""
import os
import shutil
import sqlite3
import sys
import time
from collections import defaultdict

sys.path.insert(0, r"C:\myself\projects\my\open-source\lumii\apps\windows\resources\wechat-mcp")
sys.path.insert(0, r"C:\myself\projects\my\open-source\lumii\apps\windows\resources\wechat-crm-mcp")
import contactscore as C                                            # noqa: E402
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
    fts = mirror("contact/contact_fts.db")
    cdb = mirror("contact/contact.db")
    wc._refresh()                                                   # noqa: SLF001

    # ---------- ③ 群内昵称非空覆盖率 ----------
    f = ro(fts)
    id2name = dict(f.execute("select rowid, username from name2id"))
    nick = defaultdict(dict)
    n_all = n_ok = 0
    for c0, c1, c2 in f.execute("select c0, c1, c2 from chatroom_member_fts_v3_content"):
        n_all += 1
        if (c0 or "").strip():
            n_ok += 1
            nick[id2name.get(c1)][id2name.get(c2)] = c0.strip()
    print("群内昵称：content 表 %d 行，**非空 c0 = %d（%.1f%%）**，覆盖 %d 个群"
          % (n_all, n_ok, 100.0 * n_ok / max(1, n_all), len(nick)))
    f.close()
    c = ro(cdb)
    disp = {u: (r or n or u) for u, r, n in
            c.execute("select username, remark, nick_name from contact")}
    idof = {i: u for i, u in c.execute("select id, username from contact")}
    per_group = []
    for g, d in nick.items():
        if not g or not g.endswith("@chatroom"):
            continue
        mem = [idof.get(m) for (m,) in c.execute(
            "select member_id from chatroom_member where room_id="
            "(select id from contact where username=?)", (g,))]
        mem = [m for m in mem if m]
        per_group.append((disp.get(g, g), len(d), len(mem)))
    for label, srt in (("高", lambda x: -x[1] / max(1, x[2])), ("低", lambda x: x[1] / max(1, x[2]))):
        print("  非空率%s：%s" % (label, [(n[:16], "%d/%d" % (k, m))
                                        for n, k, m in sorted(per_group, key=srt)[:3]]))
    c.close()

    # ---------- ① 全量 + 按发送者聚合的耗时 ----------
    print("\n# 全库消息量与「按发送者聚合」的耗时")
    total = 0
    t0 = time.time()
    last = defaultdict(int)
    cnt = defaultdict(int)
    per_tbl = []
    for sh in wc._cache["msg"]:                                     # noqa: SLF001
        con = ro(sh)
        try:
            smap = wc._cache["senders"].get(sh, {})                 # noqa: SLF001
            for tbl in wc._cache["tables"].get(sh, ()):             # noqa: SLF001
                ta = time.time()
                n = 0
                for sid, mx, c2 in con.execute(
                        "select real_sender_id, max(create_time), count(*) from [%s] "
                        "group by real_sender_id" % tbl):
                    u = smap.get(sid, "")
                    if u:
                        last[u] = max(last[u], mx or 0)
                        cnt[u] += c2
                    n += c2
                total += n
                per_tbl.append((time.time() - ta, tbl, n))
        finally:
            con.close()
    dt = time.time() - t0
    print("消息总量 %d 条，%d 个会话表；**按发送者聚合全库共用 %.1fs**"
          % (total, len(per_tbl), dt))
    print("  最慢 5 个表：%s" % [(round(t, 2), tb, n)
                                for t, tb, n in sorted(per_tbl, reverse=True)[:5]])

    # ---------- ② 发送者维度 vs 1:1 维度 ----------
    print("\n# 有活动的人：发送者维度 vs 1:1 维度")
    friends = [u for u in disp if C.kind_of(u) == "friend"]
    tables = {t for sh, ts in wc._cache["tables"].items() for t in ts}   # noqa: SLF001
    one2one = [u for u in friends if wc.tbl_of(u) in tables]
    by_sender = [u for u in friends if last.get(u)]
    print("好友 %d ｜ 有 1:1 会话 %d ｜ **发过言（含群里）%d** ｜ 两者都没 %d"
          % (len(friends), len(one2one), len(by_sender), len(friends) - len(by_sender)))
    now = int(time.time())
    bk = {"0-7天": 0, "8-30天": 0, "31-60天": 0, "61-90天": 0, "90天以上": 0}
    for u in by_sender:
        d = (now - last[u]) / 86400
        for k, hi in (("0-7天", 7), ("8-30天", 30), ("31-60天", 60), ("61-90天", 90)):
            if d <= hi:
                bk[k] += 1
                break
        else:
            bk["90天以上"] += 1
    print("按最后发言时间分层：%s" % bk)
    print("样例（久未出现者）：%s" % [(disp.get(u, u)[:12], cnt[u],
                                     time.strftime("%Y-%m-%d", time.localtime(last[u])))
                                    for u in sorted(by_sender, key=lambda x: last[x])[:5]])
    print("  ⚠️ 口径提醒：'最后一次发言'含群聊，与'我们的私聊最后一次'是**两个不同的数**，"
          "两个都要给，别混。")


if __name__ == "__main__":
    main()
