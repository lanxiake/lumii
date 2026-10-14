"""近似配对值不值得做：**拿已有的 8 条精确命中当标尺**，量盲配的覆盖率与准确率。只读。

盲配 = 完全不用 md5，只用 (会话, 消息时间, 消息里的 length)。时间窗内的磁盘正片当候选。
判据两条：① 在**已知正确答案**的 8 条上，盲配选中了没有；② 48 条里能给出**唯一候选**的有几条。
"""
import os, sys, sqlite3, glob
RES = r"C:\myself\projects\my\open-source\lumii\apps\windows\resources\wechat-mcp"
sys.path.insert(0, RES)
import wechat_core as core

core._refresh()
hl = core._video_hardlink()
disk = []
for p in glob.glob(os.path.join(os.path.dirname(core.db_root()), "msg", "video", "*", "*.mp4")):
    b = os.path.basename(p).lower()
    if b.endswith("_raw.mp4") or b.endswith("_thumb.jpg"):
        continue
    disk.append({"path": p, "size": os.path.getsize(p), "mtime": os.path.getmtime(p)})
print(f"磁盘正片 {len(disk)} 个；hardlink 可用 {len(hl)}")

msgs = []
for shard in core._cache["msg"]:
    smap = core._cache["senders"].get(shard, {})
    con = sqlite3.connect(shard)
    try:
        for tbl in core._cache["tables"].get(shard, ()):
            for ct, content, sid in con.execute(
                    f"select create_time, message_content, real_sender_id from [{tbl}] "
                    f"where (local_type & 4294967295) = 43"):
                md5, length = core._video_meta(content)
                msgs.append({"ts": ct, "md5": (md5 or "").lower(), "len": length,
                             "from": core.names().get(smap.get(sid, ""), "")})
    finally:
        con.close()
print(f"视频消息 {len(msgs)} 条")

# ① 已知正确答案（md5 精确路）——当标尺用
truth = {}
for m in msgs:
    n = hl.get(m["md5"])
    p = core.video_file_path(n) if n else None
    if p:
        truth[(m["ts"], m["len"])] = os.path.normcase(p)
print(f"其中精确可定位 {len(truth)} 条 —— 这 {len(truth)} 条就是盲配的标尺")

print("\n== 这 8 条上，消息时间 vs 磁盘文件 mtime ==")
for m in msgs:
    p = truth.get((m["ts"], m["len"]))
    if not p:
        continue
    f = next((d for d in disk if os.path.normcase(d["path"]) == p), None)
    if f:
        print(f"  时差 {m['ts'] - f['mtime']:>9.0f} s   "
              f"消息 len={m['len']:>9} 磁盘 size={f['size']:>9}"
              f"{'  ← 相等' if m['len'] == f['size'] else ''}")

print("\n== 盲配（不用 md5，只按 时间窗 + size 相等）==")
for win in (60, 600, 3600, 86400):
    uni = 0
    ok = wrong = none = 0
    for m in msgs:
        cands = [d for d in disk if (m["len"] and d["size"] == m["len"])
                 and abs(d["mtime"] - m["ts"]) <= win]
        if len(cands) == 1:
            uni += 1
            if (m["ts"], m["len"]) in truth:
                if os.path.normcase(cands[0]["path"]) == truth[(m["ts"], m["len"])]:
                    ok += 1
                else:
                    wrong += 1
        elif (m["ts"], m["len"]) in truth:
            none += 1
    print(f"  窗口 ±{win:>6}s：唯一候选 {uni}/48 条；"
          f"在那 8 条标尺上 对 {ok} / 错 {wrong} / 没选中 {none}")
