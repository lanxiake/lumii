# -*- coding: utf-8 -*-
"""`read_history` 的翻页游标会不会**静默丢消息**？（只读，不碰微信任何状态）

`history()` 的 `cursor` 是本页**最老一条的 ts**，下一页用 `create_time < cursor` 取。
`create_time` **只到秒** —— 于是「和本页最老那条同一秒、但它更早」的消息**永远取不到**：
`< cursor` 把它们挡在外面，而不翻页又看不到它们。这和 §9.12 ① 是**同一类** bug
（秒级水位 + 一个比较运算符），只不过那条在 `poll`（已被 local_id 补集修掉），
这条在**读取/导出**路径上。

判据不看推理看对账：拿真库逐表**模拟一遍翻页**，把"翻页取到的 local_id 集合"与
"全量取到的集合"作差 —— 差集就是丢的。

跑法：PYTHONIOENCODING=utf-8 ~/.lumii/runtimes/python-embed/python.exe probe_history_cursor_gap.py [limit]
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.abspath(os.path.join(HERE, "..", "..", "apps", "windows", "resources"))
for _p in (os.path.join(RES, "wechat-mcp"),):
    sys.path.insert(0, _p)

import wechat_core as core      # noqa: E402


def page_ids(tbl, limit, cap=400, pad=True):
    """照 `history()` 的算法翻页，返回 [(local_id, ct)] 列表（升序去重前的原始流）。

    `pad=False` 走**修复前**的行为（不补秒），用来做前后对照。
    """
    seen, before, pages = [], 0, 0
    while pages < cap:
        rows = core._rows_full(tbl, limit, before=before)     # desc
        if pad:
            rows = core._pad_page(tbl, rows, limit)
        if not rows:
            break
        pages += 1
        for r in rows:
            seen.append((r[4], r[0]))                          # (local_id, create_time)
        cursor = min(r[0] for r in rows)                       # = msgs[0]["ts"]（反转后最老一条）
        if len(rows) < limit:
            break
        if before == cursor:                                   # 卡住就停，别空转
            break
        before = cursor
    return seen, pages


def all_ids(tbl):
    rows = core._rows_full(tbl, 10 ** 9)
    return [(r[4], r[0]) for r in rows]


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                          # noqa: BLE001
        pass
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 10

    core._refresh()
    tables = []
    for p in core._cache["msg"]:
        for t in sorted(core._cache["tables"].get(p, ())):
            tables.append(t)
    print("会话表 %d 张；翻页 limit=%d（= read_history 的默认）\n" % (len(tables), limit))

    worst = []
    tot_msgs = tot_lost = tot_lost_new = 0
    for tbl in tables:
        try:
            full = all_ids(tbl)
        except Exception:                                      # noqa: BLE001
            continue
        if len(full) <= limit:
            continue
        got, pages = page_ids(tbl, limit, pad=False)
        gset = set(got)
        lost = [x for x in full if x not in gset]
        tot_msgs += len(full)
        tot_lost += len(lost)
        if lost:
            worst.append((len(lost), tbl, len(full), pages))
        got2, _ = page_ids(tbl, limit, pad=True)
        tot_lost_new += len([x for x in full if x not in set(got2)])

    # 机制侧的数：同一秒最多挤了多少条（这是"丢"的必要条件）
    print("【机制】同一 `create_time` 里最多挤了多少条（抽查前 40 张表）")
    mx = []
    for tbl in tables[:40]:
        try:
            rows = core._rows_full(tbl, 10 ** 9)
        except Exception:                                      # noqa: BLE001
            continue
        from collections import Counter
        c = Counter(r[0] for r in rows)
        if c:
            mx.append((c.most_common(1)[0][1], len(rows), tbl, len([1 for v in c.values() if v > 1])))
    mx.sort(reverse=True)
    for top, n, tbl, multi in mx[:8]:
        print("   %-46s 共 %5d 条，最挤的一秒 %2d 条，有 %3d 个秒是多条" % (tbl, n, top, multi))
    print("   （同秒最多几条第 1 名/中位：%s / %s）"
          % (mx[0][0] if mx else "-", mx[len(mx) // 2][0] if mx else "-"))

    print("\n【对账】逐表模拟翻页：翻页集合 vs 全量集合")
    worst.sort(reverse=True)
    if not worst:
        print("   0 张表丢 —— 本机这套数据下没丢（不等于没这个 bug：要有同秒多条才触发）")
    for n, tbl, total, pages in worst[:15]:
        print("   %-46s 丢 %3d / %5d 条（翻 %d 页）" % (tbl, n, total, pages))
    print("\n合计：%d 张表丢，共丢 %d / %d 条（%.2f%%）"
          % (len(worst), tot_lost, tot_msgs, 100.0 * tot_lost / tot_msgs if tot_msgs else 0))
    print("补秒后（`_pad_page` 生效）：共丢 %d / %d 条" % (tot_lost_new, tot_msgs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
