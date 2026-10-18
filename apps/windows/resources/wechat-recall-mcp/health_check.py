"""守护健康检查：把 daemon.status() 的事实翻成"哪坏了、怎么修"。

判活口径只有 daemon.py 一份（`running` 按停止事件、`alive` 按心跳周期），这里不重写。
额外补两件 status 不报的事：**归档是否还在增长**、磁盘**还剩多少**。
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import archive  # noqa: E402

_STALL_S = 6 * 3600      # 归档条数超过这个时长没动、且守护在跑 → 警告（无人发消息时属正常）

_RANK = {"healthy": 0, "unknown": 1, "warning": 2, "critical": 3}


def _worst(statuses):
    return max(statuses, key=lambda s: _RANK.get(s, 1)) if statuses else "healthy"


def _disk_free_gb(path):
    if os.name == "nt":
        import ctypes
        free = ctypes.c_ulonglong(0)
        ctypes.windll.kernel32.GetDiskFreeSpaceExW(
            ctypes.c_wchar_p(path), None, None, ctypes.pointer(free))
        return free.value / (1024 ** 3)
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize / (1024 ** 3)


def health():
    """返回 `{status, checks, issues, suggestions, stats}`。

    `status`：`healthy` / `warning` / `critical` / `unknown`（取各项里最差的一个）。
    """
    import daemon
    st = daemon.status()
    checks, issues, suggestions = [], [], []

    # 1. 进程 + 心跳（口径来自 daemon.status）
    running, alive = st.get("running"), st.get("alive")
    if running is False:
        checks.append({"name": "daemon", "status": "critical", "detail": "守护进程未运行"})
        issues.append("守护进程未运行，撤回防护不可用")
        suggestions.append("启动守护：wechat-recall-mcp.exe --daemon；长期使用建议 --install-autostart")
    elif running is None:
        checks.append({"name": "daemon", "status": "unknown", "detail": "非 Windows 环境无法判进程"})
    elif not alive:
        checks.append({"name": "daemon", "status": "warning",
                       "detail": "进程在，但心跳已过期（可能卡死）"})
        issues.append("守护心跳过期")
        suggestions.append("先看 daemon.log；必要时 --stop 后重启")
    else:
        checks.append({"name": "daemon", "status": "healthy", "detail": "运行中，心跳正常"})

    # 2. 归档规模 / 增长
    archived = int(st.get("archived") or 0)
    now = int(time.time())
    con = archive.connect()
    try:
        last_count = int(archive.meta_get(con, "health_last_count") or 0)
        last_ts = int(archive.meta_get(con, "health_last_ts") or 0)
        gap_count = len(archive.gaps(con))
        archive.meta_set(con, "health_last_count", archived)
        archive.meta_set(con, "health_last_ts", now)
    finally:
        con.close()

    if archived == 0:
        detail = "归档库为空" + ("（首次打底可能还没跑完）" if running else "")
        checks.append({"name": "archive", "status": "warning", "detail": detail})
        issues.append("归档库为空，现在查不到任何撤回")
        suggestions.append("确认微信已登录；守护首次打底需要跑一会儿")
    elif last_ts and now - last_ts > _STALL_S and archived == last_count:
        hours = (now - last_ts) // 3600
        checks.append({"name": "growth", "status": "warning",
                       "detail": f"已 {hours} 小时没有新消息归档（当前 {archived} 条）"})
        issues.append("归档长时间没有增长")
        suggestions.append("确认微信在线；长时间无人发消息时也属正常，不必强求")
    else:
        checks.append({"name": "growth", "status": "healthy", "detail": f"已归档 {archived} 条"})

    # 3. 缺口（是"如实告知"，不是故障）
    checks.append({"name": "gaps", "status": "healthy" if gap_count == 0 else "warning",
                   "detail": f"{gap_count} 个未覆盖时段" if gap_count else "无未覆盖时段"})
    if gap_count:
        issues.append(f"有 {gap_count} 个时段没被守护覆盖（关机/休眠），那段时间的撤回查不到")

    # 4. 磁盘空间
    try:
        free_gb = _disk_free_gb(os.path.dirname(archive.db_path()))
        if free_gb < 1:
            checks.append({"name": "disk", "status": "critical",
                           "detail": f"磁盘仅剩 {free_gb:.2f} GB"})
            issues.append("磁盘空间不足")
            suggestions.append("清理磁盘，或给守护加 --retain-days N 控制归档体积")
        elif free_gb < 5:
            checks.append({"name": "disk", "status": "warning",
                           "detail": f"磁盘剩余 {free_gb:.2f} GB"})
        else:
            checks.append({"name": "disk", "status": "healthy",
                           "detail": f"磁盘剩余 {free_gb:.2f} GB"})
    except OSError as e:
        checks.append({"name": "disk", "status": "unknown", "detail": f"读不到磁盘空间：{e}"})

    return {
        "status": _worst([c["status"] for c in checks]),
        "checks": checks,
        "issues": issues,
        "suggestions": suggestions,
        "stats": {k: st.get(k) for k in
                  ("running", "alive", "archived", "talkers", "db_bytes", "last_tick",
                   "gaps", "autostart", "interval", "oldest", "newest", "log_path")},
        "checked_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now)),
    }
