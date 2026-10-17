# -*- coding: utf-8 -*-
"""E2（报告 §9.8）：视频消息 → 磁盘上的 `.mp4`，到底靠哪个值对得上？**只读**。

背景：`probe_e2_schema.py` 已证实 `hardlink.db` 里有 **`video_hardlink_info_v4`**（本机 33 行，
磁盘命中 100%）。但"表里有"不等于"能用"——要能**从一条消息**走到那份文件，
得先回答：消息 XML 里的哪个值等于磁盘名？

候选三条路（**必须量，不能推**）：
  A. 消息 `md5`     —— 图片那条路的 `md5` 是**原图** md5、经常查不到（见 `_image_name`），
                       视频很可能同构；
  B. 消息 `newmd5`   —— 视频转码后的 md5，历史上（3.x）这才是本地文件名；
  C. 查 `video_hardlink_info_v4`（`md5`/`newmd5` → `file_name`）—— 要开库，有成本。

判据：三条路各自的**命中率**（命中的那 N 条消息里，磁盘上真有对应 `.mp4`），外加
"扫一遍 msg/video + 开一次 hardlink.db"的耗时——它决定这条路能不能进 15 秒一拍的盯梢回路。

⚠️ 只读：只读消息**属性名**与 32 位十六进制，不打印任何正文。
跑法：PYTHONIOENCODING=utf-8 ~/.lumii/runtimes/python-embed/python.exe probe_e2_video_map.py
"""
import collections
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.abspath(os.path.join(HERE, "..", "..", "apps", "windows", "resources"))
for _p in (os.path.join(RES, "wechat-mcp"), os.path.join(RES, "wechat-export-mcp")):
    sys.path.insert(0, _p)

import exportcore as X          # noqa: E402
import wechat_core as core      # noqa: E402

HEX32 = re.compile(r"^[0-9a-fA-F]{32}$")
ATTR = re.compile(r'([A-Za-z_][\w-]*)="([^"]*)"')


def video_index():
    """扫 `msg/video/<月>/` → `{文件名小写: 路径}`。返回 `(索引, 耗时秒)`。"""
    base = os.path.join(os.path.dirname(core.db_root().rstrip("\\/")), "msg", "video")
    t0 = time.perf_counter()
    idx = {}
    for dp, _dirs, fs in os.walk(base):
        for f in fs:
            idx[f.lower()] = os.path.join(dp, f)
    return idx, time.perf_counter() - t0


def stems_of(idx):
    """去掉扩展名与 `_thumb`/`_raw` 后缀 → 一组"主体名"（视频那几份共用同一个 hex 主体）。"""
    out = set()
    for name in idx:
        s = os.path.splitext(name)[0]
        for suf in ("_thumb", "_raw"):
            if s.endswith(suf):
                s = s[: -len(suf)]
        out.add(s)
    return out


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                            # noqa: BLE001
        pass
    root = core.db_root()
    print("数据根目录：%s" % root)

    disk, dt = video_index()
    stems = stems_of(disk)
    print("磁盘 msg/video 索引：%d 个文件，扫一遍 %.1f ms" % (len(disk), dt * 1000))

    # ---------- hardlink：md5 / file_name ----------
    km = core.keys(root)
    hl_rel = next((r.replace("\\", "/") for _k, r in km.values()
                   if os.path.basename(r).lower() == "hardlink.db"), None)
    hl_by_md5 = {}
    if hl_rel:
        t0 = time.perf_counter()
        hl = core._plain(km, root, hl_rel)                       # noqa: SLF001
        import sqlite3
        c = sqlite3.connect("file:%s?mode=ro" % hl.replace("\\", "/"), uri=True)
        for md5, name, size, typ in c.execute(
                "select md5, file_name, file_size, type from video_hardlink_info_v4"):
            hl_by_md5[str(md5).lower()] = (name, size, typ)
        c.close()
        print("hardlink.db：video_hardlink_info_v4 %d 行，解密+开库 %.1f ms"
              % (len(hl_by_md5), (time.perf_counter() - t0) * 1000))
    else:
        print("⚠️ 没找到 hardlink.db")

    # ---------- 消息侧：全库扫 lt=43 ----------
    attr_names = collections.Counter()
    by_attr_disk = collections.Counter()     # 哪个属性 == 磁盘文件名（去掉 .mp4）
    by_attr_hl = collections.Counter()       # 哪个属性 == hardlink 的 md5 列
    by_attr_stem = collections.Counter()     # 哪个属性 == 磁盘名主体（去掉 _thumb/_raw 与扩展名）
    cand_buckets = collections.defaultdict(lambda: [0, 0])   # 消息年龄桶 → [解析得出, 总数]
    pairs = []                               # 命中的 (文件名, 消息 length, rawlength, 磁盘大小)
    n_msg = 0
    placeholder = 0
    hit_md5 = hit_new = hit_hl = hit_ab = 0
    has_mp4_any = 0
    miss_sample = []
    t0 = time.perf_counter()
    for s in core.sessions():
        tk = s.get("talker")
        if not tk:
            continue
        try:
            rows = X.iter_rows(tk, 0, 0)
        except Exception:                                        # noqa: BLE001
            continue
        for _ct, lt, content, _sd, _lid in rows:
            if (lt & 0xFFFFFFFF) != 43:
                continue
            raw = core.decode(content)
            n_msg += 1
            amap = dict(ATTR.findall(raw))
            for k in amap:
                attr_names[k] += 1
            if amap.get("isplaceholder", "0") not in ("0", ""):
                placeholder += 1
            md5 = (amap.get("md5") or "").lower()
            new = (amap.get("newmd5") or "").lower()
            names = {n for n in (md5, new) if HEX32.match(n)}
            # 逐属性试：哪个属性（如果有）等于磁盘上的文件名 / hardlink 的 file_name
            for k, v in amap.items():
                v = v.lower()
                if not HEX32.match(v):
                    continue
                if (v + ".mp4") in disk:
                    by_attr_disk[k] += 1
                if v in stems:
                    by_attr_stem[k] += 1
                if v in hl_by_md5:
                    by_attr_hl[k] += 1
            # A/B：磁盘上真有 <md5>.mp4 / <newmd5>.mp4
            a = bool(md5) and (md5 + ".mp4") in disk
            b = bool(new) and (new + ".mp4") in disk
            hit_md5 += a
            hit_new += b
            hit_ab += (a or b)
            # C：经 hardlink 换成 file_name 再找
            c_ok = False
            for n in names:
                fn = hl_by_md5.get(n)
                if fn and fn[0].lower() in disk:
                    c_ok = True
                    # 命中了还要问一句：**这份文件的字节数对不对得上消息自己写的 `length`**。
                    # 对得上 ⇒ 可以拿大小当"是不是这条"的判据（错图比没图更糟）；
                    # 对不上 ⇒ 要么是 `_raw` 那版（消息里的 `rawlength` 才是它），要么撞了别人。
                    if len(pairs) < 8:
                        try:
                            sz = os.path.getsize(disk[fn[0].lower()])
                        except OSError:
                            sz = -1
                        pairs.append((fn[0][:40], amap.get("length"), amap.get("rawlength"), sz))
            hit_hl += c_ok
            # 任何同 basename 的文件（含 .jpg 缩略图）在不在磁盘上
            any_ok = any(n in disk for n in names)
            # 按**消息年龄**分桶：磁盘上只留得下最近下过的那几份，老消息的 mp4 早被微信清了
            # ⇒ 总命中率会被稀释成"看着很低"，不能拿它判断这条路值不值得做。
            age_d = max(0.0, (time.time() - _ct) / 86400.0)
            bucket = "≤7天" if age_d <= 7 else ("≤30天" if age_d <= 30 else "更早")
            cand_buckets[bucket][1] += 1
            cand_buckets[bucket][0] += bool(a or b or c_ok)
            has_mp4_any += any_ok
            if not (a or b or c_ok) and len(miss_sample) < 6:
                miss_sample.append((s.get("name"), sorted(names), c_ok, any_ok,
                                    (hl_by_md5.get(md5) or [None])[0]))
    scan = time.perf_counter() - t0

    print("\n全库扫 %d 会话、%.1f s：lt=43 视频消息 **%d 条**（其中 isplaceholder 非 0 的 %d 条）"
          % (len(core.sessions()), scan, n_msg, placeholder))
    print("视频消息 XML 的属性名（出现次数）：%s" % dict(attr_names.most_common()))
    print("逐属性命中：== 磁盘 `<值>.mp4` 的：%s" % dict(by_attr_disk))
    print("            == 磁盘名**主体**（去掉 _thumb/_raw 与扩展名）的：%s" % dict(by_attr_stem))
    print("            == hardlink.md5 的：%s" % dict(by_attr_hl))
    print("磁盘 msg/video 里的文件名样例（前 6 个，去掉扩展名）：%s"
          % sorted({os.path.splitext(k)[0] for k in disk})[:6])
    if not n_msg:
        print("本机没有视频消息，判据不成立（换台机器再跑）")
        return 2
    pct = lambda k: "%d/%d = %.1f%%" % (k, n_msg, 100.0 * k / n_msg)   # noqa: E731
    print("\n从一条消息走到磁盘 mp4 的三条路：")
    print("  A 消息 md5      → <md5>.mp4      ：%s" % pct(hit_md5))
    print("  B 消息 newmd5   → <newmd5>.mp4   ：%s" % pct(hit_new))
    print("  C hardlink 换名 → file_name      ：%s" % pct(hit_hl))
    print("  （对照）同 basename 的任何文件在盘上（含 .jpg 缩略图）：%s" % pct(has_mp4_any))
    print("  A∪B（不看库、纯消息自证）：%s" % pct(hit_ab))
    print("  按消息年龄分桶（分母是「这条消息」，不是「磁盘上还剩几份」）：")
    for b in ("≤7天", "≤30天", "更早"):
        got, tot = cand_buckets.get(b, (0, 0))
        print("    %-6s %d/%d%s" % (b, got, tot, "" if not tot else
                                    "  = %.0f%%" % (100.0 * got / tot)))
    print("  命中的那几对，大小对不对得上（消息 length / rawlength vs 磁盘实际）：")
    for fn, ln, rl, sz in pairs:
        print("    %-42s 消息 length=%-9s rawlength=%-9s 磁盘=%s" % (fn, ln, rl, sz))
    for row in miss_sample:
        print("    ✗ 会话 %s names=%s hl=%s anyfile=%s hl_name=%s" % row)

    ok = hit_hl == n_msg and hit_new < n_msg     # C 全中、但 B 不全中 ⇒ 必须开库
    # ---------- 另一条候选：message_resource.db 的 MessageResourceDetail ----------
    # 报告 §9.8 猜「视频/文件很可能有同构的表（或在 message_resource.db 里）」。它有
    # `data_index`（文本）与 `packed_info`（BLOB）两列——`data_index` 若是文件名，这条就成立。
    mr_rel = next((r.replace("\\", "/") for _k, r in km.values()
                   if os.path.basename(r).lower() == "message_resource.db"), None)
    if mr_rel:
        import sqlite3
        c = sqlite3.connect("file:%s?mode=ro" % core._plain(km, root, mr_rel).replace("\\", "/"),
                            uri=True)                              # noqa: SLF001
        dist = dict(c.execute("select type, count(*) from MessageResourceDetail group by type"))
        print("\nmessage_resource.db / MessageResourceDetail：type 分布 %s" % dist)
        print("  data_index 样例：%s"
              % [r[0][:46] for r in c.execute("select data_index from MessageResourceDetail "
                                              "limit 6")])
        n_disk = sum(1 for (d,) in c.execute("select data_index from MessageResourceDetail")
                     if d and d.lower() in stems)
        print("  data_index ∈ 磁盘名主体 的行数：%d" % n_disk)
        c.close()

    print("\n判据（§9.8 是否成立）：**只要 C 明显高于 B，就说明「必须查 hardlink 表」**；"
          "若 B 就等于 C，纯消息自证即可、不必开库。")
    print("  结论：" + ("C(%d) == 总数 ⇒ 换名可全中" % hit_hl if hit_hl == n_msg else
                       "C 未全中（%d/%d）⇒ 有的是真没下载" % (hit_hl, n_msg)))
    return 0 if ok or hit_hl > hit_new else 1


if __name__ == "__main__":
    sys.exit(main())
