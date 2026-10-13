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
import re
import os
import shutil
import subprocess
import sys
import time

# 部署目录约定：`~/.lumii/mcp/<产品>/<产品>.exe`
# 为什么是这里：主产品 wechat-mcp 就装在这儿（`wechat-mcp/PUBLISHING.md` §1 方式 C），
# 而它由 `src/main/bundled-mcp-exe.ts` 的 `getDeployedMcpExePath()` 决定——沿用，别另开一处。
DATA_DIRNAME = ".lumii"

# 注：这里原本有个 `--check-update`（查远端有没有新版，走 GitHub release 上的清单）。
# **2026-10-13 摘掉了**：本产品不做对外发布 ⇒ 没有发布通道 ⇒ 那个开关永远只能返回 404，
# 是个"注定失败的按钮"（比没有这个功能更糟：后来的人会以为它坏了）。设计留档在
# `docs/design/渠道与CLI/2026-10-12-微信小工具MCP四件套设计.md` §16，要恢复照着捞即可。
# 本模块因此**一条网络请求都不发**——与产品红线「本地处理、不外传」一致。

# 能安全合并的 JSON 客户端配置。**判据是文件在不在**，不是"这个客户端装没装"——
# 有的客户端不装也有配置目录，有的装了配置在别的形状里（Codex 是 TOML，见文件头说明）。
JSON_CLIENTS = (
    ("Claude Desktop", ("APPDATA", "Claude", "claude_desktop_config.json")),
    ("Cursor", ("~", ".cursor", "mcp.json")),
)


def _say(*a):
    """安装动作是**命令行**行为，直接写 stdout（此时协议循环还没接管 stdout）。

    **写不出去也不能崩**：控制台代码页不是 UTF-8 时（中文 Windows 很常见），一个 `✓` 就够
    让向导抛 `UnicodeEncodeError`——而那是**装到一半的现场**（exe 拷了、客户端还没注册）。
    真机上就是这么撞见的；所以这里降级成可编码的近似字符，把流程走完。
    （正常双击路径上 `serve()` 已先 `force_utf8_stdio()`，走到这儿基本不会降级。）
    """
    line = " ".join(str(x) for x in a)
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        enc = getattr(sys.stdout, "encoding", None) or "ascii"
        print(line.encode(enc, "replace").decode(enc, "replace"), flush=True)


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


def installed_record_path(product):
    return os.path.join(install_dir(product), "installed.json")


def _read_installed(product):
    """读装那份的登记（版本/来源/时间）。读不到返回 `{}`。"""
    try:
        with open(installed_record_path(product), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_installed(product, spec, exe):
    """登记**装的是哪一版**。

    为什么要落一个文件而不是问部署副本：`wechat-*-mcp.exe --version` 是 PyInstaller onefile，
    **连打印版本都要先解包，冷启动 1–3 秒**（这条已在 wechat-mcp 那边实测过，主产品因此
    在 TS 侧留了版本常量镜像）。`--install-status` 每次问一遍就等于把状态查询拖成秒级。
    """
    rec = {"product": product, "name": spec["name"], "version": spec.get("version") or "",
           "label": spec.get("label") or "", "exe": exe,
           "installed_at": time.strftime("%Y-%m-%d %H:%M:%S")}
    try:
        os.makedirs(install_dir(product), exist_ok=True)
        _write_cfg(installed_record_path(product), rec)
    except OSError:
        pass                                   # 登记失败不该让安装失败
    return rec


def version_tuple(v):
    """`"0.5.0"` → `(0, 5, 0)`；解析不了的段当 0（宁可判成"一样"，也不误报有新版）。"""
    out = []
    for part in str(v or "").split("."):
        m = "".join(ch for ch in part if ch.isdigit())
        out.append(int(m) if m else 0)
    return tuple(out) or (0,)


def compare_versions(a, b):
    """`a` 比 `b` 新返回 1，相同 0，更旧 -1。"""
    ta, tb = version_tuple(a), version_tuple(b)
    n = max(len(ta), len(tb))
    ta, tb = ta + (0,) * (n - len(ta)), tb + (0,) * (n - len(tb))
    return (ta > tb) - (ta < tb)


def _clean_install_dir(product):
    """卸载后把部署目录也清掉——**包括 `*.old-*` 残留**。

    只删 `product.exe` 是不够的：目录里还躺着升级时让位出来的旧 exe（11MB 一个）。
    用户看到"卸载完了"，磁盘上却还留着一份，这说不过去。
    只删**以产品名打头的**文件，再 `rmdir`（目录里还有别的东西时 rmdir 会失败，正好不误删）。
    """
    d = install_dir(product)
    mine = (product + ".exe", "installed.json", "update.json")
    left = []
    try:
        for f in os.listdir(d):
            if f.startswith(mine):
                try:
                    os.remove(os.path.join(d, f))
                except OSError:
                    left.append(f)                # 正被占用：留给下次（或重启后删除）
            else:
                left.append(f)                    # 不是我们的东西 ⇒ 目录留着，别误删
        if not left:
            os.rmdir(d)
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


# ---- 客户端注册：Codex（TOML，额外小心）-------------------------------------
# ⚠️ `~/.codex/config.toml` 里可能有**明文 API key**（实测本机就有），所以这里的纪律比 JSON
# 那两家更硬：改前备份 → 写完**立刻用 `tomllib` 读回来验** → 读不回来就**整份还原**。
# 标准库只有 `tomllib`（只读），所以是**手工拼段**而不是引入写 TOML 的依赖；
# 手工拼只在"**追加一个还不存在的段**"和"**整段删掉**"这两件事上安全，那就**只做这两件**。

CODEX_CONFIG = ("~", ".codex", "config.toml")


def _toml_str(s):
    """TOML 双引号字符串（**反斜杠必须转义**——Windows 路径全是反斜杠，不转会写出非法 TOML）。"""
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _toml_drop_section(text, header):
    """删掉 `[header]` 整段（到下一个段头之前），含它的子表 `[header.x]`。

    行式删除成立的前提：TOML 的段头**独占一行**。所以"从我这行到下一个 `[` 开头"就是这一段。
    """
    out, skipping = [], False
    for ln in text.splitlines(keepends=True):
        st = ln.strip()
        if st.startswith("["):
            skipping = st == header or st.startswith(header[:-1] + ".")
        if not skipping:
            out.append(ln)
    return "".join(out)


def codex_apply(name, entry=None):
    """注册/注销 Codex 的 MCP 条目 → `(状态, 说明)`。文件不存在 = 没装 = skip。"""
    path = _client_path(CODEX_CONFIG)
    if not path or not os.path.isfile(path):
        return "skip", "未安装（没有配置文件）"
    header = f"[mcp_servers.{name}]"
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        return "fail", f"读不出来，**一个字节都没动**：{e}"

    body = _toml_drop_section(text, header)               # 幂等：先摘掉旧的（没有也不报错）
    if entry is None:                                     # 注销
        if body == text:
            return "skip", "本来就没注册"
    else:
        if not body.endswith("\n"):
            body += "\n"
        body += (f"\n{header}\n"
                 f"type = \"stdio\"\n"
                 f"command = {_toml_str(entry['command'])}\n"
                 f"args = []\n"
                 f"transport = \"stdio\"\n")

    # **写完读回来验**：TOML 拼坏了自己不一定看得出来，但 `tomllib` 一定看得出来。
    try:
        import tomllib
        tomllib.loads(body)
    except Exception as e:                                 # noqa: BLE001
        return "fail", f"拼出来的 TOML 读不回来，**已放弃改动**：{type(e).__name__}: {e}"

    _backup(path)
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            f.write(body)
        os.replace(tmp, path)
    except OSError as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return "fail", f"写入失败（{e}）；原文未动"
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


# 各客户端的技能目录。判据是**客户端目录在不在**（不是"技能目录在不在"）：
# 装了客户端、还没放过任何技能时，技能目录往往不存在，那时我们**该**建它。
# Cursor 不在列：它的 `~/.cursor/skills-cursor/` 旁边有个 `.sync-manifest.json`，
# 看着是**别人在管**的目录——往一个自己看不懂其管理方式的目录里写，比不写更糟。
SKILL_TARGETS = (
    ("Claude Code", ("~", ".claude", "skills"), ("~", ".claude")),
    ("Codex",       ("~", ".codex", "skills"),  ("~", ".codex")),
)


def skill_targets():
    """装了哪些会读技能包的客户端 → `[(客户端, 技能根目录)]`。

    与 JSON 配置同一条纪律：**不去给没装的客户端造目录**。
    """
    out = []
    for label, root_parts, client_parts in SKILL_TARGETS:
        if os.path.isdir(_client_path(client_parts)):
            out.append((label, _client_path(root_parts)))
    return out


def skill_apply(spec, remove=False):
    """装/卸技能包到**各已装客户端** → `[(客户端, 状态, 说明)]`。

    目录名是**技能 id**（= `spec["product"]`），不是 MCP 服务名（= `spec["name"]`）——
    这两个名字不一样，混用过一次，后果是技能包静默没装上而其余步骤全绿。
    """
    src = skill_source(spec)
    targets = skill_targets()
    if not targets:
        return [("技能包", "skip", "没检测到会读技能包的客户端")]
    rows = []
    for label, root in targets:
        dst = os.path.join(root, spec["product"])
        if remove:
            if not os.path.isdir(dst):
                rows.append((label, "skip", "本来就没装"))
                continue
            shutil.rmtree(dst, ignore_errors=True)
            rows.append((label, "ok", dst))
            continue
        if not os.path.isdir(src):
            # 源码模式：技能包就在仓库里，找不到是调用方没给路径 → 跳过
            # 冻结模式：技能包**本该**打进 exe，找不到就是构建漏了 `--add-data` → **报失败**，
            #           别用 skip 蒙混过去（用户会以为装好了，实际客户端里没有这个技能）
            if getattr(sys, "frozen", False):
                rows.append((label, "fail",
                             f"技能包没打进这个 exe（构建漏了 --add-data）：{src or '未提供'}"))
            else:
                rows.append((label, "skip", f"技能包源没找到（{src or '未提供'}）"))
            continue
        try:
            os.makedirs(root, exist_ok=True)
            if os.path.isdir(dst):
                shutil.rmtree(dst, ignore_errors=True)   # 覆盖装：旧文件别留下
            shutil.copytree(src, dst)
            rows.append((label, "ok", dst))
        except OSError as e:
            rows.append((label, "fail", f"拷贝失败（{e}）：{dst}"))
    return rows


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


def clients():
    """本机**可能注册的客户端**及其装没装 → `[{key,label,kind,path,detected}]`。

    判据是"那个客户端自己的东西在不在"（CLI 在不在 PATH / 配置文件在不在），**不是**
    "我们上次装过没"。所以这份清单随机器变，向导据此只列真正能动的那些。

    `kind` 决定怎么读写：`claude_code`（走它的 CLI）/ `json`（合并 JSON）/ `toml`（Codex）。
    三家的纪律完全不同，但**对调用方长得一样**——所以三个动作（装/卸/看状态）都只遍历这一份。
    """
    out = []
    cli = claude_cli()
    out.append({"key": "claude-code", "label": "Claude Code", "kind": "claude_code",
                "path": cli, "detected": bool(cli)})
    for label, parts in JSON_CLIENTS:
        p = _client_path(parts)
        out.append({"key": label.lower().replace(" ", "-"), "label": label, "kind": "json",
                    "path": p, "detected": bool(p and os.path.isfile(p))})
    cp = _client_path(CODEX_CONFIG)
    out.append({"key": "codex", "label": "Codex", "kind": "toml",
                "path": cp, "detected": bool(cp and os.path.isfile(cp))})
    return out


def register_client(c, name, entry):
    """按 `kind` 分派注册 → `(状态, 说明)`。

    Claude Code 那条**先摘再挂**（幂等）；而**摘是尽力而为**——目标本来就不存在时
    `claude mcp remove` 会失败，那时**照样得挂**。真机实测就漏在这儿：卸载过之后再装，
    remove 报 "No MCP server named …"，拿它的结果当闸门的话 add 永远不跑，
    而用户看着"安装"跑完了以为装上了。
    """
    if c["kind"] == "claude_code":
        claude_code_apply(name)
        return claude_code_apply(name, entry["command"])
    if c["kind"] == "toml":
        return codex_apply(name, entry)
    return json_client_apply(c["label"], c["path"], name, entry)


def unregister_client(c, name):
    if c["kind"] == "claude_code":
        return claude_code_apply(name)                 # command=None ⇒ 摘
    if c["kind"] == "toml":
        return codex_apply(name, None)
    return json_client_apply(c["label"], c["path"], name, None)


def _registered_line(c, name):
    """看状态用：这个客户端里我们那一条在不在。"""
    if c["kind"] == "claude_code":
        r, err = _run([claude_cli(), "mcp", "get", name], 60) if claude_cli() else (None, "没装")
        if r is None:
            return "fail", err
        out = (r.stdout or b"").decode("utf-8", "replace").strip().splitlines()
        return ("ok" if r.returncode == 0 else "skip"), (out[0][:90] if out else "未注册")
    if c["kind"] == "toml":
        try:
            with open(c["path"], encoding="utf-8") as f:
                txt = f.read()
        except OSError as e:
            return "fail", f"配置读不出来：{e}"
        has = f"[mcp_servers.{name}]" in txt
        return ("ok" if has else "skip"), (c["path"] if has else "未注册")
    try:
        servers = (_read_cfg(c["path"]).get("mcpServers") or {})
    except Exception as e:                                     # noqa: BLE001
        return "fail", f"配置读不出来：{e}"
    got = servers.get(name)
    return ("ok" if got else "skip"), (str(got.get("command", "")) if got else "未注册")


def do_install(spec, only=None):
    name, product = spec["name"], spec["product"]
    _say(f"\n安装 {spec.get('label') or name}（{name}）")
    seen = []

    prev = _read_installed(product).get("version") or ""
    cur = spec.get("version") or ""
    exe, how = deploy_self(product)
    if exe:
        note = exe
        if prev and cur and prev != cur:
            arrow = "→"
            note = f"{exe}\n      v{prev} {arrow} **v{cur}**"
        seen.append(_line("部署", "ok", note))
        _write_installed(product, spec, exe)
    else:
        seen.append(_line("部署", "skip", how))
        exe, _args = _own_command()

    entry = {"type": "stdio", "command": exe, "args": [], "env": {}}
    for c in clients():
        if not c["detected"]:
            seen.append(_line(c["label"], "skip", "未安装（不去给没装的客户端造配置）"))
        elif only is not None and c["key"] not in only:
            seen.append(_line(c["label"], "skip", "按你的选择跳过"))
        else:
            seen.append(_line(c["label"], *register_client(c, name, entry)))

    for label, st, detail in skill_apply(spec):
        seen.append(_line(f"技能包·{label}", st, detail))

    if _footer(seen):
        return 1

    # 装好了但没授权 → 说清楚，否则用户会以为"装完就能用"，然后在客户端里撞一鼻子灰
    try:
        import mcp_license as L
        st = L.status(product)
        if not st["ok"]:
            _say(f"\n⚠️  还没有授权：{L.describe(st)}")
            _say(f"    {L.how_to_fix(st)}")
    except Exception as e:                                 # noqa: BLE001
        _say(f"\n（授权状态没查成：{e}）")

    _say("\n⚠️  重启你的 AI 客户端，新的 MCP 服务器才会被加载。")
    _say(f"    验证：`claude mcp get {name}`，或在客户端里问一句试试。")
    return 0


def do_uninstall(spec):
    name, product = spec["name"], spec["product"]
    _say(f"\n卸载 {spec.get('label') or name}（{name}）")
    seen = []

    # 卸载**不问**要摘哪些：装的时候能挑，是因为那是加法；摘干净是减法，留一半更糟
    for c in clients():
        if not c["detected"]:
            seen.append(_line(c["label"], "skip", "未安装"))
        else:
            seen.append(_line(c["label"], *unregister_client(c, name)))

    for label, st, detail in skill_apply(spec, remove=True):
        seen.append(_line(f"技能包·{label}", st, detail))

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
    cur = spec.get("version") or ""
    if os.path.isfile(dst):
        _line("部署", "ok", f"{dst}（{os.path.getsize(dst) // 1048576}MB）")
    else:
        _line("部署", "skip", f"没装（期望位置 {dst}）")

    # 版本对账（**纯本地**，不联网——本产品的红线是"本地处理、不外传"）：
    # 你现在跑的这份 vs 装在客户端里那份。不一致就是"该重跑 --install 了"。
    # 装的那份的版本读 `installed.json`，**不去启动它**：onefile 冷启动 1–3s，
    # 每次查状态都解一次包，状态查询就变秒级了。
    inst = _read_installed(product)
    got = inst.get("version") or ""
    if not got:
        _line("版本", "skip", f"当前 v{cur}（没装，或这份登记早于本版本）")
    elif compare_versions(cur, got) > 0:
        _line("版本", "fail", f"跑的是 v{cur}，装的是 v{got} —— **重跑 --install 升级**")
    elif compare_versions(cur, got) < 0:
        _line("版本", "ok", f"跑的是 v{cur}，装的是 v{got}（装的那份更新）")
    else:
        _line("版本", "ok", f"v{got}（与当前一致）")

    for c in clients():
        if not c["detected"]:
            _line(c["label"], "skip", f"未安装（{c['path'] or '找不到'}）")
            continue
        _line(c["label"], *_registered_line(c, name))

    # 技能包按**技能 id**（= product）找目录，不是按服务名。跟 skill_apply 用同一份判断，
    # 别各写各的（写错过一次：明明装了却报"没装"）。
    sts = skill_targets()
    if not sts:
        _line("技能包", "skip", "没检测到会读技能包的客户端")
    for label, root in sts:
        dst_skill = os.path.join(root, product)
        _line(f"技能包·{label}", "ok" if os.path.isdir(dst_skill) else "skip",
              dst_skill if os.path.isdir(dst_skill) else "没装")
    return 0


def is_interactive():
    """**双击 exe**（或在终端里直接敲它）⇒ True；被 MCP 客户端拉起 ⇒ False。

    ⚠️ **不能只用 `sys.stdin.isatty()`**：Windows 上 `NUL` 是**字符设备**，`isatty()` 对它
    返回**真**（实测）。客户端若拿 `NUL` 当 stdin 拉起服务器，服务器就会被弹成一个安装向导、
    再也不干活。真正的判据是 **`GetConsoleMode`** —— 它只对**真正的控制台**返回成功：

        新控制台（双击）  isatty=True   GetConsoleMode=True
        stdin=NUL         isatty=True   GetConsoleMode=False   ← 只有它分得出来
        真管道（客户端）   isatty=False  GetConsoleMode=False

    判不出来一律当**客户端**（安全侧）：宁可双击时显得没反应（用户会再点一次或看文档），
    也不能让服务器在客户端里弹向导——那会把 stdio 传输直接堵死。
    """
    if os.name == "nt":
        try:
            import ctypes
            k32 = ctypes.windll.kernel32
            k32.GetConsoleMode.argtypes = (ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32))
            mode = ctypes.c_uint32(0)
            h = k32.GetStdHandle(-10)                          # STD_INPUT_HANDLE
            return bool(k32.GetConsoleMode(ctypes.c_void_p(h), ctypes.byref(mode)))
        except Exception:                                      # noqa: BLE001
            return False
    try:
        return bool(sys.stdin.isatty())
    except Exception:                                          # noqa: BLE001
        return False


def _ask_raw(prompt):
    """读一行**原文**（不是是/否）。EOF / Ctrl-C 返回 `None`——调用方按默认处理，别卡住。"""
    try:
        return input(prompt)
    except (EOFError, KeyboardInterrupt):
        _say("")
        return None


def _ask(prompt, default_yes=True):
    """问一句 → 是否同意。回车走默认；EOF/Ctrl-C/看不懂的输入都按默认处理（别卡住）。"""
    tail = "[回车=是 / n=否]" if default_yes else "[y=是 / 回车=否]"
    ans = _ask_raw(f"{prompt} {tail} ")
    if ans is None or not ans.strip():
        return default_yes
    return ans.strip().lower() in ("y", "yes", "是")


def _choose_clients(cs, ask_raw=_ask_raw):
    """勾选要注册到哪些客户端 → 选中的 key 集合。

    交互：输入序号**切换**那一项（`2 3` 同时切两个），**直接回车 = 就用当前勾选**。
    默认把检测到的全勾上；没装的显示「（未安装）」且点了不生效——别让人选一个我们根本
    找不到的东西。
    """
    chosen = {c["key"] for c in cs if c["detected"]}
    while True:
        _say("")
        _say("检测到你装了这些 AI 客户端，要注册到哪些？")
        for i, c in enumerate(cs, 1):
            box = "[✓]" if c["key"] in chosen else "[ ]"
            _say(f"  {i}. {box} {c['label']}" + ("" if c["detected"] else "   （未安装）"))
        raw = ask_raw("  输入序号切换（空格/逗号分开），直接回车 = 就这些：")
        if raw is None or not str(raw).strip():
            return chosen
        for tok in re.split(r"[\s,，]+", str(raw).strip()):
            if not tok.isdigit() or not 1 <= int(tok) <= len(cs):
                continue
            c = cs[int(tok) - 1]
            if not c["detected"]:
                _say(f"     {c['label']} 没装，跳过")
            elif c["key"] in chosen:
                chosen.discard(c["key"])
            else:
                chosen.add(c["key"])
        if not chosen:
            _say("     （一个都没勾：那就只部署 exe，不注册到任何客户端）")


def _pause():
    """**别让窗口一装完就消失**——用户双击来的，输出还没看就没了等于没装。"""
    try:
        input("\n按回车关闭这个窗口…")
    except (EOFError, KeyboardInterrupt):
        pass


def interactive(spec, ask=_ask, ask_raw=_ask_raw):
    """双击时走的路：说清楚这是什么 → **勾选客户端** → 一键装 → 该常驻的顺带装上。

    `ask` / `ask_raw` 可注入（测试用），默认走真 `input()`。
    """
    label = spec.get("label") or spec["product"]
    _say("=" * 62)
    _say(f"  {label} v{spec.get('version') or ''}")
    _say("=" * 62)
    _say("这是给 AI 客户端用的插件（MCP 服务器）——不是双击就能自己干活的程序。")
    _say("双击我可以一键装好，之后在 Claude Code / Cursor / Codex 里直接用。")
    _say("")
    _say("接下来会做三件事：")
    _say(f"  1. 把这个 exe 复制到稳定目录 {install_dir(spec['product'])}")
    _say("     （这样你以后清理「下载」文件夹，也不会把注册好的路径弄断）")
    _say("  2. 注册到你指定的 AI 客户端（只加我们这一条，改前备份，不动你的其它配置）")
    _say("  3. 把技能包放到对应客户端的技能目录")
    _say("")
    _say("想撤随时可以：跑 `<本 exe> --uninstall`。")

    prev = _read_installed(spec["product"]).get("version") or ""
    if prev:
        _say(f"\n（检测到已经装过 v{prev}，这一步会直接覆盖升级。）")

    cs = clients()
    if any(c["detected"] for c in cs):
        only = _choose_clients(cs, ask_raw)
    else:
        only = set()
        _say("\n（一个 AI 客户端都没检测到——那就只部署 exe；之后可以跑 `--install` 再来一次。）")

    if not ask("\n现在开始？"):
        _say("\n好，什么都没做。想装的时候再双击一次（或跑 `--install`）。")
        _pause()
        return 0

    rc = do_install(spec, only=only)

    # 需要常驻的产品（撤回防护的守护）：不装它这个功能等于没有，所以顺口问一句
    daemon_flag = spec.get("daemon_install")
    if rc == 0 and daemon_flag:
        _say("")
        if ask(f"这个产品的「撤回防护」需要它**常驻后台**才有效（{daemon_flag}）。现在开开机自启？"):
            cmd, args = _own_command()
            try:
                r = subprocess.run([cmd, *args, daemon_flag], capture_output=True, timeout=180,
                                   **_quiet_kwargs())
                ok = r.returncode == 0
                _line("开机自启", "ok" if ok else "fail",
                      "已开启（开机自动留在后台）" if ok
                      else (r.stderr or b"").decode("utf-8", "replace").strip()[:120])
            except Exception as e:                              # noqa: BLE001
                _line("开机自启", "fail", str(e))
        else:
            _say("  跳过。想开的时候跑 `<本 exe> --install-autostart`。")

    _pause()
    return rc


def do_license_status(spec):
    """`--license-status`：看授权状态 + 授权文件该放哪 + 本机机器码。

    机器码一起打出来是有意的：换授权的整个流程就是「用户把这段发给发行方」，
    分成两条命令会让人多跑一趟。
    """
    import mcp_license as L
    st = L.status(spec["product"])
    _say(f"\n{spec.get('label') or spec['product']} 授权状态")
    _line("授权", "ok" if st["ok"] else "fail", L.describe(st))
    if not st["ok"]:
        _say(f"\n    {L.how_to_fix(st)}")
    _say(f"\n  授权文件：{L.license_path()}")
    _say(f"  本机机器码（把这段发给签发方）：\n{json.dumps(L.machine_id(), ensure_ascii=False, indent=2)}")
    return 0 if st["ok"] else 1


def do_machine_id(_spec):
    """`--machine-id`：只打机器码（脚本化调用时好抓）。"""
    import mcp_license as L
    _say(json.dumps(L.machine_id(), ensure_ascii=False, indent=2))
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
    "--license-status": do_license_status,
    "--machine-id": do_machine_id,
}


def consume_flags(argv, spec):
    """命中命令行开关就执行并返回**退出码**；没命中返回 `None`（调用方据此进 MCP 循环）。

    只认第一个命中的开关：`--install --uninstall` 一起传是没想清楚，别猜。
    """
    for f in ("--install", "--uninstall", "--install-status",
              "--license-status", "--machine-id"):
        if f in argv:
            return FLAGS[f](spec) or 0
    return None
