# wechat-crm-mcp · 微信客户分析

一个 **stdio MCP server**：读取本机微信的**通讯录与会话统计**——好友/群/公众号/企业微信、
群成员、单会话互动数字、互动排行。

**只出取数与统计，不出判断**："这个客户意向高不高"交给接入方的 LLM + 技能包。

**只读**：读层直读 SQLCipher4（密钥从进程内存**只读**扫描取，不注入、不改微信数据）。

> ⚠️ 仅用于**你自己的账号、你自己的机器**。通讯录与统计涉及大量他人隐私——**本地、不外传**。

## 装

### 一键装（推荐）

```powershell
wechat-crm-mcp.exe --install
```

它做三件事：

1. **部署到稳定目录** `%USERPROFILE%\.lumii\mcp\wechat-crm-mcp\` —— 这样你以后清理"下载"文件夹，
   也不会把已经注册好的路径弄断。（覆盖旧版用"旧文件改名让位"：Windows 下运行中的 exe 就是不能覆盖。）
2. **注册到检测到的 MCP 客户端**：Claude Code 走它自己的 `claude mcp` CLI（不手改它的状态文件）；
   Claude Desktop / Cursor 合并进它们的 JSON 配置；**Codex** 加一段 `[mcp_servers.<名>]`（它是 TOML）
   —— **改之前备份**，且**只动我们自己那一条**，你的其它配置一个字节都不碰。配置读不出来
   （比如有语法错）就**拒绝改**，只报告；Codex 那份写完还会**用 TOML 解析器读回来验**，读不回来
   就整份还原（它可能装着你的明文 API key，容不得拼坏）。
3. **拷技能包**到 `~/.claude/skills/wechat-crm-mcp/`（技能包是**打进 exe** 的，不需要另外下载）。

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

```json
{
  "mcpServers": {
    "wechat-crm": { "command": "C:\\你\\的\\路径\\wechat-crm-mcp.exe", "args": [] }
  }
}
```

- 独立 exe：`dist/wechat-crm-mcp.exe`（单文件）。
- 源码：`python server.py`（需 `pip install pycryptodome zstandard`），或 `uv run server.py`。
- 数据目录默认自动探测；探测失败用 `env.LUMII_WECHAT_DB` 兜底。
- **改 py 代码要重新构建 exe**：`pnpm --filter ./apps/windows build:wechat-crm-mcp`。

技能包：[`skills/wechat-crm-mcp/SKILL.md`](skills/wechat-crm-mcp/SKILL.md)。

## 典型场景

**看看最近都在跟谁聊、谁很久没联系了**

1. 你问：「我最近跟谁聊得最多？」
   → AI 调 `interaction_rank(top=20)`，给互动排行。
2. 你问：「哪些人很久没联系了？」
   → `interaction_rank(sort="recent")`，久未联系的在最前面。
3. 你问：「我跟老王最近聊得怎么样？」
   → `contact_stats(talker="老王")`：总条数 / 我发对方发 / 活跃时段 / 沉默天数。
4. 你问：「这个群里都有谁？」→ `list_contacts(scope="room", room="XX群")`。

**边界要说清**：这里只端上**确定性的清单与数字**——「这个客户意向高不高」由 AI 结合数字来判断，
本服务**不下结论**。

## 工具（3 个）

| 工具 | 说明 |
|---|---|
| `list_contacts(scope?, room?, keyword?, include_deleted?, limit?, offset?)` | 通讯录；`room=` 时列该群成员。默认只回 200 条，看 `total` 判断有没有被截断，用 `offset` 接着翻 |
| `contact_stats(talker, since?, until?)` | 单会话：总条数 / 我发对方发 / 活跃小时 / 活跃天 Top / 首末 / 跨度 / 沉默天数 |
| `interaction_rank(since?, until?, top?, sort?)` | 互动排行；`sort=recent` = 久未联系在前 |

`talker` / `room` 传会话**显示名**（如「文件传输助手」）或 wxid/群号都可以。

## 失败长什么样

任何失败都是**同一个形状**（四件套一致，也和 wechat-mcp 一致）：

```json
{"ok": false, "detail": "发生了什么", "error_code": "target_not_found",
 "stage": "target", "suggestion": "该怎么办", "candidates": [...]}
```

**看到 `ok: false` 就是没成功**——别把同一个结果里的其它字段当数据用。

| `error_code` | 含义 | 该怎么办 |
|---|---|---|
| `target_not_found` | 会话名没对上**唯一**目标 | 这是「名字没对上」，**不是**「你俩没聊过」——`candidates` 里是相近的会话，挑一个或问用户 |
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
| 好友数是 200 / 群成员只有一部分 | 默认 `limit=200`——看 `total` 有没有比 `count` 大，用 `offset` 接着翻 |
| `contact_stats` 返回 0 条 | 先确认 `talker` 是不是**唯一**对上了（对不上会给 `target_not_found`，不会静默给 0）；真为 0 才是「没聊过」 |

## 怎么工作的

1. **联系人分类按 username 后缀**（确定性）：`@chatroom`→群、`gh_`→公众号、`@open`→企业微信、
   系统名单→系统、其余→好友。
   **不按 `local_type`**——实测它语义不干净（`wxid_` 既有 1 也有 3，自定义用户名同样两档都有）。
2. **群成员**：`chatroom_member` 给成员 id，join `contact` 取**全局**显示名（备注 > 昵称）。
   列表**包含自己**（`is_me=true`）——否则"这个群几个人"与微信里对不上。
3. **统计**：跨**所有分片**扫会话消息（微信 4.x 按时间滚动分片），只取 `create_time` 与发送者，
   在 Python 里聚合。

## 不支持的

- **标签筛选**：本地库只有标签名（`contact_label`），**没有**好友↔标签映射表（疑似
  `contact.extra_buffer` 的 protobuf，需逆向）——留研究项。
- **群内昵称**：确实在 `chat_room.ext_buffer` 里（实测能看到群里的称呼），但字段语义未解，
  猜错会张冠李戴 → 只给全局名，留研究项。
- 出任何"判断"（客户价值 / 关系好坏 / 情绪）——那是接入方 LLM 的事。
- 读取**别人**的数据（只支持本机已登录账号）。

## 文件

| 文件 | 作用 |
|---|---|
| `server.py` | MCP 入口（stdio JSON-RPC）+ 3 个只读工具 |
| `contactscore.py` | 核心逻辑：分类 / 通讯录 / 群成员 / 会话统计 / 排行 |
| `test_contactscore.py` | 单测（分类纯函数 + 真机只读冒烟，无库时跳过） |
| `skills/wechat-crm-mcp/SKILL.md` | 给别的 AI 客户端看的技能包 |

**共享基础层**：读取层直接复用 `../wechat-mcp/` 的模块（经 `contactscore.py`），本包**不复制**——详见
`docs/design/渠道与CLI/2026-10-12-微信小工具MCP四件套设计.md`。

自检：`python test_contactscore.py`。
