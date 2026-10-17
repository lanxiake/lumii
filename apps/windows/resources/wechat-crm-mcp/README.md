# wechat-crm-mcp · 微信客户分析

一个 **stdio MCP server**：读取本机微信的**通讯录与会话统计**——好友/群/公众号/企业微信、
群成员、单会话互动数字、互动排行。

**只出取数与统计，不出判断**："这个客户意向高不高"交给接入方的 LLM + 技能包。

**只读**：读层直读 SQLCipher4（密钥从进程内存**只读**扫描取，不注入、不改微信数据）。

> ⚠️ 仅用于**你自己的账号、你自己的机器**。通讯录与统计涉及大量他人隐私——**本地、不外传**。

## 装

> **适配的微信版本：4.1.15.x**（真机验证过——密钥、会话、历史、发送全通）。4.1.6 起的其它 4.x
> 静态扫描**全部命中**、可以试，但没逐版真机跑过：跑起来每条结果会挂一句「该版本未验证」，
> 拿到的内容先抽查再用。**微信 3.x 不支持**——那是另一套数据目录与密钥提取，不是同一个后端。

### 一键装（推荐）

**双击这个 exe 就行**——它会先讲清楚自己是什么，再**用方向键勾选要装到哪些 AI 客户端**
（↑/↓ 移动、空格勾选、`a` 全选、回车确认——**不用打字**），然后一键装好。

已经装过时，双击会先问一句：**重新安装 / 卸载（可以只从某些客户端里摘掉）/ 退出**。

```powershell
wechat-crm-mcp.exe --install
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

## 有效期

**不需要任何授权密钥**。这份 exe 在**构建时**钉死一个到期日，到期后每次工具调用返回
`{"ok": false, "error_code": "expired", ...}`，并把「该怎么办」写在 `hint` 里。
`initialize` 照常完成（连接是通的），**引导词里也会先写明**——这样你的 AI 能一句话说清要做什么，
而不是看着一个连不上的服务器发懵。

```powershell
wechat-crm-mcp.exe --expiry-status   # 看到期日与剩余天数（在有效期内退出 0）
```

- 有效期 = **构建日期 + N 天**（N 由构建脚本的 `--days` 定，默认 365）：拿到新版本就重新装一次。
- **防时钟回拨**：`~/.lumii/wechat-mcp/.state.json` 记见过的最大时间，把系统时间调回去按过期处理。
- 判据在 `builtin_expiry.py`（五件套共用一份，源码运行不判）。

> **隐私**：有效期校验**全程离线**，不会把任何数据发出去。

## 典型场景

**看看最近都在跟谁聊、谁很久没联系了**

1. 你问：「我最近跟谁聊得最多？」
   → AI 调 `interaction_rank(top=20)`，给互动排行。
2. 你问：「哪些人很久没联系了？」
   → `silence_ladder()`：按 30/60/90 天分层，每层给**原始时间戳**（不打分）。
   它按**人**看，所以私聊没说过话、只在群里冒过泡的人也看得见；通讯录里有、全库一句话没说的
   单独进 `never` 桶（本机 2475/2520——那批人用别的工具是**完全看不见**的）。
3. 你问：「我跟老王最近聊得怎么样？」
   → `contact_stats(talker="老王")`：总条数 / 我发对方发 / 活跃时段 / 沉默天数。
4. 你问：「这个群里都有谁？」→ `list_contacts(room="XX群")`（`room=` 会列成员）。

**看清一个客户最近怎么回事（不用先翻几百条聊天）**

5. 你问：「张三最近什么情况？我有没有漏掉什么？」
   → `customer_brief(talker="张三")` 一次拿到：614 条 / 127 段（他主动开场 83、我 44）/
   我回他中位 **52 秒**、他回我 **50 秒** / 类型分布 / 他在聊的高频二字组合 /
   **他提了 44 句问句、其中 1 句我 24 小时内没回**。
6. 你问：「他提过报价吗？」→ `search_messages(keyword="报价", talker="张三")`；
   想圈时间段就再叠 `since`/`until`（范围 = 会话 + 时间 + 关键词的自由组合）。
7. 你问：「那几句我看看」→ `read_messages(talker="张三", since=…, until=…)`，
   按**时间正序**给正文，图片带 `image_md5`、视频带 `video_path`。

**边界要说清**：这里只端上**确定性的清单与数字**——「这个客户意向高不高」由 AI 结合数字来判断，
本服务**不下结论**。

## 工具（7 个）

**通讯录面**（不读正文）：

| 工具 | 说明 |
|---|---|
| `list_contacts(scope?, room?, keyword?, include_deleted?, limit?, offset?)` | 通讯录；`room=` 时列该群成员（含 `name_in_room` = **群里的称呼**，及 `name_in_room_with` 报有几个是真的）。默认只回 200 条，看 `total` 判断有没有被截断，用 `offset` 接着翻 |
| `contact_stats(talker, since?, until?)` | 单会话：总条数 / 我发对方发 / 活跃小时 / 活跃天 Top / 首末 / 跨度 / 沉默天数 |
| `silence_ladder(scope?, days?, top?)` | **按人**分层：多久没互动 / 从没聊过的人。只给原始时间戳与条数，不打分 |
| `interaction_rank(since?, until?, top?, sort?)` | **按会话**排行；`sort=recent` = 久未联系在前 |

**消息面**（读正文）：

| 工具 | 说明 |
|---|---|
| `read_messages(talker, since?, until?, limit?)` | 读会话**正文**，**时间正序**；非文本给一行摘要（`[图片 12KB]` / `[引用] …`）。`limit` 取时间段内**最近**的若干条，`truncated=true` = 还有更早的没给完 |
| `search_messages(keyword, talker?, since?, until?, limit?)` | 在**指定范围**里搜正文：`talker` 不传 = **全库**，再叠加时间段 |
| `customer_brief(talker, since?, until?, top?)` | **一次看清一个客户**：谁主动开场 / 回复间隔中位数 / 消息类型分布 / 高频二字组合 / **对方提问后 24 小时内我没回的那几句** |

`talker` / `room` 传会话**显示名**（如「文件传输助手」）或 wxid/群号都可以。

**做一次客户分析，按这个顺序走**（本产品自己就能闭环，不需要别的工具）：

```
① 找   list_contacts(keyword=…) / silence_ladder()   → 有哪些人、谁久没联系
② 看量 contact_stats(talker)                          → 多少条、活跃时段、沉默多久
③ 摘要 customer_brief(talker)                         → 谁主动、回多快、在聊什么、漏了什么
④ 细节 read_messages / search_messages                → 读原文、按话题找
⑤ 判断 —— 由 AI 或你下，工具不下
```

## 消息面读的是什么（**和通讯录面不是一回事**）

`contactscore`（通讯录面）**从不读正文**：所有落在消息表上的 SQL 只取 `create_time` 与
`real_sender_id` 两列。`chatlog`（消息面）**会读正文**——`read_messages`/`search_messages`
直接回原文，`customer_brief` 拿正文做短语与问句统计。

**两者都是只读、都只在本地处理、都不外传**，但"读不读正文"这件事上口径不同，
别把通讯录面那句"读不到正文"套到消息面上。

数据来源全部是**同一个本机库**（`wechat_core` 共享读取层），没有第二条路径、没有网络请求。

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
2. **群成员**：`chatroom_member` 给成员 id，join `contact` 取**全局**显示名（备注 > 昵称）；
   另外从 `contact_fts.db.chatroom_member_fts_v3_content` 取**群里的称呼**填 `name_in_room`
   （稀疏，见下）。列表**包含自己**（`is_me=true`）——否则"这个群几个人"与微信里对不上。
3. **统计**：跨**所有分片**扫会话消息（微信 4.x 按时间滚动分片），只取 `create_time` 与发送者，
   在 Python 里聚合。
4. **沉默分层**：全库按 `real_sender_id` 聚合出"这个人最后一次发言"，与"我们私聊最后一条"
   **分开报**——两个口径不是一回事（前者含群，本机 2520 好友里 45 个有私聊会话、166 个发过言）。
5. **消息面**（`chatlog.py`）：读正文走共享层的 `_rows_full`（跨分片 + 时间范围**下推到 SQL**），
   渲染走 `wechat_core._render`（消息渲染的唯一入口）。
   `customer_brief` 的每个数都是**纯函数**从时间正序的消息序列上算的
   （切段 / 换手间隔 / 问句判定），喂合成数据就能逐项对账——见 `test_chatlog.py`。

## 不支持的

- **标签筛选**：本地库只有标签名（`contact_label`），**没有**好友↔标签映射表（疑似
  `contact.extra_buffer` 的 protobuf，需逆向）——留研究项。
- **群里的称呼只对一部分人存在**：来源是 `contact_fts.db` 的 `chatroom_member_fts_v3`
  （列定义写明是 `a_group_remark`），本机 1980 行里只有 191 行非空（**9.6%**），
  自己的办公群多（27/32）、外部大群几乎没有（1/159）。`name_in_room` 为空串就是"这个群里没设过"，
  **不是查不到**——所以别拿全局名顶上。它也不能用来认人（认人用 `username`）。
- 出任何"判断"（客户价值 / 关系好坏 / 情绪 / 意向分）——那是接入方 LLM 的事。
  `customer_brief.unanswered` 是**形态判定**（句尾问号/疑问词 + 24 小时内我没发过消息），
  不等于"他在催你"；`hot_pairs` 是**线索不是词表**（2-gram 没有词典）。都别当结论用。
- 读取**别人**的数据（只支持本机已登录账号）。

## 文件

| 文件 | 作用 |
|---|---|
| `server.py` | MCP 入口（stdio JSON-RPC）+ 7 个只读工具 |
| `contactscore.py` | **通讯录面**逻辑：分类 / 通讯录 / 群成员（含群里称呼）/ 会话统计 / 排行 / 沉默分层（**不读正文**） |
| `chatlog.py` | **消息面**逻辑：读正文 / 按范围检索 / 客户简报（**会读正文**） |
| `test_contactscore.py` | 通讯录面单测（分类纯函数 + 真机只读冒烟，无库时跳过） |
| `test_chatlog.py` | 消息面单测（简报等纯函数用**合成数据**对账 + 真机只读冒烟，无库时跳过） |
| `skills/wechat-crm-mcp/SKILL.md` | 给别的 AI 客户端看的技能包 |

**共享基础层**：读取层直接复用 `../wechat-mcp/` 的模块（经 `contactscore.py` / `chatlog.py`），本包**不复制**——详见
`docs/design/渠道与CLI/2026-10-12-微信小工具MCP四件套设计.md`。

自检：`python test_contactscore.py` + `python test_chatlog.py`。
