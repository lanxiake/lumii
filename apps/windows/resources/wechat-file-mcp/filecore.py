"""A · 文件归档 —— 核心逻辑（纯函数，可单测；不依赖微信运行）。

职责：把微信消息里的**文件消息**（`local_type=49` 且 appmsg `type=6`）映射到磁盘上的
真实文件（`msg/file/<YYYY-MM>/<文件名>`），并支持归档（**只拷、不改微信数据**）。

关键实测事实（2026-10-12，决定了这里的实现）：
- 消息 `<title>` 与磁盘文件名**直接同名**；同名用 `<totallen>` 对大小消歧。
- 本机命中率 140 条 → 129 条 title+大小双命中（92%）；剩 8% 是未下载/已过期。
- 微信给重名文件加 `(1)`/`(3)` 后缀；少量文件有 `YYYYMMDD` 日期前缀；同一磁盘文件可被多条消息引用。
"""
import os
import re
import shutil
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
# 共享基础层：直接复用现有 wechat-mcp 的读取层（零复制；它是权威源）
_SHARED = os.path.join(os.path.dirname(HERE), "wechat-mcp")
if _SHARED not in sys.path:
    sys.path.insert(0, _SHARED)

import mcp_stdio  # noqa: E402  （只为了报进度；没装回调时 progress() 是空操作）
import wechat_core as core  # noqa: E402

FILE_LT = 49                      # 文件/链接类消息的 local_type
_WIN_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]')   # Windows 文件名非法字符

# 「文件消息 → 磁盘文件」这段**读原语**已上移到共享层 `wechat_core`（B 导出也要用它收附件），
# 这里只留同名引用：A 的调用点与本文件的测试都不用改，实现只有一份。
unwrap = core._unxml              # 就是共享层的 `<![CDATA[]]>` + 实体反转义
parse_file_msg = core.parse_file_msg
files_root = core.files_root
build_index = core.build_index
match_file = core.match_file


def _tbl_targets(talker):
    """{表名: talker}。给了 talker 只取它；否则取所有分片里出现过的会话。"""
    if talker:
        return {core.tbl_of(talker): talker}
    return {t: tk for t, tk in core.talkers()}


def list_files(talker=None, since=0, until=0, types=None, keyword="", only_missing=False):
    """列文件消息。返回**时间正序**的记录列表，每条带磁盘定位结果。

    `talker` 走 `core.talker_of`（**不是** `tbl_of`）——传会话**显示名**必须能筛出东西来，
    解析不出唯一目标就抛 `UnknownTalker`（MCP 侧 → `target_not_found`）。曾经直接把它喂给
    `tbl_of`（= md5(username)），于是 `talker="文件传输助手"` 算出张不存在的表、**静默返回 0 条**。
    """
    talker = core.talker_of(talker)
    core._refresh()
    names, me = core.names(), core.self_wxid()
    idx = build_index()
    want = {t.lower().lstrip(".") for t in (types or []) if t}
    targets = _tbl_targets(talker)
    out = []
    for shard in core._cache["msg"]:
        smap = core._cache["senders"].get(shard, {})
        tables = [t for t in core._cache["tables"].get(shard, ()) if t in targets]
        if not tables:
            continue
        con = sqlite3.connect(shard)
        try:
            for tbl in tables:
                conds, params = ["(local_type & 4294967295) = ?"], [FILE_LT]
                if since:
                    conds.append("create_time >= ?")
                    params.append(int(since))
                if until:
                    conds.append("create_time <= ?")
                    params.append(int(until))
                sql = (f"select create_time, message_content, real_sender_id, local_id"
                       f" from [{tbl}] where " + " and ".join(conds))
                for ct, content, sid, lid in con.execute(sql, params):
                    fm = parse_file_msg(core.decode(content))
                    if not fm:
                        continue
                    if want and fm["ext"] not in want:
                        continue
                    if keyword and keyword.lower() not in fm["title"].lower():
                        continue
                    path, status = match_file(idx, fm["title"], fm["size"])
                    if only_missing and status != "missing":
                        continue
                    su = smap.get(sid, "")
                    tk = targets[tbl]
                    out.append({
                        "talker": tk, "name": names.get(tk, tk), "ts": ct, "local_id": lid,
                        "sender": names.get(su, su) if su else "", "from_me": su == me,
                        "title": fm["title"], "size": fm["size"], "ext": fm["ext"],
                        "local_path": path, "status": status,
                    })
        finally:
            con.close()
    out.sort(key=lambda r: r["ts"])
    return out


def _walk_sizes(root, depth=1):
    """一次 walk 出「路径前 `depth` 层」的体积：`({key: [字节, 文件数]}, 总字节, 总文件数)`。

    微信自己的目录结构就是这个形状（`msg/file/<年月>`），按层聚合比按类型猜更稳。
    """
    agg, total, n_files = {}, 0, 0
    for dp, _dirs, fs in os.walk(root):
        rel = os.path.relpath(dp, root)
        key = os.sep.join(([] if rel == "." else rel.split(os.sep))[:depth]) or "."
        for f in fs:
            try:
                n = os.path.getsize(os.path.join(dp, f))
            except OSError:
                continue
            e = agg.setdefault(key, [0, 0])
            e[0] += n
            e[1] += 1
            total += n
            n_files += 1
    return agg, total, n_files


def disk_usage(session_limit=20):
    """磁盘占用分析：**磁盘的硬事实** + **能归属的按会话排行**。

    三条实测事实（2026-10-14，探针 `verify/wechat-mcp/probe_disk_usage.py`）决定了这里的分账方式：

    1. **大头不在库里**：`db_storage` 67 MB，而 `msg/` 1322 MB（file 896 / video 270 / attach 157）。
       所以「为什么占这么大」只能在磁盘上答，会话条数那套读库答不了。
    2. **只有 74% 能归属**（149 个磁盘文件只有 110 个被消息引用到）。剩下的记
       `file_unattributed`，**必须单列**——否则各会话加起来对不上总量，用户会以为工具漏了。
    3. **同一份文件会被多个会话引用**（本机 91 独占 / 15 双主 / 4 三主，共享 281 MB）。
       于是「按会话求和」会**重复计**（实测求和 1039 MB > 磁盘 896 MB），
       "删了这个会话能省 X"就成了假话。所以独占 `own_*` 与共享 `shared_*` 分开报：
       前者删了确实省，后者别人也在用。

    `video/` 与 `attach/` **只报子树小计，不做会话归属**——video 靠消息配对只有 9/48 能唯一定位
    （计划 §3.4），attach 是 md5 目录名 + 加密 `.dat`。**配不出来就别编**。

    不变式（测试里钉住）：`Σ own_bytes + shared_bytes + file_unattributed.bytes == msg/file 总量`。
    """
    root = os.path.dirname(core.db_root())            # 账号目录：占用大头在 db_storage **外面**
    trees, total, n_all = _walk_sizes(root)
    msg_path = os.path.join(root, "msg")
    msg_trees, _mt, _mf = _walk_sizes(msg_path) if os.path.isdir(msg_path) else ({}, 0, 0)
    file_bytes, file_files = msg_trees.get("file", [0, 0])

    # ── msg/file 的归属：磁盘文件 → 引用它的会话
    meta, owners = {}, {}                             # 规范化路径 -> {size, ts, ext} / {会话名}
    for r in list_files():
        p = r["local_path"]
        if not p or not os.path.isfile(p):
            continue
        k = os.path.normcase(p)
        owners.setdefault(k, set()).add(r["name"])
        if k not in meta:                             # 同一份文件被多条消息引用只算一次
            try:
                meta[k] = {"size": os.path.getsize(p), "ts": r["ts"], "ext": r["ext"]}
            except OSError:
                pass

    sessions, shared_bytes, own_bytes = {}, 0, 0
    for k, m in meta.items():
        who = owners[k]
        if len(who) > 1:
            shared_bytes += m["size"]
        else:
            own_bytes += m["size"]
        for nm in who:
            s = sessions.setdefault(nm, {"name": nm, "own_bytes": 0, "own_files": 0,
                                         "shared_bytes": 0, "shared_files": 0})
            if len(who) == 1:
                s["own_bytes"] += m["size"]
                s["own_files"] += 1
            else:
                s["shared_bytes"] += m["size"]
                s["shared_files"] += 1

    by_month, by_ext = {}, {}
    for m in meta.values():
        mon = time.strftime("%Y-%m", time.localtime(m["ts"]))
        by_month[mon] = by_month.get(mon, 0) + m["size"]
        ext = m["ext"] or "(无扩展名)"
        by_ext[ext] = by_ext.get(ext, 0) + m["size"]

    ranked = sorted(sessions.values(), key=lambda s: -(s["own_bytes"] + s["shared_bytes"]))
    attributed = sum(m["size"] for m in meta.values())
    return {
        "root": root,
        "total_bytes": total, "total_files": n_all,
        "trees": [{"path": k, "bytes": v[0], "files": v[1]} for k, v in
                  sorted(trees.items(), key=lambda kv: -kv[1][0])],
        "msg_trees": [{"path": k, "bytes": v[0], "files": v[1]} for k, v in
                      sorted(msg_trees.items(), key=lambda kv: -kv[1][0])],
        "file_bytes": file_bytes, "file_files": file_files,
        # 三个总量**单独给**：`sessions` 是被 `session_limit` 截断的，拿它去求和必然对不上账
        # （本机 20 名之外还有会话，实测差 9.6 KB）——调用方要验账请看这三个数。
        "file_own_bytes": own_bytes,
        "file_unattributed": {"bytes": file_bytes - attributed, "files": file_files - len(meta)},
        "shared_bytes": shared_bytes,
        "session_count": len(sessions),
        "sessions": ranked[:session_limit] if session_limit > 0 else ranked,
        "by_month": by_month, "by_ext": by_ext,
        "note": ("`sessions[].own_bytes` 是**只此一处**引用的文件（删了确实能省）；"
                 "`shared_bytes` 是多个会话都在用的（删除不一定省）。"
                 "`file_unattributed` 是没被任何消息引用到的磁盘文件，归属不了。"
                 "`msg/video`、`msg/attach` 只报小计，不做会话归属。"),
    }


def _safe(name):
    """文件名净化：Windows 非法字符换成 `_`（不丢信息地可读，够用）。"""
    cleaned = _WIN_BAD.sub("_", name).strip().rstrip(".")
    return cleaned or "file"


def _sizes_equal(dest, src):
    """`dest` 存在且与 `src` 同大小（任一取不到大小就算不同）——即"同一份已归档过"。"""
    try:
        return os.path.getsize(dest) == os.path.getsize(src)
    except (OSError, TypeError):
        return False


def _conflict(target, src):
    """目标已存在且**不是同一份** → 要换名，别覆盖上次归档的另一个版本。

    目标不存在 → 不冲突；大小相同 → 视为同一份（幂等重跑，交给 `_sizes_equal` 去跳过拷贝）。
    """
    return bool(src) and os.path.exists(target) and not _sizes_equal(target, src)


def _dest_path(out_dir, rec, layout, used):
    """决定归档目标路径，并处理重名冲突（同目录同名 → 加时间戳后缀）。

    冲突有两个来源：**本次调用内**（`used`，多条消息同名）与**盘上已有的**（`_conflict`，
    上次归档留下的另一版本）。后者不看会静默覆盖——同名不同版本正是重命名后缀存在的理由。
    """
    if layout == "flat":
        sub = ""
    elif layout == "by_type":
        sub = rec["ext"] or "_noext"
    else:                                          # by_session（默认）
        sub = _safe(rec["name"] or rec["talker"])
    folder = os.path.join(out_dir, sub) if sub else out_dir
    target = os.path.join(folder, _safe(rec["title"]))
    if target.lower() in used or _conflict(target, rec.get("local_path")):
        stem, ext = os.path.splitext(target)
        target = f"{stem}({rec['ts']}){ext}"
    used.add(target.lower())
    return target


def archive_files(out_dir, talker=None, since=0, until=0, types=None,
                  layout="by_session", dry_run=True):
    """把可定位的文件**拷贝**到 out_dir（**不动微信原文件**）。

    返回 `{out_dir, layout, dry_run, total, copied, dedup, exists, missing, files[]}`。
    - 同一磁盘源只拷一次（多条消息引用同一文件时不重复）；
    - 目标已存在且**是同一份** → `exists` 跳过，不重拷（重跑幂等，也方便"昨天归档到一半"续跑）；
    - 目标已存在但是**另一版本**（大小不同）→ 另存为带时间戳的名字，**绝不覆盖**。

    返回的 `copied` 在 `dry_run=true` 时是"将拷贝"的计划数（`exists` 同样会被提前算出来）。
    """
    recs = list_files(talker=talker, since=since, until=until, types=types)
    used = set()
    seen_src = set()
    files, copied, skipped, missing, exists = [], 0, 0, 0, 0
    # 进度：几百个文件/几个 G 的拷贝要跑几十秒，中间不吭声用户只会以为卡死了。
    # 按「每 20 条」**或**「距上次 2 秒」报——单文件可能上百 MB，只按条数报会长时间静默。
    n_all, last_t = len(recs), time.monotonic()
    mcp_stdio.progress(f"开始归档：共 {n_all} 个文件可定位", total=n_all, n=0)
    for i, rec in enumerate(recs, 1):
        # 放在循环**最前面**：后面的 `continue`（dedup/exists/出错）会跳过循环尾部，
        # 放尾部就会漏报——而"跳过的多"恰恰是要让用户看见的。
        now = time.monotonic()
        if i == n_all or i % 20 == 0 or now - last_t >= 2.0:
            last_t = now
            mcp_stdio.progress(f"归档中 {i}/{n_all}（已拷贝 {copied}）", total=n_all, n=i)
        src, status = rec["local_path"], rec["status"]
        if status == "missing" or not src:
            missing += 1
            files.append({"title": rec["title"], "status": "missing", "session": rec["name"]})
            continue
        dest = _dest_path(out_dir, rec, layout, used)
        if src in seen_src:                        # 同一文件多处引用：只拷一次，登记别名
            files.append({"title": rec["title"], "status": "dedup", "dest": dest,
                          "src": src, "session": rec["name"], "size": rec["size"]})
            skipped += 1
            continue
        seen_src.add(src)
        entry = {"title": rec["title"], "status": status, "dest": dest, "src": src,
                 "session": rec["name"], "ts": rec["ts"], "size": rec["size"]}
        if _sizes_equal(dest, src):                # 目标已是同一份 → 不重拷（重跑幂等）
            entry["status"] = "exists"
            exists += 1
            files.append(entry)
            continue
        if not dry_run:
            try:
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                shutil.copy2(src, dest)
                entry["copied"] = True
            except OSError as e:
                entry["status"], entry["error"] = "error", str(e)
                files.append(entry)
                continue
        copied += 1
        files.append(entry)
    return {"out_dir": os.path.abspath(out_dir), "layout": layout, "dry_run": bool(dry_run),
            "total": len(recs), "copied": copied, "dedup": skipped, "exists": exists,
            "missing": missing, "files": files}
