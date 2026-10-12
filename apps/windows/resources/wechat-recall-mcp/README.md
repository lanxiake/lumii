# wechat-recall-mcp · 微信撤回防护

查看本机微信里**被撤回 / 被删除**的消息。

**先说清原理**（这决定了它能做什么、不能做什么）：**撤回后原消息会从微信本地库里消失**
——实测 114 条撤回通知里，原消息的行被删掉/改写，且通知里**没有**被撤回消息的 id。
所以这不是"读库翻历史"，而是**事前留存**：一个常驻守护把新消息持续留档，撤回后拿归档与
当前库对差。**守护没跑之前发生过的撤回，看不到。**

**只读**——不改动任何微信数据。

## 装

```json
{
  "mcpServers": {
    "wechat-recall": { "command": "C:\\你\\的\\路径\\wechat-recall-mcp.exe", "args": [] }
  }
}
```

### ⚠️ 必须让守护常驻（否则查不到任何撤回）

```bash
wechat-recall-mcp.exe --install-autostart   # 写 HKCU Run，开机自启（一次即可）
wechat-recall-mcp.exe --daemon              # 或手动前台跑（--interval 30 可调）
wechat-recall-mcp.exe --status              # 查状态（归档条数 / 水位 / 缺口 / 自启）
wechat-recall-mcp.exe --uninstall-autostart
```

- 独立 exe：`dist/wechat-recall-mcp.exe`（**单文件双身份**：不带参数= MCP server，带 `--daemon` = 守护）。
- 源码：`python server.py`（MCP）/ `python daemon.py --daemon`（守护）。
- 归档库：`~/.lumii/wechat-recall/archive.db`（可用 `env.LUMII_WECHAT_RECALL_DB` 改）。
- **改 py 代码要重新构建 exe**：`pnpm --filter ./apps/windows build:wechat-recall-mcp`。

技能包：[`skills/wechat-recall-mcp/SKILL.md`](skills/wechat-recall-mcp/SKILL.md)。

## 工具（4 个）

| 工具 | 说明 |
|---|---|
| `daemon_status()` | 守护在不在跑 / 归档条数 / 水位 / 缺口数 / 是否已自启 |
| `list_recalls(talker?, since?, until?, limit?)` | 被撤回/删除的消息（`reason`：`deleted`/`recalled`/`changed`） |
| `read_recall(talker, local_id)` | 取某条撤回消息的完整原文 |
| `archive_gap()` | 归档漏记的时间段（关机等）——**如实报告，不假装全覆盖** |

## 怎么工作的

```
   微信 ──写库──▶  守护进程（常驻，poll 增量 → 归档库）
                          │  INSERT OR IGNORE：只写一次，永不覆盖 ⇒ 原文留得住
                          ▼
        ~/.lumii/wechat-recall/archive.db   (SQLite)
                          ▲
                   MCP 前台（stdio）只读，并与当前微信库对差
```

**判定规则**（对两种撤回机制都成立——删行 / 原地改写）：
按 `(talker, local_id)` 分组比较**内容变体集合**：
- 归档有、当前完全没有该 `local_id` → `deleted`
- 变体不同、当前变体是系统消息 → `recalled`
- 变体不同、其它 → `changed`

**为什么用变体集合而不是直接比 id**：实测 `local_id` 在每个会话内唯一（70 个表零重复），
但跨分片理论上可能撞号；按变体集合比对，撞号时两侧一致 → 不误报（有专门单测兜）。

**打底与缺口**：首次启动做一次全量打底（本机实测 4637 条 / 70 会话 / 约 3 秒），
之后每 30s 增量（每次多回扫 5 分钟接住异步落库的晚到行，`INSERT OR IGNORE` 保证幂等）。
停机超过 3 个周期就落一条 `gap`。

## 不支持的

- **守护启动之前**、或**关机期间**发生的撤回（那是黑洞，补不回来）。
- **阻止**撤回（只事后查看）。
- 替「文件归档」备份被撤回的**文件本体**（那是 `wechat-file-mcp` 的事）。

## 文件

| 文件 | 作用 |
|---|---|
| `server.py` | MCP 入口（stdio JSON-RPC）+ 4 个只读工具；带 `--daemon` 等开关时转发给守护 |
| `archive.py` | 归档库（SQLite schema / 写入 / 撤回判定 / 缺口） |
| `daemon.py` | 常驻守护：打底 + 增量 + 心跳 + 开机自启 |
| `test_recall.py` | 单测（合成库验两种撤回机制 + 假阳性防护 + 真机只读打底冒烟） |
| `skills/wechat-recall-mcp/SKILL.md` | 给别的 AI 客户端看的技能包 |

**共享基础层**：读取层直接复用 `../wechat-mcp/` 的模块（经 `archive.py`），本包**不复制**——详见
`docs/design/渠道与CLI/2026-10-12-微信小工具MCP四件套设计.md`。

自检：`python test_recall.py`。
