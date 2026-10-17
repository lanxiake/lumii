"""探针：**冻结的 exe**上跑一遍装/卸，验新版装法（绿色安装）。

单测全在打桩环境里，验不到三件只在真 exe 上才成立的事：
  ① 台账真的落在 **exe 旁边**（`<exe目录>/.lumii/mcp/<产品>/installed.json`）；
  ② 注册进客户端配置的路径**就是这份 exe 的绝对路径**（一个字节都没拷贝）；
  ③ 卸载之后 **exe 还在**、台账收掉了。

**隔离**：整场跑在临时 `USERPROFILE`/`APPDATA` 里，且把 `claude` 从 PATH 里摘掉
（否则会去调真的 `claude mcp add`）。**不碰用户真实的任何配置**。

跑法：python probe_frozen_install.py [exe路径]
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    "..", ".."))
DEFAULT_EXE = os.path.join(ROOT, "apps", "windows", "resources", "wechat-mcp",
                           "dist", "pro", "wechat-mcp.exe")


def main():
    # 控制台代码页不是 UTF-8 时（中文 Windows 默认 GBK），一个 ✓ 就够让**探针自己**崩掉
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                          # noqa: BLE001
        pass
    exe_in = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_EXE)
    product = sys.argv[2] if len(sys.argv) > 2 else "wechat-mcp"     # lite 传 wechat-mcp-lite
    assert os.path.isfile(exe_in), "先构建：pnpm --filter ./apps/windows build:wechat-mcp"

    sb = tempfile.mkdtemp(prefix="wmcp-probe-")
    home = os.path.join(sb, "home")
    exe_dir = os.path.join(sb, "下载")                      # 中文目录也一并验一下
    for d in (home, exe_dir, os.path.join(sb, "appdata"), os.path.join(sb, "localappdata")):
        os.makedirs(d)
    for c in (".cursor", ".gemini"):                        # 造两个"装了"的客户端（JSON 那种）
        os.makedirs(os.path.join(home, c))
    exe = os.path.join(exe_dir, os.path.basename(exe_in))
    shutil.copy2(exe_in, exe)

    env = dict(os.environ)
    env.update({"USERPROFILE": home, "HOME": home,
                "APPDATA": os.path.join(sb, "appdata"),
                "LOCALAPPDATA": os.path.join(sb, "localappdata"),
                # 摘掉 claude：否则会去调真的 `claude mcp add`（那会写用户的真实配置）
                "PATH": os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32")})
    env.pop("HOMEDRIVE", None)
    env.pop("HOMEPATH", None)

    def run(*flags):
        p = subprocess.run([exe, *flags], env=env, capture_output=True, timeout=300)
        return p.returncode, p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")

    def show(tag, txt):
        print("----- %s -----" % tag)
        print(txt.strip())

    rc, out, err = run("--install")
    show("--install", out + ("\n[stderr] " + err if err.strip() else ""))
    assert rc == 0, rc

    # ① 台账在 exe 旁边（**不是**在 USERPROFILE 里）
    ledger = os.path.join(exe_dir, ".lumii", "mcp", product, "installed.json")
    assert os.path.isfile(ledger), "台账没落在 exe 旁边：%s" % ledger
    rec = json.load(open(ledger, encoding="utf-8"))
    print("台账：", rec)
    assert rec["exe"] == exe, rec
    assert sorted(rec.get("clients") or []) == ["cursor", "gemini"], rec

    # ② 客户端配置里存的就是这份 exe，且 exe 旁边**没有多出一份拷贝**
    name = rec["name"]
    for cfg, key in ((os.path.join(home, ".cursor", "mcp.json"), "mcpServers"),
                     (os.path.join(home, ".gemini", "settings.json"), "mcpServers")):
        data = json.load(open(cfg, encoding="utf-8"))
        got = data[key][name]["command"]
        assert got == exe, "%s 里注册的是 %r" % (cfg, got)
        print("注册：", os.path.relpath(cfg, sb), "→", got)
    copies = [os.path.join(r, f) for r, _, fs in os.walk(exe_dir) for f in fs
              if f.lower().endswith(".exe")]
    assert copies == [exe], "状态目录里多出了 exe 拷贝：%s" % copies

    # ③ 卸载：exe 与用户数据都在，台账与注册都收掉
    rc, out, err = run("--uninstall")
    show("--uninstall", out + ("\n[stderr] " + err if err.strip() else ""))
    assert rc == 0, rc
    assert os.path.isfile(exe), "卸载把 exe 删了"
    assert not os.path.isfile(ledger), "台账没收掉"
    assert not os.path.isdir(os.path.join(exe_dir, ".lumii")), "自己建的目录没收干净"
    for cfg, key in ((os.path.join(home, ".cursor", "mcp.json"), "mcpServers"),
                     (os.path.join(home, ".gemini", "settings.json"), "mcpServers")):
        data = json.load(open(cfg, encoding="utf-8"))
        assert name not in data.get(key, {}), "%s 里还留着我们的条目" % cfg

    rc, out, _ = run("--install-status")
    show("--install-status（卸完之后）", out)
    print("\nPASS（沙箱：%s）" % sb)
    shutil.rmtree(sb, ignore_errors=True)


if __name__ == "__main__":
    main()
