# wechat-export-mcp · 微信记录导出

一个 **stdio MCP server**：把本机微信里某个会话的聊天记录导出成 **md / html / json**，
可选连图片（已解密）与语音（SILK→wav）、可选语音转写。

**只读**：读层直读 SQLCipher4（密钥从进程内存**只读**扫描取，不注入、不改微信数据）；
导出只是把记录写成文件，微信里一个字都不动。

> ⚠️ 仅用于**你自己的账号、你自己的机器**。记录涉及他人隐私——**本地导出、不外传**。

## 装

### 一键装（推荐）

**双击这个 exe 就行**——它会先讲清楚自己是什么，再**用方向键勾选要装到哪些 AI 客户端**
（↑/↓ 移动、空格勾选、`a` 全选、回车确认——**不用打字**），然后一键装好。

已经装过时，双击会先问一句：**重新安装 / 卸载（可以只从某些客户端里摘掉）/ 退出**。

```powershell
wechat-export-mcp.exe --install
```

它做三件事：

1. **部署到稳定目录** `%USERPROFILE%\.lumii\mcp\wechat-export-mcp\` —— 这样你以后清理"下载"文件夹，
   也不会把已经注册好的路径弄断。（覆盖旧版用"旧文件改名让位"：Windows 下运行中的 exe 就是不能覆盖。）
2. **注册到已装的 MCP 客户端**：Claude Code / Cursor / Claude Desktop / Codex / Gemini CLI /
   Qwen Code / OpenCode / VS Code / Zed / Cline / Roo Code / Trae / Warp / Copilot CLI
   —— 自动检测你装了哪些，让你勾要装到哪几个。Claude Code 走它自己的 `claude mcp` CLI
   （不手改它的状态文件），其余按**各家格式**合并（JSON 的顶层键各家不同：多数 `mcpServers`、
   VS Code `servers`、Zed `context_servers`、OpenCode `mcp`；Codex 是 TOML 段）。
   **改之前备份**，且**只增删我们自己那一条**——你的其它内容不动
   （文件会被**重新序列化**：格式可能变、内容不变）。
   配置读不出来（比如有语法错）就**拒绝改**，只报告；**带 `//` 注释的 JSONC 也不动**
   （重写会把你的注释抹掉），改成给你一段可直接粘贴的配置。Codex 那份写完还会
   **用 TOML 解析器读回来验**，读不回来就放弃改动（它可能装着你的明文 API key）。
3. **拷技能包**到对应客户端的技能目录（技能包是**打进 exe** 的，不需要另外下载），
   并把**部署后的真实 exe 路径**填进去——这样 AI 客户端读技能就能自己把配置配好，
   你不必知道 exe 在哪。

装完**重启你的 AI 客户端**才会加载。

| 开关 | 作用 |
|---|---|
| `--install` | 装（幂等，可重复跑；升级后重跑一遍即可） |
| `--install-status` | 看装到哪、注册到哪些客户端 |
| `--uninstall` | 摘注册 + 删技能包 + 删部署的 exe（正被占用则安排重启后删）。**你的数据一律不动**。交互式跑会先让你**勾要摘哪些客户端**；脚本里跑一律全摘 |

`--install-status` 里有一行**版本对账**：你现在跑的这份 vs 装在客户端里那份。不一致就说明该重跑
`--install` 升级了。（它读安装时留下的登记，**不去启动部署副本**——onefile 冷启动 1–3 秒，
每次查状态都解一遍包就太慢了。）

### 手工装

```json
{
  "mcpServers": {
    "wechat-export": { "command": "C:\\你\\的\\路径\\wechat-export-mcp.exe", "args": [] }
  }
}
```

- 独立 exe：`dist/wechat-export-mcp.exe`（单文件）。
- 源码：`python server.py`（需 `pip install pycryptodome zstandard pilk`），或 `uv run server.py`。
- 数据目录默认自动探测；探测失败用 `env.LUMII_WECHAT_DB` 兜底。
- **改 py 代码要重新构建 exe**：`pnpm --filter ./apps/windows build:wechat-export-mcp`。

技能包：[`skills/wechat-export-mcp/SKILL.md`](skills/wechat-export-mcp/SKILL.md)。

## 有效期

**不需要任何授权密钥**。这份 exe 在**构建时**钉死一个到期日，到期后每次工具调用返回
`{"ok": false, "error_code": "expired", ...}`，并把「该怎么办」写在 `hint` 里。
`initialize` 照常完成（连接是通的），**引导词里也会先写明**——这样你的 AI 能一句话说清要做什么，
而不是看着一个连不上的服务器发懵。

```powershell
wechat-export-mcp.exe --expiry-status   # 看到期日与剩余天数（在有效期内退出 0）
```

- 有效期 = **构建日期 + N 天**（N 由构建脚本的 `--days` 定，默认 365）：拿到新版本就重新装一次。
- **防时钟回拨**：`~/.lumii/wechat-mcp/.state.json` 记见过的最大时间，把系统时间调回去按过期处理。
- 判据在 `builtin_expiry.py`（五件套共用一份，源码运行不判）。

> **隐私**：有效期校验**全程离线**，不会把任何数据发出去。

## 典型场景

**把某个群/某个人的聊天记录导出成文件**

1. 你问：「我和『两河10组村民群』的聊天记录导出来」
   → 名字没把握时 AI 先 `list_sessions(query="两河")` 拿**确切**会话名（这一步是为了避免
   `target_not_found`）。
2. AI 调 `export_chat(talker="两河10组村民群", out_dir="D:\\导出", format="md")`。
3. 要连图片：`media="images"`；连语音（转成 wav）：`media="all"`；
   记录多到一个文件读不动：`split="month"` 按月拆。

产出：

```
D:\导出\两河10组村民群\
  chat.md              ← 正文（群聊标发送人）
  assets\img_001.jpg   ← media=images/all
  assets\voice_003.wav ← media=all
```

## 工具（2 个）

| 工具 | 说明 |
|---|---|
| `list_sessions(query?)` | 列会话（拿确切名字/talker） |
| `export_chat(talker, out_dir, format?, since?, until?, media?, transcribe_voice?, split?)` | 导出 |

- `format`：`md`（默认）/ `html`（可分享，带样式）/ `json`（机读）。
- `media`：`none`（默认）/ `images` / `all`（+语音 wav）。
- `split`：`none`（默认）/ `month`（按月拆子目录）。
- `transcribe_voice`：默认 `false`；需本机装语音识别模型，缺了就逐条跳过并计数。
- 这三个枚举值**传错会被拒**，**不会静默降级**——否则"参数打错"和"这批消息没图"在返回里分不出来。
- `talker` 传会话**显示名**（如「文件传输助手」）或 wxid/群号都可以。

**长任务有进度**：大会话导出（跨全部分片读消息 + 逐条解密图片/解码语音）要跑几十秒，
期间会通过 MCP 的 `notifications/progress` 持续上报「正在读取会话记录…」「导出图片 20/120」——
客户端支持的话界面会动起来，不用盯着转圈猜是不是卡死了。
（只在客户端**主动带了** `_meta.progressToken` 时上报；没带就不发。）

## 失败长什么样

任何失败都是**同一个形状**（四件套一致，也和 wechat-mcp 一致）：

```json
{"ok": false, "detail": "发生了什么", "error_code": "target_not_found",
 "stage": "target", "suggestion": "该怎么办", "candidates": [...]}
```

**看到 `ok: false` 就是没成功**——别把同一个结果里的其它字段当数据用。

| `error_code` | 含义 | 该怎么办 |
|---|---|---|
| `target_not_found` | 会话名没对上**唯一**目标 | 这是「名字没对上」，**不是**「这个会话没记录」；`candidates` 里是相近的会话，挑一个或问用户 |
| `env_not_ready` | 微信没就绪（没运行 / 找不到数据目录 / 密钥扫不到） | 看 `detail` + `hint` 的动手步骤（通常是「先打开微信并登录」），**不是**参数问题，别重试 |
| `bad_args` | 参数缺失或取值非法（含 `format`/`media`/`split` 传了枚举外的值） | 按 `detail` 改正后重试；`invalid` 字段会列出具体哪几个 |
| `internal_error` | 工具内部出错（bug），此时 `isError=true` | 把 `detail` 原文反馈给开发者 |

`stage` 说的是**卡在哪一道**（`env` / `target` / `args` / `data` / `internal`），
让你一眼看出是环境的锅还是参数的锅。

## 故障排查

| 现象 | 原因与处置 |
|---|---|
| `env_not_ready`：未找到微信数据目录 | 确认微信**已登录**；在微信「设置 → 文件管理」看数据目录；仍不行就设 `LUMII_WECHAT_DB=<数据目录>\xwechat_files\<账号>_<4位>\db_storage` |
| `env_not_ready`：未能从微信进程内存取到数据库密钥 | 打开微信并登录、点开一个会话等几秒再试；仍不行多半是微信版本超出已验证范围（见 `wechat_core.VERIFIED_VERSION_PREFIXES`） |
| `media=images` 但一张图都没有 | 看 `media_report.image_missing`：图片解密需要**账号级图片密钥已缓存**（先用带图的会话刷一次） |
| `media=all` 但语音是 0 条 | 群里可能本来就没语音；有语音却没导出，看 `media_report.voice_missing` |
| 语音转写全是跳过 | `sherpa-onnx` **未随 exe 打包**（体积）——转写要本机自备模型，缺了就逐条跳过并计数，**不影响导出** |

## 输出形态

```
D:\导出\客户群\
  chat.md              ← 正文（split=month 时是 2026-08\chat.md 等）
  assets\img_001.jpg   ← media=images/all
  assets\voice_003.wav ← media=all
```

正文（群聊标发送人）：
```markdown
### 2026-08-12 14:30 · 张三
晚上一起吃饭？

### 2026-08-12 14:31 · 我
好，几点？
```

## 怎么工作的

1. **跨分片全量**：微信 4.x 按时间滚动分片（`message_N.db`），只读 `message_0.db` 会漏掉绝大部分历史——
   本服务合并**所有分片**。
2. **正文保留换行**：群消息正文前缀了发送者（`wxid:\n文本`），按核心的 `_PREFIX_RE` 剥掉后再保留换行；
   非文本消息走 `describe_nontext` 拿一行摘要（`[图片 17KB]`/`[引用] …`）。
3. **代发标记**：助手代发的消息正文里有零宽标记，导出时剥掉并标 `agent_sent`。
4. **图片**：走已解密的本地位图（需账号级图片密钥已缓存，见 wechat-mcp 的说明）。
5. **语音**：`VoiceInfo` 里的 SILK → `pilk` 解码 → stdlib `wave` 写 wav。

## 不支持的

- 导出发送（导出 ≠ 发送；发送是另一个产品的事）。
- 语音转写：**需要模型**，且 `sherpa-onnx` 未随 exe 打包（体积），没装就跳过。
- 读取**别人**的数据（只支持本机已登录账号）。

## 文件

| 文件 | 作用 |
|---|---|
| `server.py` | MCP 入口（stdio JSON-RPC）+ 2 个工具 |
| `exportcore.py` | 核心逻辑：跨分片取数、渲染 md/html/json、媒体导出 |
| `test_exportcore.py` | 单测（纯函数 + 真机只读导出冒烟，无库时跳过） |
| `skills/wechat-export-mcp/SKILL.md` | 给别的 AI 客户端看的技能包 |

**共享基础层**：读取层直接复用 `../wechat-mcp/` 的模块，本包**不复制**——详见
`docs/design/渠道与CLI/2026-10-12-微信小工具MCP四件套设计.md`。

自检：`python test_exportcore.py`。
