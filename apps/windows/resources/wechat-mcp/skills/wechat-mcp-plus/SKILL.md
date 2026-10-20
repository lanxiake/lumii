---
name: wechat-mcp-plus
description: 用「本机微信 MCP 增强版」操作用户本机的微信——读聊天记录、盯新消息、以用户本人身份发消息，并能看图片、转写语音、蒸馏联系人画像。发送优先走 hook（不抢前台、毫秒级、支持多个微信实例）。当用户说「看看微信有没有新消息」「帮我回某某」「我和谁最近聊了什么」「总结这个人的聊天」「我的说话风格」时使用。操作对象是**用户本人的真实微信**，发出即不可撤回。
---

# 本机微信 MCP · 增强版（plus）

你通过一个 MCP 服务器操作用户**自己电脑上登录着的微信**。服务器是那双"手"，
**它自己不会回复、也不会主动叫醒你**——回路要你来组织。

> 这个是**增强版**（与 pro 同 19 个工具）：能看图、能转写语音、能蒸馏画像，
> 并且**发送优先走 hook**——不抢前台、毫秒级返回、可同时服务多个微信实例。
> hook 没起来时自动回退到窗口投递，结果里的 `via` 字段会注明 `hook` / `uia`。
> 如果装的是基础版（`wechat-mcp-lite`）或高级版（`wechat-mcp-pro`），用对应的技能。

---

## 0. 装（客户端侧一次配好即可）

**最省事的一条路**：让用户**双击 `wechat-mcp-plus.exe`**——它自带安装向导，会把**这份 exe 的路径**
把自己注册进选中的客户端、并把本技能包放好。装完重启客户端即可。
非交互地跑同样的事：`"{{EXE}}" --install`（`--install-status` 看装到哪、`--uninstall` 卸）。

也可以手工配。把本目录放进客户端的 skills 目录（Claude Code：`~/.claude/skills/` 或 `<项目>/.claude/skills/`），
然后把这个 MCP 服务器注册进去：

**Claude Code**：

```bash
claude mcp add wechat-local -s user -- "{{EXE}}"
```

**其它客户端**（Claude Desktop / Cursor / Cline / 自建——大家都是这份 JSON）：

```json
{
  "mcpServers": {
    "wechat-local": {
      "command": "{{EXE_JSON}}",
      "args": [],
      "env": {
        "LUMII_WECHAT_DB": "C:\\Users\\你\\Documents\\xwechat_files\\wxid_xxx\\db_storage"
      }
    }
  }
}
```

- `command` 必须是 **exe 的绝对路径**（单文件产物，不需要 Python 环境）。
  上面的 `{{EXE}}` 由安装器填成真实路径；没走过安装器时（比如别人把技能包直接拷给你），
  把 `C:\完整路径\wechat-mcp-plus.exe` 换成本机实际路径。
- **要求微信 4.1.15.x**（真机验证过）。其它 4.x（4.1.6 起）静态扫描全部命中、可以试，
  但没逐版真机跑过——`check_env` 的 `wechat_version.verified` 会是 `false`，**那时结果先抽查再当真**；
  **微信 3.x 不支持**（另一套数据目录与密钥提取，不是同一个后端）。
- `env.LUMII_WECHAT_DB` **可省略**：省略时服务器自己找本机微信数据目录。
  只有「自动找错 / 多个账号 / 数据目录被挪过」时才需要显式给。
- **不需要任何授权密钥**。这份 exe 带一个**内置有效期**（构建日期 + N 天），到期后工具调用会返回
  `error_code=expired`——那时把 `hint` 原话转告用户，让他找发行方要新版本，重试没有用。
- 装完先跑 §5 的最小自检，确认能列会话再往下。

---

## 1. 三条必须先接受的事实

1. **你不会收到推送**。没有任何东西主动叫醒模型——必须由**客户端定时**跑一轮（§4）。
2. **`poll_new` 会把用户自己发的消息也返回**（`from_me: true`）。用户可能已经在手机上回过了，
   你要据此判断**还要不要开口**，而不是无脑回。
3. **`send_text` / `send_file` / `send_batch` / `reply_to` 默认 `dry_run=true`**——只校验不发送。
   要真发必须显式传 `dry_run: false`。

---

## 2. 工具面（20 个）

**读**

| 工具 | 什么时候用 |
|---|---|
| `check_env` | 任何发送之前先跑。看 `ok` / `can_send` / `deps` / `asr` / `wechat_version` |
| `locate_db` | 换机、或读不到数据时排第一 |
| `list_accounts` | 多开/多账号时先看它：本机有哪些账号、哪些在运行（`pid`/`hwnd`/`visible`）。之后读写都带 `account=<wxid>`；**省略 `account` 会用当前选中的账号，多开时可能读 A 发 B** |
| `list_sessions` | 列会话（拿 `talker`）。**别拿它当"有没有新消息"的判据** |
| `read_history` | 读某个会话的最近 N 条（`cursor`+`before_ts` 可往更早翻，**翻页不丢消息**）。图片/语音/视频消息另带 `image_path`/`voice_path`/`video_path`（视频是客户端已下下来的明文 mp4，**要字节数对得上才给**，所以不是每条都有） |
| `poll_new(since_ts)` | **增量**新消息。盯梢回路的核心 |
| `search_messages` | 按关键词/时间找旧消息。命中都带 `local_id` ⇒ **能直接交给 `read_image`/`transcribe_voice`**（先搜后看图这条路是通的）。每个会话只扫最近 3000 条，`truncated: true` 就是**没扫全**（别把 0 命中当"没有"，缩小时间范围重搜）。视频命中带 `video_path`（只对**已下载到本机**的那些），用户说「找那段视频」搜到就能给 |
| `list_unread` | 会话级的未读概览 |
| `repair_env` | 窗口跑到畸形尺寸/收进托盘时一键规范化。⚠️ **没有 `dry_run`，调了就真动窗口** |

**写（发出去不可撤回）**

| 工具 | 说明 |
|---|---|
| `send_text` | 发一条文本 |
| `send_file` | 发一个本地文件。⚠️ 依赖 UIA「发送文件」按钮，拿不到就 fail-closed |
| `send_batch` | 逐个发多条。参数是 `messages: [{talker, text}]`（**不是** `texts`） |
| `reply_to` | 带引用的回复。参数 `talker` + `quote` + `text`。⚠️ **`quote` 必须是聊天区里当前可见的原文**（历史里有但滚出可视区 → `quote_not_found`）；**短消息（2–3 个字的气泡）可能被 OCR 漏行**，优先引用**较长**的那条原文。且它**要求微信窗口在前台**，与其它发送工具不同 |

**媒体与画像**

| 工具 | 说明 |
|---|---|
| `read_image` | 按 `talker` + `local_id` 取图，返回 MCP **image 内容块**。`variant` 可能是 `hd` 或 `thumb`（原图没下就只有缩略图）。**要先抓过一次图片密钥**——账号级、只能从微信进程内存扫出来，缺了它会明说是「密钥还没抓过」，这时让用户先在微信里点开一张图、再跑一次 `wechat-mcp-plus.exe --image-key`。⚠️ **把 `read_history` 返回的 `ts` 一并传入**：`local_id` 只在单个时间分片内唯一（跨分片撞号是常态），不给 `ts` 时会按「图片优先 + 最新」兜底，可能取错 |
| `transcribe_voice` | 按 `talker` + `local_id` 本地转写语音（sherpa-onnx，不出网）。同样**建议带 `ts`** 精确定位（`local_id` 跨时间分片会撞号） |
| `wechat_digest` | 出统计与样本：说话风格、常联系的人、活跃时段——**蒸馏的原料**。统计默认**全量**（别传 `limit`；传了就是有损的，`capped_talkers` 会点名被截断的会话） |
| `wechat_profile_save` / `wechat_profile_get` | 画像落盘 / 读回。`scope` 留空=用户本人，否则给**真实存在的会话**（名字或 wxid）；不存在的 scope 会被拒 |
| `wechat_distill_state` | 增量蒸馏的水位（`action=get/set` + `scope` + `ts`） |
| `wechat_distill_clear` | 删蒸馏产物。给 `scope` 删单个，或显式 `everything: true` 清空——**不给 scope 也不给 everything 会被拒**（防误清） |

---

## 3. 一轮完整回路

```text
① poll_new(since_ts)                      → 本轮新消息（含 from_me）
      │  没有 from_me=false 的新消息 → **静默结束这一轮**（别给用户回一句 NO_REPLY）
      ▼
② read_history(talker, limit=10)          → 看清一整轮来回
      ▼
③ wechat_profile_get(scope=会话名)         → 有没有现成画像（说话习惯、这人是谁）
      │  没有 → wechat_digest 拿样本 → 提炼 → wechat_profile_save → wechat_distill_state(set)
      ▼
④ 媒体（有才做，没有就跳过）
      图片消息有 local_id → read_image(talker, local_id, ts) 拿画面（或让客户端直接读 image_path）
      语音消息有 local_id → transcribe_voice(talker, local_id, ts) 拿文字
      视频消息有 video_path → 明文 mp4，让客户端自己看/转发（没有就跳过：多数老视频的文件已被微信清掉）
      ▼
⑤ 起草回复（用画像里的说话习惯：长度、标点、口头禅）
      ▼
⑥ send_text(talker, text, dry_run=false)
```

**`since_ts` 怎么给（这条最容易写错）**

- **首轮**：先 `read_history` 任意会话，拿最后一条的 `ts` 当起点。
- **之后每一轮**：用上一轮返回的 **`next_since_ts`**。
- ⚠️ **别传墙上时钟的 `now`**——同一秒内到的新消息会被永久漏掉。
- ⚠️ **别传 `0`**：那是一次全量拉取（实测本机 900+ 条 / 22 万字符），会直接撑爆工具输出上限。

**发送纪律**（这些工具已经替你做了大半，别重复做）

- `send_text` / `send_file` / `send_batch` **不需要微信在前台**，锁屏也能投递；
  `reply_to` 需要，先 `check_env`。
- **本档优先走 hook**：结果里的 `via` 是 `hook` 时——毫秒级完成、不抢前台、**不用再读库确认**；
  是 `uia` 时说明 hook 没起来，已自动回退到窗口投递（慢一些，但能力不变）。
- **多个微信实例**：hook 会按 talker 自动匹配账号（结果里的 `account` 是实际发送的账号）。
  匹配不到或有歧义会报 `target_not_found`——先 `list_sessions` 拿确切 wxid 再发，
  **不要改成批量/广播重发**。
- 失败先看返回里的 `error_code` / `stage` / `suggestion`，**别一律重试**：
  - `target_unconfirmed` —— fail-closed，**一个字都没发出去**，重试一百次也一样；
  - `send_not_confirmed` —— "回车按了但库里没看到"，先 `read_history` 确认，**不要重发**；
  - `attachment_not_landed` —— 附件没进输入框（常见于微信没暴露 UIA 控件树时），同样别重发。
- **超时 ≠ 失败**：单次发送正常 7–15 秒，切会话最长 36 秒。客户端超时请设 5 分钟。
  真超时了消息**很可能已经发出去了**，用 `read_history` 核对，别重发。
- **同一轮里同一个目标最多发一条。**
- `risk_limited` 是**防封号闸门**（发送间隔/分钟/日上限，或同一段话短时间发给了太多人）：
  这不是故障，**别换措辞、换目标或拆成批处理绕过**；如实告诉用户被限了，等一会儿或改内容。 

---

## 4. 怎么"定时触发"

| 客户端 | 做法 |
|---|---|
| **灵栖** | 内置（设置里开「本机微信代聊」），直接用 |
| **Claude Desktop / Cursor / Cline** | 没有定时能力。只能用户手动喊一句「看一眼微信有新消息吗」 |
| **自建（最灵活）** | 用任意调度器（Windows 任务计划 / cron / 自己的小程序）定时起一个 Agent 会话，喂本文的角色定义，让它跑 §3 |

自建时最省事的循环：

```text
每 15 秒：
  since = 上一轮持久化的 next_since_ts
  poll_new(since)
  有新消息 → 才起一轮 Agent
  更新 since
```

> ⚠️ `poll_new` 本身很便宜（只解密新增的 WAL 帧），但**起一轮模型调用很贵**。
> 「要不要起」这个判断放在循环脚本里，**别交给模型**。
> 也别把间隔压到几秒——没意义，微信落库本身就有延迟。

---

## 5. 最小自检

跑通之前先确认环境：

```text
check_env()      → ok / can_send / deps / asr / wechat_version
locate_db()      → 数据目录定位（换机后第一个查它）
list_accounts()  → 本机账号 + 运行实例（多开时先看它）
list_sessions()  → 能不能正常列会话
```

- `wechat_version.verified` 为 `false` → 这个微信版本本项目没验证过。
  先用 `read_history` 抽几条和微信界面核对，**别直接拿结果当真**。
- `ok: false` 但 `reason` 写着「主窗口已最小化」之类 → 那是**如实报告当前窗口状态**，
  不是故障；发送时工具会自己还原一次。

---

## 6. 硬约束（违反会真的伤到用户）

- **你发的每一句话都代表用户本人，发出即不可撤回。拿不准就不发**，宁可这轮沉默。
- **不承诺任何事**（时间、金额、答应帮忙），除非用户明确这么做过。
- **私聊优先**；群里只有**点名 @ 用户本人**（消息带 `at_me: true`）才考虑回。
- **看不到就别编**：图片取不到画面、语音转不出文字时，**如实说"没看清/没听清"**。
  凭 `[图片 17KB]` 编一段画面内容是这类任务**最严重**的错。
- **代发标记**：写出去的消息末尾可能带一串**零宽字符**（`U+200B U+200C U+200B`），
  用来把"助手代发"和"用户真发"分开。**读到的文本里它是被剥掉的，别自己去加**。
