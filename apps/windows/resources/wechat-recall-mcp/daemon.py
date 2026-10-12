"""D · 撤回防护 —— 常驻守护：持续把新消息灌进归档库。

**为什么必须常驻**：撤回后原消息从微信库消失（实测），所以只能在撤回**之前**留存。
MCP 前台是 stdio、随客户端生死，做不了这件事——守护必须独立进程。

行为：
- 首次启动做一次**全量打底**，之后按 `--interval`（默认 30s）增量扫描。
- 每次增量从 `水位 - 安全余量` 起扫，`INSERT OR IGNORE` 保证幂等（重扫不会覆盖已归档原文）。
- **每 24h 回头做一次全量对账**：增量只捞 `create_time > 水位-5min` 的行，"落库晚但时间戳更老"
  的补历史行（换机同步、离线成批落库）永远进不来，不回头全量就补不上。
- 记录**心跳**；发现停机/休眠超过 3 个周期就落一条 `gap`（漏记的时段**如实报告**，不假装全覆盖）。
- `--retain-days N` 可选修剪（默认 0 = 永不删）：归档是全量原文、只增不减，要磁盘还是要
  取证范围由用户定。

用法：
  python daemon.py --daemon                 # 前台跑守护
  python daemon.py --daemon --interval 30
  python daemon.py --daemon --retain-days 365
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
FULL_RESCAN_S = 86400          # 每 24h 全量对账一次（增量捞不到"晚到但时间戳更老"的补历史行）
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


def full_scan_due(con, now, due_s=FULL_RESCAN_S):
    """该不该做全量对账。**纯判据，可单测**。

    增量只捞 `create_time > 水位 - 5min`：换机/重新登录时微信补的历史、离线消息成批落库，
    这些行"落库晚、但 create_time 比水位老"，**永远**不会被增量捞到。打底只做一次、之后
    永不回头，这个洞就补不上——所以每 24h 回头全量扫一遍（`INSERT OR IGNORE` 幂等，
    代价是一次全表扫，实测本机 4.8 秒）。
    """
    if archive.meta_get(con, "backfilled") != "1":
        return True
    return now - int(archive.meta_get(con, "last_full") or 0) > due_s


def note_gap(con, now, interval):
    """上一拍距今超过 3 个周期 → 那段没在归档（关机 / 休眠 / 进程被杀），如实记一条 gap。

    开机时查一次**不够**：休眠不会让进程退出，`time.sleep` 只是被挂起，醒来后循环自己接着跑
    ——不查这一下，睡过去的两小时就是"静默漏记"，跟"全覆盖"在某些角度分不出来。
    """
    last = archive.meta_get(con, "last_tick")
    if last and now - int(last) > interval * 3:
        con.execute("insert into gap(start_ts, end_ts) values(?,?)", (int(last), now))
        con.commit()
        log(f"检测到停机/休眠缺口：{archive.core._ts(int(last))} ~ {archive.core._ts(now)}（这段漏记）")


def round_once(con, retain_days=0, interval=DEFAULT_INTERVAL):
    """扫一轮（该全量时先全量、该修剪时顺带修剪）。返回本轮新增条数。"""
    now = int(time.time())
    full = full_scan_due(con, now)
    if full:
        archive.meta_set(con, "last_full", now)
        log("本轮**全量对账**" + ("（首次打底）" if archive.meta_get(con, "backfilled") != "1" else ""))
        if retain_days:                                # 修剪只在全量这一拍做：删得多，也省得每拍 VACUUM
            killed = archive.prune(con, retain_days)
            if killed:
                log(f"修剪掉 {killed} 条 {retain_days} 天前的归档"
                    f"（那段之后再发生的撤回就查不到了）")
                try:
                    archive.vacuum(con)
                except Exception as e:                 # noqa: BLE001 —— 压实失败不该拖垮这一拍
                    log("VACUUM 跳过：", repr(e))
        since = 0
    else:
        since = max(0, archive.watermark(con) - SAFETY_MARGIN_S)
    added = tick(con, since, now)
    archive.meta_set(con, "backfilled", "1")
    archive.meta_set(con, "interval", interval)        # 判活要用真实周期，别假设默认 30s
    if not archive.meta_get(con, "first_seen"):
        archive.meta_set(con, "first_seen", now)
    return added


def run(interval=DEFAULT_INTERVAL, once=False, retain_days=0):
    con = archive.connect()
    note_gap(con, int(time.time()), interval)          # 关机缺口
    added = round_once(con, retain_days, interval)
    log(f"本轮新增 {added} 条；归档共 {archive.stats(con)['archived']} 条")

    if once:
        archive.meta_set(con, "last_tick", int(time.time()))
        con.close()
        return

    log(f"进入循环，每 {interval}s 一拍（Ctrl-C 退出）"
        + (f"，保留 {retain_days} 天" if retain_days else ""))
    try:
        while True:
            time.sleep(interval)
            try:
                note_gap(con, int(time.time()), interval)     # 休眠醒来的缺口也在这里抓
                n = round_once(con, retain_days, interval)
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
    try:
        st["db_bytes"] = os.path.getsize(st["db_path"])       # 归档只增不减，体积得看得见
    except OSError:
        st["db_bytes"] = 0
    iv = int(archive.meta_get(con, "interval") or DEFAULT_INTERVAL)
    st["interval"] = iv
    last_tick = st.get("last_tick")
    # 判活按**守护实际跑的周期**算（`--interval 300` 时用 90s 判会把活着的报成死的）
    st["alive"] = bool(last_tick) and (time.time() - int(last_tick)) < iv * 3
    st["gaps"] = len(archive.gaps(con))
    con.close()
    return st


def main():
    ap = argparse.ArgumentParser(description="微信撤回防护守护")
    ap.add_argument("--daemon", action="store_true", help="运行守护循环")
    ap.add_argument("--once", action="store_true", help="只扫一轮就退出（测试用）")
    ap.add_argument("--interval", type=int, default=DEFAULT_INTERVAL)
    ap.add_argument("--retain-days", type=int, default=0,
                    help="归档保留天数（0=永不删除；被修剪掉的那段，之后再撤回就查不到了）")
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
        run(interval=a.interval, once=a.once, retain_days=a.retain_days)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
