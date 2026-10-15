---
name: wechat-crm-mcp
description: 用「微信客户分析 MCP」读取用户本机微信的**通讯录、互动统计与聊天正文**——列好友/群/公众号/企业微信、列群成员、按微信标签筛人、把名单导成 Excel 表格、看某人的互动数字、列互动排行与久未联系的人、读某段聊天正文、按关键词在指定范围内搜消息、把一个人的往来汇总成一份客户简报（谁主动开场、回复多快、在聊什么、有没有没接的问句）。当用户说「我有哪些客户群」「这个群里都有谁」「我和某某聊得多不多」「谁最久没联系了」「张三最近什么情况」「他提过报价吗」「整理一下我的联系人」「我标了客户的有哪些人」「把客户名单导出来」时使用。只读、本地处理；只给清单、数字和原文，不下判断。
---

# 微信客户分析 MCP

你通过一个 MCP 服务器读取用户**自己电脑上登录着的微信**的通讯录、互动统计**与聊天正文**。**只读**。

**它只给清单、数字和原文，不做任何判断**——"这个客户意向高不高""关系好不好"由**你**（模型）
拿到事实后自己分析，工具不会替你下结论。

## 0. 装（客户端侧一次配好即可）

把本目录放进客户端的 skills 目录，然后注册 MCP 服务器：

**Claude Code**：
```bash
claude mcp add wechat-crm -s user -- "{{EXE}}"
```

**其它客户端**：
```json
{
  "mcpServers": {
    "wechat-crm": { "command": "{{EXE_JSON}}", "args": [] }
  }
}
```

## 0.5 环境要求与失败处置

- **Windows + 微信 4.1.15.x 已登录并运行**（真机验证过的版本）。工具直读本机微信库，**不联网、不外传**。
  其它 4.x（4.1.6 起）静态扫描全部命中、可以试，但没逐版真机跑过——`check_env` 的
  `wechat_version.verified` 会是 `false`，**那时结果先抽查几条再当真**。**微信 3.x 不支持**（另一套后端）。
- 出错一律返回**同一形状**：`{"ok": false, "detail", "error_code", "stage", "suggestion"}`。
  **看到 `ok: false` 就是没成功**，别把同一结果里别的字段当数据用。按 `error_code` 分派：
  - `env_not_ready` —— 微信没就绪（没运行 / 找不到数据目录 / 密钥扫不到）。**不是用户参数的问题**：
    把 `detail` + `hint` 里的动手步骤**原话转告用户**（通常是「先打开微信并登录、点开一个会话」），
    **不要重试**。
  - `target_not_found` —— 会话名没对上唯一目标。那是「名字没对上」，**不是**「你俩没聊过」；
    `candidates` 里是名字相近的会话，拿它向用户问清是哪一个，**别把 `count: 0` 讲给用户听**。
  - `bad_args` —— 参数缺失或取值非法，按 `detail` 改正后重试。
  - `internal_error` —— 工具内部出错（bug），此时 `isError=true`；把 `detail` 原话反馈，别自己绕。

## 1. 三条必须先接受的事实

1. **分类按 username 后缀**（`@chatroom`/`gh_`/`@open`/系统名单），**不是**按库里的
   `local_type`——实测后者语义不干净（`wxid_` 既有 1 也有 3），拿它判断会错。
2. **群里的称呼是稀疏的**：`list_contacts(room=...)` 会同时给 `name`（全局显示名）和
   `name_in_room`（群里的称呼）。**空串就是"这个群里没设过"**——本机只有 9.6% 的人有，
   自己的办公群多、外部大群几乎没有。**别拿全局名顶上、也别当成查询失败**。
   另外它**不能用来认人**（认人一律用 `username`）。
3. **标签名要精确**：每个联系人带 `labels`（用户在微信里打的标签）；按标签筛用
   `list_contacts(label="标签名")`，名字拿不准先 `list_labels()`。名字打错会回 `target_not_found`
   并在 `candidates` 里列出全部标签——那**不是**「这个标签下没人」。

## 2. 工具面（8 个，两面）

**通讯录面**（不读正文）：

| 工具 | 用途 |
|---|---|
| `list_contacts(scope?, room?, keyword?, include_deleted?, label?, out_dir?, limit?, offset?)` | 通讯录；`room=` 时列**该群成员**（含 `name_in_room` 与 `name_in_room_with`）；`label=` 按标签筛；**`out_dir=` 把全部命中导成 CSV**（Excel 直接打开），只回 `csv_path` 与 `total` |
| `list_labels()` | 用户打过的全部标签 + 每个标签下的好友人数 |
| `contact_stats(talker, since?, until?)` | 单会话数字：总条数/我发对方发/活跃小时/活跃天 Top/沉默天数 |
| `silence_ladder(scope?, days?, top?)` | **按人**分层：多久没互动 / 从没聊过的人（`never` 桶）。分层结果同时给 `buckets`（数组）与扁平化键 `within_30` / `31_60` / `61_90` / `90_plus`，直接取键即可，不必遍历数组 |
| `interaction_rank(since?, until?, top?, sort?)` | **按会话**排行；`sort=recent` = 久未联系在前 |

**消息面**（读正文）：

| 工具 | 用途 |
|---|---|
| `customer_brief(talker, since?, until?, top?)` | **一次看清一个人**：条数占比 / `segments` 来过几趟 + 谁主动开场 / 双方回复间隔**中位数** / 消息类型分布 / 对方高频二字组合 / **`unanswered`：对方提问后 24 小时内我没发过消息的那几句** |
| `read_messages(talker, since?, until?, limit?)` | 读会话**正文**，**时间正序**；非文本给一行摘要。`limit` 取时间段内**最近**的若干条 |
| `search_messages(keyword, talker?, since?, until?, limit?)` | 在**指定范围**里搜正文：`talker` 不传 = **全库**，再叠加时间段 |

`scope` ∈ `friend`（默认）/ `group` / `official` / `open` / `system` / `all`。
`talker` 传显示名或 wxid/群号都可以。

问「谁最久没联系了」**优先用 `silence_ladder`**：`interaction_rank` 只看得见"有你俩消息的会话"，
私聊没说过话、只在群里冒过泡的人它完全看不见（本机 2520 个好友里只有 45 个有 1:1 会话）。

## 3. 一轮完整回路（客户分析就按这个顺序）

```
① 找   list_contacts(keyword=…) / silence_ladder()   → 有哪些人、谁久没联系
② 看量 contact_stats(talker)                          → 多少条、活跃时段、沉默多久
③ 摘要 customer_brief(talker)                         → 谁主动、回多快、在聊什么、漏了什么
④ 细节 read_messages / search_messages                → 读原文、按话题找
⑤ 判断 —— 由你下，工具不下
```

**第 ③ 步是省事的关键**：多数「XX 最近什么情况」在这一步就够了，不必先读几百条原文。
只有用户追问具体内容时才走第 ④ 步。

具体问法：
1. 「我有哪些客户群」→ `list_contacts(scope="group", keyword="客户")`
2. 「这个群里都有谁」→ `list_contacts(room="群名")`（先从上一步拿到确切群名）
   「我标了『客户』的有哪些人」→ `list_labels()` 确认标签名 → `list_contacts(label="客户")`
   「把客户名单导出来 / 离职前交接」→ `list_contacts(label="客户", out_dir="D:\\导出")`
   （或 `room=` 导群成员）——**用 `out_dir` 落表格，别把几千行贴进对话**
3. 「谁最久没联系了」→ `silence_ladder(top=20)`；「哪些人从没聊过」→ 看返回里的 `never` 桶
4. 「我和某某聊得多不多」→ `contact_stats(talker="某某")`
5. 「某某最近什么情况 / 我有没有漏掉什么」→ `customer_brief(talker="某某")`
6. 「他提过报价吗」→ `search_messages(keyword="报价", talker="某某")`；
   「把那段发我看看」→ `read_messages(talker="某某", since=…, until=…)`

**你要下判断时，把数字摆出来再说结论**（例："近 90 天只有 3 条往来，最后联系在 4 个月前"），
别只丢一句"关系淡了"。

## 3.5 常见误用（都会让答案失真）

- **上来就 `read_messages(limit=5000)`**：先用 `customer_brief` 拿摘要，只有用户追问具体内容时才读原文。
- **用 `interaction_rank` 回答「谁久没联系」**：它按**会话**统计，看不见"从没私聊、只在群里冒过泡"的人；
  这个问题用 `silence_ladder`。
- **把 `hot_pairs` 当话题清单**：2-gram 会带碎片词，说"从高频词看可能在关注…"，别说"他只聊这个"。
- **只看 `silent_days` 不看两个口径**：`last_msg_*`（私聊最后一条）与 `last_spoke_*`（含群最后一次发言）
  不同属正常，别拿一个当全部。
- **忽略 `truncated`**：读正文 / 检索 / 简报撞到扫描上限时**没扫完**，别讲成"就这些"。
- **全库搜索**：`search_messages` 不传 `talker` 会扫整个微信号库（本机数百会话，数秒到 10s+）；
  优先单会话，或收窄 `since`/`until`。
- **通讯录默认 200 条**：看 `total`，不够用 `offset` 翻页，别把一页当成全部。

## 4. 硬约束

- **失败一律长成 `ok: false`**：`{"ok": false, "detail": "发生了什么", "error_code": "...", "stage": "...", "suggestion": "该怎么办"}`。
  **看到 `ok: false` 就是没成功**，别把同一个结果里的其它字段当数据用。按 `error_code` 决定下一步：
  - `target_not_found` —— `talker`/`room` 没对上**唯一**会话。那是「名字没对上」，**不是**「没有数据」；
    `candidates` 里是名字相近的会话，拿它向用户问清是哪一个，**别把 `count: 0` 讲给用户听**。
  - `env_not_ready` —— 微信没就绪（没运行 / 找不到数据目录 / 密钥扫不到）。**不是用户参数的问题**，
    把 `detail` + `hint` 里的动手步骤转告用户（通常是「先打开微信并登录」），**别重试**。
  - `bad_args` —— 参数缺失或取值非法，按 `detail` 改正后重试。

- 工具**不下判断**：不要要求它给"客户价值分"之类的结论（它没有）。
  `customer_brief.unanswered` 是**形态判定**（句尾问号/疑问词 + 24 小时内我没发过消息），
  **不等于「他在催你」**；`hot_pairs` 是 2-gram 切出来的**线索不是词表**。两者都别当结论讲。
- **`truncated=true` 是红灯**：`read_messages` / `search_messages` / `customer_brief` 都有扫描上限，
  撞上说明**没扫完**——**别把"就这些"讲给用户听**，往前挪 `since` 或收窄范围再来一次。
- **`read_messages` 的 `text` 是 400 字硬截断**：带 `text_len` 就是说后面还有（`text_more` 是补的那截），
  **拿 400 字当全文去总结就是"看不到就编"**。
- 认人一律用 `username`：`name_in_room` 稀疏且**不能**用来认人，群成员也不止有全局名。
- 通讯录、统计**与聊天正文**含大量他人隐私：**本地处理、不外传**；
  要发给第三方或送去云端分析前先问用户。
  注意本服务**消息面确实会读到正文**（这是它和纯统计工具的区别），别对用户说"它读不到聊天内容"。
