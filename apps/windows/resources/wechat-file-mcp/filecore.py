"""A · 文件归档 —— 核心逻辑（纯函数，可单测；不依赖微信运行）。

职责：把微信消息里的**文件消息**（`local_type=49` 且 appmsg `type=6`）映射到磁盘上的
真实文件（`msg/file/<YYYY-MM>/<文件名>`），并支持归档（**只拷、不改微信数据**）。

关键实测事实（2026-10-12，决定了这里的实现）：
- 消息 `<title>` 与磁盘文件名**直接同名**；同名用 `<totallen>` 对大小消歧。
- 本机命中率 140 条 → 129 条 title+大小双命中（92%）；剩 8% 是未下载/已过期。
- 微信给重名文件加 `(1)`/`(3)` 后缀；少量文件有 `YYYYMMDD` 日期前缀；同一磁盘文件可被多条消息引用。
"""
import html
import os
import re
import shutil
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# 共享基础层：直接复用现有 wechat-mcp 的读取层（零复制；它是权威源）
_SHARED = os.path.join(os.path.dirname(HERE), "wechat-mcp")
if _SHARED not in sys.path:
    sys.path.insert(0, _SHARED)

import wechat_core as core  # noqa: E402

FILE_LT = 49                      # 文件/链接类消息的 local_type
_APPMSG_TYPE = 6                  # appattach 里的 appmsg 子类型：6 = 文件
_DATE_PREFIX = re.compile(r"^\d{8}\s*")          # 磁盘侧偶见的 YYYYMMDD 前缀（连同其后的空格）
_WIN_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]')   # Windows 文件名非法字符


def unwrap(s):
    """XML 文本节点 → 去掉 CDATA、反转义 HTML 实体（`&#x20;` 这类在文件名里真实出现过）。"""
    s = (s or "").strip()
    if s.startswith("<![CDATA[") and s.endswith("]]>"):
        s = s[9:-3]
    return html.unescape(s).strip()


def parse_file_msg(raw):
    """消息原文 → `{title, size, ext}`；**不是文件消息**（非 appmsg / 非 type=6 / 无标题）返回 None。"""
    if "<appmsg" not in raw:
        return None
    if core._num(raw, "type") != _APPMSG_TYPE:
        return None
    title = unwrap(core._tag(raw, "title"))
    if not title:
        return None
    size = core._num(raw, "totallen")
    ext = unwrap(core._tag(raw, "fileext")).lower()
    if not ext:
        ext = os.path.splitext(title)[1].lstrip(".").lower()
    return {"title": title, "size": max(size, 0), "ext": ext}


def files_root():
    """磁盘上的文件根：`<账号目录>/msg/file`。"""
    return os.path.join(os.path.dirname(core.db_root()), "msg", "file")


def build_index(root=None, _cache={}):
    """扫描磁盘 → `{文件名: [(大小, 路径), …]}`。按 root 缓存（换库/重扫传 force）。

    少量文件带 `YYYYMMDD` 日期前缀（磁盘侧有、消息标题没有），所以再给去前缀的名字挂**别名键**
    （真名优先，别名只在没撞名时加），让 `match_file` 保持一次查表。
    """
    root = root or files_root()
    if _cache.get("root") == root and "idx" in _cache:
        return _cache["idx"]
    idx = {}
    for dp, _dirs, fs in os.walk(root):
        for f in fs:
            p = os.path.join(dp, f)
            try:
                idx.setdefault(f, []).append((os.path.getsize(p), p))
            except OSError:
                continue
    for name, cands in list(idx.items()):
        alias = _DATE_PREFIX.sub("", name)
        if alias and alias != name:
            idx.setdefault(alias, cands)
    _cache["root"], _cache["idx"] = root, idx
    return idx


def match_file(idx, title, size):
    """消息 → 磁盘文件。返回 `(路径 | None, status)`；status ∈ ok / size_mismatch / missing。"""
    cands = idx.get(title) or idx.get(_DATE_PREFIX.sub("", title))
    if not cands:
        return None, "missing"
    if size:
        exact = [p for s, p in cands if s == size]
        if exact:
            return exact[0], "ok"
        return cands[0][1], "size_mismatch"        # 同名但大小不符：可能是另一版本
    return cands[0][1], "ok"


def _tbl_targets(talker):
    """{表名: talker}。给了 talker 只取它；否则取所有分片里出现过的会话。"""
    if talker:
        return {core.tbl_of(talker): talker}
    return {t: tk for t, tk in core.talkers()}


def list_files(talker=None, since=0, until=0, types=None, keyword="", only_missing=False):
    """列文件消息。返回**时间正序**的记录列表，每条带磁盘定位结果。"""
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


def _safe(name):
    """文件名净化：Windows 非法字符换成 `_`（不丢信息地可读，够用）。"""
    cleaned = _WIN_BAD.sub("_", name).strip().rstrip(".")
    return cleaned or "file"


def _dest_path(out_dir, rec, layout, used):
    """决定归档目标路径，并处理重名冲突（同目录同名 → 加时间戳后缀）。"""
    if layout == "flat":
        sub = ""
    elif layout == "by_type":
        sub = rec["ext"] or "_noext"
    else:                                          # by_session（默认）
        sub = _safe(rec["name"] or rec["talker"])
    folder = os.path.join(out_dir, sub) if sub else out_dir
    target = os.path.join(folder, _safe(rec["title"]))
    if target.lower() in used:
        stem, ext = os.path.splitext(target)
        target = f"{stem}({rec['ts']}){ext}"
    used.add(target.lower())
    return target


def archive_files(out_dir, talker=None, since=0, until=0, types=None,
                  layout="by_session", dry_run=True):
    """把可定位的文件**拷贝**到 out_dir（**不动微信原文件**）。

    返回 `{out_dir, layout, dry_run, copied, skipped, missing, files[]}`。
    同一磁盘源只拷一次（多条消息引用同一文件时不重复）。
    """
    recs = list_files(talker=talker, since=since, until=until, types=types)
    used = set()
    seen_src = set()
    files, copied, skipped, missing = [], 0, 0, 0
    for rec in recs:
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
            "total": len(recs), "copied": copied, "dedup": skipped, "missing": missing,
            "files": files}
