---
name: wechat-crm-mcp
description: 用「微信客户分析 MCP」读取用户本机微信的**通讯录与会话统计**——列好友/群/公众号/企业微信、列群成员、看某人的互动数字、列互动排行与久未联系的人。当用户说「我有哪些客户群」「这个群里都有谁」「我和某某聊得多不多」「谁最久没联系了」「整理一下我的联系人」时使用。只读，只给清单和数字，不做判断。
---

# 微信客户分析 MCP

你通过一个 MCP 服务器读取用户**自己电脑上登录着的微信**的通讯录与互动统计。**只读**。

**它只给清单和数字，不做任何判断**——"这个客户意向高不高""关系好不好"由**你**（模型）拿到
数字后自己分析，工具不会替你下结论。

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

- **Windows + 微信 4.x 已登录并运行**。工具直读本机微信库，**不联网、不外传**。
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
3. **没有标签**：本地库没有好友↔标签映射表（需逆向），所以没有按标签筛选。

## 2. 工具面（4 个）

| 工具 | 用途 |
|---|---|
| `list_contacts(scope?, room?, keyword?, include_deleted?, limit?, offset?)` | 通讯录；`room=` 时列**该群成员**（含 `name_in_room` 与 `name_in_room_with`） |
| `contact_stats(talker, since?, until?)` | 单会话数字：总条数/我发对方发/活跃小时/活跃天 Top/沉默天数 |
| `silence_ladder(scope?, days?, top?)` | **按人**分层：多久没互动 / 从没聊过的人（`never` 桶） |
| `interaction_rank(since?, until?, top?, sort?)` | **按会话**排行；`sort=recent` = 久未联系在前 |

`scope` ∈ `friend`（默认）/ `group` / `official` / `open` / `system` / `all`。

问「谁最久没联系了」**优先用 `silence_ladder`**：`interaction_rank` 只看得见"有你俩消息的会话"，
私聊没说过话、只在群里冒过泡的人它完全看不见（本机 2520 个好友里只有 45 个有 1:1 会话）。

## 3. 一轮完整回路

1. 「我有哪些客户群」→ `list_contacts(scope="group", keyword="客户")`
2. 「这个群里都有谁」→ `list_contacts(room="群名")`（先从上一步拿到确切群名）
3. 「谁最久没联系了」→ `silence_ladder(top=20)`；「哪些人从没聊过」→ 看返回里的 `never` 桶
4. 「哪个会话最活跃」→ `interaction_rank(sort="count")`
5. 「我和某某聊得多不多」→ `contact_stats(talker="某某")`
5. **你要下判断时，把数字摆出来再说结论**（例："近 90 天只有 3 条往来，最后联系在 4 个月前"），
   别只丢一句"关系淡了"。

## 4. 硬约束

- **失败一律长成 `ok: false`**：`{"ok": false, "detail": "发生了什么", "error_code": "...", "stage": "...", "suggestion": "该怎么办"}`。
  **看到 `ok: false` 就是没成功**，别把同一个结果里的其它字段当数据用。按 `error_code` 决定下一步：
  - `target_not_found` —— `talker`/`room` 没对上**唯一**会话。那是「名字没对上」，**不是**「没有数据」；
    `candidates` 里是名字相近的会话，拿它向用户问清是哪一个，**别把 `count: 0` 讲给用户听**。
  - `env_not_ready` —— 微信没就绪（没运行 / 找不到数据目录 / 密钥扫不到）。**不是用户参数的问题**，
    把 `detail` + `hint` 里的动手步骤转告用户（通常是「先打开微信并登录」），**别重试**。
  - `bad_args` —— 参数缺失或取值非法，按 `detail` 改正后重试。

- 工具**不下判断**：不要要求它给"客户价值分"之类的结论（它没有）。
- 群成员只有全局名，**不要**把全局名当成群内称呼去认人。
- 通讯录与统计含大量他人隐私：**本地处理、不外传**；要发给第三方或送去云端分析前先问用户。
