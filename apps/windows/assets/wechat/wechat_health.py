# -*- coding: utf-8 -*-
"""微信进程的轻量自检：最多每分钟探一次，**状态变化才写日志**。

为什么要有它：MCP 是常驻进程，微信却可能随时退出。没有这层时，客户端每一拍调工具都会
打一行 `call ...`，失败再打一条 `env_not_ready`（主产品还带整段堆栈）——一分钟几十行，
真正的故障反而被淹掉。这里只回答一个问题：**微信进程在不在**。

口径：
- 只探进程（`wxkey4.find_wechat_pids()`），不读库、不扫盘、不取密钥——那是工具调用的事。
- 结果缓存 60 秒；工具调用直接读缓存，不在每次调用时重新扫进程。
- 日志只在「运行 ↔ 未运行」切换时写一条；未运行期间保持安静。
"""
import threading
import time

INTERVAL = 60.0

_state = {
    "at": -1e9,          # 上次探测时刻（monotonic）
    "running": None,     # 上次探测结果
    "pid": None,
    "logged": None,      # 上次**写进日志**的状态（None = 还没写过）
}
_lock = threading.Lock()


def probe():
    """探一次微信进程，返回 `(running, pid)`。探测失败按「未运行」处理。"""
    try:
        import wxkey4
        pids = wxkey4.find_wechat_pids()
    except Exception:
        return False, None
    if not pids:
        return False, None
    return True, int(pids[0][1])


def status(refresh=False):
    """`(running, pid)`；`refresh=False` 时复用 60 秒内的结果。"""
    now = time.monotonic()
    with _lock:
        if not refresh and now - _state["at"] < INTERVAL:
            return _state["running"], _state["pid"]
    running, pid = probe()
    with _lock:
        _state.update(at=now, running=running, pid=pid)
    return running, pid


def running():
    """微信进程是否在运行（走缓存，工具调用可以无脑调）。"""
    return status()[0]


def notify(log_fn):
    """探一次；仅当状态与上次**写进日志**的不同时调用 `log_fn`。返回当前是否运行。"""
    now_running, pid = status(refresh=True)
    with _lock:
        changed = _state["logged"] is not now_running
        _state["logged"] = now_running
    if changed:
        if now_running:
            log_fn("env:", f"微信进程 运行中 pid={pid}")
        else:
            log_fn("env:", "微信进程 **未运行**（每分钟自检一次，恢复后会自动继续）")
    return now_running


def start_watcher(log_fn, interval=INTERVAL):
    """后台每分钟自检一次，状态变化才写日志。守护线程，不阻止进程退出。"""
    def run():
        while True:
            try:
                notify(log_fn)
            except Exception:
                pass                      # 自检本身绝不能拖垮服务
            time.sleep(interval)

    t = threading.Thread(target=run, name="wechat-health", daemon=True)
    t.start()
    return t
