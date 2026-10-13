# -*- coding: utf-8 -*-
"""四件套共用的**一键安装**：部署到稳定目录、注册到检测到的 MCP 客户端、拷上技能包。

每个小工具 exe 自带这几个开关（在 `mcp_stdio.serve()` 里被拦下，不会进 MCP 循环）：

    wechat-file-mcp.exe --install          # 装（幂等，可重复跑）
    wechat-file-mcp.exe --uninstall        # 卸（摘注册 + 删技能包；**不删用户数据**）
    wechat-file-mcp.exe --install-status   # 看装到哪、注册到哪些客户端

**为什么要它**：原本用户得自己找 exe 路径、手写 `mcpServers` JSON、再手拷技能包目录——
这是上手门槛最高的一环，也是"能不能卖"的第一道坎。

**写别人的配置文件是危险操作**，所以三条纪律（每一条都对应一种真实的翻车方式）：

1. **只改已经存在的客户端配置文件**。不去给没装的客户端造一个目录——造出来的目录会让
   用户以为装了那个客户端，或者只是留一地垃圾。
2. **读不出来就拒绝**。文件不是合法 JSON / 顶层不是对象 ⇒ **一个字节都不动**，只报告。
   宁可不装，也不能把用户手写了几十条的配置洗掉。
3. **只增删我们自己的那个键**，其余内容原样保留；写回走 tmp + `os.replace` 原子替换，
   改之前先备份成 `<文件>.bak`。

**Claude Code 不直接改它的配置**：`~/.claude.json` 是 Claude Code 自己的状态库（实测 60 个
顶层键，混着 projects/pluginUsage/tipsHistory 等），整体重写必然出事；而它自带
`claude mcp add/remove -s user` 就是干这个的、并且自己知道怎么加锁。**有 CLI 就用 CLI。**
"""
import json
import os
import shutil
import subprocess
import sys
import time

# 部署目录约定：`~/.lumii/mcp/<产品>/<产品>.exe`
# 为什么是这里：主产品 wechat-mcp 就装在这儿（`wechat-mcp/PUBLISHING.md` §1 方式 C），
# 而它由 `src/main/bundled-mcp-exe.ts` 的 `getDeployedMcpExePath()` 决定——沿用，别另开一处。
DATA_DIRNAME = ".lumii"

# 能安全合并的 JSON 客户端配置。**判据是文件在不在**，不是"这个客户端装没装"——
# 有的客户端不装也有配置目录，有的装了配置在别的形状里（Codex 是 TOML，见文件头说明）。
JSON_CLIENTS = (
    ("Claude Desktop", ("APPDATA", "Claude", "claude_desktop_config.json")),
    ("Cursor", ("~", ".cursor", "mcp.json")),
)


def _say(*a):
    """安装动作是**命令行**行为，直接写 stdout（此时协议循环还没接管 stdout）。"""
    print(*a, flush=True)


def data_root():
    return os.path.join(os.path.expanduser("~"), DATA_DIRNAME)


def install_dir(product):
    return os.path.join(data_root(), "mcp", product)


def deployed_exe(product):
    return os.path.join(install_dir(product), product + ".exe")


# ---- 部署自身 ---------------------------------------------------------------

def _prune_old(dst_dir, product, keep=2):
    """清理 `*.old-*` 残留。

    每次覆盖都会留一个旧 exe（10MB 上下），不清理就是慢性涨盘；留最近两个够回退了。
    """
    olds = sorted(f for f in os.listdir(dst_dir) if f.startswith(product + ".exe.old-"))
    for f in olds[:-keep] if keep else olds:
        try:
            os.remove(os.path.join(dst_dir, f))
        except OSError:
            pass                      # 正被占用就留给下次


def _clean_install_dir(product):
    """卸载后把部署目录也清掉——**包括 `*.old-*` 残留**。

    只删 `product.exe` 是不够的：目录里还躺着升级时让位出来的旧 exe（11MB 一个）。
    用户看到"卸载完了"，磁盘上却还留着一份，这说不过去。
    只删**以产品名打头的**文件，再 `rmdir`（目录里还有别的东西时 rmdir 会失败，正好不误删）。
    """
    d = install_dir(product)
    try:
        for f in os.listdir(d):
            if f.startswith(product + ".exe"):
                try:
                    os.remove(os.path.join(d, f))
                except OSError:
                    pass                          # 正被占用：留给下次（或重启后删除）
        os.rmdir(d)                               # 非空会抛，正好
    except OSError:
        pass


def deploy_self(product):
    """把自身拷到稳定目录 → `(部署后的路径 | None, 说明)`。

    **为什么要拷**：用户多半是从"下载"目录双击跑的，那地方随时会被清掉；而注册进客户端
    配置里的路径必须固定下来。

    覆盖用**「旧文件改名让位」**而不是直接 `copy2` 到目标：Windows 下**运行中的 exe 可以改名、
    不能覆盖**（直接覆盖是 `WinError 5`）。主产品的 `bundled-mcp-exe.ts` 就是这套做法。
    """
    dst = deployed_exe(product)
    if not getattr(sys, "frozen", False):
        return None, "源码模式运行：不拷贝自身（用解释器 + 脚本路径注册）"
    src = os.path.abspath(sys.executable)
    if src.lower() == os.path.abspath(dst).lower():
        return dst, "已经在部署目录里，跳过拷贝"
    dst_dir = os.path.dirname(dst)
    os.makedirs(dst_dir, exist_ok=True)
    tmp = dst + ".tmp"
    shutil.copy2(src, tmp)
    if os.path.exists(dst):
        os.replace(dst, f"{dst}.old-{int(time.time() * 1000)}")
    os.replace(tmp, dst)
    _prune_old(dst_dir, product)
    return dst, "ok"


# ---- 客户端注册：JSON 配置（Claude Desktop / Cursor）-------------------------

def _client_path(spec_parts):
    parts = []
    for p in spec_parts:
        if p == "~":
            parts.append(os.path.expanduser("~"))
        elif p == "APPDATA":
            base = os.environ.get("APPDATA")
            if not base:
                return None
            parts.append(base)
        else:
            parts.append(p)
    return os.path.join(*parts)


def _read_cfg(path):
    """读客户端配置；**读不懂就抛**（调用方据此拒绝改动，绝不覆盖）。"""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("顶层不是 JSON 对象")
    return data


def _write_cfg(path, data):
    """原子写回：先落 `.tmp` 再 `os.replace`——中途断电也不会留下半个配置文件。"""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def _backup(path):
    try:
        shutil.copy2(path, path + ".bak")
    except OSError:
        pass                          # 备份失败不阻断（有 .bak 是加分项，不是前提）


def json_client_apply(label, path, name, entry):
    """向某个 JSON 客户端增删我们那一条 → `(状态, 说明)`；状态 ∈ ok/skip/fail。"""
    if not path or not os.path.isfile(path):
        return "skip", "未安装（没有配置文件）"
    try:
        data = _read_cfg(path)
    except Exception as e:                                     # noqa: BLE001
        return "fail", f"配置读不出来，**一个字节都没动**：{e}"
    servers = data.get("mcpServers")
    if entry is None:                                          # 注销
        if not isinstance(servers, dict) or name not in servers:
            return "skip", "本来就没注册"
        _backup(path)
        del servers[name]
    else:
        if isinstance(servers, dict) and servers.get(name) == entry:
            return "ok", "已在注册（内容一致）"
        _backup(path)
        data.setdefault("mcpServers", {})[name] = entry
    _write_cfg(path, data)
    return "ok", path


# ---- 客户端注册：Claude Code（走它自己的 CLI）-------------------------------

def claude_cli():
    return shutil.which("claude")


def _quiet_kwargs():
    """调子进程时别弹出控制台窗口。

    注意是 `creationflags=CREATE_NO_WINDOW`，**不是** `windowsHide`——后者是 Node 的写法，
    Python 的 `subprocess` 里没有这个参数（真跑一次就会 `TypeError`）。
    """
    if os.name == "nt":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}
    return {}


def _run(cmd, timeout):
    """跑一个外部命令 → `(CompletedProcess | None, 错误说明)`。**永远返回二元组**。"""
    try:
        return subprocess.run(cmd, capture_output=True, timeout=timeout, **_quiet_kwargs()), ""
    except Exception as e:                                     # noqa: BLE001
        return None, str(e)


def claude_code_apply(name, command=None, args=()):
    """用 `claude mcp` 注册/注销（user 级）→ `(状态, 说明)`。

    **有 CLI 就用 CLI**，不去手改 `~/.claude.json`：那是 Claude Code 的状态库，
    我们读写之间它自己也在写，竞态下丢的是用户的项目状态。
    """
    exe = claude_cli()
    if not exe:
        return "skip", "没装 claude CLI"
    if command is None:
        cmd = [exe, "mcp", "remove", name, "-s", "user"]
    else:
        cmd = [exe, "mcp", "add", name, "-s", "user", "--", command, *args]
    r, err = _run(cmd, 180)
    if r is None:
        return "fail", f"调 claude CLI 失败：{err}"
    out = ((r.stdout or b"").decode("utf-8", "replace")
           + (r.stderr or b"").decode("utf-8", "replace")).strip()
    if r.returncode != 0:
        return "fail", out.splitlines()[0][:160] if out else f"退出码 {r.returncode}"
    return "ok", (out.splitlines()[0][:160] if out else "ok")


# ---- 技能包 -----------------------------------------------------------------

def skill_source(spec):
    """技能包源目录。

    冻结后技能包是**打进 exe** 的（构建脚本 `--add-data`），从 `sys._MEIPASS` 解出来——
    单文件产品不该要求"技能包得跟 exe 放在一起"。源码模式直接读产品目录。

    ⚠️ 目录名用 `product`（`wechat-file-mcp`）而**不是** `name`（`wechat-file`）：
    技能 id 与 MCP 服务名是**两个不同的名字**（SKILL.md 的 frontmatter 写的是 `wechat-file-mcp`），
    实测第一次真装就栽在这儿——拿服务名去找，`_MEIPASS/skills/wechat-file` 根本不存在。
    """
    if getattr(sys, "frozen", False):
        cand = os.path.join(getattr(sys, "_MEIPASS", ""), "skills", spec["product"])
        if os.path.isdir(cand):
            return cand
    return spec.get("skill") or ""


def skills_root():
    """Claude Code 的用户级技能目录：`~/.claude/skills/<skill-id>/SKILL.md`。

    只装这一处：Cursor（`.cursor/skills-cursor/`）与 Codex（`.codex/skills/`）的根目录不同，
    而 `.cursor/skills-cursor/` 旁边还有个 `.sync-manifest.json`，看着是**别人在管**的目录——
    往一个自己看不懂其管理方式的目录里写，比不写更糟。
    """
    return os.path.join(os.path.expanduser("~"), ".claude", "skills")


def skill_apply(spec, remove=False):
    src = skill_source(spec)
    dst = os.path.join(skills_root(), spec["product"])       # 目录名 = 技能 id，不是服务名
    if remove:
        if not os.path.isdir(dst):
            return "skip", "本来就没装"
        shutil.rmtree(dst, ignore_errors=True)
        return "ok", dst
    if not os.path.isdir(src):
        # 源码模式：技能包就在仓库里，找不到是调用方没给路径 → 跳过
        # 冻结模式：技能包**本该**打进 exe，找不到就是构建漏了 `--add-data` → **报失败**，
        #           别用 skip 蒙混过去（用户会以为装好了，实际客户端里没有这个技能）
        if getattr(sys, "frozen", False):
            return "fail", f"技能包没打进这个 exe（构建漏了 --add-data）：{src or '未提供'}"
        return "skip", f"技能包源没找到（{src or '未提供'}）"
    os.makedirs(skills_root(), exist_ok=True)
    if os.path.isdir(dst):
        shutil.rmtree(dst, ignore_errors=True)     # 覆盖装：旧文件别留下
    shutil.copytree(src, dst)
    return "ok", dst


# ---- 三个动作 ---------------------------------------------------------------

def _own_command():
    """客户端配置里我们该长什么样 → `(command, args)`。

    冻结时就是 exe 自己；源码模式用「解释器 + 脚本」，方便开发期直接注册来试。
    """
    if getattr(sys, "frozen", False):
        return sys.executable, []
    return sys.executable, [os.path.abspath(sys.argv[0])]


def _line(label, status, detail):
    mark = {"ok": "✅", "skip": "⏭️", "fail": "❌"}.get(status, "•")
    _say(f"  {mark} {label:<15} {detail}")
    return status


def _footer(seen):
    """结尾把「有没有真装成」说清楚。

    为什么要有：`fail` 的行夹在中间，用户扫一眼看到最后一句"重启客户端"就以为装好了。
    装了一半的安装器比失败的安装器更坑——后者至少会去查。
    """
    bad = sum(1 for s in seen if s == "fail")
    if bad:
        _say(f"\n❌ 有 {bad} 项**没装成**（上面标 ❌ 的行）——别当成装好了。")
    return bad


def do_install(spec):
    name, product = spec["name"], spec["product"]
    _say(f"\n安装 {spec.get('label') or name}（{name}）")
    seen = []

    exe, how = deploy_self(product)
    if exe:
        seen.append(_line("部署", "ok", exe))
    else:
        seen.append(_line("部署", "skip", how))
        exe, _args = _own_command()

    # 幂等靠「先摘再挂」，但**摘是尽力而为**：目标本来就不存在时 `claude mcp remove` 会失败，
    # 那时**照样得挂**。真机实测就是这么漏装了一个——卸载过之后再装，remove 报
    # "No MCP server named …"，如果拿它的结果当闸门，add 就永远不跑，而用户以为装上了。
    claude_code_apply(name)
    seen.append(_line("Claude Code", *claude_code_apply(name, exe)))

    entry = {"type": "stdio", "command": exe, "args": [], "env": {}}
    for label, parts in JSON_CLIENTS:
        st, detail = json_client_apply(label, _client_path(parts), name, entry)
        seen.append(_line(label, st, detail))

    st, detail = skill_apply(spec)
    seen.append(_line("技能包", st, detail))

    if _footer(seen):
        return 1
    _say("\n⚠️  重启你的 AI 客户端，新的 MCP 服务器才会被加载。")
    _say(f"    验证：`claude mcp get {name}`，或在客户端里问一句试试。")
    return 0


def do_uninstall(spec):
    name, product = spec["name"], spec["product"]
    _say(f"\n卸载 {spec.get('label') or name}（{name}）")
    seen = []

    seen.append(_line("Claude Code", *claude_code_apply(name)))

    for label, parts in JSON_CLIENTS:
        seen.append(_line(label, *json_client_apply(label, _client_path(parts), name, None)))

    seen.append(_line("技能包", *skill_apply(spec, remove=True)))

    dst = deployed_exe(product)
    if not os.path.isfile(dst):
        seen.append(_line("部署", "skip", "部署目录里没有它"))
    elif os.path.abspath(sys.executable).lower() == os.path.abspath(dst).lower():
        # 正在跑的就是它自己：Windows 删不掉运行中的 exe，安排重启后删
        if _delete_on_reboot(dst):
            seen.append(_line("部署", "ok", f"正在运行删不掉，已安排**重启后**删除：{dst}"))
        else:
            seen.append(_line("部署", "fail", f"删不掉，请手动删除：{dst}"))
    else:
        try:
            os.remove(dst)
            seen.append(_line("部署", "ok", dst))
        except OSError as e:
            seen.append(_line("部署", "fail", f"删除失败（{e}）：{dst}"))
    _clean_install_dir(product)

    # 用户数据**一律不动**——但要说清留在哪，免得用户以为卸载没干净
    _say("\nℹ️  你的数据没有动（卸载不该删数据）：")
    _say("    · D 的归档库：~/.lumii/wechat-recall/archive.db")
    _say("    · A/B 归档与导出的文件：你当初指定的 out_dir")
    _say("    要清就自己删。")
    if _footer(seen):
        return 1
    _say("\n⚠️  重启你的 AI 客户端，被摘掉的服务器才会从列表里消失。")
    return 0


def do_status(spec):
    name, product = spec["name"], spec["product"]
    _say(f"\n{spec.get('label') or name}（{name}）安装状态")

    dst = deployed_exe(product)
    if os.path.isfile(dst):
        _line("部署", "ok", f"{dst}（{os.path.getsize(dst) // 1048576}MB）")
    else:
        _line("部署", "skip", f"没装（期望位置 {dst}）")

    exe = claude_cli()
    if exe:
        r, err = _run([exe, "mcp", "get", name], 60)
        if r is None:
            _line("Claude Code", "fail", err)
        else:
            out = (r.stdout or b"").decode("utf-8", "replace").strip().splitlines()
            _line("Claude Code", "ok" if r.returncode == 0 else "skip",
                  out[0][:100] if out else f"未注册（退出码 {r.returncode}）")
    else:
        _line("Claude Code", "skip", "没装 claude CLI")

    for label, parts in JSON_CLIENTS:
        path = _client_path(parts)
        if not path or not os.path.isfile(path):
            _line(label, "skip", "未安装")
            continue
        try:
            servers = (_read_cfg(path).get("mcpServers") or {})
        except Exception as e:                                 # noqa: BLE001
            _line(label, "fail", f"配置读不出来：{e}")
            continue
        entry = servers.get(name)
        _line(label, "ok" if entry else "skip",
              (entry or {}).get("command", "未注册") if entry else "未注册")

    dst_skill = os.path.join(skills_root(), name)
    _line("技能包", "ok" if os.path.isdir(dst_skill) else "skip",
          dst_skill if os.path.isdir(dst_skill) else "没装")
    return 0


def _delete_on_reboot(path):
    """安排**重启后删除**自己（运行中的 exe 删不掉）。

    `MoveFileEx(..., MOVEFILE_DELAY_UNTIL_REBOOT)` 是 Windows 给这件事的标准口子——
    比"再起一个进程等几秒再删"稳（不用赌延迟够不够）。
    """
    import ctypes
    MOVEFILE_DELAY_UNTIL_REBOOT = 0x4
    try:
        k32 = ctypes.windll.kernel32
        k32.MoveFileExW.argtypes = (ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32)
        return bool(k32.MoveFileExW(path, None, MOVEFILE_DELAY_UNTIL_REBOOT))
    except Exception:                                          # noqa: BLE001
        return False


FLAGS = {
    "--install": do_install,
    "--uninstall": do_uninstall,
    "--install-status": do_status,
}


def consume_flags(argv, spec):
    """命中安装类开关就执行并返回**退出码**；没命中返回 `None`（调用方据此进 MCP 循环）。

    只认第一个命中的开关：`--install --uninstall` 一起传是没想清楚，别猜。
    """
    for f in ("--install", "--uninstall", "--install-status"):
        if f in argv:
            return FLAGS[f](spec) or 0
    return None
