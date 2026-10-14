"""A2（占用分析 `disk_usage`）落地前先量：**磁盘上到底有什么、值不值得做一个工具**。

只读。回答四个问题（少一个都可能把工具设计错）：

1. 账号目录里各子树的**实际占用**——如果总量只有 50 MB，这个工具就没有存在的必要；
2. `msg/file` 按**年月**的分布（微信自己就是按月建目录的）；
3. **可归属率**：磁盘文件里有多少能靠「消息 title + 大小」匹配回某个会话
   ——A2/A3 的「按会话排行」**只能**建在这个之上，目录结构里没有会话信息；
4. 走一遍要多久（§3.6 的扫描成本要在设计里有个数）。

跑法：`PYTHONIOENCODING=utf-8 python probe_disk_usage.py`
"""
import collections
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(os.path.dirname(os.path.dirname(HERE)), "apps", "windows", "resources")
for p in (os.path.join(RES, "wechat-mcp"), os.path.join(RES, "wechat-file-mcp")):
    sys.path.insert(0, p)

import wechat_core as core                            # noqa: E402
import filecore as F                                  # noqa: E402


def _mb(n):
    return f"{n / 1048576:.1f} MB"


def subtree_sizes(root, depth=1):
    """`root` 下各子树（默认一层）的体积与文件数——只 walk 一次，别每个子树重扫。"""
    agg = collections.defaultdict(lambda: [0, 0])     # name -> [bytes, files]
    for dp, _dirs, fs in os.walk(root):
        rel = os.path.relpath(dp, root)
        top = rel.split(os.sep)[0] if rel != "." else "(根)"
        for f in fs:
            try:
                n = os.path.getsize(os.path.join(dp, f))
            except OSError:
                continue
            agg[top][0] += n
            agg[top][1] += 1
    return sorted(agg.items(), key=lambda kv: -kv[1][0])


def main():
    dbroot = core.db_root()                           # ...\<账号>_<4hex>\db_storage
    root = os.path.dirname(dbroot)                    # 账号目录：**占用的大头在 db_storage 外面**
    print("账号目录:", root)

    t0 = time.monotonic()
    print("\n== 账号目录各子树（一层）==")
    for name, (n, cnt) in subtree_sizes(root):
        print(f"  {name:<16} {_mb(n):>12}  {cnt:>6} 个文件")

    for sub in ("msg",):                              # msg 是大头，再钻一层
        p = os.path.join(root, sub)
        if os.path.isdir(p):
            print(f"\n== {sub}/ 各子树 ==")
            for name, (n, cnt) in subtree_sizes(p):
                print(f"  {name:<16} {_mb(n):>12}  {cnt:>6} 个文件")

    # msg/file 细分：按月 + 按扩展名
    froot = core.files_root()
    print("\n== msg/file 按月 ==")
    by_month = {}
    t1 = time.monotonic()
    for dp, _dirs, fs in os.walk(froot):
        m = os.path.basename(dp)
        for f in fs:
            try:
                by_month[m] = by_month.get(m, 0) + os.path.getsize(os.path.join(dp, f))
            except OSError:
                pass
    for m in sorted(by_month):
        print(f"  {m:<10} {_mb(by_month[m]):>12}")
    print(f"  小计 {_mb(sum(by_month.values()))}（walk 耗时 {time.monotonic() - t1:.2f}s）")

    # 磁盘文件 → 消息 → 会话：能归属多少
    print("\n== 可归属率（磁盘文件 ↔ 消息 title+大小）==")
    t2 = time.monotonic()
    idx = core.build_index()                          # {文件名: [(大小, 路径), …]}，别把别名键当两份文件
    files = {p: s for cands in idx.values() for s, p in cands}
    print(f"  磁盘可索引文件: {len(files)} 个 / {_mb(sum(files.values()))}"
          f"（build_index 耗时 {time.monotonic() - t2:.2f}s）")

    recs = F.list_files()
    owned = collections.Counter()
    for r in recs:
        if r["local_path"]:
            owned[os.path.normcase(r["local_path"])] += 1
    hit = sum(1 for p in files if os.path.normcase(p) in owned)
    print(f"  文件消息总数: {len(recs)}；其中命中磁盘: "
          f"{sum(1 for r in recs if r['local_path'])}")
    print(f"  磁盘文件里被消息引用到的: {hit}/{len(files)} "
          f"({100.0 * hit / max(1, len(files)):.0f}%)"
          f" ⇒ **剩下的只能算「无主占用」**，别假装能归到某个会话")
    # 真给用户看的那张榜长什么样：会话 + 一档「无主」
    print("\n== 按会话排行的实际样子（file/ 那 896 MB）==")
    per = collections.Counter()
    for r in recs:
        if r["local_path"] and os.path.isfile(r["local_path"]):
            per[r["name"]] += os.path.getsize(r["local_path"])
    shown = sum(per.values())
    for name, n in per.most_common(6):
        print(f"  {name:<24} {_mb(n):>10}")
    # 「无主」只能用**去重后**的可归属体积算。第一版拿"按会话求和"去减，得到 −143 MB ——
    # 就是这个负号暴露出「同一份文件被多个会话引用」这件事（见下一节）。
    distinct = {os.path.normcase(r["local_path"]) for r in recs if r["local_path"]}
    distinct_bytes = sum(s for p, s in files.items() if os.path.normcase(p) in distinct)
    print(f"  …前 6 名合计 {_mb(sum(n for _k, n in per.most_common(6)))} / 按会话求和 {_mb(shown)}"
          f"（**会重复计**，见下）")
    print(f"  【无主】          {_mb(sum(files.values()) - distinct_bytes):>10}"
          f"（= 磁盘总体积 − 去重后能归属的；**必须单列**，否则排行加起来对不上，用户会以为漏了）")
    # 上面那张榜会**重复计**同一份文件（一个文件被多个会话引用时）。
    # 这不是小概率：实测可归属 1039 MB > 磁盘 896 MB。口径必须写清楚，否则用户会得出
    # 「删了这俩会话能省 1 GB」的错结论。
    print("\n== 同一份磁盘文件被几个会话引用 ==")
    owners = collections.defaultdict(set)
    for r in recs:
        if r["local_path"]:
            owners[os.path.normcase(r["local_path"])].add(r["name"])
    dist = collections.Counter(len(v) for v in owners.values())
    for k in sorted(dist):
        print(f"  被 {k} 个会话引用: {dist[k]} 个文件")
    shared = sum(s for p, s in files.items() if len(owners.get(os.path.normcase(p), ())) > 1)
    print(f"  ⇒ 共享体积 {_mb(shared)}（排行里被数了不止一遍；**磁盘只占一份**）")

    # 另两块大头能不能归属，决定 A2 的覆盖面
    for sub in ("video", "attach"):
        p = os.path.join(root, "msg", sub)
        if not os.path.isdir(p):
            continue
        names = collections.Counter()
        sizes = collections.Counter()
        for dp, _d, fs in os.walk(p):
            for f in fs:
                names[os.path.splitext(f)[1].lower()] += 1
                try:
                    sizes[os.path.splitext(f)[1].lower()] += os.path.getsize(os.path.join(dp, f))
                except OSError:
                    pass
        print(f"\n== msg/{sub} 里是什么（{len(names)} 种扩展名，前 5）==")
        for ext, n in names.most_common(5):
            print(f"  {ext or '(无扩展名)':<12} {n:>5} 个 / {_mb(sizes[ext]):>10}")
        # 有没有目录结构能直接给会话（微信自己按会话/日期分过目录吗）
        subs = sorted({os.path.relpath(dp, p).split(os.sep)[0] for dp, _d, _f in os.walk(p)})[:6]
        print(f"  顶层子目录样例: {subs}")

    print(f"\n总耗时 {time.monotonic() - t0:.2f}s")


if __name__ == "__main__":
    main()
