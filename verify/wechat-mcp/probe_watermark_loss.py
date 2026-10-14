"""水位丢失的**真机量化**：只读解密镜像，不复现、不改任何东西。

问的是两个问题：
  ① 旧语义（`create_time > 水位`）在真机的历史流上到底丢多少？（水位是"见过的最大 ts"，
     而 `create_time` 只到秒 ⇒ 同一秒里晚到的那些会被永久关在门外）
  ② 新语义（补 `create_time = 水位 AND local_id > 上次扫描时的最大 local_id`）是不是**一条不漏、
     且一条不重**？

方法：拿每个会话表按 `local_id`（插入序，AUTOINCREMENT）重放一遍，在**每一个插入点之后**都假定
放过一次 poll（这是对"丢失"的**上界**：轮询再密也不会更密了），按两套语义各推一遍水位。
真机轮询节奏是秒级、比"每次都轮询"稀疏得多，所以实际值在两端之间；这里给上界与曲线。

⚠️ 结论只对"表内"成立：真实 `poll` 的水位是**跨会话全局**的，还会受 `per` 截断影响（那条已由
满量放大修掉、并有 `test_watch.py::b5` 锁）。本探针量的是**时间维度**那一半。

用法：
  set PYTHONIOENCODING=utf-8
  ~/.lumii/runtimes/python-embed/python.exe verify/wechat-mcp/probe_watermark_loss.py [--every N]
"""
import argparse
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "..",
                                                "apps", "windows", "resources", "wechat-mcp")))

import wechat_core as core  # noqa: E402


def rows_of(c, tbl):
    """(create_time, local_id) 按 local_id 升序 = 插入序。"""
    return list(c.execute(f'select create_time, local_id from [{tbl}] order by local_id'))


def _bucket(lag):
    return 0 if lag <= 0 else 1 if lag <= 5 else 2 if lag <= 60 else 3 if lag <= 86400 else 4


BUCKETS = ("同一秒(差 0s)", "≤5s", "≤60s", "≤1天", ">1天")


def replay(rows, every):
    """按两套语义各推一遍水位。返回 (旧丢的分档, 新丢的分档, 新重复数, 总行数)。

    `every`：每 N 次插入之后放一次 poll（1 = 每个插入点都放，即丢失的上界）。

    **必须按"每次 poll 扫一次"来建模**，不能按行逐条判定：真实 `poll` 是**一次扫描**对当时已有的
    全部行施加**同一条**规则（用的是扫描**前**的水位、扫完才推水位）。逐行判定会把"水位在这一批
    里自己涨了"算成漏判，凭空造出假丢失。

    **丢的条要按"晚到了多久"分档**，否则数字会骗人：新语义放弃的那批绝大多数是**历史回填**
    （ts 落后水位几分钟到几天，见 `_rows_full_conn` 的取舍），那是**故意不送**的，不是丢失；
    真正算"丢失"的是**同一秒（差 0s）**那一档——消息刚到、时间戳却和已送过的一样。
    """
    old_drop, new_drop, dup = [0] * 5, [0] * 5, 0
    W_old, seen_old, cut_old = 0, set(), None
    W_new, seen_new, cut_new = 0, set(), None
    start = 0
    for end in sorted(set(list(range(every, len(rows) + 1, every)) + [len(rows)])):
        batch = rows[start:end]              # 本次 poll 能看到的全部行
        start = end
        if not batch:
            continue
        # 旧语义：水位 = 见过的最大 ts；只认 create_time > 扫描前的水位
        hit = [r for r in batch if r[0] > W_old]
        for _ts, lid in hit:
            seen_old.add(lid)
        W_old = max([W_old] + [r[0] for r in hit])
        for ts, lid in batch:
            if lid not in seen_old:          # 同一秒里晚到的 ⇒ 永久取不到
                old_drop[_bucket(W_old - ts)] += 1
        # 新语义：额外认「create_time == 水位 且 local_id > 上次扫描时的最大 local_id」
        hit = [r for r in batch
               if r[0] > W_new or (r[0] == W_new and cut_new is not None and r[1] > cut_new)]
        for _ts, lid in hit:
            if lid in seen_new:
                dup += 1
            seen_new.add(lid)
        W_new = max([W_new] + [r[0] for r in hit])
        for ts, lid in batch:
            if lid not in seen_new:
                new_drop[_bucket(W_new - ts)] += 1
        cut_old = batch[-1][1]               # 扫描时的逐分片最大 local_id（= 最后一行）
        cut_new = cut_old
    return old_drop, new_drop, dup, len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--every", type=int, default=1,
                    help="每 N 次插入放一次 poll（1=上界，5/10=更接近真机节奏）")
    a = ap.parse_args()

    core._refresh()
    paths, tables = core._cache["msg"], core._cache["tables"]
    names = core.names()
    tot = dup = 0
    o = [0] * 5
    n_ = [0] * 5
    worst = []
    for p in paths:
        try:
            c = sqlite3.connect("file:" + p + "?mode=ro", uri=True)
        except Exception:
            continue
        for tbl in tables.get(p, ()):
            try:
                rows = rows_of(c, tbl)
            except Exception:
                continue
            if len(rows) < 2:
                continue
            do, dn, dd, n = replay(rows, a.every)
            tot += n
            dup += dd
            o = [x + y for x, y in zip(o, do)]
            n_ = [x + y for x, y in zip(n_, dn)]
            if do[0]:
                worst.append((do[0], names.get(tbl, tbl)[:26], n))
        c.close()

    def line(tag, b):
        cells = "  ".join(f"{BUCKETS[i]}={b[i]}" for i in range(5) if b[i])
        return f"  {tag}t {sum(b):>4} 条   {cells or '（无）'}"

    print(f"轮询密度：每 {a.every} 次插入一拍（1 = 上界；真机是秒级节奏，比这稀疏）")
    print(f"消息行 {tot}")
    print(line("旧语义（create_time > 水位）", o))
    print(line("新语义（+ 水位那一秒按 local_id 续读）", n_))
    print(f"新语义重复 {dup} 条")
    if worst:
        print("  旧语义真丢（同一秒）最多的会话：")
        for k, nm, n in sorted(worst, reverse=True)[:6]:
            print(f"    {k:>3}/{n:<4} {nm}")
    ok = n_[0] == 0 and dup == 0
    print(f"\n判据：**同一秒那一档必须为 0**（那才是真丢失）；其余档是历史回填，属刻意不送。")
    print(f"  旧语义真丢 {o[0]} 条 → 新语义真丢 {n_[0]} 条，重复 {dup} 条 ⇒ "
          + ("通过" if ok else "**未通过**"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
