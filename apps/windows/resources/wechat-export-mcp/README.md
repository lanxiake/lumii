# wechat-export-mcp · 微信导出与文件归档

一个 **stdio MCP server**，两个面，都从本机微信里出：

- **记录面**：把某个会话的聊天记录导出成 **md / html / json**，可选连图片（已解密）、
  语音（SILK→wav）、**文件附件**，可选语音转写；也**按关键词只导出命中的那部分**（含全库搜）。
  `json` 带**统计报表**，每个会话目录另落一份机读的 `stats.json`。
- **文件面**：把微信里收发的**文件**列出来（`list_files`）、算占用（`disk_usage`）、
  归档到本地目录（`archive_files`，默认只出计划）。**过期下不动的文件能提前预警**。

两边**写进同一棵树**：`<out_dir>/<会话名>/` 下 `chat.<格式>` + `stats.json` + `assets/` +
`files/`——记录导出收的附件与归档收的文件落在同一个 `files/`，同一份只存一次。

**只读、只拷贝**：读层直读 SQLCipher4（密钥从进程内存**只读**扫描取，不注入、不改微信数据）；
导出只是把记录写成文件，归档只把 `msg/file/<月>/` 里的文件**复制**到用户目录，微信原文件原地不动。

> ⚠️ 仅用于**你自己的账号、你自己的机器**。记录与文件都涉及他人隐私——**本地处理、不外传**。

## 装

> **适配的微信版本：4.1.15.x**（真机验证过——密钥、会话、历史、发送全通）。4.1.6 起的其它 4.x
> 静态扫描**全部命中**、可以试，但没逐版真机跑过：跑起来每条结果会挂一句「该版本未验证」，
> 拿到的内容先抽查再用。**微信 3.x 不支持**——那是另一套数据目录与密钥提取，不是同一个后端。

### 一键装（推荐）

**双击这个 exe 就行**——它会先讲清楚自己是什么，再**用方向键勾选要装到哪些 AI 客户端**
（↑/↓ 移动、空格勾选、`a` 全选、回车确认——**不用打字**），然后一键装好。

已经装过时，双击会先问一句：**重新安装 / 卸载（可以只从某些客户端里摘掉）/ 退出**。

```powershell
wechat-export-mcp.exe --install
```

它做三件事：

1. **不搬动、不拷贝**：注册进客户端的路径**就是这份 exe 现在所在的位置**。所以装完
   **别移动、别删掉这个 exe**（客户端配置里存的就是它）；它旁边那个 `.lumii/` 是安装台账，也留着。
   想换地方，就在新位置再双击一次——它会按新位置重装一遍。
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
   并把**这份 exe 的真实路径**填进去——这样 AI 客户端读技能就能自己把配置配好，
   你不必知道 exe 在哪。

装完**重启你的 AI 客户端**才会加载。

| 开关 | 作用 |
|---|---|
| `--install` | 装（幂等，可重复跑；升级后重跑一遍即可） |
| `--install-status` | 看装到哪、注册到哪些客户端 |
| `--uninstall` | 摘注册 + 删技能包。**你的数据和这份 exe 一律不动**。交互式跑会先让你**勾要摘哪些客户端**；脚本里跑一律全摘 |

`--install-status` 里有一行**版本对账**：你现在跑的这份 vs 装在客户端里那份。不一致就说明该重跑
`--install` 升级了。（它读安装时留下的登记，**不去启动那份 exe**——onefile 冷启动 1–3 秒，
每次查状态都解一遍包就太慢了。）

### 手工装

Windows x64（**不需要 Node、不需要 Python**，依赖全在单文件 exe 里）：

```json
{
  "mcpServers": {
    "wechat-export": { "command": "C:\\你\\的\\路径\\wechat-export-mcp.exe", "args": [] }
  }
}
```

- 独立 exe：`dist/wechat-export-mcp.exe`（单文件）。
- 源码：`python server.py`（需 `pip install pycryptodome zstandard pilk`），或 `uv run server.py`。
- 数据目录默认自动探测（微信 4.x 自定义目录、任意盘）；探测失败用 `env.LUMII_WECHAT_DB` 兜底。
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

### 记录面

**把某个群/某个人的聊天记录导出成文件**

1. 你问：「我和『两河10组村民群』的聊天记录导出来」
   → 名字没把握时 AI 先 `list_sessions(query="两河")` 拿**确切**会话名（这一步是为了避免
   `target_not_found`）。
2. AI 调 `export_chat(talker="两河10组村民群", out_dir="D:\\导出", format="md")`。
3. 要连图片：`media="images"`；连**文件附件**：`media="files"`；全都要：`media="all"`
   （图片 + 文件 + 语音 wav）；
   记录多到一个文件读不动：`split="month"` 按月拆。
4. 想**把记录发给别人**（不是给自己看）：`format="html"` + `media="images"` ——
   图**内嵌在 HTML 里**，就一个文件，换台机器打开也不掉图。

**把记录导出来做分析**（喂模型 / 交给脚本）

1. 你问：「把和 XX 的记录导出来，我想看看聊了些什么」
   → `export_chat(talker="XX", out_dir="D:\\导出", format="json")`。
2. AI **先看 `stats` 再决定要不要读正文**：报表里有条数 / 我 vs 对方 / 按月 / 按小时 /
   按星期 / 类型分布 / 发言人排行 / 最忙的几天 —— 几千条记录不必全塞进上下文。
   `stats.json` 是同一份报表的独立落点（**不管正文是什么格式都落**），脚本直接读它。
3. 报表**只有计数、没有一句判断**（不评意向、不评情绪、不打分）；要结论时让 AI 说清那是它的推断。

**只导你要的那部分**（"把提到发票的都导出来"）

1. `export_chat(talker="XX", keyword="发票", format="json")` —— 只导出正文或附件名含该词的消息。
2. 不知道在哪个会话：**省掉 `talker`** → 全库搜。命中的会话按命中条数从多到少各存一个目录，
   根上另出 `index.md` 清单；超过 `max_sessions`（默认 20）的部分**如实报 `sessions_skipped`**。
3. 命中过多会被 `limit` 截断（默认 500/会话，保留**最新**的那些）—— 返回里
   **`truncated: true` 就是"被切过"，别说成"就这么多"**。
4. 同一个会话搜多次互不覆盖：每次落在自己的 `<会话名>\q-<关键词>\` 下。

**文件附件**（`media=files`/`all`）走的是微信消息里的文件名 ↔ 磁盘文件匹配
（`msg\file\<月>\`）。**没下载过 / 已过期**的在服务器上已经没了，定位不到——这些计入
`media_report.file_missing`，**不会编一个空文件出来**；同名但大小对不上计入 `file_mismatch`
（多半是另一版本），同一份文件被多条消息引用只收一次（`file_dup`）。

产出（**html + media ⇒ 自包含，没有 assets 目录**）：

```
D:\导出\两河10组村民群\
  chat.html            ← 正文 + 图（data: URI）+ 语音 + 跨天日期目录
```

体积：**实测**一个 500 条带图的会话，文字才 17 KB 而原图 30 MB ⇒ base64 后单文件 40 MB。
所以内嵌有上限 `inline_max_mb`（默认 20）：超出的媒体**退回落盘**到 `assets/`，页首会写明
"这份不再自包含"，返回里也有 `media_report.inline_fallback`。要全内嵌就调大它（`0` = 不限）。

### 文件面

**把文件传输助手里的文件备份出来**

1. 你问：「列一下文件传输助手里的文件，哪些已经下不动了？」
   → AI 调 `list_files(talker="文件传输助手")`，回报条数、体积，以及 `missing`（过期/未下载）有几个。
   **这一步只列清单，不落盘。**
2. 你问：「能下的都归档到 `D:\wechat-backup`」
   → AI 先调 `archive_files(out_dir="D:\\wechat-backup", talker="文件传输助手", dry_run=true)`，
   把计划（将拷贝 N / 跳过 M / 过期 K）报给你确认——**这时候一个文件都还没落盘**。
3. 你说「可以」→ AI 用 `dry_run=false` 真拷，回报落盘目录与文件数。

落点是 `<out_dir>\文件传输助手\files\`——**和 `export_chat(media="files")` 收附件是同一个目录**，
所以「先导记录、再补归档」不会出现两份副本（同一份文件按大小判重，跳过）。

**群文件过期预警**：问「我那些群里哪些文件已经过期了？」→ `list_files(only_missing=true)`。
过期的**救不回来**（微信服务器上也没了），只能如实告诉用户——这正是要"趁早归档"的理由。

**看空间花在哪**：问「微信怎么这么占地方 / 哪个会话最占空间？」→ `disk_usage()`。
本机实测（2026-10-14）：账号目录 **1503 MB**，其中 `msg/` 1322 MB（file 896 / video 269 / attach 157），
而**数据库只有 67 MB**——所以"为什么这么大"只能在磁盘上答。

`msg/file` 那 896 MB 是这样拆的，**三个数加起来才是总量**：

| 分项 | 本机 | 含义 |
|---|---|---|
| `file_own_bytes` | 455 MB | 只被**一个**会话引用的文件之和 —— **删了确实能省这些** |
| `shared_bytes` | 281 MB | 被**多个**会话引用的（转发的文件），每个会话都能看到它，**但磁盘只占一份** |
| `file_unattributed` | 160 MB | **没被任何消息引用到**的磁盘文件（74% 的文件有主，剩 26% 归属不了） |

⚠️ **别把 `own_bytes` 与 `shared_bytes` 相加当成"能省的空间"**：同一份转发文件会被数不止一遍
（实测按会话求和 1039 MB > 磁盘 896 MB）。`sessions[]` 默认只回前 20 名，**要验账请用上面三个总数**，
别拿截断后的榜单去求和。

`msg/video`（269 MB）与 `msg/attach`（157 MB，加密 `.dat`）**只报小计、不做会话归属**——
视频靠消息配对只有 9/48 能唯一定位，attach 是 md5 目录名。配不出来就不编。

## 工具（5 个）

记录面：

| 工具 | 说明 |
|---|---|
| `list_sessions(query?)` | 列会话（拿确切名字/talker） |
| `export_chat(talker?, out_dir, format?, keyword?, limit?, since?, until?, media?, transcribe_voice?, split?, inline_max_mb?, max_sessions?)` | 导出（整段 / 只导命中） |

文件面：

| 工具 | 说明 |
|---|---|
| `list_files(talker?, since?, until?, types?, keyword?, only_missing?, limit?)` | 列文件消息 + 磁盘定位。`only_missing=true` = **过期预警**。默认只回**最近 500 条**，看 `total`/`count` 判断有没有被截断 |
| `disk_usage(session_limit?)` | 磁盘占用：子树小计 + 按会话排行（独占/共享分开）+ 无主占用。**只读，不删任何东西** |
| `archive_files(out_dir, talker?, since?, until?, types?, layout?, dry_run?)` | 拷贝归档；`dry_run=true`（默认）只出计划 |

`export_chat` 的参数：

- `format`：`md`（默认）/ `html`（可分享，带样式，**媒体内嵌**）/ `json`（机读，带统计报表）。
- `keyword`：只导出正文/附件名含它的消息；给了它 `talker` 可省 → **全库搜**（用 `max_sessions` 封顶）。
- `limit`：按关键词导出时每个会话最多导多少条命中（默认 500，保留**最新**的；`0` = 不限）。
- `media`：`none`（默认）/ `images` / `files`（收附件到 `files/`）/ `all`（图片 + 文件 + 语音 wav）。
- `split`：`none`（默认）/ `month`（按月拆子目录）。
- `inline_max_mb`：html 内嵌媒体的体积上限（MB，默认 20，`0` = 不限）；超了退回落盘并留痕。
- `transcribe_voice`：默认 `false`；需本机装语音识别模型，缺了就逐条跳过并计数。
- `format`/`media`/`split` 这三个枚举值**传错会被拒**，**不会静默降级**——否则"参数打错"和
  "这批消息没图"在返回里分不出来。`limit`/`max_sessions` 给负数也拒。
- `talker` 传会话**显示名**（如「文件传输助手」）或 wxid/群号都可以。

`archive_files` 的 `layout`：`by_session`（默认，落 `<会话名>\files\`，**与导出同构**）/
`by_type`（按扩展名）/ `flat`（不分子目录）。
每条文件的 `status`：`ok` 可归档 / `size_mismatch` 同名但大小不符（可能另一版本）/ `missing` 过期或未下载。
归档侧另有两种**不落盘新内容**的状态：`exists` 目标已是同一份（重跑幂等，不重拷）、
`dedup` 同一磁盘文件被多条消息引用（只拷一次）。

**归档绝不覆盖**：目标已存在又是**另一版本**（大小不同）→ 另存为带时间戳的名字。

**长任务有进度**：大会话导出（跨全部分片读消息 + 逐条解密图片/解码语音）与归档几百个文件
都要跑几十秒，期间会通过 MCP 的 `notifications/progress` 持续上报「正在读取会话记录…」
「导出图片 20/120」「归档中 40/200（已拷贝 37）」——客户端支持的话界面会动起来，
不用盯着转圈猜是不是卡死了。
（只在客户端**主动带了** `_meta.progressToken` 时上报；没带就不发。）

## 目录结构（一套，记录与文件共用）

| 层 | 什么时候有 |
|---|---|
| `<out_dir>/<会话名>/` | 总是 |
| `<out_dir>/<会话名>/q-<关键词>/` | 传了 `keyword`（同一会话搜多次互不覆盖） |
| `<out_dir>/<会话名>/<YYYY-MM>/` | `split="month"` |
| `<out_dir>/<会话名>/files/` | 归档落点；也是 `media=files/all` 收附件的地方 |
| `<out_dir>/index.md` | 一次导了多个会话（全库搜命中 > 1） |

会话目录里：`chat.<格式>` 正文、`stats.json` 报表、`assets/` 图片与语音、`files/` 文件。
会话名与关键词都做文件名净化（`\/:*?"<>|` → `_`），长关键词截断到 40 字。
这个结构只在一处定义（`exportcore.session_subdir`）——归档那边调它，不另立一套。

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
| `media=images` 但一张图都没有 | 先看 `media_report.image_no_key`：图片解密要**账号级图片密钥已缓存**，在微信里**点开任意一张图**就有了；是 `image_missing` 才是原图/中图本地已不存在 |
| `media=files` 少收了一些附件 | 看 `media_report.file_missing`——**没下载过 / 已过期的文件微信服务器上已经没了**，定位不到；在微信里点一下那个文件（触发下载）再导一次就有了 |
| `media=all` 但语音是 0 条 | 群里可能本来就没语音；有语音却没导出，看 `media_report.voice_missing` |
| 语音转写全是跳过 | `sherpa-onnx` **未随 exe 打包**（体积）——转写要本机自备模型，缺了就逐条跳过并计数，**不影响导出** |
| `list_files` 里 `status=missing` 的很多 | 那是**未下载/已过期**，本地和服务器都没有，归档不了——如实告诉用户，别反复重试 |
| 归档后目标目录里出现带时间戳的文件名 | 预期行为：同名**不同版本**另存，**绝不覆盖**已归档的文件 |

## 输出形态

```
D:\导出\客户群\
  chat.md              ← 正文（split=month 时是 2026-08\chat.md 等）
  stats.json           ← 统计报表（机读；任何格式都落，与上面是什么格式无关）
  assets\img_001.jpg   ← media=images/all
  assets\voice_003.wav ← media=all
  files\合同.pdf        ← media=files/all 收的附件；也是 archive_files 的落点
D:\导出\客户群\q-发票\   ← 传了 keyword 时的落点
D:\导出\index.md        ← 一次导多个会话时的清单
```

`stats.json` 长这样（`chat.json` 里的 `stats` 字段是同一份）：

```json
{"count": 384, "from_me": 384, "from_other": 0,
 "first": "2026-08-21 14:18", "last": "2026-10-14 14:42", "span_days": 54.0, "active_days": 29,
 "by_hour": {"00": 7, "01": 1, "07": 1, "08": 7, "...": 0},
 "by_weekday": {"周一": 34, "周二": 45, "周三": 133, "周四": 3, "周五": 45, "周六": 42, "周日": 82},
 "by_month": {"2026-08": 11, "2026-09": 15, "2026-10": 358},
 "busiest_days": [{"day": "2026-10-14", "count": 119}, "..."],
 "types": [{"type": "文本", "count": 330}, {"type": "文件", "count": 20}, "..."],
 "top_senders": [{"sender": "我", "count": 384}],
 "media": {"image_exported": 12, "image_missing": 0, "image_no_key": 0, "...": 0},
 "session": "文件传输助手", "talker": "filehelper", "since": 0, "until": 0,
 "query": "", "format": "json", "exported_at": 1791900000}
```

（这是本机「文件传输助手」384 条那份、`media="images"` 导出的**真实输出**；
`by_hour`/`busiest_days`/`types` 为省地方省略了中间几项。`media` 那笔账跟着 **`media` 参数**走——
`media="none"`（默认）时里面全是 0。）

**都是计数**：没有意向分、没有情绪、没有画像。工具不下结论。

`format=html` 且带媒体时不一样：图/语音作为 `data:` URI **内嵌在 chat.html 里**，
没有 assets 目录，单个文件就是完整记录（跨多天时页首还有日期目录，点了直接跳）。
超出 `inline_max_mb` 的那部分仍会落到 `assets/`，页首有黄条提示。

**附件（files/）是唯一不内嵌的**——一个附件动辄几十上百 MB，内嵌进去 HTML 就没人打得开了；
要把它们一起发出去，连 `files/` 目录一起打包。html 里附件的落点是**可点的下载链接**。

正文（群聊标发送人）：
```markdown
### 2026-08-12 14:30 · 张三
晚上一起吃饭？

### 2026-08-12 14:31 · 我
好，几点？
```

## 怎么工作的

**记录面**

1. **跨分片全量**：微信 4.x 按时间滚动分片（`message_N.db`），只读 `message_0.db` 会漏掉绝大部分历史——
   本服务合并**所有分片**。
2. **正文保留换行**：群消息正文前缀了发送者（`wxid:\n文本`），按核心的 `_PREFIX_RE` 剥掉后再保留换行；
   非文本消息走 `describe_nontext` 拿一行摘要（`[图片 17KB]`/`[引用] …`）。
3. **代发标记**：助手代发的消息正文里有零宽标记，导出时剥掉并标 `agent_sent`。
4. **图片**：走已解密的本地位图（需账号级图片密钥已缓存，见 wechat-mcp 的说明）。
5. **语音**：`VoiceInfo` 里的 SILK → `pilk` 解码 → stdlib `wave` 写 wav。
6. **类型名从渲染文本里取**（`[图片 12KB]` → `图片`），不另抄一份 `local_type` 映射表——
   另一份映射迟早分叉（有过 57「引用」被标成「文件」的先例）。
7. **关键词匹配的是渲染后的正文 + 附件文件名**，和核心层 `search_messages` 一个口径
   （所以「图片」「语音」这类摘要词也搜得到）。
8. **全库搜按 `(表名, talker)` 的顺序取会话**——这里踩过坑：取反了会让每个会话都抛
   `UnknownTalker`，再被一个 `except Exception` 吞掉，于是全库搜恒返回"命中 0 个"却不报错。
   现在只吞**预期内**的失败（`UnknownTalker`/`OSError`/`sqlite3.Error`）并计入 `sessions_failed`。

**文件面**（一条链）

1. 消息：`message/message_N.db`（多分片，时间滚动）里 `local_type=49` 且 appmsg `type=6` 的是文件消息，
   带 `title`(文件名) / `totallen`(大小) / `fileext`。
2. 磁盘：文件本体在 `msg/file/<YYYY-MM>/<文件名>`，与消息 `title` **同名**；
   同名用 `totallen` 对大小消歧，少量文件带 `YYYYMMDD` 前缀（按别名命中）。
3. 关联率：真机实测 157 条文件消息 → 148 条可定位（94%），其余 9 条是**未下载/已过期**。
   这个数会**随着你在微信里点开文件而变小**——所以它是个快照，不是能力上限。

## 不支持的

- 导出发送（导出 ≠ 发送；发送是另一个产品的事）。
- 语音转写：**需要模型**，且 `sherpa-onnx` 未随 exe 打包（体积），没装就跳过。
- 归档**已过期**的文件（服务器端已无，本地也没有）。
- 归档**图片/视频**：文件面只归档文件消息。`disk_usage` 会报 `msg/video`、`msg/attach` 的**体积小计**，
  但**不归属到会话、也不归档**（视频靠消息配对只有 9/48 能唯一定位，attach 是 md5 目录名 + 加密 `.dat`）。
- 删除/清理任何东西：`disk_usage` 只报告。
- 读取**别人**的数据（只支持本机已登录账号）。

## 文件

| 文件 | 作用 |
|---|---|
| `server.py` | MCP 入口（stdio JSON-RPC）+ 5 个工具 |
| `exportcore.py` | 记录面：跨分片取数、渲染 md/html/json、统计报表、关键词筛选、媒体导出、**目录结构定义** |
| `filecore.py` | 文件面：文件消息解析、磁盘映射、占用分析、归档 |
| `test_exportcore.py` | 记录面单测（纯函数 + 真机只读导出冒烟，无库时跳过） |
| `test_filecore.py` | 文件面单测（纯函数 + 真机只读冒烟，无库时跳过） |
| `skills/wechat-export-mcp/SKILL.md` | 给别的 AI 客户端看的技能包 |

**共享基础层**：读取层（密钥扫描 / SQLCipher 解密 / 多分片镜像 / 路径发现）与**协议层**
（stdio JSON-RPC + 工具错误约定）直接复用 `../wechat-mcp/` 的模块（`wechat_core.py` /
`mcp_stdio.py`），本包**不复制**——详见
`docs/design/渠道与CLI/2026-10-12-微信小工具MCP四件套设计.md`。

自检：`python test_exportcore.py && python test_filecore.py`。
