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
claude mcp add wechat-recall -s user -- "C:\完整路径\wechat-recall-mcp.exe"
```

**其它客户端**：
```json
{
  "mcpServers": {
    "wechat-recall": { "command": "C:\\完整路径\\wechat-recall-mcp.exe", "args": [] }
  }
}
```

**⚠️ 关键：必须让守护常驻**，否则看不到任何撤回（见下）。
```bash
wechat-recall-mcp.exe --install-autostart   # 写开机自启，一次即可
wechat-recall-mcp.exe --daemon              # 或手动前台跑
wechat-recall-mcp.exe --status              # 查状态
```

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

- **绝不编造撤回内容**：查不到就说查不到，并说明原因（守护没跑 / 在缺口里 / 早于守护启用）。
- `daemon_status` 里 `backfilled` 为 false 说明打底还没完成——先让用户等它跑完。
- 归档库（`~/.lumii/wechat-recall/archive.db`）含他人隐私：**本地、不外传**。
