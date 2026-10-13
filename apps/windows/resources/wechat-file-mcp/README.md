# wechat-file-mcp · 微信文件归档

一个 **stdio MCP server**：把本机微信里收发的**文件**列出来、归档到本地目录、报告已过期下不动的文件。

**只读、只拷贝**：读层直读 SQLCipher4（密钥从进程内存**只读**扫描取，不注入、不改微信数据）；
归档只把 `msg/file/<月>/` 里的文件**复制**到用户目录，微信原文件原地不动。

> ⚠️ 仅用于**你自己的账号、你自己的机器**。文件涉及他人隐私——全部**本地处理、不外传**。

## 装

### 一键装（推荐）

```powershell
wechat-file-mcp.exe --install
```

它做三件事：

1. **部署到稳定目录** `%USERPROFILE%\.lumii\mcp\wechat-file-mcp\` —— 这样你以后清理"下载"文件夹，
   也不会把已经注册好的路径弄断。（覆盖旧版用"旧文件改名让位"：Windows 下运行中的 exe 就是不能覆盖。）
2. **注册到检测到的 MCP 客户端**：Claude Code 走它自己的 `claude mcp` CLI（不手改它的状态文件）；
   Claude Desktop / Cursor 合并进它们的 JSON 配置；**Codex** 加一段 `[mcp_servers.<名>]`（它是 TOML）
   —— **改之前备份**，且**只动我们自己那一条**，你的其它配置一个字节都不碰。配置读不出来
   （比如有语法错）就**拒绝改**，只报告；Codex 那份写完还会**用 TOML 解析器读回来验**，读不回来
   就整份还原（它可能装着你的明文 API key，容不得拼坏）。
3. **拷技能包**到 `~/.claude/skills/wechat-file-mcp/`（技能包是**打进 exe** 的，不需要另外下载）。

装完**重启你的 AI 客户端**才会加载。

| 开关 | 作用 |
|---|---|
| `--install` | 装（幂等，可重复跑；升级后重跑一遍即可） |
| `--install-status` | 看装到哪、注册到哪些客户端 |
| `--uninstall` | 摘注册 + 删技能包 + 删部署的 exe（正被占用则安排重启后删）。**你的数据一律不动** |
| `--check-update` | **显式**联网查有没有新版。默认一次网络都不发（本产品的红线是「本地处理、不外传」） |

`--install-status` 里有一行**版本对账**：你现在跑的这份 vs 装在客户端里那份。不一致就说明该重跑
`--install` 升级了。（它读安装时留下的登记，**不去启动部署副本**——onefile 冷启动 1–3 秒，
每次查状态都解一遍包就太慢了。）

### 手工装

Windows x64（**不需要 Node、不需要 Python**，依赖全在单文件 exe 里）：

```json
{
  "mcpServers": {
    "wechat-file": { "command": "C:\\你\\的\\路径\\wechat-file-mcp.exe", "args": [] }
  }
}
```

- 独立 exe：`dist/wechat-file-mcp.exe`（单文件，依赖全在里面）。
- 源码：`python server.py`（需 `pip install pycryptodome zstandard`），或 `uv run server.py`。
- 数据目录默认自动探测（微信 4.x 自定义目录、任意盘）；探测失败用 `env.LUMII_WECHAT_DB` 兜底。
- **改 py 代码要重新构建 exe**：`pnpm --filter ./apps/windows build:wechat-file-mcp`。

技能包（给别的 AI 客户端看的接入说明）：[`skills/wechat-file-mcp/SKILL.md`](skills/wechat-file-mcp/SKILL.md)。

## 典型场景

**把文件传输助手里的文件备份出来**

1. 你问：「列一下文件传输助手里的文件，哪些已经下不动了？」
   → AI 调 `list_files(talker="文件传输助手")`，回报条数、体积，以及 `missing`（过期/未下载）有几个。
2. 你问：「能下的都归档到 `D:\wechat-backup`」
   → AI 先调 `archive_files(out_dir="D:\\wechat-backup", talker="文件传输助手", dry_run=true)`，
   把计划（将拷贝 N / 跳过 M / 过期 K）报给你确认——**这时候一个文件都还没落盘**。
3. 你说「可以」→ AI 用 `dry_run=false` 真拷，回报落盘目录与文件数。

**群文件过期预警**：问「我那些群里哪些文件已经过期了？」→ `list_files(only_missing=true)`。
过期的**救不回来**（微信服务器上也没了），只能如实告诉用户——这正是要"趁早归档"的理由。

## 工具（2 个）

| 工具 | 说明 |
|---|---|
| `list_files(talker?, since?, until?, types?, keyword?, only_missing?, limit?)` | 列文件消息 + 磁盘定位。`only_missing=true` = **过期预警**。默认只回**最近 500 条**，看 `total`/`count` 判断有没有被截断 |
| `archive_files(out_dir, talker?, since?, until?, types?, layout?, dry_run?)` | 拷贝归档；`dry_run=true`（默认）只出计划 |

`layout`：`by_session`（默认，每会话一个子目录）/ `by_type` / `flat`。
每条文件的 `status`：`ok` 可归档 / `size_mismatch` 同名但大小不符（可能另一版本）/ `missing` 过期或未下载。
归档侧另有两种**不落盘新内容**的状态：`exists` 目标已是同一份（重跑幂等，不重拷）、
`dedup` 同一磁盘文件被多条消息引用（只拷一次）。

**归档绝不覆盖**：目标已存在又是**另一版本**（大小不同）→ 另存为带时间戳的名字。
`talker` 传会话**显示名**（如「文件传输助手」）或 wxid/群号都可以。

**长任务有进度**：`archive_files` 归档几百个文件要跑几十秒，期间会通过 MCP 的
`notifications/progress` 持续上报「归档中 40/200（已拷贝 37）」——客户端支持的话界面会动起来，
不用盯着转圈猜是不是卡死了。（只在客户端**主动带了** `_meta.progressToken` 时上报；没带就不发。）

## 失败长什么样

任何失败都是**同一个形状**（四件套一致，也和 wechat-mcp 一致）：

```json
{"ok": false, "detail": "发生了什么", "error_code": "target_not_found",
 "stage": "target", "suggestion": "该怎么办", "candidates": [...]}
```

**看到 `ok: false` 就是没成功**——别把同一个结果里的其它字段当数据用。

| `error_code` | 含义 | 该怎么办 |
|---|---|---|
| `target_not_found` | 会话名没对上**唯一**目标 | 这是「名字没对上」，**不是**「没有数据」；`candidates` 里是相近的会话，挑一个或问用户 |
| `env_not_ready` | 微信没就绪（没运行 / 找不到数据目录 / 密钥扫不到） | 看 `detail` + `hint` 的动手步骤（通常是「先打开微信并登录」），**不是**参数问题，别重试 |
| `bad_args` | 参数缺失或取值非法 | 按 `detail` 改正后重试 |
| `internal_error` | 工具内部出错（bug），此时 `isError=true` | 把 `detail` 原文反馈给开发者 |

`stage` 说的是**卡在哪一道**（`env` / `target` / `args` / `data` / `internal`），
让你一眼看出是环境的锅还是参数的锅。

## 故障排查

| 现象 | 原因与处置 |
|---|---|
| `env_not_ready`：未找到微信数据目录 | 确认微信**已登录**；在微信「设置 → 文件管理」看数据目录；仍不行就设 `LUMII_WECHAT_DB=<数据目录>\xwechat_files\<账号>_<4位>\db_storage` |
| `env_not_ready`：未能从微信进程内存取到数据库密钥 | 打开微信并登录、点开一个会话等几秒再试；仍不行多半是微信版本超出已验证范围（见 `wechat_core.VERIFIED_VERSION_PREFIXES`） |
| `status=missing` 的文件很多 | 那是**未下载/已过期**，本地和服务器都没有，归档不了——如实告诉用户，别反复重试 |
| 归档后目标目录里出现带时间戳的文件名 | 预期行为：同名**不同版本**另存，**绝不覆盖**已归档的文件 |

## 怎么工作的（一条链）

1. 消息：`message/message_N.db`（多分片，时间滚动）里 `local_type=49` 且 appmsg `type=6` 的是文件消息，
   带 `title`(文件名) / `totallen`(大小) / `fileext`。
2. 磁盘：文件本体在 `msg/file/<YYYY-MM>/<文件名>`，与消息 `title` **同名**；
   同名用 `totallen` 对大小消歧，少量文件带 `YYYYMMDD` 前缀（按别名命中）。
3. 关联率：真机实测 145 条文件消息 → 137 条可定位（94%），其余 8 条是**未下载/已过期**。

## 不支持的

- 归档**已过期**的文件（服务器端已无，本地也没有）。
- 图片/视频（另属记录导出；本产品只管文件消息）。
- 读取**别人**的数据（只支持本机已登录账号）。

## 文件

| 文件 | 作用 |
|---|---|
| `server.py` | MCP 入口 + 2 个工具（协议层在共享层，本文件不含 JSON-RPC 循环） |
| `filecore.py` | 核心逻辑（纯函数，可单测）：文件消息解析、磁盘映射、归档 |
| `test_filecore.py` | 单测（纯函数 + 真机只读冒烟，无微信库时跳过） |
| `skills/wechat-file-mcp/SKILL.md` | 给别的 AI 客户端看的技能包 |

**共享基础层**：读取层（密钥扫描 / SQLCipher 解密 / 多分片镜像 / 路径发现）与**协议层**
（stdio JSON-RPC + 工具错误约定）直接复用 `../wechat-mcp/` 的模块（`wechat_core.py` /
`mcp_stdio.py`），本包**不复制**——详见
`docs/design/渠道与CLI/2026-10-12-微信小工具MCP四件套设计.md`。

自检：`python test_filecore.py`（纯函数秒回 + 真机只读冒烟）。
