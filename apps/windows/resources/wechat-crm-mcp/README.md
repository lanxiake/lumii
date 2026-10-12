# wechat-crm-mcp · 微信客户分析

一个 **stdio MCP server**：读取本机微信的**通讯录与会话统计**——好友/群/公众号/企业微信、
群成员、单会话互动数字、互动排行。

**只出取数与统计，不出判断**："这个客户意向高不高"交给接入方的 LLM + 技能包。

**只读**：读层直读 SQLCipher4（密钥从进程内存**只读**扫描取，不注入、不改微信数据）。

> ⚠️ 仅用于**你自己的账号、你自己的机器**。通讯录与统计涉及大量他人隐私——**本地、不外传**。

## 装

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

## 工具（3 个）

| 工具 | 说明 |
|---|---|
| `list_contacts(scope?, room?, keyword?, include_deleted?, limit?, offset?)` | 通讯录；`room=` 时列该群成员。默认只回 200 条，看 `total` 判断有没有被截断，用 `offset` 接着翻 |
| `contact_stats(talker, since?, until?)` | 单会话：总条数 / 我发对方发 / 活跃小时 / 活跃天 Top / 首末 / 跨度 / 沉默天数 |
| `interaction_rank(since?, until?, top?, sort?)` | 互动排行；`sort=recent` = 久未联系在前 |

`talker` / `room` 传会话**显示名**（如「文件传输助手」）或 wxid/群号都可以；解析不出唯一目标时
返回 `error_code=target_not_found`（**不是**"你俩没聊过"——那个"0 条"是能骗过模型的）。

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
