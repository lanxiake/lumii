# -*- coding: utf-8 -*-
"""**真机兼容性抽验**：把某个版本的微信解出来直接跑，然后拿 `wechat-mcp` 的真实链路去量它。

为什么不跑安装器：微信 4.x 的安装目录形状 = **根上一个 2.9MB 常驻启动器 `Weixin.exe`
+ `<版本号>\\` 一整棵载荷**（版本由 `--user-lib-dir` 选，实测见主进程命令行）。
而 `install.7z` 里就是这棵树——所以解包 == 安装，**不写注册表、不动现有安装**，
验完 `rm -rf` 就干净了。

⚠️ 三条必须知道的前提：
 1. **要扫码登录**（数据目录共享，未登录时内存里没有 Cipher）——所以这步必须有人。
 2. 会**动用户的 `xwechat_files`**：老版本的客户端打开新版本写的库，可能触发迁移。
    所以先备份（`--backup`）再测；不放心就选比现装版本**新**的方向测。
 3. 静态命中 ≠ 能用：静态只证明字面量在，**页几何 / UIA 树形状只有这里能量**。

用法：
  PYTHONIOENCODING=utf-8 python probe_live_version.py <install.7z 或 安装包.exe 或 已解目录>
  PYTHONIOENCODING=utf-8 python probe_live_version.py <...> --backup     # 先备份数据目录
  PYTHONIOENCODING=utf-8 python probe_live_version.py <...> --need-data  # 等到能读出会话再判
  PYTHONIOENCODING=utf-8 python probe_live_version.py <...> --send       # 真发一条（**只发文件传输助手**）

只读？`--send` 之外只 PROCESS_VM_READ，不发送任何东西。`--send` 时唯一的外发目标是
`filehelper`（文件传输助手 = 用户自己），且判据是**读库回读**，不是只看返回值。
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

MCP = r"C:\myself\projects\my\open-source\lumii\apps\windows\resources\wechat-mcp"
sys.path.insert(0, MCP)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                                "apps", "windows", "resources", "wechat-mcp"))

SZ = r"C:\Program Files\7-Zip\7z.exe"
DATA = os.path.join(os.path.expanduser("~"), "Documents", "xwechat_files")
WAIT_MIN = 8                 # 等扫码的上限（分钟）
DO_SEND = "--send" in sys.argv   # 真发（默认关；只发**文件传输助手**，即用户自己）


def unpack(arg, out):
    """安装包 → 安装目录树（根上有 Weixin.exe、版本子目录）。"""
    os.makedirs(out, exist_ok=True)
    if os.path.exists(os.path.join(out, "Weixin.exe")):
        return out
    subprocess.run([SZ, "x", "-o" + out, "-y", arg], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    inner = os.path.join(out, "install.7z")
    if os.path.exists(inner):
        subprocess.run([SZ, "x", "-o" + out, "-y", inner], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.remove(inner)
    return out


def backup_data():
    """整棵 `xwechat_files` 复制一份。1.3GB 本机约一分钟——换版本前唯一能回滚的东西。"""
    dst = DATA + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
    print("备份 %s → %s …" % (DATA, dst))
    shutil.copytree(DATA, dst)
    print("备份完成")
    return dst


def ver_dir_of(inst):
    """载荷目录名 == 版本号（安装包文件名不是版本，`4.1.6.exe` 装出来是 `4.1.6.46`）。"""
    return next((d for d in sorted(os.listdir(inst))
                 if os.path.isdir(os.path.join(inst, d)) and re.match(r"^\d+\.\d+", d)), None)


def launch(inst):
    """起这个版本，返回**属于我们**的 pid 集合（按命令行里的 user-lib-dir 认，别按名字认）。"""
    ver_dir = ver_dir_of(inst)
    exe = os.path.join(inst, "Weixin.exe")
    cmd = [exe] + (["--user-lib-dir=" + os.path.join(inst, ver_dir)] if ver_dir else [])
    print("启动：%s" % " ".join(cmd))
    subprocess.Popen(cmd, close_fds=True)
    time.sleep(8)
    return ver_dir


def our_pids(marker=None):
    """命令行里带我们那个 user-lib-dir 的进程——**用户自己那份微信不能碰**。
    `marker=None` 时返回**所有**微信进程（用来判断"现在能不能安全起第二个"）。"""
    ps = ("Get-CimInstance Win32_Process -Filter \"Name='Weixin.exe'\" | "
          "ForEach-Object { \"$($_.ProcessId)\t$($_.CommandLine)\" }")
    out = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                         capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
    pids = []
    for ln in out.splitlines():
        if not ln.strip():
            continue
        if marker is None or (marker and marker.lower() in ln.lower()):
            pids.append(int(ln.split("\t")[0]))
    return pids


def checks():
    """拿真实链路量一遍。判据是**能取到密钥**（整条读路的前提）+ 会话/历史能读。"""
    import wechat_core as wc
    v = wc.wechat_version()
    print("  微信版本：%s（本项目验过？%s）" % (v["version"], v["verified"]))
    print("  数据目录：%s" % wc.db_root())
    out = {"version": v["version"], "ok": False}
    try:
        km = wc.keys(refresh=True)
        print("  密钥：%d 个库" % len(km))
        out["keys"] = len(km)
    except Exception as e:                                          # noqa: BLE001
        print("  ✗ 取密钥失败：%s" % e)
        return out
    try:
        st = wc.sessions()
        print("  会话：%d 个；头一个 %s" % (len(st), st[0]["name"] if st else "—"))
        if st:
            h = wc.history(st[0]["talker"], 3)
            print("  历史：%s → %d 条" % (st[0]["name"], h["count"]))
        out["ok"] = bool(st)
    except Exception as e:                                          # noqa: BLE001
        print("  ✗ 读会话/历史失败：%s" % e)
    try:
        import wechat_sender as S
        env = S.check_env()
        print("  发送层 check_env：ok=%s reason=%s 窗口=%s" % (env["ok"], env.get("reason"), env.get("size")))
        # **静态看不见的第二件事**：UIA 树形状。四件套的发送/读界面全押在它上面
        # （`session_item_` / `search_list` / `chat_input_field`）。
        # ⚠️ 空树**不等于**这版不兼容：微信 4.x 默认不暴露 mmui 控件树，且跟**进程**同生命周期
        # （`wechat_sender.py:_uia_tree_blank` 有记录），重启微信才恢复——所以空的时候要重启再量一次。
        u = S.read_uia()
        if u:
            print("  UIA：会话行 %d、表头 %r、输入框 %r、按钮 %d → 树是活的"
                  % (len(u["items"]), u["header"], u["input"], len(u["btns"])))
            out["uia"] = len(u["items"])
        else:
            print("  ⚠️ UIA 树是空的（本机已知会这样，见 _uia_tree_blank）——**重启微信再量**才算数")
            out["uia"] = 0
    except Exception as e:                                          # noqa: BLE001
        print("  ✗ check_env/read_uia 失败：%s" % e)

    if DO_SEND:
        # **发送才是最容易随版本崩的那条路**（切会话 → 输入落地 → 回车 → 读库确认），
        # 只验读路等于只验了一半。目标**只发 `filehelper`（文件传输助手 = 用户自己）**：
        # 真实投递、零打扰。`talker` 必须传 wxid：`_header_distinguishes_target` 拿它跟
        # `names()` 的键比，传显示名会把目标自己当成"别家"一票否掉（踩过，看着像产品 bug）。
        import wechat_sender as S
        text = "【版本兼容自检】%s 真发" % out.get("version", "?")
        ok, det = S.send_text(text, "filehelper", dry_run=False)
        print("  真发 filehelper：ok=%s %s" % (ok, det))
        # 判据不能只看返回值——**读库回读**才作数（发出去没落库 = 没发）。
        h = wc.history("filehelper", 3)
        got = any(text in str(m.get("text", "")) for m in h["messages"])
        print("  读库回读：%s" % ("命中刚发的那条 ✓" if got else "✗ 库里没有"))
        out["send"] = bool(ok and got)
        out["ok"] = out["ok"] and out["send"]
    return out


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                               # noqa: BLE001
        pass
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        return 2
    prompt = "--prompt" in sys.argv
    work = os.environ.get("WX_TEST_DIR") or os.path.join(
        os.environ.get("TEMP") or os.path.expanduser("~"), "wxcompat", "wxlive")
    inst = unpack(args[0], os.path.join(work, os.path.basename(args[0]) + ".inst"))
    if "--prepare" in sys.argv:
        print("已解包到 %s（下次直接跑同一条命令就会复用它）" % inst)
        return 0
    ver_dir = ver_dir_of(inst)
    # 认**整棵解包目录**，不是版本子目录：`--type=xplayer` 这类子进程命令行里**没有**
    # `--user-lib-dir`（实测漏掉过），只按版本目录认会把它当成"别人的微信"。
    marker = inst
    mine = set(our_pids(marker))         # 上一次跑留下的**我们自己的**实例：可以接着用

    # **闸，且必须在备份之前**：**别人的**微信在跑就先别动。两个微信同时开同一个
    # `xwechat_files` 会各自迁移/抢 WAL——这不是"测不出来"，是"可能把用户的数据搞坏"；
    # 而在运行中拷 1.3GB 的库还会拷到撕裂的 WAL 帧，那份备份等于没有。
    others = [p for p in our_pids() if p not in mine]
    if others:
        print("⚠️ 已有微信在运行（pid %s）。先**完全退出微信**（托盘右键 → 退出微信）再重来。"
              % ",".join(map(str, others)))
        return 2
    if not mine:
        if "--backup" in sys.argv:
            backup_data()
        launch(inst)
    else:
        print("复用已在跑的被测实例（pid %s），不再启动第二个" % ",".join(map(str, sorted(mine))))

    # **不交互**：轮询等到"能取到密钥"（= 已登录），而不是等键盘。
    # 敲键盘那版在自动化里会直接 EOF；而且"登录好了"本来就该由**事实**判，不是由人按回车判。
    # `--need-data`：还要求**读得出会话**——本机有两个账号目录，登错那个是空的，
    # 密钥照样拿得到、会话却是 0，这时候判"通过"就是假绿。
    need = "--need-data" in sys.argv
    import wechat_core as wc
    print(">>> 请在微信窗口里登录（最多等 %d 分钟）%s" % (WAIT_MIN, "，且要登到有数据的那个账号" if need else ""))
    t0, r = time.time(), None
    while time.time() - t0 < WAIT_MIN * 60:
        pids = our_pids(marker)
        if not pids:
            print("  ⚠️ 没找到被测进程——你自己的微信大概还在跑（单实例会把它顶掉）。先完全退出微信再重来。")
            return 2
        try:
            wc.keys(refresh=True)
            ns = len(wc.sessions())
            print("  %s（%.0fs；%s）" % ("已登录且读得到会话" if ns else "已登录，会话 0 个",
                                        time.time() - t0, wc.db_root()))
            if ns or not need:
                break
        except Exception:                                           # noqa: BLE001
            pass
        time.sleep(10)
    else:
        print("  等超时了——没拿到可判定的状态")
        return 2
    if prompt:
        input("按回车继续…")

    print("被测进程（只认命令行带 %s 的）：%s" % (ver_dir, pids))
    r = checks()
    if pids:
        print("（要关掉它：Stop-Process -Id %s；目录留在 %s）" % (",".join(map(str, pids)), inst))
    return 0 if r.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
