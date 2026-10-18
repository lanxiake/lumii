"""导出预览：只算不写。让 Agent 在真正导出前先看规模。

复用 exportcore 的读取与筛选路径（build_records / keyword_hits / stats_of）——
预览与实际导出走同一套计数，不会出现"预览 300 条、导出 642 条"的分叉。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_SHARED = os.path.join(os.path.dirname(HERE), "wechat-mcp")
for _p in (HERE, _SHARED):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import exportcore as E  # noqa: E402


def _estimate_bytes(records):
    """粗估落盘体积：正文按 UTF-8 约 3 字节/字 + 每条渲染开销（时间/发送者/标签）。

    ponytail: 估算是给"要不要导"用的量级判断，不是精确值；要准请直接导出看 `bytes`。
    """
    return sum(len(r.get("text") or "") for r in records) * 3 + len(records) * 160


def preview_chat(talker, since=0, until=0, keyword="", limit=0):
    """预览单个会话会导出什么：条数 / 体积量级 / 类型分布 / 是否会被截断。不写任何文件。"""
    data = E.build_records(talker, since, until)
    recs, truncated = E.keyword_hits(data["records"], keyword, int(limit or 0))
    stats = E.stats_of(recs)
    return {
        "talker": data["talker"], "name": data["name"],
        "scanned": len(data["records"]),
        "matched": len(recs),
        "truncated": truncated,
        "size_estimate": _estimate_bytes(recs),
        "first": stats["first"], "last": stats["last"],
        "types": stats["types"],
        "images": sum(1 for r in recs if (r.get("text") or "").startswith("[图片")),
        "voices": sum(1 for r in recs if (r.get("text") or "").startswith("[语音")),
    }


def preview_many(keyword, since=0, until=0, limit=0, max_sessions=None):
    """预览全库关键词搜索：哪些会话会命中、各多少条、预估体积。

    跳过读不动的会话时**计数**（`sessions_failed`）——和 export_many 同一口径，
    静默跳过会让"命中 0 个"看起来像正常结果。
    """
    kw = (keyword or "").strip()
    if not kw:
        raise ValueError("keyword 必填（不给 talker 时只能按关键词预览）")
    E.core._refresh()
    pairs = list(E.core.talkers())
    hits, failed = [], 0
    for _tbl, t in pairs:
        try:
            data = E.build_records(t, since, until)
        except E.E_SKIP:
            failed += 1
            continue
        recs, truncated = E.keyword_hits(data["records"], kw, int(limit or 0))
        if recs:
            hits.append({
                "name": data["name"], "talker": data["talker"],
                "matched": len(recs), "scanned": len(data["records"]),
                "size_estimate": _estimate_bytes(recs), "truncated": truncated,
                "first": recs[0]["time"], "last": recs[-1]["time"],
            })
    hits.sort(key=lambda x: -x["matched"])
    shown = hits[:int(max_sessions)] if max_sessions else hits
    return {
        "keyword": kw,
        "sessions_scanned": len(pairs), "sessions_failed": failed,
        "sessions_matched": len(hits), "sessions_exported": len(shown),
        "sessions_skipped": len(hits) - len(shown),
        "total_matched": sum(h["matched"] for h in hits),
        "total_export": sum(h["matched"] for h in shown),
        "size_estimate": sum(h["size_estimate"] for h in shown),
        "sessions": shown,
    }
