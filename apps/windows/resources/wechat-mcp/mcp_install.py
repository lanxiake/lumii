# -*- coding: utf-8 -*-
"""四件套共用的**一键安装**：把**这份 exe 自己**注册到检测到的 MCP 客户端、拷上技能包。

不拷贝、不搬运：注册进客户端的路径就是"你双击的这个 exe 现在在哪"。代价写在安装提示里——
装完**别移动、别删除它**（客户端配置里存的就是这个路径）。安装台账落在 exe 旁边的 `.lumii/`。

每个小工具 exe 自带这几个开关（在 `mcp_stdio.serve()` 里被拦下，不会进 MCP 循环）：

    wechat-file-mcp.exe --install          # 装（幂等，可重复跑）
    wechat-file-mcp.exe --uninstall        # 卸（摘注册 + 删技能包；**不删用户数据**）
    wechat-file-mcp.exe --install-status   # 看装到哪、注册到哪些客户端
    wechat-file-mcp.exe --expiry-status    # 看这份 exe 的有效期到哪天

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

# 数据目录名。现在有**两个根**，别混：
#   · 冻结运行时 → **exe 旁边那份** `<exe目录>/.lumii/`（安装台账落这儿，跟着 exe 走）
#   · 源码模式与老安装器 → `~/.lumii/`（见 `user_root()`）
# `~/.lumii/mcp/<产品>/` 是**老安装器**的落点（它把 exe 拷到那儿再注册），现在只剩
# "认领旧拷贝"这一个用途。注意 App 侧 `bundled-mcp-exe.ts::getDeployedMcpExePath()` 也用这条路径
# 部署**它自己的**那份主产品 exe——那是 App 的事，别去动（我们只删台账里记着的、我们自己拷的那份）。
DATA_DIRNAME = ".lumii"

# 注：这里原本有个 `--check-update`（查远端有没有新版，走 GitHub release 上的清单）。
# **2026-10-13 摘掉了**：本产品不做对外发布 ⇒ 没有发布通道 ⇒ 那个开关永远只能返回 404，
# 是个"注定失败的按钮"（比没有这个功能更糟：后来的人会以为它坏了）。设计留档在
# `docs/design/渠道与CLI/2026-10-12-微信小工具MCP四件套设计.md` §16，要恢复照着捞即可。
# 本模块因此**一条网络请求都不发**——与产品红线「本地处理、不外传」一致。

# 客户端注册表（2026-10-13 调研后扩到 15 家）。每条说清三件事：
#   ① 怎么认出"装了"（`detect` 目录在不在）
#   ② 配置写在哪（`paths`，**命中第一个已存在的**，都不存在就用第一个）
#   ③ 写进去长什么样（`kind` 决定，因为各家语法差别很大）
#
# **判据是"客户端在不在"，不是"配置文件在不在"**：客户端装了但还没建过配置（首次使用的
# 客户端就是），我们**该**替它建——那正是它自己的 UI 也会做的事。反过来，客户端目录都不在
# 就一个字节都不碰。
#
# `kind` 的五种写法：
#   claude_code        —— 走它自己的 `claude mcp` CLI（**不手改它的状态文件**）
#   json_mcp           —— JSON，顶层 `mcpServers`（大多数）
#   json_servers       —— JSON，顶层 `servers`（VS Code）
#   json_context       —— JSON，顶层 `context_servers`（Zed）
#   json_opencode      —— JSON，顶层 `mcp`，且 command 是**数组**、env 叫 `environment`
#   toml_codex         —— TOML 段 `[mcp_servers.<名>]`
#
# **刻意没做的**（都有明确理由，不是漏）：
#   Continue    —— YAML，且 `mcpServers` 是**列表**。标准库没有 YAML 解析器 ⇒
#                  **没法"写完读回来验"**；写坏了看不出来。宁可不上。
#   JetBrains / 通义灵码 —— 官方没文档化独立配置文件（只能 UI 或内部 XML），程序化写不了。
#   Windsurf(Devin) —— 顶层键在多个来源里说法不一，且产品已改名 ⇒ 没把握就别动。
#   Aider       —— MCP 支持至今没合并发布（PR #3672/#3937/#5694 挂着）。
CLIENTS = (
    # 灵栖自己的 MCP 配置（`~/.lumii/config/mcp-servers.json`，标准 mcpServers 格式）。
    # `detect` 用 `config/` 而不是 `~/.lumii`：四件套自己的数据目录（如撤回归档
    # `~/.lumii/wechat-recall/`）也会建 `~/.lumii`，拿它当判据会把"没装灵栖"误判成装了。
    {"key": "lumii", "label": "Lumii", "kind": "json_mcp",
     "paths": (("~", ".lumii", "config", "mcp-servers.json"),),
     "detect": ("~", ".lumii", "config")},
    {"key": "claude-code", "label": "Claude Code", "kind": "claude_code"},
    {"key": "claude-desktop", "label": "Claude Desktop", "kind": "json_mcp",
     # MSIX/Store 版会被文件系统虚拟化重定向到 Packages 下——两个位置都试
     "paths": (("APPDATA", "Claude", "claude_desktop_config.json"),
               ("LOCALAPPDATA", "Packages", "Claude_*", "LocalCache", "Roaming",
                "Claude", "claude_desktop_config.json")),
     "detect": ("APPDATA", "Claude")},
    {"key": "cursor", "label": "Cursor", "kind": "json_mcp",
     "paths": (("~", ".cursor", "mcp.json"),)},
    {"key": "codex", "label": "Codex", "kind": "toml_codex",
     "paths": (("~", ".codex", "config.toml"),)},
    {"key": "gemini", "label": "Gemini CLI", "kind": "json_mcp",
     "paths": (("~", ".gemini", "settings.json"),), "detect": ("~", ".gemini")},
    {"key": "qwen", "label": "Qwen Code", "kind": "json_mcp",
     "paths": (("~", ".qwen", "settings.json"),), "detect": ("~", ".qwen")},
    {"key": "opencode", "label": "OpenCode", "kind": "json_opencode",
     "paths": (("~", ".config", "opencode", "opencode.json"),)},
    {"key": "zed", "label": "Zed", "kind": "json_context",
     "paths": (("APPDATA", "Zed", "settings.json"),), "detect": ("APPDATA", "Zed")},
    {"key": "vscode", "label": "VS Code", "kind": "json_servers",
     # 官方说"别手摸这个路径、走命令面板"，但路径本身是确定的；合并写（不动别的键）风险可控
     "paths": (("APPDATA", "Code", "User", "globalStorage", "modelcontextprotocol.mcp",
                "mcp.json"),),
     "detect": ("APPDATA", "Code", "User", "globalStorage",
                "modelcontextprotocol.mcp")},
    {"key": "copilot-cli", "label": "Copilot CLI", "kind": "json_mcp",
     "paths": (("~", ".copilot", "mcp-config.json"),), "detect": ("~", ".copilot")},
    {"key": "cline", "label": "Cline", "kind": "json_mcp",
     "paths": (("APPDATA", "Code", "User", "globalStorage", "saoudrizwan.claude-dev",
                "settings", "cline_mcp_settings.json"),
               ("~", ".cline", "data", "settings", "cline_mcp_settings.json")),
     "detect": ("APPDATA", "Code", "User", "globalStorage", "saoudrizwan.claude-dev")},
    {"key": "roo", "label": "Roo Code", "kind": "json_mcp",
     "paths": (("APPDATA", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline",
                "settings", "mcp_settings.json"),),
     "detect": ("APPDATA", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline")},
    {"key": "trae", "label": "Trae", "kind": "json_mcp",
     "paths": (("APPDATA", "Trae", "User", "mcp.json"),
               ("APPDATA", "Trae CN", "User", "mcp.json"))},
    {"key": "warp", "label": "Warp", "kind": "json_mcp",
     "paths": (("~", ".warp", ".mcp.json"),), "detect": ("~", ".warp")},
)

# 各家顶层键 / 条目形状（`kind` → 怎么塞我们那一条）
# `args` 是**源码模式**才用得上（注册的是"解释器 + 脚本"，脚本路径得进 args）；
# 冻结模式下恒为空——注册的就是 exe 本身。
JSON_SHAPES = {
    "json_mcp": ("mcpServers", lambda exe, args=(): {"type": "stdio", "command": exe,
                                                     "args": list(args), "env": {}}),
    "json_servers": ("servers", lambda exe, args=(): {"type": "stdio", "command": exe,
                                                      "args": list(args)}),
    "json_context": ("context_servers", lambda exe, args=(): {"command": exe,
                                                              "args": list(args), "env": {}}),
    # OpenCode 三处都不一样：顶层 `mcp`、command 是 **argv 数组**、env 叫 `environment`
    "json_opencode": ("mcp", lambda exe, args=(): {"type": "local", "command": [exe, *args],
                                                   "enabled": True, "environment": {}}),
}


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


def own_exe():
    """**注册的就是你自己**：这份 exe 现在在哪，就往客户端里填哪个路径——一个字节都不拷。

    为什么不拷到"稳定目录"（老做法）：拷完就有两份，用户分不清哪份在跑，升级时还要绕
    "运行中的 exe 删不掉"这道坎。代价写在安装提示里：装完**别移动、别删除这个 exe**——
    它本身就是注册路径。源码模式（`python server.py`）返回 `None`：那会儿没有 exe 可注册，
    调用方退回"解释器 + 脚本"。
    """
    return os.path.abspath(sys.executable) if getattr(sys, "frozen", False) else None


def user_root():
    """用户级数据根 `~/.lumii`：**老安装器**的落点，也是源码模式的数据根。"""
    return os.path.join(os.path.expanduser("~"), DATA_DIRNAME)


def data_root():
    """本产品状态根：**exe 旁边那份 `.lumii/`**。

    既然注册的是 exe 当前位置，"装在哪"就等于"exe 在哪"——台账跟着走，才不会出现
    "exe 换了地方、状态还留在老地方"。**运行数据不在这里**：画像蒸馏 / 撤回归档 / ASR 模型
    仍在 `~/.lumii`——那些是用户内容，而且 App 与 MCP 共用同一个根（见四件套 README）。
    """
    if getattr(sys, "frozen", False):
        return os.path.join(os.path.dirname(os.path.abspath(sys.executable)), DATA_DIRNAME)
    return user_root()


def install_dir(product):
    """本产品的状态目录。现在**只放台账**——exe 不再拷进来。"""
    return os.path.join(data_root(), "mcp", product)


def legacy_install_dir(product):
    """**老安装器**（≤0.13.0）的状态目录：exe 拷贝与台账都躺在那儿（`~/.lumii/mcp/<产品>/`）。

    只用于两件事：认得出（状态里说一句）、卸得掉（别留孤儿）。
    """
    return os.path.join(user_root(), "mcp", product)


def installed_record_path(product):
    return os.path.join(install_dir(product), "installed.json")


def _read_installed(product):
    """读这份安装的台账（版本 / 注册的路径 / 装到过哪些客户端）。读不到返回 `{}`。"""
    try:
        with open(installed_record_path(product), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _read_legacy_installed(product):
    """读**老安装器**的台账。只给"认领旧拷贝"用（见 `_drop_legacy_copy`）。"""
    try:
        with open(os.path.join(legacy_install_dir(product), "installed.json"),
                  encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_installed(product, spec, exe, clients=None):
    """登记**装的是哪一版、注册的是哪个路径、装到了哪些客户端**。

    为什么要落一个文件而不是去问那个 exe：`--version` 是 PyInstaller onefile，**连打印版本都要
    先解包，冷启动 1–3 秒**（主产品那边实测过）。每次状态查询都启动一遍，状态就变秒级了。

    `clients` 是这次**真注册成**的客户端 key——卸载时靠它分辨"全摘"还是"只摘一部分"：
    只摘一部分就不该去动技能包和常驻守护。
    """
    rec = {"product": product, "name": spec["name"], "version": spec.get("version") or "",
           "label": spec.get("label") or "", "exe": exe,
           "clients": sorted(clients or []),
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


# ---- 收尾：状态目录与老安装器留的拷贝 ---------------------------------------

def _drop_state_dir(product):
    """全摘之后收掉我们自己的状态目录（`<状态根>/mcp/<产品>/`，里面只有那份台账）。

    逐级往上 `rmdir`——每一级都只在**空**的时候才成功，所以别的产品、别人放的东西一律留得住。
    """
    try:
        os.remove(installed_record_path(product))
    except OSError:
        pass
    d = install_dir(product)
    for _ in range(3):                          # mcp/<产品> → mcp → 状态根
        try:
            os.rmdir(d)
        except OSError:
            break
        d = os.path.dirname(d)


def _drop_legacy_copy(product):
    """清掉**老安装器**留下的 exe 拷贝 → 删掉的文件名列表（没得清就是空的）。

    ≤0.13.0 那版会把 exe 拷到 `~/.lumii/mcp/<产品>/` 再注册那一份；现在注册的是 exe 本身，
    那份拷贝没人用了。**只认台账里记着的那个路径**：那个目录里也可能躺着别人放的东西
    （主产品的 exe 就是 App 自己部署在那儿的），凭"文件名像我们的"就删是危险的。
    """
    rec = _read_legacy_installed(product)
    old = os.path.abspath(rec.get("exe") or "")
    d = os.path.abspath(legacy_install_dir(product))
    if not old or os.path.dirname(old).lower() != d.lower():
        return []
    if old.lower() == (own_exe() or "").lower():
        return []                              # 正在跑的就是那份拷贝（用户直接双击了它）
    gone = []
    for f in os.listdir(d) if os.path.isdir(d) else []:
        if f.startswith(product + ".exe") or f == "installed.json":
            try:
                os.remove(os.path.join(d, f))
                gone.append(f)
            except OSError:
                pass                           # 正被占用（比如守护进程在跑）就留给下次
    try:
        os.rmdir(d)                            # 里面还有别人的东西 ⇒ 失败，正好不误删
    except OSError:
        pass
    return gone


# ---- 客户端注册：JSON 配置（Claude Desktop / Cursor）-------------------------

def _client_path(spec_parts):
    """把路径段拼成绝对路径。段里带 `*`（MSIX 的 `Packages\\Claude_*`）就 **glob 展开取第一个**。

    展开不到（那个包还没装 / 环境变量没有）返回 `None`——调用方据此跳过这一条候选路径。
    """
    if not spec_parts:
        return None
    parts = []
    for p in spec_parts:
        if p == "~":
            parts.append(os.path.expanduser("~"))
        elif p in ("APPDATA", "LOCALAPPDATA"):
            base = os.environ.get(p)
            if not base:
                return None
            parts.append(base)
        else:
            parts.append(p)
    pattern = os.path.join(*parts)
    if "*" not in pattern:
        return pattern
    import glob
    hits = sorted(glob.glob(pattern))
    return hits[0] if hits else None


def _strip_jsonc(text):
    """去掉 JSONC 的注释 → `(去注释后的文本, 是否原本有注释)`。

    哪些客户端是 JSONC：**OpenCode 的 `opencode.json`、Zed 的 `settings.json`**（Zed 出厂那份
    默认设置里就带一大段注释）。逐字符走、跟踪 in-string 状态——字符串里的 `//` 不是注释。
    """
    out, i, n, in_str, esc, had = [], 0, len(text), False, False, False
    while i < n:
        ch = text[i]
        if in_str:
            out.append(ch)
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            i += 1
            continue
        if ch == '"':
            in_str = True
        elif ch == "/" and i + 1 < n and text[i + 1] == "/":
            had = True
            while i < n and text[i] not in "\r\n":
                i += 1
            continue
        elif ch == "/" and i + 1 < n and text[i + 1] == "*":
            had = True
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out), had


def _read_cfg(path):
    """读客户端配置 → `(data, 原本有没有注释)`；**读不懂就抛**（调用方据此拒绝改动）。

    带注释的 JSONC 也能读，但调用方拿到 `had_comments=True` 时必须**拒绝写**：
    我们写回是 `json.dump` 重新序列化，**注释会被抹掉**——那是用户手写的内容，
    宁可不装也不能洗掉（与"读不出来一个字节都不动"同一条纪律）。
    """
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    try:
        data = json.loads(raw)
        had = False
    except ValueError:
        cleaned, had = _strip_jsonc(raw)
        data = json.loads(cleaned)              # 还是不行就抛出去（fail-closed）
        if not had:
            raise                           # 不是注释的锅（比如尾逗号）：别假装读懂了
    if not isinstance(data, dict):
        raise ValueError("顶层不是 JSON 对象")
    return data, had


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


def json_client_apply(label, path, name, entry, top_key="mcpServers"):
    """向某个 **JSON** 客户端增删我们那一条 → `(状态, 说明)`；状态 ∈ ok/skip/fail。

    `top_key` 各家不同（多数 `mcpServers`、VS Code `servers`、Zed `context_servers`、
    OpenCode `mcp`）——**只动我们自己的那个键**，其余内容原样保留。
    """
    if not path:
        return "skip", "没有可写的位置"
    if not os.path.isfile(path):
        # 客户端在、配置还没建过（首次使用的客户端就是这样）⇒ **替它建**，这正是它自己的 UI 也会做的事。
        # 注意：调用方只在"客户端目录在"时才会走到这儿（见 `clients()`）。
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
        except OSError as e:
            return "fail", f"建不了配置目录：{e}"
    try:
        data, had_comments = _read_cfg(path) if os.path.isfile(path) else ({}, False)
    except Exception as e:                                     # noqa: BLE001
        return "fail", f"配置读不出来，**一个字节都没动**：{e}"
    if had_comments and entry is not None:
        # 写回是重新序列化 ⇒ 会把用户写的 `// 注释` 抹掉。**宁可不装**，把能直接粘的片段给他。
        snippet = json.dumps({top_key: {name: entry}}, ensure_ascii=False, indent=2)
        return "fail", ("这个配置里有 `//` 注释——重写会**丢掉你的注释**，所以没动它。\n"
                        f"     手动加进去（粘到 {top_key} 里即可）：\n"
                        + "\n".join("     " + ln for ln in snippet.splitlines()))
    servers = data.get(top_key)
    if entry is None:                                          # 注销
        if not isinstance(servers, dict) or name not in servers:
            return "skip", "本来就没注册"
        _backup(path)
        del servers[name]
    else:
        if isinstance(servers, dict) and servers.get(name) == entry:
            return "ok", "已在注册（内容一致）"
        if os.path.isfile(path):
            _backup(path)
        data.setdefault(top_key, {})[name] = entry
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
        argv = ", ".join(_toml_str(a) for a in (entry.get("args") or ()))
        body += (f"\n{header}\n"
                 f"type = \"stdio\"\n"
                 f"command = {_toml_str(entry['command'])}\n"
                 f"args = [{argv}]\n"
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
    # 灵栖的工作区技能目录（`directory-manager.ts` 的 `workspace/skills`）。
    # `detect` 看 `workspace/`：灵栖启动就会建它，而 `config/` 也可能是别的工具建的。
    {"label": "Lumii", "kind": "skill_dir",
     "root": ("~", ".lumii", "workspace", "skills"), "detect": ("~", ".lumii", "workspace")},
    # ① **skills 目录**（首选落点）：渐进披露——只在真的用到时才进模型的上下文。
    #    三种形态里最不打扰用户，能放这儿就不往指令文件里塞。
    {"label": "Claude Code", "kind": "skill_dir",
     "root": ("~", ".claude", "skills"), "detect": ("~", ".claude")},
    # 跨工具的约定目录（Zed 等认这个，见调研）
    {"label": "通用 skills", "kind": "skill_dir",
     "root": ("~", ".agents", "skills"), "detect": ("~", ".agents")},

    # ② **单文件规则**（往它自己的规则目录放一个文件；不动用户已有的东西）
    {"label": "Copilot", "kind": "rule_file",
     "path": ("~", ".copilot", "instructions", "@P@.instructions.md"),
     "detect": ("~", ".copilot")},
    {"label": "Roo Code", "kind": "rule_file",
     "path": ("~", ".roo", "rules", "@P@.md"), "detect": ("~", ".roo")},
    {"label": "Cline", "kind": "rule_file",
     "path": ("~", "Documents", "Cline", "Rules", "@P@.md"),
     "detect": ("~", "Documents", "Cline")},
    {"label": "Trae", "kind": "rule_file",
     "path": ("~", ".trae-cn", "user_rules", "@P@.md"), "detect": ("~", ".trae-cn")},
    # Qwen 既有全局 `QWEN.md` 也有 `~/.qwen/rules/` 目录——**用目录**：
    # 放一个文件进去不影响用户已有的 QWEN.md（合并进单文件是不得已才做的事）。
    {"label": "Qwen Code", "kind": "rule_file",
     "path": ("~", ".qwen", "rules", "@P@.md"), "detect": ("~", ".qwen")},

    # ③ **合并进用户的指令文件**：这几种只有"一份全局指令文件"这一条路。
    #    ⚠️ 这类文件**每次会话都会进上下文**，所以只放一小段指路、**不塞整份技能**
    #    （见 `pointer_block()`）。改前备份 + 分隔块 + 卸载时精确摘掉。
    {"label": "Codex", "kind": "merge_block",
     "path": ("~", ".codex", "AGENTS.md"), "detect": ("~", ".codex")},
    {"label": "Gemini CLI", "kind": "merge_block",
     "path": ("~", ".gemini", "GEMINI.md"), "detect": ("~", ".gemini")},
    {"label": "OpenCode", "kind": "merge_block",
     "path": ("~", ".config", "opencode", "AGENTS.md"), "detect": ("~", ".config", "opencode")},
    {"label": "Zed", "kind": "merge_block",
     "path": ("APPDATA", "Zed", "AGENTS.md"), "detect": ("APPDATA", "Zed")},
    {"label": "Windsurf", "kind": "merge_block",
     "path": ("~", ".codeium", "windsurf", "memories", "global_rules.md"),
     "detect": ("~", ".codeium", "windsurf")},
)

# 刻意**没做**的（都有理由，不是漏）：
#   Claude Desktop —— 官方明确"**没有文件系统自动发现**"，技能只能手工上传 ZIP。没有可落盘的位置。
#   Cursor         —— 官方只文档化了 **project 级** `.cursor/rules/*.mdc`；user 级磁盘路径是社区说法。
#                     我们是**用户级**安装器，不往别人的仓库里写文件。
#   Continue       —— 用户级规则要走 `config.yaml`（YAML 合并）。同 MCP 那边：没有 YAML 校验器
#                     ⇒ 写坏了看不出来 ⇒ 不做。
#   Aider          —— `.aider.conf.yml` 的 `read:` 列表（YAML），同上。
#   Warp           —— 用户级规则存在**云端 Warp Drive**，本地没有文件。
#   通义灵码        —— 官方只文档化了 project 级 `.lingma/rules/`，**没有 user 级路径**。
#   Trae 国际版     —— 只找到中文版 `~/.trae-cn/user_rules/`，国际版路径未找到官方说明。
#
# 另外记一条**没有采纳的"证据"**：本机 `~/.codex/skills/` 下确实有 16 个 `<名>/SKILL.md`，
# 但调研（官方文档）只说 Codex 读 `~/.codex/AGENTS.md`；那些目录是**别的东西同步进去的**，
# 不能据此断言 Codex 会读。所以 Codex 走**有官方出处**的那条路（合并一小段进 AGENTS.md）。


def skill_id(spec):
    """技能落点的名字 = **`SKILL.md` frontmatter 里的 `name`**（那才是技能 id）。

    为什么不拿 `product` 顶替：pro 版 `product` 是 `wechat-mcp`，而技能名是 `wechat-mcp-pro`
    ——按 product 落，就变成"装在一个名字下、去另一个名字里找"（实测本机 `~/.claude/skills/`
    里躺着的正是 `wechat-mcp-pro`：状态里看不见，卸载也摘不掉）。三个名字都可能不一样：
    服务名 `wechat-local` / 产品名 `wechat-mcp` / 技能名 `wechat-mcp-pro`。
    读不到 frontmatter（源码模式没给技能源、文件坏了）就退回 product。
    """
    try:
        with open(os.path.join(skill_source(spec), "SKILL.md"), encoding="utf-8") as f:
            head = f.read(600)
    except OSError:
        return spec["product"]
    m = re.search(r"^name:[ \t]*(\S+)", head, re.M)
    return m.group(1) if m else spec["product"]


def _named_path(t, name):
    """把目标里的 `@P@` 占位换成真名之后的落点（`skill_targets` 与"清老落点"共用这一处）。"""
    key = "root" if t["kind"] == "skill_dir" else "path"
    return _client_path([seg.replace("@P@", name) for seg in t[key]])


def skill_targets(sid):
    """装了哪些**会读技能/规则**的客户端 → `[目标 dict]`（附 `resolved` 落点）。

    与 MCP 配置同一条纪律：**判据是客户端在不在，不是文件在不在**——客户端装了、文件还没建过，
    那时我们该替它建（那正是它自己的 UI 也会做的事）。

    `sid` 是**技能 id**（见 `skill_id()`），用来填 `@P@` 那个规则文件名的占位——
    写死就没法几个产品共用了。
    """
    out = []
    for spec in SKILL_TARGETS:
        mark = _client_path(spec["detect"])
        if not (mark and os.path.isdir(mark)):
            continue
        t = dict(spec)
        t["resolved"] = _named_path(t, sid)
        out.append(t)
    return out


def skill_dir_defaults(sid):
    """安装引导要打印的**技能落点目录**：`[(客户端, root/<sid>)]`。

    只取 `skill_dir` 档（Lumii / Claude Code / 通用 skills）——`rule_file` 与 `merge_block`
    没有"目录"可言。路径与 `skill_apply` 同源（都走 `_named_path` 再拼技能 id），别另抄一份。

    为什么给用户看：装不上时用户会把引导整页复制给 AI，AI 得知道技能该放哪、
    或从哪份已装的里拷出来。给**精确落点**而不是 skills 根目录——AI 拿到就能直接拷。
    """
    return [(t["label"], os.path.join(_named_path(t, sid), sid))
            for t in SKILL_TARGETS if t["kind"] == "skill_dir"]


def fill_skill(dst_root, exe):
    """把技能文件里的占位符换成**装完之后的真实路径**。

    为什么要这一步：技能是给**AI 客户端**读的。写上真实路径，AI 就能照着它自己把 MCP 配好
    （或告诉用户"你已经装好了，路径是这个"）——用户不必知道 exe 在哪，也不必手抄路径。

    两个占位符，因为**同一个路径在两种语法里写法不同**：
      `{{EXE}}`      —— 原样，给 shell / 命令行 / 散文用
      `{{EXE_JSON}}` —— 反斜杠**双写**，给 JSON 配置片段用（不双写那段 JSON 是**非法**的，
                       而 AI 很可能直接照抄）
    没替换到的占位符会**原样留着**——宁可露馅，也别悄悄写个错的路径进去。
    """
    if not exe:
        return 0                                        # 没有可写的路径就别动——留住占位符比填个空串强
    exe = str(exe)
    repl = {"{{EXE}}": exe, "{{EXE_JSON}}": exe.replace("\\", "\\\\")}
    n = 0
    for dp, _dirs, files in os.walk(dst_root):
        for f in files:
            if not f.lower().endswith((".md", ".mdx", ".mdc", ".txt", ".json", ".toml")):
                continue
            p = os.path.join(dp, f)
            try:
                with open(p, encoding="utf-8") as fh:
                    txt = fh.read()
                if not any(k in txt for k in repl):
                    continue
                for k, v in repl.items():
                    txt = txt.replace(k, v)
                with open(p, "w", encoding="utf-8") as fh:
                    fh.write(txt)
                n += 1
            except OSError:
                continue
    return n


def skill_body(spec):
    """技能源里的**正文**（去掉 YAML frontmatter）。

    frontmatter 是 Claude Code 那套的元数据（`name`/`description`），别的客户端读的是**纯规则**，
    带着它反而是噪音。所以按形态各取所需，正文只有一份。
    """
    src = skill_source(spec)
    p = os.path.join(src, "SKILL.md") if src else ""
    try:
        with open(p, encoding="utf-8") as f:
            txt = f.read()
    except OSError:
        return ""
    if txt.startswith("---"):
        end = txt.find("\n---", 3)
        if end != -1:
            return txt[end + 4:].lstrip("\n")
    return txt


def pointer_block(spec, exe):
    """给**指令文件**用的**一小段指引**。

    为什么不塞整份技能：`AGENTS.md` / `GEMINI.md` 这类文件**每次会话都会进上下文**（不像 skills
    是渐进披露）。把几百行塞进去等于每轮都在烧用户的 token，换来的只是"偶尔用得上"。
    所以这里只写清三件事：**这是什么、exe 在哪、出错怎么读**——够模型自己把事情办对了。
    """
    name = spec["name"]
    label = spec.get("label") or name
    return (
        f"## {label}（MCP：`{name}`）\n\n"
        f"本机已装。可执行文件：`{exe}`\n\n"
        f"- 它是个 MCP 服务器，工具面见 `{name}` 客户端里的工具列表。\n"
        f"- 需要重新配置到别的客户端时：跑 `\"{exe}\" --install`（交互式会列出所有客户端）。\n"
        f"- **失败一律返回** `{{\"ok\": false, \"detail\", \"error_code\", \"stage\", \"suggestion\"}}`；"
        f"看到 `ok: false` 就是没成功，**别当成数据用**。按 `error_code` 处置：\n"
        f"  - `target_not_found` —— 会话名没对上唯一目标（**不是**「没有数据」），"
        f"`candidates` 里是相近的，拿它问清是哪一个。\n"
        f"  - `env_not_ready` —— 微信没就绪（没运行 / 找不到数据目录 / 密钥扫不到）；"
        f"把 `hint` 里的动手步骤转告用户，**别重试**。\n"
        f"  - `bad_args` —— 参数错，按 `detail` 改。\n"
        f"  - `expired` —— 这份 exe 过了内置有效期，把 `hint` 转告用户；重试没用。\n"
        f"- 数据全部**本地处理、不外传**。\n"
    )


# 分隔块：卸载时靠它**精确摘掉**自己那一段，不碰用户在同一文件里写的别的内容
BLOCK_BEGIN = "<!-- lumii:{p} 开始（由安装器写入，卸载时会自动摘掉） -->"
BLOCK_END = "<!-- lumii:{p} 结束 -->"


def merge_block_apply(path, product, body=None):
    """把一段带分隔标记的文字**合并进**用户的指令文件 → `(状态, 说明)`。

    - 已经有一段了 ⇒ 原地替换（幂等，升级时更新）；
    - 没有 ⇒ 追加到文件末尾（不插到中间，避免打断人家的结构）；
    - `body=None` ⇒ 摘掉我们那一段（连标记一起），**其余内容一个字节不动**。
    """
    begin = BLOCK_BEGIN.format(p=product)
    end = BLOCK_END.format(p=product)
    try:
        old = open(path, encoding="utf-8").read() if os.path.isfile(path) else ""
    except OSError as e:
        return "fail", f"读不出来，**没动它**：{e}"
    if body is None:
        if begin not in old:
            return "skip", "本来就没写进去"
        i = old.index(begin)
        j = old.find(end, i)
        kept = (old[:i] + (old[j + len(end):] if j != -1 else "")).strip("\n")
        _backup(path) if os.path.isfile(path) else None
        _write_text(path, kept + "\n" if kept else "")
        return "ok", f"{path}（已摘掉我们那段）"

    block = f"{begin}\n{body.rstrip()}\n{end}\n"
    if begin in old:
        i = old.index(begin)
        j = old.find(end, i)
        new = old[:i] + block + (old[j + len(end):].lstrip("\n") if j != -1 else "")
    else:
        new = old.rstrip("\n") + ("\n\n" if old.strip() else "") + block
    if new == old:
        return "ok", f"{path}（内容一致）"
    if os.path.isfile(path):
        _backup(path)
    _write_text(path, new)
    return "ok", path


def _write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def skill_apply(spec, remove=False, exe=None):
    """装/卸技能到**各已装客户端** → `[(客户端, 状态, 说明)]`。

    三种形态（见 `SKILL_TARGETS`）：`skill_dir` 拷整个技能目录、`rule_file` 写一个规则文件、
    `merge_block` 往用户的指令文件里合并一小段。

    落点名字是**技能 id**（`skill_id()`），不是 MCP 服务名、也不是产品名——三个名字都可能
    不一样，混用过一次，后果是技能静默没装上而其余步骤全绿。
    `merge_block` 的分隔标记仍用**产品名**：那是"我们写过没写过"的判据，必须跨版本稳定，
    换名字等于在用户文件里留一段永远摘不掉的孤儿。

    `stale`：老安装器按**产品名**落过一份，换名字之后那份会变成孤儿（而且两份会被同时读到）。
    所以装和卸都顺带把它清掉——一次性，之后就没它什么事了。
    """
    product = spec["product"]
    sid = skill_id(spec)
    stale = product if product != sid else ""
    src = skill_source(spec)
    targets = skill_targets(sid)
    if not targets:
        return [("技能", "skip", "没检测到会读技能/规则的客户端")]
    need_src = any(t["kind"] != "merge_block" for t in targets)
    if not remove and need_src and not os.path.isdir(src):
        # 源码模式：技能就在仓库里，找不到是调用方没给路径 → 跳过
        # 冻结模式：技能**本该**打进 exe，找不到就是构建漏了 `--add-data` → **报失败**，
        #           别用 skip 蒙混过去（用户会以为装好了，实际客户端里没有这个技能）
        why = (f"技能没打进这个 exe（构建漏了 --add-data）：{src or '未提供'}"
               if getattr(sys, "frozen", False) else f"技能源没找到（{src or '未提供'}）")
        return [(t["label"], "fail" if getattr(sys, "frozen", False) else "skip", why)
                for t in targets]

    rows = []
    for t in targets:
        label, dst = t["label"], t["resolved"]
        if t["kind"] == "merge_block":
            rows.append((label, *merge_block_apply(
                dst, product, None if remove else pointer_block(spec, exe or ""))))
            continue
        if t["kind"] == "rule_file":
            if remove:
                if stale:
                    _remove_file(_named_path(t, stale))
                rows.append((label, *_remove_file(dst)))
            else:
                body = skill_body(spec) or "（技能正文缺失）"
                if exe:
                    body = body.replace("{{EXE}}", exe).replace(
                        "{{EXE_JSON}}", str(exe).replace("\\", "\\\\"))
                if stale:
                    _remove_file(_named_path(t, stale))       # 老名字那份别留着，两份会被同时读到
                rows.append((label, *_write_rule(dst, body)))
            continue
        # skill_dir
        sub = os.path.join(dst, sid)
        if remove:
            if stale:
                shutil.rmtree(os.path.join(dst, stale), ignore_errors=True)
            if not os.path.isdir(sub):
                rows.append((label, "skip", "本来就没装"))
                continue
            shutil.rmtree(sub, ignore_errors=True)
            rows.append((label, "ok", sub))
            continue
        try:
            os.makedirs(dst, exist_ok=True)
            if stale:
                shutil.rmtree(os.path.join(dst, stale), ignore_errors=True)
            if os.path.isdir(sub):
                shutil.rmtree(sub, ignore_errors=True)   # 覆盖装：旧文件别留下
            shutil.copytree(src, sub)
            if exe:
                fill_skill(sub, exe)                     # 把 `{{EXE}}` 落成真实路径
            rows.append((label, "ok", sub))
        except OSError as e:
            rows.append((label, "fail", f"拷贝失败（{e}）：{sub}"))
    return rows


def _write_rule(path, body):
    """写一个规则文件。有 frontmatter 的客户端（Copilot/Trae）由各自的 `SKILL_TARGETS` 约定说明——
    这里统一写**纯 Markdown**（调研里只有 Copilot 的 `applyTo` 与 Trae 的 `alwaysApply` 是"可选"，
    不写它们规则照样加载，写了反而可能因为 glob 不匹配而不生效）。
    """
    try:
        if os.path.isfile(path):
            _backup(path)
        _write_text(path, body.rstrip() + "\n")
        return "ok", path
    except OSError as e:
        return "fail", f"写失败（{e}）：{path}"


def _remove_file(path):
    if not os.path.isfile(path):
        return "skip", "本来就没装"
    try:
        os.remove(path)
        return "ok", path
    except OSError as e:
        return "fail", f"删不掉（{e}）：{path}"


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

    `path` 是**命中的那个配置文件**（已存在的优先，都没有就用第一个候选——用来展示"期望位置"）。
    `detected` 看的是**客户端自己的目录在不在**，不是配置文件在不在：首次使用某客户端时它的
    配置还没建过，那时我们**该**替它建（那正是它自己的 UI 也会做的事）；而客户端目录都不在
    就一个字节都不碰。

    `kind` 决定**怎么读写**（五家语法差别很大），但对调用方长得一样——装/卸/看状态都只遍历这一份。
    """
    out = []
    for spec in CLIENTS:
        if spec["kind"] == "claude_code":
            cli = claude_cli()
            out.append({"key": spec["key"], "label": spec["label"], "kind": spec["kind"],
                        "path": cli, "detected": bool(cli)})
            continue
        paths = [p for p in (_client_path(t) for t in spec.get("paths", ())) if p]
        hit = next((p for p in paths if os.path.isfile(p)), None)
        if spec.get("detect"):
            mark = _client_path(spec["detect"])
            detected = bool(mark) and (os.path.isdir(mark) or bool(hit))
        else:
            parent = os.path.dirname(paths[0]) if paths else ""
            detected = bool(hit) or (bool(parent) and os.path.isdir(parent))
        out.append({"key": spec["key"], "label": spec["label"], "kind": spec["kind"],
                    "path": hit or (paths[0] if paths else None), "detected": detected})
    return out


def register_client(c, name, exe, args=()):
    """按 `kind` 分派注册 → `(状态, 说明)`。`args` 只有源码模式非空（解释器 + 脚本）。

    Claude Code 那条**先摘再挂**（幂等）；而**摘是尽力而为**——目标本来就不存在时
    `claude mcp remove` 会失败，那时**照样得挂**。真机实测就漏在这儿：卸载过之后再装，
    remove 报 "No MCP server named …"，拿它的结果当闸门的话 add 永远不跑，
    而用户看着"安装"跑完了以为装上了。
    """
    if c["kind"] == "claude_code":
        claude_code_apply(name)
        return claude_code_apply(name, exe, args)
    if c["kind"] == "toml_codex":
        return codex_apply(name, {"type": "stdio", "command": exe,
                                  "args": list(args), "env": {}})
    top, shape = JSON_SHAPES[c["kind"]]
    return json_client_apply(c["label"], c["path"], name, shape(exe, args), top)


def unregister_client(c, name):
    if c["kind"] == "claude_code":
        return claude_code_apply(name)                 # command=None ⇒ 摘
    if c["kind"] == "toml_codex":
        return codex_apply(name, None)
    top, _shape = JSON_SHAPES[c["kind"]]
    return json_client_apply(c["label"], c["path"], name, None, top)


def _registered_line(c, name):
    """看状态用：这个客户端里我们那一条在不在。"""
    if c["kind"] == "claude_code":
        r, err = _run([claude_cli(), "mcp", "get", name], 60) if claude_cli() else (None, "没装")
        if r is None:
            return "fail", err
        out = (r.stdout or b"").decode("utf-8", "replace").strip().splitlines()
        return ("ok" if r.returncode == 0 else "skip"), (out[0][:90] if out else "未注册")
    if c["kind"] == "toml_codex":
        try:
            with open(c["path"], encoding="utf-8") as f:
                txt = f.read()
        except OSError as e:
            return "fail", f"配置读不出来：{e}"
        has = f"[mcp_servers.{name}]" in txt
        return ("ok" if has else "skip"), (c["path"] if has else "未注册")
    top, _shape = JSON_SHAPES[c["kind"]]
    try:
        servers = (_read_cfg(c["path"])[0].get(top) or {})
    except Exception as e:                                     # noqa: BLE001
        return "fail", f"配置读不出来：{e}"
    got = servers.get(name) if isinstance(servers, dict) else None
    return ("ok" if got else "skip"), (str(got.get("command", "")) if got else "未注册")


def do_install(spec, only=None):
    name, product = spec["name"], spec["product"]
    _say(f"\n安装 {spec.get('label') or name}（{name}）")
    seen = []

    prev = _read_installed(product).get("version") or ""
    cur = spec.get("version") or ""
    mine = own_exe()                     # 注册的就是你自己；源码模式是 None
    exe, args = (mine, ()) if mine else _own_command()
    if mine:
        note = mine
        if prev and cur and prev != cur:
            note = f"{mine}\n      v{prev} → **v{cur}**"
        seen.append(_line("注册的 exe", "ok", note))
    else:
        seen.append(_line("注册的 exe", "skip",
                          f"源码模式：注册 {os.path.basename(exe)} + 脚本路径（不写台账）"))

    done = []
    for c in clients():
        if not c["detected"]:
            seen.append(_line(c["label"], "skip", "未安装（不去给没装的客户端造配置）"))
        elif only is not None and c["key"] not in only:
            seen.append(_line(c["label"], "skip", "按你的选择跳过"))
        elif _line(c["label"], *register_client(c, name, exe, args)) == "ok":
            done.append(c["key"])

    if mine:
        # 台账记**真注册成**的那几家：卸载时靠它分辨"全摘"与"只摘一部分"
        _write_installed(product, spec, mine, clients=done)

    # 技能里落**真实路径**（`{{EXE}}` → 这份 exe）；源码模式没有 exe ⇒ 占位符原样留着（开发场景）
    for label, st, detail in skill_apply(spec, exe=mine):
        seen.append(_line(f"技能包·{label}", st, detail))

    if mine:
        # 这是新装法**唯一的代价**，得说在明面上：注册路径就是这份 exe 的当前位置
        _say("\n⚠️  装完**别移动、别删除这个 exe**（客户端配置里存的就是这个路径）：")
        _say(f"    {mine}")
        _say("    它旁边那个 `.lumii/` 是我的安装记录，也留着。要换地方，就再双击它装一次。")

    if _footer(seen):
        return 1

    # 装的是过了有效期的 exe → 说清楚，否则用户会以为"装完就能用"，然后在客户端里撞一鼻子灰
    try:
        import builtin_expiry as E
        st = E.status()
        if not st["ok"]:
            _say(f"\n⚠️  这份 exe 不能用：{E.describe(st)}")
            _say(f"    {E.how_to_fix(st)}")
    except Exception as e:                                 # noqa: BLE001
        _say(f"\n（有效期状态没查成：{e}）")

    _say("\n⚠️  重启你的 AI 客户端，新的 MCP 服务器才会被加载。")
    _say(f"    验证：`claude mcp get {name}`，或在客户端里问一句试试。")
    _say("    ✅ 装完了——**现在就可以关掉这个窗口**，装好的东西跟窗口没有关系。")
    return 0


def _is_full_uninstall(spec, only):
    """这次算**全摘**吗？技能包与常驻守护只该在全摘时动。

    判据用台账里记的"装到了哪些客户端"：`only` 把它们都盖住了才算全摘。老台账（≤0.13.0
    没这个字段）⇒ 按全摘处理，行为回到从前，别把用户卡在"卸不干净"里。
    """
    if only is None:
        return True
    rec = set(_read_installed(spec["product"]).get("clients") or [])
    return not rec or rec <= set(only)


def do_uninstall(spec, only=None):
    """摘注册 +（全摘时）删技能包 / 停守护 / 收台账。**exe 一律不动**——那是你自己的文件。

    `only=None`（命令行 `--uninstall`）表示全摘——脚本化调用要的就是"清干净"；
    交互式调用会在向导里先让用户勾。只摘一部分时**不碰技能包与常驻守护**：
    用户只是想从某个客户端里退出来，不是要拆干净。
    """
    name, product = spec["name"], spec["product"]
    _say(f"\n卸载 {spec.get('label') or name}（{name}）")
    seen = []

    for c in clients():
        if not c["detected"]:
            seen.append(_line(c["label"], "skip", "未安装"))
        elif only is not None and c["key"] not in only:
            seen.append(_line(c["label"], "skip", "按你的选择保留"))
        else:
            seen.append(_line(c["label"], *unregister_client(c, name)))

    if not _is_full_uninstall(spec, only):
        _say("\n（只摘了勾选的客户端 ⇒ 技能包与常驻守护**都留着**；要拆干净就带上")
        _say("  `--uninstall`，或在菜单里把客户端全勾上。）")
    else:
        for label, st, detail in skill_apply(spec, remove=True):
            seen.append(_line(f"技能包·{label}", st, detail))

        # 需要常驻的产品：**卸载要连守护一起停**，否则"卸载完了"它还在后台跑（同一类静默错误）
        daemon_flag = spec.get("daemon_uninstall")
        if daemon_flag:
            cmd, args = _own_command()
            try:
                r = subprocess.run([cmd, *args, daemon_flag], capture_output=True, timeout=180,
                                   **_quiet_kwargs())
                seen.append(_line("常驻守护", "ok" if r.returncode == 0 else "skip",
                                  "已停掉、并取消开机自启" if r.returncode == 0
                                  else (r.stderr or b"").decode("utf-8", "replace").strip()[:90]
                                  or "本来就没装自启"))
            except Exception as e:                                  # noqa: BLE001
                seen.append(_line("常驻守护", "fail", str(e)))

        if own_exe():          # 源码模式没有"我们的状态目录"，别去动真机上那份台账
            gone = _drop_legacy_copy(product)
            if gone:
                seen.append(_line("老拷贝", "ok",
                                  f"老安装器拷的那份已清掉（{len(gone)} 个文件）："
                                  f"{legacy_install_dir(product)}"))
            _drop_state_dir(product)

    # 用户数据与 exe **一律不动**——但要说清留在哪，免得用户以为卸载没干净
    _say("\nℹ️  你的数据与这份 exe 都没动（卸载不该删它们）：")
    _say(f"    · exe（想删自己删）：{own_exe() or '源码模式，没有这份 exe'}")
    _say("    · D 的归档库：~/.lumii/wechat-recall/archive.db")
    _say("    · A/B 归档与导出的文件：你当初指定的 out_dir")
    if _footer(seen):
        return 1
    _say("\n⚠️  重启你的 AI 客户端，被摘掉的服务器才会从列表里消失。")
    return 0


def do_status(spec):
    name, product = spec["name"], spec["product"]
    _say(f"\n{spec.get('label') or name}（{name}）安装状态")

    inst = _read_installed(product)
    exe = inst.get("exe") or ""
    if exe and os.path.isfile(exe):
        _line("注册的 exe", "ok", exe)
    elif exe:
        # 新模式**唯一的失效方式**：exe 被挪走/删了（注册的是它的绝对路径）
        _line("注册的 exe", "fail",
              f"注册的路径已经不在了（挪走 / 删了？）：{exe} —— 重跑 --install 指回现在这份")
    else:
        _line("注册的 exe", "skip", f"没装过（现在这份：{own_exe() or '源码模式'}）")

    # 版本对账（**纯本地**，不联网——本产品的红线是"本地处理、不外传"）：
    # 你现在跑的这份 vs 注册进客户端的那份。不一致就是"该重跑 --install 了"。
    # 装的那份的版本读 `installed.json`，**不去启动它**：onefile 冷启动 1–3s，
    # 每次查状态都解一次包，状态查询就变秒级了。
    cur = spec.get("version") or ""
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

    # 技能落点按**技能 id** 找（见 `skill_id()`），不是按服务名、也不是按产品名。跟 skill_apply
    # 用同一份判断，别各写各的（写错过一次：明明装了却报"没装"）。三种形态的"在不在"判据不同。
    sid = skill_id(spec)
    sts = skill_targets(sid)
    if not sts:
        _line("技能", "skip", "没检测到会读技能/规则的客户端")
    for t in sts:
        where = t["resolved"]
        if t["kind"] == "skill_dir":
            where = os.path.join(where, sid)
            there = os.path.isdir(where)
        elif t["kind"] == "rule_file":
            there = os.path.isfile(where)
        else:
            there = os.path.isfile(where) and BLOCK_BEGIN.format(p=product) in _peek(where)
        _line(f"技能·{t['label']}", "ok" if there else "skip", where if there else "没装")

    # 老安装器（≤0.13.0）在 `~/.lumii/mcp/<产品>/` 留的那份拷贝：说一句，免得用户看见磁盘上
    # 两份 exe 犯迷糊（卸载时会一起清掉）。
    lexe = _read_legacy_installed(product).get("exe") or ""
    if lexe and os.path.isfile(lexe) and os.path.normcase(lexe) != os.path.normcase(exe):
        _line("老拷贝", "skip", f"{lexe}（老安装器拷的，卸载时会一起清掉）")
    return 0


def _peek(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


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


# ---- 选择界面：**只用方向键和空格，不用打字** --------------------------------
_VT = {"ok": None}


def _vt_ok():
    """当前控制台支持 ANSI 转义吗（菜单要**原地重画**，靠的就是它）。

    不打开的话 `\\x1b[2K` 会被**原样打印**成乱码。Python 在真控制台上一般会开，但拿不到就
    退化成"每按一次重印一遍"——难看，但能用、不会崩。
    """
    if _VT["ok"] is None:
        _VT["ok"] = False
        if os.name == "nt":
            try:
                import ctypes
                k32 = ctypes.windll.kernel32
                h = k32.GetStdHandle(-11)              # STD_OUTPUT_HANDLE
                mode = ctypes.c_uint32(0)
                if k32.GetConsoleMode(ctypes.c_void_p(h), ctypes.byref(mode)):
                    _VT["ok"] = bool(k32.SetConsoleMode(ctypes.c_void_p(h), mode.value | 0x0004))
            except Exception:                          # noqa: BLE001
                pass
    return _VT["ok"]


def _emit(text):
    """往 stdout 写一段**不带换行**的文本；编不出来就降级（同 `_say`，别在重画时抛）。"""
    try:
        sys.stdout.write(text)
    except UnicodeEncodeError:
        enc = getattr(sys.stdout, "encoding", None) or "ascii"
        sys.stdout.write(text.encode(enc, "replace").decode(enc, "replace"))
    sys.stdout.flush()


def _key_reader():
    """逐键读 → 规范化记号；**拿不到真控制台就返回 None**（调用方退化成打字）。

    为什么要逐键：用户要的是"**只选择，不打字**"。打序号也算打字。
    """
    try:
        import msvcrt
    except ImportError:
        return None                                    # 非 Windows
    if not is_interactive():
        return None                                    # 没控制台：读键会抛

    def read():
        ch = msvcrt.getch()
        if ch in (b"\x00", b"\xe0"):                   # 方向键是两字节序列
            return {"H": "up", "P": "down"}.get(msvcrt.getch().decode("latin1", "replace"), "?")
        c = ch.decode("latin1", "replace")
        return {"\r": "enter", "\n": "enter", " ": "toggle", "a": "all", "A": "all",
                "\x1b": "quit", "\x03": "quit"}.get(c, c)
    return read


def _menu(title, rows, cur, redraw):
    """画 / 原地重画菜单。`rows` = `[(label, checked, selectable, note)]`，`cur` 是光标行号。"""
    lines = ["", title]
    for i, (label, checked, selectable, note) in enumerate(rows):
        pointer = ">" if i == cur else " "
        box = "[✓]" if checked else "[ ]"
        lines.append(f"   {pointer} {box} {label}{note}")
    lines.append("   ↑/↓ 移动 · 空格 勾选 · a 全选/全不选 · 回车 确认")
    if redraw and _vt_ok():
        _emit(f"\x1b[{len(lines)}A")                   # 回到上一次的块首
        for ln in lines:
            _emit("\x1b[2K" + ln + "\n")
    else:
        _emit("\n".join(lines) + "\n")


def pick_clients(cs, title="要注册到哪些 AI 客户端？", keys=None, ask_raw=_ask_raw,
                 prechecked=None):
    """**只用选择**地勾客户端 → 选中的 key 集合。

    ↑/↓ 移动、空格勾选、`a` 全选、回车确认。没装的显示「（未安装）」且**光标不停在它上面**
    ——别让人选一个我们根本找不到的东西。

    退化路径：拿不到真控制台（非 Windows / 被管道接走）时回到"输入序号"那套，认 `ask_raw`；
    `keys` 可注入（测试用）。
    """
    if not cs:
        return set()
    chosen = set(prechecked) if prechecked is not None else {c["key"] for c in cs if c["detected"]}
    rows = [(c["label"], c["key"] in chosen, c["detected"],
             "" if c["detected"] else "   （未安装）") for c in cs]
    selectable = [i for i, r in enumerate(rows) if r[2]]
    if not selectable:
        return chosen

    read = _key_reader() if keys is None else None
    if read is None and keys is None:
        return _pick_clients_typed(cs, title, ask_raw, chosen)

    cur = selectable[0]
    _menu(title, [(l, c, s, n) for l, c, s, n in rows], cur, redraw=False)
    it = iter(keys) if keys is not None else None
    while True:
        k = next(it, "enter") if it is not None else read()
        if k in ("quit", None):
            return chosen
        if k in ("up", "down"):
            step = -1 if k == "up" else 1
            cur = selectable[(selectable.index(cur) + step) % len(selectable)]
            _menu(title, rows, cur, redraw=True)       # ↑/↓ 得**当场**重画：只改 cur 不重画＝按了没动静
        elif k == "toggle":
            rows[cur] = (rows[cur][0], not rows[cur][1], True, rows[cur][3])
            _menu(title, rows, cur, redraw=True)
        elif k == "all":
            want = not all(r[1] for r in rows if r[2])
            rows = [(l, want if s else c, s, n) for l, c, s, n in rows]
            _menu(title, rows, cur, redraw=True)
        elif k == "enter":
            _menu(title, rows, cur, redraw=True)
            return {c["key"] for c, r in zip(cs, rows) if r[1] and r[2]}
        # 别的键（←/→ 就是「?」）不动光标。以前这里跟着 ↓ 走一格，才显得"是左右键在选"


def _menu_one(title, options, cur, redraw):
    lines = ["", title]
    for i, o in enumerate(options):
        lines.append(f"   {'>' if i == cur else ' '} {o}")
    lines.append("   ↑/↓ 移动 · 回车 选定")
    if redraw and _vt_ok():
        _emit(f"\x1b[{len(lines)}A")
        for ln in lines:
            _emit("\x1b[2K" + ln + "\n")
    else:
        _emit("\n".join(lines) + "\n")


def pick_one(title, options, keys=None, default=0):
    """**单选**（↑/↓ 移动、回车选定）→ 选中的下标。

    拿不到真控制台（脚本/管道）时返回 `default`——那正是"没人能回答，就用默认"的正确语义。
    """
    read = _key_reader() if keys is None else None
    if read is None and keys is None:
        return default
    cur = default
    _menu_one(title, options, cur, redraw=False)
    it = iter(keys) if keys is not None else None
    while True:
        k = next(it, "enter") if it is not None else read()
        if k in ("quit", None):
            return len(options) - 1 if len(options) > 1 else default
        if k == "up":
            cur = (cur - 1) % len(options)
        elif k == "down":
            cur = (cur + 1) % len(options)
        if k == "enter":
            _menu_one(title, options, cur, redraw=True)
            return cur
        _menu_one(title, options, cur, redraw=True)


def _pick_clients_typed(cs, title, ask_raw, chosen):
    """退化路径：没有真控制台时用"输入序号切换 + 回车确认"（脚本/非 Windows 也能用）。"""
    while True:
        _say("")
        _say(title)
        for i, c in enumerate(cs, 1):
            _say(f"   {i}. {'[✓]' if c['key'] in chosen else '[ ]'} {c['label']}"
                 + ("" if c["detected"] else "   （未安装）"))
        raw = ask_raw("   输入序号切换（空格/逗号分开），直接回车 = 就这些：")
        if raw is None or not str(raw).strip():
            return chosen
        for tok in re.split(r"[\s,，]+", str(raw).strip()):
            if not tok.isdigit() or not 1 <= int(tok) <= len(cs):
                continue
            c = cs[int(tok) - 1]
            if not c["detected"]:
                _say(f"      {c['label']} 没装，跳过")
            elif c["key"] in chosen:
                chosen.discard(c["key"])
            else:
                chosen.add(c["key"])


def _pause():
    """**别让窗口一装完就消失**——用户双击来的，输出还没看就没了等于没装。"""
    try:
        input("\n按回车关闭这个窗口…")
    except (EOFError, KeyboardInterrupt):
        pass


def wechat_compat_line():
    """安装引导里的「适配的微信版本」一行；取不到返回 `""`。

    **单一来源就是 `wechat_core.VERIFIED_VERSION_PREFIXES`**——运行期给每条工具结果挂告警
    （`version_warning`）用的是同一个常量。这里**绝不另抄一份**：抄了必然漂，而漂的方向恰好
    是最坏的那种（引导里说支持，装完每条结果都挂「未验证」）。

    导入失败按"这类产品不关心微信版本"处理（安装器是四件套共用的），**不报错**：
    引导里少一行，远好过双击就崩。
    """
    try:
        import wechat_core
        prefixes = tuple(wechat_core.VERIFIED_VERSION_PREFIXES)
    except Exception:                                    # noqa: BLE001
        return ""
    return "、".join(f"{p}.x" for p in prefixes) if prefixes else ""


def interactive(spec, ask=_ask, ask_raw=_ask_raw, keys=None):
    """双击时走的路。**这一层只管一件事**：出错了别让窗口一闪就没。

    向导本体在 `_wizard()`。双击来的用户看不到任何东西时，只会以为"装上了"（或者"没反应"）
    ——那比报错难查得多，所以崩了要把栈打出来、并且停住窗口。
    """
    try:
        return _wizard(spec, ask, ask_raw, keys)
    except Exception:                                          # noqa: BLE001
        import traceback
        traceback.print_exc()
        _say("\n❌ 安装器自己出错了——把上面这段报错发给开发者。")
        _say("   改过的客户端配置都留了 `.bak` 备份；重跑一次通常能接着往下走。")
        _pause()
        return 1


def _wizard(spec, ask=_ask, ask_raw=_ask_raw, keys=None):
    """说清楚这是什么 → **只按方向键勾客户端** → 一键装 → 该常驻的顺带装上。

    已经装过时先给一个岔路（重装 / **只从某些客户端摘掉** / 退出）——首次用户看不到这一步。

    `ask` / `ask_raw` / `keys` 可注入（测试用），默认走真 `input()` 与真键盘。
    """
    label = spec.get("label") or spec["product"]
    mine = own_exe()
    _say("=" * 62)
    _say(f"  {label} v{spec.get('version') or ''}")
    _say("=" * 62)
    _say("这是给 AI 客户端用的插件（MCP 服务器）——不是双击就能自己干活的程序。")
    _say("双击我可以一键装好，之后在 Claude Code / Cursor / Codex 里直接用。")
    _say("")
    _say("接下来会做四件事：")
    _say("  1. 把**这份 exe 的当前位置**注册进客户端（不拷贝、不搬运）")
    _say("  2. 注册到你指定的 AI 客户端（只加我们这一条，改前备份，不动你的其它配置）")
    _say("  3. 把技能包放到对应客户端的技能目录")
    _say("  4. 如果装完还是用不了：把**这一页的全部内容**复制给 AI 客户端，让它照下面的路径自己装")
    _say("")
    _say("装不上时的兜底（把这一页整页复制给 AI 客户端，它可照此自行安装）：")
    _say(f"    MCP 名称：{spec['name']}")
    snippet = json.dumps({"mcpServers": {spec["name"]: {
        "command": mine or "<这份 exe 的绝对路径>", "args": []}}}, ensure_ascii=False)
    _say(f"    配置片段：{snippet}")
    _say("    技能默认目录：")
    for client_label, dst in skill_dir_defaults(skill_id(spec)):
        _say(f"      · {client_label}：{dst}")
    _say("")
    compat = wechat_compat_line()
    if compat:
        # 装机前就告诉用户"你的微信版本在不在适配范围内"——等装完再报，等于让他先折腾一遍。
        # 范围外**不是不能用**：能读的照读，只是每条结果会挂一句「这版没验过」，得自己核对。
        _say(f"适配的微信版本：{compat}（其它 4.x 也能跑，但**没在本项目验证过**——"
             "结果会逐条挂告警，别直接当真）")
        _say("")
    if mine:
        _say("⚠️  装完**别移动、也别删除这个 exe**——客户端里注册的就是它的路径：")
        _say(f"    {mine}")
        _say("")

    cs = clients()
    detected = [c for c in cs if c["detected"]]
    prev = _read_installed(spec["product"]).get("version") or ""

    # 已经装过 ⇒ 先给一个岔路。**没装过就不问**，首次用户不该为常见路径多按一次键。
    if prev and detected:
        _say(f"\n（检测到已经装过 v{prev}。）")
        idx = pick_one("要做什么？",
                       ["重新安装 / 升级", "卸载（可以只从某些客户端里摘掉）", "退出"], keys)
        if idx == 2:
            _say("\n好，什么都没做。")
            _pause()
            return 0
        if idx == 1:
            # 预勾**台账里记着的那几家**（= 我们真注册过的地方）；老台账没记就回到"全勾"
            got = set(_read_installed(spec["product"]).get("clients") or [])
            only = pick_clients(detected, "要从哪些客户端里摘掉？", keys, ask_raw,
                                prechecked=got or {c["key"] for c in detected})
            if not only:
                _say("\n一个都没勾——那就什么都不动。")
                _pause()
                return 0
            rc = do_uninstall(spec, only=only)
            _pause()
            return rc

    if detected:
        only = pick_clients(detected, "要注册到哪些 AI 客户端？", keys, ask_raw)
    else:
        only = set()
        _say("\n（一个 AI 客户端都没检测到——那就谁都不注册；exe 还在你手上，什么都不会丢。）")

    if not ask("\n现在开始？"):
        _say("\n好，什么都没做。想装的时候再双击一次（或跑 `--install`）。")
        _pause()
        return 0

    rc = do_install(spec, only=only)

    # 需要常驻的产品（撤回防护的守护）：不装它这个功能等于没有，所以顺口问一句（回车 = 开）
    daemon_flag = spec.get("daemon_install")
    if rc == 0 and daemon_flag:
        _say("")
        if ask(f"这个产品的「撤回防护」需要它**常驻后台**才有效（{daemon_flag}）。现在开开机自启？"):
            install_daemon(spec)
        else:
            _say("  跳过。想开的时候跑 `<本 exe> --install-autostart`。")

    _pause()
    return rc


def install_daemon(spec):
    """给需要常驻的产品开开机自启（该 flag 内部也会立即拉起守护）。返回是否成功。

    向导与命令行 `--install` 共用这一条：命令行静默安装原来**不碰守护**，
    于是脚本化部署出来的撤回防护一条都留不住，用户还以为装好了。
    """
    daemon_flag = spec.get("daemon_install")
    if not daemon_flag:
        return False
    cmd, args = _own_command()
    try:
        r = subprocess.run([cmd, *args, daemon_flag], capture_output=True, timeout=180,
                           **_quiet_kwargs())
    except Exception as e:                                      # noqa: BLE001
        _line("开机自启", "fail", str(e))
        return False
    ok = r.returncode == 0
    _line("开机自启", "ok" if ok else "fail",
          "已开启：守护已在后台运行，开机也会自动启动" if ok
          else (r.stderr or b"").decode("utf-8", "replace").strip()[:120])
    return ok


def do_expiry_status(spec):
    """`--expiry-status`：看这份 exe 的有效期还有多久、到期了该怎么办。"""
    import builtin_expiry as E
    st = E.status()
    _say(f"\n{spec.get('label') or spec['product']} 有效期")
    _line("有效期", "ok" if st["ok"] else "fail", E.describe(st))
    if not st["ok"]:
        _say(f"\n    {E.how_to_fix(st)}")
    return 0 if st["ok"] else 1


FLAGS = {
    "--install": do_install,
    "--uninstall": do_uninstall,
    "--install-status": do_status,
    "--expiry-status": do_expiry_status,
}


def consume_flags(argv, spec):
    """命中命令行开关就执行并返回**退出码**；没命中返回 `None`（调用方据此进 MCP 循环）。

    只认第一个命中的开关：`--install --uninstall` 一起传是没想清楚，别猜。
    `--install` 装成功后，需要常驻的产品**默认**顺带开自启（`--no-autostart` 跳过）。
    """
    for f in ("--install", "--uninstall", "--install-status", "--expiry-status"):
        if f in argv:
            rc = FLAGS[f](spec) or 0
            if f == "--install" and rc == 0 and spec.get("daemon_install") \
                    and "--no-autostart" not in argv:
                install_daemon(spec)
            return rc
    return None
