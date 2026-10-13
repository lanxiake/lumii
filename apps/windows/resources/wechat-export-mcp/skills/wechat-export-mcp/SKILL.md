---
name: wechat-export-mcp
description: 用「微信记录导出 MCP」把用户本机微信里某个会话的聊天记录导出成文件——Markdown/HTML/JSON，可选连图片与语音。当用户说「导出我和某某的聊天记录」「把某个群的聊天记录存下来」「聊天记录整理成文档」「导出成 HTML 发给别人看」时使用。只读微信，不改动任何微信数据。
---

# 微信记录导出 MCP

你通过一个 MCP 服务器读取用户**自己电脑上登录着的微信**里某个会话的聊天记录，
把它导出成能读、能分享、能归档的文件。**只读**——不发送、不修改任何微信内容。

## 0. 装（客户端侧一次配好即可）

把本目录放进客户端的 skills 目录，然后注册 MCP 服务器：

**Claude Code**：
```bash
claude mcp add wechat-export -s user -- "{{EXE}}"
```

**其它客户端**：
```json
{
  "mcpServers": {
    "wechat-export": { "command": "{{EXE_JSON}}", "args": [] }
  }
}
```
`command` 必须是 **exe 的绝对路径**（单文件产物，不需要 Python 环境）。

## 0.5 环境要求与失败处置

- **Windows + 微信 4.x 已登录并运行**。工具直读本机微信库，**不联网、不外传**。
- 出错一律返回**同一形状**：`{"ok": false, "detail", "error_code", "stage", "suggestion"}`。
  **看到 `ok: false` 就是没成功**，别把同一结果里别的字段当数据用。按 `error_code` 分派：
  - `env_not_ready` —— 微信没就绪（没运行 / 找不到数据目录 / 密钥扫不到）。**不是用户参数的问题**：
    把 `detail` + `hint` 里的动手步骤**原话转告用户**（通常是「先打开微信并登录、点开一个会话」），
    **不要重试**。
  - `target_not_found` —— 会话名没对上唯一目标。那是「名字没对上」，**不是**「没有数据」；
    `candidates` 里是名字相近的会话，拿它向用户问清是哪一个，**别把 `count: 0` 讲给用户听**。
  - `bad_args` —— 参数缺失或取值非法（含 `format`/`media`/`split` 传了枚举外的值）；
    `invalid` 会列出具体哪几个，按 `detail` 改正后重试。
  - `internal_error` —— 工具内部出错（bug），此时 `isError=true`；把 `detail` 原话反馈，别自己绕。

## 1. 三条必须先接受的事实

1. **导出的是本地已有的记录**：更早的历史可能已被微信滚出本机，导不出来就是导不出来，
   **别承诺"全部记录"**——先导出再说条数。
2. **只读**：导出不影响微信里的任何东西。
3. **语音转写需要本机模型**：`transcribe_voice=true` 在没装识别模型的机器上会**逐条失败并计数**，
   导出本身不受影响。所以默认 `false`；用户明确要转写时再开，并如实报告有多少条没转成。

## 2. 工具面（2 个）

| 工具 | 用途 |
|---|---|
| `list_sessions(query?)` | 列会话拿确切名字/talker（不确定会话名时先用它） |
| `export_chat(talker, out_dir, format?, since?, until?, media?, transcribe_voice?, split?)` | 导出 |

`format`：`md`（默认，人读）/ `html`（可分享，带样式）/ `json`（机读）。
`media`：`none`（默认只文字）/ `images`（+图片）/ `all`（+图片+语音 wav）。
`split`：`none`（默认单文件）/ `month`（按月拆子目录，记录多时用）。

## 3. 一轮完整回路

1. 用户说「把我和张三的聊天记录导出来」→
   `list_sessions(query="张三")` 拿到确切的 `talker`。
2. 问清**存到哪**、要不要带图片。
3. `export_chat(talker=..., out_dir="D:\\导出\\张三", format="md")`
4. 回报：导出多少条、落在哪个文件、体积；若带媒体，报告成功与跳过数。

**记录很多**（几百条以上或横跨数月）时用 `split="month"`。
**要给不装微信的人看**时用 `format="html"`（单文件、可双击打开、带图片）。

## 4. 硬约束

- **失败一律长成 `ok: false`**：`{"ok": false, "detail": "发生了什么", "error_code": "...", "stage": "...", "suggestion": "该怎么办"}`。
  **看到 `ok: false` 就是没成功**，别把同一个结果里的其它字段当数据用。按 `error_code` 决定下一步：
  - `target_not_found` —— `talker`/`room` 没对上**唯一**会话。那是「名字没对上」，**不是**「没有数据」；
    `candidates` 里是名字相近的会话，拿它向用户问清是哪一个，**别把 `count: 0` 讲给用户听**。
  - `env_not_ready` —— 微信没就绪（没运行 / 找不到数据目录 / 密钥扫不到）。**不是用户参数的问题**，
    把 `detail` + `hint` 里的动手步骤转告用户（通常是「先打开微信并登录」），**别重试**。
  - `bad_args` —— 参数缺失或取值非法，按 `detail` 改正后重试。

- `talker` 不唯一时**不要猜**——用 `list_sessions` 让用户确认，导错会话就是把别人的私聊给了用户。
- `out_dir` 由用户指定，别自己挑目录。
- 记录含他人隐私：**本地导出**。要发给第三方或送去云端分析前**先问用户**（如实说明那是外传）。
