"""D · 撤回防护 —— 常驻守护：持续把新消息灌进归档库。

**为什么必须常驻**：撤回后原消息从微信库消失（实测），所以只能在撤回**之前**留存。
MCP 前台是 stdio、随客户端生死，做不了这件事——守护必须独立进程。

行为：
- 首次启动做一次**全量打底**，之后按 `--interval`（默认 30s）增量扫描。
- 每次增量从 `水位 - 安全余量` 起扫，`INSERT OR IGNORE` 保证幂等（重扫不会覆盖已归档原文）。
- 记录**心跳**；重启时若发现停机时间超过 3 个周期，就落一条 `gap`（关机期间的漏记**如实报告**，
  不假装全覆盖）。

用法：
  python daemon.py --daemon                 # 前台跑守护
  python daemon.py --daemon --interval 30
  python daemon.py --install-autostart      # 写 HKCU Run，开机自启
  python daemon.py --uninstall-autostart
  python daemon.py --status                 # 打印归档库状态
"""
import argparse
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import archive  # noqa: E402

DEFAULT_INTERVAL = 30
SAFETY_MARGIN_S = 300          # 每次多回扫 5 分钟：接住异步落库的晚到行（重扫幂等）
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_VALUE = "LumiiWechatRecall"


def log(*a):
    print(f"[wechat-recall-daemon] {time.strftime('%Y-%m-%d %H:%M:%S')}", *a, file=sys.stderr, flush=True)


def _autostart_command():
    """开机自启要执行的命令行（冻结产物用 exe 自身；源码运行用当前解释器 + 脚本）。"""
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}" --daemon'
    return f'"{sys.executable}" "{os.path.join(HERE, "daemon.py")}" --daemon'


def install_autostart():
    import winreg
    # CreateKeyEx 而非 OpenKey：Run 键通常已在，但键缺失时该建出来（也让它能在临时键上被测试）
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        winreg.SetValueEx(k, RUN_VALUE, 0, winreg.REG_SZ, _autostart_command())
    log("已写入开机自启：", _autostart_command())


def uninstall_autostart():
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
            winreg.DeleteValue(k, RUN_VALUE)
        log("已移除开机自启")
    except FileNotFoundError:
        log("开机自启本来就没装")


def autostart_installed():
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_READ) as k:
            winreg.QueryValueEx(k, RUN_VALUE)
        return True
    except FileNotFoundError:
        return False


def tick(con, since, seen_ts):
    """扫一轮：从 `since` 起把当前库的行灌进归档库。返回新增条数。"""
    rows = list(archive.live_rows(since=since))
    return archive.capture(con, rows, seen_ts=seen_ts)


def run(interval=DEFAULT_INTERVAL, once=False):
    con = archive.connect()
    now = int(time.time())
    last_tick = archive.meta_get(con, "last_tick")

    # 停机缺口：上一次心跳离现在超过 3 个周期 → 那段时间没归档（如实记下来）
    if last_tick and now - int(last_tick) > interval * 3:
        con.execute("insert into gap(start_ts, end_ts) values(?,?)", (int(last_tick), now))
        con.commit()
        log(f"检测到停机缺口：{archive.core._ts(int(last_tick))} ~ {archive.core._ts(now)}（这段漏记）")

    # 首次打底：全量（水位 0）；之后增量
    backfilled = archive.meta_get(con, "backfilled") == "1"
    since = 0 if not backfilled else max(0, archive.watermark(con) - SAFETY_MARGIN_S)
    log("开始扫描", "（全量打底）" if not backfilled else f"（增量，since={since}）")
    added = tick(con, since, now)
    archive.meta_set(con, "backfilled", "1")
    if not archive.meta_get(con, "first_seen"):
        archive.meta_set(con, "first_seen", now)
    log(f"本轮新增 {added} 条；归档共 {archive.stats(con)['archived']} 条")

    if once:
        archive.meta_set(con, "last_tick", int(time.time()))
        return

    log(f"进入循环，每 {interval}s 一拍（Ctrl-C 退出）")
    try:
        while True:
            time.sleep(interval)
            try:
                s = max(0, archive.watermark(con) - SAFETY_MARGIN_S)
                n = tick(con, s, int(time.time()))
                archive.meta_set(con, "last_tick", int(time.time()))
                if n:
                    log(f"新增 {n} 条")
            except Exception as e:                      # 单拍失败不能拖垮守护
                log("本轮出错（继续）：", repr(e))
    except KeyboardInterrupt:
        log("收到退出信号，记录停机时间")
    finally:
        archive.meta_set(con, "last_stop", int(time.time()))
        con.close()


def status():
    con = archive.connect()
    st = archive.stats(con)
    st["autostart"] = autostart_installed()
    st["db_path"] = archive.db_path()
    last_tick = st.get("last_tick")
    st["alive"] = bool(last_tick) and (time.time() - int(last_tick)) < DEFAULT_INTERVAL * 3
    st["gaps"] = len(archive.gaps(con))
    con.close()
    return st


def main():
    ap = argparse.ArgumentParser(description="微信撤回防护守护")
    ap.add_argument("--daemon", action="store_true", help="运行守护循环")
    ap.add_argument("--once", action="store_true", help="只扫一轮就退出（测试用）")
    ap.add_argument("--interval", type=int, default=DEFAULT_INTERVAL)
    ap.add_argument("--install-autostart", action="store_true")
    ap.add_argument("--uninstall-autostart", action="store_true")
    ap.add_argument("--status", action="store_true")
    a = ap.parse_args()
    if a.install_autostart:
        install_autostart()
    elif a.uninstall_autostart:
        uninstall_autostart()
    elif a.status:
        import json
        print(json.dumps(status(), ensure_ascii=False, indent=2))
    elif a.daemon or a.once:
        run(interval=a.interval, once=a.once)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
