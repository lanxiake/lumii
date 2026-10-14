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
claude mcp add wechat-file -s user -- "{{EXE}}"
```

**其它客户端**（Claude Desktop / Cursor / Cline / 自建——都是这份 JSON）：
```json
{
  "mcpServers": {
    "wechat-file": { "command": "{{EXE_JSON}}", "args": [] }
  }
}
```
`command` 必须是 **exe 的绝对路径**（单文件产物，不需要 Python 环境）。
数据目录默认自动探测，探测失败时用 `env.LUMII_WECHAT_DB` 指定。

## 0.5 环境要求与失败处置

- **Windows + 微信 4.x 已登录并运行**。工具直读本机微信库，**不联网、不外传**。
- 出错一律返回**同一形状**：`{"ok": false, "detail", "error_code", "stage", "suggestion"}`。
  **看到 `ok: false` 就是没成功**，别把同一结果里别的字段当数据用。按 `error_code` 分派：
  - `env_not_ready` —— 微信没就绪（没运行 / 找不到数据目录 / 密钥扫不到）。**不是用户参数的问题**：
    把 `detail` + `hint` 里的动手步骤**原话转告用户**（通常是「先打开微信并登录、点开一个会话」），
    **不要重试**。
  - `target_not_found` —— 会话名没对上唯一目标。那是「名字没对上」，**不是**「没有数据」；
    `candidates` 里是名字相近的会话，拿它向用户问清是哪一个，**别把 `count: 0` 讲给用户听**。
  - `bad_args` —— 参数缺失或取值非法，按 `detail` 改正后重试。
  - `internal_error` —— 工具内部出错（bug），此时 `isError=true`；把 `detail` 原话反馈，别自己绕。

## 1. 三条必须先接受的事实

1. **文件可能已经过期**：微信服务器上的文件会过期，过期后本地磁盘没有、**任何工具都救不回来**。
   这类文件 `status=missing`——**如实告诉用户，别承诺能恢复**。
2. **只做拷贝**：归档会把文件复制到用户指定目录，微信原文件原地不动（所以微信里「打开文件」照常能用）。
3. **文件名是线索不是铁证**：同名文件可能是不同版本，服务器用消息里的大小（`totallen`）消歧，
   对不上时给 `status=size_mismatch`——这时**告诉用户可能不是同一份**，别默认当成原文件。

## 2. 工具面（3 个）

| 工具 | 用途 |
|---|---|
| `list_files(talker?, since?, until?, types?, keyword?, only_missing?)` | 列文件消息 + 磁盘定位结果。`only_missing=true` 就是**过期预警** |
| `disk_usage(session_limit?)` | 占用分析：磁盘各子树小计 + 按会话排行 + 无主占用。**只读、只报告，不删任何东西** |
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

**问「微信怎么这么占地方」** → `disk_usage()`。回报时必须守住口径（本机实测数字）：

- `file_own_bytes`（只被一个会话引用的，**删了确实能省**）与 `shared_bytes`（多个会话共用的转发文件，
  **磁盘只占一份，删了不一定省**）**不能相加**当成"能省的空间"——同一份会被数不止一遍
  （实测按会话求和 1039 MB > 磁盘 896 MB）。
- 各会话的 `own_bytes + shared_bytes` 只用来**排序**；要验账请用 `file_own_bytes` /
  `shared_bytes` / `file_unattributed` 这三个总数（`sessions[]` 是被 `session_limit` 截断的）。
- `file_unattributed` 是**没被任何消息引用到**的磁盘文件，归属不了；`msg/video`、`msg/attach`
  只报小计。**别把它们说成"可以清理"**——本工具只读不删，清理是用户自己的事。

## 4. 硬约束

- **失败一律长成 `ok: false`**：`{"ok": false, "detail": "发生了什么", "error_code": "...", "stage": "...", "suggestion": "该怎么办"}`。
  **看到 `ok: false` 就是没成功**，别把同一个结果里的其它字段当数据用。按 `error_code` 决定下一步：
  - `target_not_found` —— `talker`/`room` 没对上**唯一**会话。那是「名字没对上」，**不是**「没有数据」；
    `candidates` 里是名字相近的会话，拿它向用户问清是哪一个，**别把 `count: 0` 讲给用户听**。
  - `env_not_ready` —— 微信没就绪（没运行 / 找不到数据目录 / 密钥扫不到）。**不是用户参数的问题**，
    把 `detail` + `hint` 里的动手步骤转告用户（通常是「先打开微信并登录」），**别重试**。
  - `bad_args` —— 参数缺失或取值非法，按 `detail` 改正后重试。

- 归档**只拷贝**，绝不移动/删除微信原文件。
- `out_dir` 必须由用户指定或确认，别自己挑目录。
- 过期文件（`missing`）**不要**反复重试——服务器端拿不到就是拿不到。
- 文件内容是用户与他人的隐私：**本地处理，不做任何外传**（别把文件内容送去云端）。
