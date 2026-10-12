---
name: wechat-file-mcp
description: 用「微信文件归档 MCP」操作用户本机的微信**文件**——列出文件传输助手/好友/群里收发的文件、把它们归档到本地目录、报告已过期下不动的文件。当用户说「整理文件传输助手」「把某个群的文件存下来」「微信里的文件导出到电脑」「哪些文件已经过期了」时使用。只读微信、只做拷贝（不改任何微信数据）。
---

# 微信文件归档 MCP

你通过一个 MCP 服务器读取用户**自己电脑上登录着的微信**里的**文件消息**，把它们归档到本地目录。
服务器只读微信、只做拷贝——**不会**移动或删除微信里的任何东西。

## 0. 装（客户端侧一次配好即可）

把本目录放进客户端的 skills 目录（Claude Code：`~/.claude/skills/` 或 `<项目>/.claude/skills/`），
然后注册 MCP 服务器：

**Claude Code**：
```bash
claude mcp add wechat-file -s user -- "C:\完整路径\wechat-file-mcp.exe"
```

**其它客户端**（Claude Desktop / Cursor / Cline / 自建——都是这份 JSON）：
```json
{
  "mcpServers": {
    "wechat-file": { "command": "C:\\完整路径\\wechat-file-mcp.exe", "args": [] }
  }
}
```
`command` 必须是 **exe 的绝对路径**（单文件产物，不需要 Python 环境）。
数据目录默认自动探测，探测失败时用 `env.LUMII_WECHAT_DB` 指定。

## 1. 三条必须先接受的事实

1. **文件可能已经过期**：微信服务器上的文件会过期，过期后本地磁盘没有、**任何工具都救不回来**。
   这类文件 `status=missing`——**如实告诉用户，别承诺能恢复**。
2. **只做拷贝**：归档会把文件复制到用户指定目录，微信原文件原地不动（所以微信里「打开文件」照常能用）。
3. **文件名是线索不是铁证**：同名文件可能是不同版本，服务器用消息里的大小（`totallen`）消歧，
   对不上时给 `status=size_mismatch`——这时**告诉用户可能不是同一份**，别默认当成原文件。

## 2. 工具面（2 个）

| 工具 | 用途 |
|---|---|
| `list_files(talker?, since?, until?, types?, keyword?, only_missing?)` | 列文件消息 + 磁盘定位结果。`only_missing=true` 就是**过期预警** |
| `archive_files(out_dir, talker?, since?, until?, types?, layout?, dry_run?)` | 拷贝归档。`dry_run=true`（默认）只出计划 |

`list_files` 每条返回：`title` / `size` / `ext` / `ts` / `name`(会话) / `sender` / `local_path` / `status`。
`status`：`ok` 可归档 / `size_mismatch` 同名大小不符 / `missing` 过期或未下载。

## 3. 一轮完整回路

1. 用户说「整理文件传输助手」→
   `list_files(talker="文件传输助手")`
2. 回报数量与过期情况（`missing` 有多少），问清**存到哪**。
3. `archive_files(out_dir="D:\\wechat-files\\助手", talker="文件传输助手", dry_run=true)`
   → 把计划（copied/dedup/missing 计数）报给用户确认。
4. 确认后 `dry_run=false` 真归档，回报落盘目录与文件数。

**默认先 dry_run**——真归档前给用户看一眼计划。

## 4. 硬约束

- **会话名对不上要问，不要当空结果**：`talker`/`room` 解析不出**唯一**目标时返回 `error_code=target_not_found`——那是「名字没对上」，**不是**「没有数据」。换成确切会话名或 wxid/群号再试；**别把 `count: 0` 直接讲给用户听**。

- 归档**只拷贝**，绝不移动/删除微信原文件。
- `out_dir` 必须由用户指定或确认，别自己挑目录。
- 过期文件（`missing`）**不要**反复重试——服务器端拿不到就是拿不到。
- 文件内容是用户与他人的隐私：**本地处理，不做任何外传**（别把文件内容送去云端）。
