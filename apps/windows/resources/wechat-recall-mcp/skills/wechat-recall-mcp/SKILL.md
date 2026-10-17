---
name: wechat-recall-mcp
description: 用「微信撤回防护 MCP」查看用户本机微信里**被撤回/被删除**的消息。当用户说「他刚才撤回的是什么」「谁撤回了消息」「被删掉的那条说了啥」「看看群里撤回的内容」时使用。只读，不改动任何微信数据；能否看到取决于守护进程有没有在撤回之前就已运行。
---

# 微信撤回防护 MCP

你通过一个 MCP 服务器查看用户**自己电脑上登录着的微信**里被撤回/删除的消息。
**只读**——不改动任何微信数据。

## 0. 装（客户端侧一次配好即可）

把本目录放进客户端的 skills 目录，然后注册 MCP 服务器：

**Claude Code**：
```bash
claude mcp add wechat-recall -s user -- "{{EXE}}"
```

**其它客户端**：
```json
{
  "mcpServers": {
    "wechat-recall": { "command": "{{EXE_JSON}}", "args": [] }
  }
}
```

**⚠️ 关键：必须让守护常驻**，否则看不到任何撤回（见下）。
```bash
wechat-recall-mcp.exe --install-autostart   # 写开机自启，一次即可
wechat-recall-mcp.exe --daemon              # 或手动前台跑
wechat-recall-mcp.exe --status              # 查状态
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
  - `target_not_found` —— 会话名没对上唯一目标。那是「名字没对上」，**不是**「没有撤回」；
    `candidates` 里是名字相近的会话，拿它向用户问清是哪一个，**别把 `count: 0` 讲给用户听**。
  - `bad_args` —— 参数缺失或取值非法，按 `detail` 改正后重试。
  - `not_archived` —— 归档里没有这条消息。**不是**「没撤回」：守护当时没在跑。用
    `daemon_status()` / `archive_gap()` 看覆盖情况，并如实告诉用户「那段没留档」。
  - `internal_error` —— 工具内部出错（bug），此时 `isError=true`；把 `detail` 原话反馈，别自己绕。

## 1. 三条必须先接受的事实（**说给用户听**）

1. **这是"事前留存"，不是"读库翻历史"**：微信把撤回的原消息**从本地库里删掉了**
   （实测：原消息行消失、且撤回通知里**没有**被撤回消息的 id），所以**只有守护在撤回发生之前
   已经在跑，才看得到**。守护启动前的撤回、或关机期间的撤回，**看不了也补不回来**。
2. **归档只写一次、永不覆盖**，所以撤回前的原文留得住；但**没跑守护的时间段是黑洞**。
3. **只读**：不影响微信里的任何东西。

## 2. 工具面（4 个）

| 工具 | 用途 |
|---|---|
| `daemon_status()` | 守护在不在跑、归档多少条、有没有停机缺口、是否已开机自启 |
| `list_recalls(talker?, since?, until?, limit?)` | 看被撤回/删除的消息（`reason`：`deleted`/`recalled`/`changed`） |
| `read_recall(talker, local_id)` | 取某条撤回消息的**完整原文** |
| `archive_gap()` | 查归档漏记的时间段（关机等） |

## 3. 一轮完整回路

1. 用户说「张三刚才撤回的是什么」→
   **先 `daemon_status()`**。
2. `alive=false` 或 `archived=0` → **直接告诉用户守护没在跑，现在看不到**，
   并给出开启方法（`--install-autostart`）。**不要假装查到了**。
3. `alive=true` → `list_recalls(talker="张三")`；要原文再 `read_recall`。
4. 若 `archive_gap()` 显示有缺口，且撤回时间落在缺口里 → 如实说明"那段没归档，看不到"。

## 4. 硬约束

- **失败一律长成 `ok: false`**：`{"ok": false, "detail": "发生了什么", "error_code": "...", "stage": "...", "suggestion": "该怎么办"}`。
  **看到 `ok: false` 就是没成功**，别把同一个结果里的其它字段当数据用。按 `error_code` 决定下一步：
  - `target_not_found` —— `talker`/`room` 没对上**唯一**会话。那是「名字没对上」，**不是**「没有数据」；
    `candidates` 里是名字相近的会话，拿它向用户问清是哪一个，**别把 `count: 0` 讲给用户听**。
  - `env_not_ready` —— 微信没就绪（没运行 / 找不到数据目录 / 密钥扫不到）。**不是用户参数的问题**，
    把 `detail` + `hint` 里的动手步骤转告用户（通常是「先打开微信并登录」），**别重试**。
  - `bad_args` —— 参数缺失或取值非法，按 `detail` 改正后重试。

- **绝不编造撤回内容**：查不到就说查不到，并说明原因（守护没跑 / 在缺口里 / 早于守护启用）。
- `daemon_status` 里 `backfilled` 为 false 说明打底还没完成——先让用户等它跑完。
- 归档库（`~/.lumii/wechat-recall/archive.db`）含他人隐私：**本地、不外传**。
