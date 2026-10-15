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
  python daemon.py --uninstall-autostart    # 摘 Run 项 **并停掉正在跑的守护**
  python daemon.py --stop                   # 只停守护（留着自启）
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
LOG_MAX_BYTES = 512 * 1024
# 停止信号用**命名事件**：`--stop` / 卸载能把守护优雅叫停，而不是杀进程。
# 用 `Local\`（会话内）——自启走 HKCU Run，本来就只在当前登录会话里。
STOP_EVENT = "Local\\LumiiWechatRecallStop"


def log(*a):
    """既写 stderr 也**落盘**。

    落盘不是可选项：开机自启拉起的进程**没有控制台**，stderr 是黑洞——不落盘的话，
    守护半夜挂掉、或者库一直被占用而每拍失败，用户和来排查的人都看不到任何痕迹。
    """
    line = (f"[wechat-recall-daemon] {time.strftime('%Y-%m-%d %H:%M:%S')} "
            + " ".join(str(x) for x in a))
    print(line, file=sys.stderr, flush=True)
    try:
        p = log_path()
        os.makedirs(os.path.dirname(p), exist_ok=True)
        if os.path.exists(p) and os.path.getsize(p) > LOG_MAX_BYTES:
            os.replace(p, p + ".1")                    # 只留一代，够查最近一段就行
        with open(p, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass                                           # 写日志失败绝不能影响守护本身


def log_path():
    """守护日志落在归档库旁边（同一份"产品自己的目录"，好找也好一起删）。"""
    return os.path.join(os.path.dirname(archive.db_path()), "daemon.log")


# ---- 停止信号（命名事件）----------------------------------------------------
# 为什么不用 pid 文件 + 杀进程：pid 会复用，杀之前得确认"这个 pid 现在到底是不是我的守护"，
# 判错的代价是**杀掉用户别的 Python 进程**；而且 TerminateProcess 是硬停，正在写库时被截断。
# 命名事件让守护自己在 finally 里收工，`--stop` 只负责喊一声。

def _create_stop_event():
    """建（或附加到）停止事件 → `(句柄, 是否已存在)`。非 Windows 返回 `(None, False)`。

    `CreateEventW` 遇到同名会返回**已存在**那个的句柄，所以第二个守护能靠
    `GetLastError()==ERROR_ALREADY_EXISTS` 当场认出"已经在跑了"——比心跳判活更准更即时。
    """
    if os.name != "nt":
        return None, False
    import ctypes
    k32 = ctypes.windll.kernel32
    k32.CreateEventW.restype = ctypes.c_void_p
    h = k32.CreateEventW(None, True, False, STOP_EVENT)      # manual-reset，初始无信号
    return h, k32.GetLastError() == 183                      # ERROR_ALREADY_EXISTS


def _close_stop_event(h):
    if h:
        import ctypes
        ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(h))


def _stopped(event, interval):
    """等到下一拍**或**收到停止信号；返回 True 表示该收工了。

    非 Windows（或无句柄）退化成 `time.sleep`——测试在没有命名事件的环境里也能跑。
    """
    if not event:
        time.sleep(interval)
        return False
    import ctypes
    k32 = ctypes.windll.kernel32
    k32.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
    k32.WaitForSingleObject.restype = ctypes.c_uint32
    return k32.WaitForSingleObject(event, int(interval * 1000)) == 0    # WAIT_OBJECT_0


def daemon_running():
    """守护进程在不在跑（按停止事件句柄判，比心跳即时）。非 Windows 返回 None。"""
    if os.name != "nt":
        return None
    import ctypes
    k32 = ctypes.windll.kernel32
    k32.OpenEventW.restype = ctypes.c_void_p
    h = k32.OpenEventW(0x00100000, False, STOP_EVENT)        # SYNCHRONIZE
    if not h:
        return False
    _close_stop_event(h)
    return True


def stop_daemon():
    """请求守护收工。返回是否真发了信号（没在跑返回 False，这不算错误）。"""
    if os.name != "nt":
        return False
    import ctypes
    k32 = ctypes.windll.kernel32
    k32.OpenEventW.restype = ctypes.c_void_p
    h = k32.OpenEventW(0x00100000 | 0x0002, False, STOP_EVENT)   # SYNCHRONIZE | EVENT_MODIFY_STATE
    if not h:
        log("守护没在跑（停止事件不存在）")
        return False
    try:
        ok = bool(k32.SetEvent(ctypes.c_void_p(h)))
        log("已请求守护收工" if ok else "发停止信号失败")
        return ok
    finally:
        _close_stop_event(h)


def _daemon_argv():
    """启动守护的参数列表（冻结产物用 exe 自身；源码运行用当前解释器 + 脚本）。

    只带 `--daemon`：以前还要把授权密钥抄进命令行（HKCU Run 的进程拿不到 MCP 配置里的
    `env`），授权移除后没有要抄的东西了。
    """
    if getattr(sys, "frozen", False):
        return [sys.executable, "--daemon"]
    return [sys.executable, os.path.join(HERE, "daemon.py"), "--daemon"]


def _autostart_command():
    """开机自启要执行的命令行（写进 HKCU Run 的那一串）。"""
    return " ".join(f'"{a}"' if a != "--daemon" else a for a in _daemon_argv())


def start_detached(argv=None, popen=None):
    """在后台拉起守护；已经在跑就什么都不做。

    返回 True = 这次拉起了 / False = 本来就在跑 / None = 非 Windows（没有命名事件可判活）。
    三路句柄全接 DEVNULL：调用方（安装向导）是 `capture_output` 跑本命令的，
    子进程若继承了管道，`subprocess.run` 会一直等到守护退出——也就是永远。
    """
    if os.name != "nt":
        return None
    if daemon_running():
        return False
    import subprocess
    flags = 0x00000008 | 0x00000200          # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    (popen or subprocess.Popen)(argv or _daemon_argv(), creationflags=flags, close_fds=True,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
    log("已在后台拉起守护")
    return True


def install_autostart():
    """写开机自启，**并立即拉起守护**。

    只写 Run 项的话，要等下次登录守护才会跑——装完到重启之间的撤回全部漏掉，
    而安装向导已经告诉用户"已开启"了。
    """
    import winreg
    # CreateKeyEx 而非 OpenKey：Run 键通常已在，但键缺失时该建出来（也让它能在临时键上被测试）
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        winreg.SetValueEx(k, RUN_VALUE, 0, winreg.REG_SZ, _autostart_command())
    log("已写入开机自启：", _autostart_command())
    start_detached()


def uninstall_autostart():
    """摘掉开机自启，**并且停掉正在跑的守护**。

    只摘 Run 项的话，卸载完它还在后台接着跑——用户说"我关了"，进程还在，这是能吵起来的。
    """
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
            winreg.DeleteValue(k, RUN_VALUE)
        log("已移除开机自启")
    except FileNotFoundError:
        log("开机自启本来就没装")
    stop_daemon()


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


def _loop(interval, retain_days, event):
    """真正干活的循环：连上库、打底、之后每 `interval` 秒一拍。"""
    con = archive.connect()
    try:
        note_gap(con, int(time.time()), interval)          # 关机缺口
        added = round_once(con, retain_days, interval)
        archive.meta_set(con, "last_tick", int(time.time()))
        log(f"本轮新增 {added} 条；归档共 {archive.stats(con)['archived']} 条")
        log(f"进入循环，每 {interval}s 一拍"
            + (f"，保留 {retain_days} 天" if retain_days else "")
            + "（停：--stop）")
        while not _stopped(event, interval):
            try:
                note_gap(con, int(time.time()), interval)     # 休眠醒来的缺口也在这里抓
                n = round_once(con, retain_days, interval)
                archive.meta_set(con, "last_tick", int(time.time()))
                if n:
                    log(f"新增 {n} 条")
            except Exception as e:                      # 单拍失败不能拖垮守护
                log("本轮出错（继续）：", repr(e))
        log("收到停止信号，收工")                        # 没有这条的话，日志最后一行会停在"进入循环"，
        #                                                  事后看不出到底是停了还是卡住了
    finally:
        archive.meta_set(con, "last_stop", int(time.time()))
        con.close()


def _supervise(interval, retain_days, event):
    """外层**自愈**：任何未预期的异常都不让守护死掉，记日志后重启。

    为什么必须自愈：守护挂着 = 那段时间发生的撤回**永久查不到**（原文只在库里活到撤回那一刻，
    过了就没了）。而自启动拉起的进程没有控制台——死了以后用户完全无感，等发现时损失已经发生。
    这一层是"静默且不可逆"的唯一防线。

    重启用**退避**（5s→10s→…→300s 封顶）：库被别的进程占着这类问题会持续一阵，
    不退避就成了疯狂重试刷日志。
    """
    fails = 0
    while True:
        try:
            _loop(interval, retain_days, event)
            return                                          # 收到停止信号，正常收工
        except KeyboardInterrupt:
            log("收到 Ctrl-C，记录停机时间")
            return
        except Exception as e:                              # noqa: BLE001 —— 这层就是要兜住一切
            fails += 1
            wait = min(300, 5 * fails)
            log(f"守护崩溃（第 {fails} 次）：{e!r}；{wait}s 后自动重启")


def expiry_gate():
    """守护也必须**在有效期内**才跑 → `(是否放行, 说明)`。

    **为什么守护也要拦**：它是**持续**跑的东西——跑到一半才发现 exe 过期了，等于白跑一场，
    而且用户会以为"撤回防护在守着"。启动时先判一次，过期就不进循环。

    **fail-closed**：有效期模块读不出来也算不过（模块是打进 exe 的，缺了就是构建出了问题，
    那种情况该报出来而不是放行）。
    """
    try:
        import builtin_expiry as E
        st = E.status()
    except Exception as e:                                     # noqa: BLE001
        return False, f"有效期模块不可用（{e!r}）——按不可用处理"
    if st["ok"]:
        return True, ""
    return False, f"{E.describe(st)}\n    {E.how_to_fix(st)}"


def run(interval=DEFAULT_INTERVAL, once=False, retain_days=0):
    ok, why = expiry_gate()
    if not ok:
        log("这份 exe 不能用了，守护不启动：", why)
        return 2
    if once:
        con = archive.connect()
        note_gap(con, int(time.time()), interval)
        added = round_once(con, retain_days, interval)
        log(f"本轮新增 {added} 条；归档共 {archive.stats(con)['archived']} 条")
        archive.meta_set(con, "last_tick", int(time.time()))
        con.close()
        return

    event, already = _create_stop_event()
    if already:
        log("已经有一个守护在跑了（停止事件已存在），本次退出——别开第二个")
        _close_stop_event(event)
        return
    try:
        _supervise(interval, retain_days, event)
    finally:
        _close_stop_event(event)


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
    # `running` 按进程本身判（停止事件还在不在），比心跳即时：守护刚崩时心跳还没过期，
    # 但进程已经没了——这两个字段一起看才分得清"没跑"和"跑着但卡住了"。
    st["running"] = daemon_running()
    st["log_path"] = log_path()
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
    ap.add_argument("--stop", action="store_true", help="让正在跑的守护收工（自启项保留）")
    ap.add_argument("--status", action="store_true")
    a = ap.parse_args()
    if a.install_autostart:
        install_autostart()
    elif a.uninstall_autostart:
        uninstall_autostart()
    elif a.stop:
        stop_daemon()
    elif a.status:
        import json
        print(json.dumps(status(), ensure_ascii=False, indent=2))
    elif a.daemon or a.once:
        # 把退出码带出去：过了有效期时 `run` 返回 2，调用方（脚本/自启动）据此看得出来没跑成
        sys.exit(run(interval=a.interval, once=a.once, retain_days=a.retain_days) or 0)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
