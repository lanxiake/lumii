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
wechat-recall-mcp.exe --daemon --retain-days 365   # 可选：只留一年（默认 0 = 永不删）
wechat-recall-mcp.exe --status              # 查状态（归档条数 / 体积 / 缺口 / 自启）
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
| `daemon_status()` | 守护在不在跑 / 归档条数 / **体积** / 最早·最新一条 / 缺口数 / 是否已自启 |
| `list_recalls(talker?, since?, until?, limit?)` | 被撤回/删除的消息（`reason`：`deleted`/`recalled`/`changed`）。`total` 是命中总数，与 `count` 不等说明被截断 |
| `read_recall(talker, local_id)` | 取某条撤回消息的完整原文 |
| `archive_gap()` | 归档漏记的时间段（关机/休眠）——**如实报告，不假装全覆盖** |

`talker` 传会话**显示名**（如「文件传输助手」）或 wxid/群号都可以。

## 守护怎么管

| 想干什么 | 命令 |
|---|---|
| 前台跑一会儿（看它到底在干嘛） | `wechat-recall-mcp.exe --daemon` |
| 开机自启 | `wechat-recall-mcp.exe --install-autostart` |
| 只停守护，留着自启 | `wechat-recall-mcp.exe --stop` |
| 关掉自启**并停掉守护** | `wechat-recall-mcp.exe --uninstall-autostart` |
| 看状态 | `wechat-recall-mcp.exe --status`（或用 MCP 的 `daemon_status` 工具） |

- **守护会自愈**：崩溃后自己重启（退避 5s→300s 封顶）并记日志。它挂了 = 那段时间的撤回
  **永久查不到**，所以不让它死是硬要求。
- **不会双开**：再起一个会当场认出"已经有一个在跑"并自己退出（两个一起写库会互相打架）。
- **停止是优雅的**：`--stop` 发的是信号，守护在 `finally` 里记完停机时间才退，不是杀进程。
- **日志**：`~/.lumii/wechat-recall/daemon.log`（512KB 滚动一代）。自启动拉起的守护**没有控制台**，
  出问题就看这个文件。

状态里的 `running` 和 `alive` 要**一起看**：`running` 是进程在不在（最准），`alive` 是心跳新不新。
刚崩的守护心跳还没过期 → `alive=true` 但 `running=false`；卡住的守护两个都真 → `running=true` 但
`alive=false`。

## 失败长什么样

任何失败都是**同一个形状**（四件套一致，也和 wechat-mcp 一致）：

```json
{"ok": false, "detail": "发生了什么", "error_code": "target_not_found",
 "stage": "target", "suggestion": "该怎么办", "candidates": [...]}
```

**看到 `ok: false` 就是没成功**——别把同一个结果里的其它字段当数据用。

| `error_code` | 含义 | 该怎么办 |
|---|---|---|
| `target_not_found` | 会话名没对上**唯一**目标 | 这是「名字没对上」，**不是**「没有撤回」；`candidates` 里是相近的会话，挑一个或问用户 |
| `env_not_ready` | 微信没就绪（没运行 / 找不到数据目录 / 密钥扫不到） | 看 `detail` + `hint` 的动手步骤（通常是「先打开微信并登录」），**不是**参数问题，别重试 |
| `bad_args` | 参数缺失或取值非法 | 按 `detail` 改正后重试 |
| `not_archived` | 归档里没有这条消息 | **不是**「没撤回」——守护当时没在跑。用 `daemon_status()` / `archive_gap()` 看覆盖情况 |
| `internal_error` | 工具内部出错（bug），此时 `isError=true` | 把 `detail` 原文反馈给开发者 |

`stage` 说的是**卡在哪一道**（`env` / `target` / `args` / `data` / `internal`），
让你一眼看出是环境的锅还是参数的锅。

## 故障排查

| 现象 | 原因与处置 |
|---|---|
| `env_not_ready`：未找到微信数据目录 | 确认微信**已登录**；在微信「设置 → 文件管理」看数据目录；仍不行就设 `LUMII_WECHAT_DB=<数据目录>\xwechat_files\<账号>_<4位>\db_storage` |
| `env_not_ready`：未能从微信进程内存取到数据库密钥 | 打开微信并登录、点开一个会话等几秒再试；仍不行多半是微信版本超出已验证范围（见 `wechat_core.VERIFIED_VERSION_PREFIXES`） |
| `list_recalls` 空，但用户说"明明撤回过" | 先看 `daemon_status()`：守护**没在跑**就什么都存不下来（撤回是**事后读取**看不到的，必须事前留存）；再看 `archive_gap()` 是不是正好覆盖那段时间（关机/休眠） |
| `daemon_status()` 说守护没跑 | 装自启：`wechat-recall-mcp.exe --install-autostart`；或手动 `--daemon` 起一个 |
| 守护好像一直在重启 | 看 `~/.lumii/wechat-recall/daemon.log`：每行都带原因（崩溃退避重启、每拍出错、双开被拒都在里面） |
| 归档库越来越大 | `--retain-days N` 定期修剪（默认 **0 = 永不删**）；修剪只在每日全量那一拍做，顺手 VACUUM |

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

**打底与缺口**：首次启动做一次全量打底（本机实测 4696 条 / 70 会话 / 约 5 秒），
之后每 30s 增量（每次多回扫 5 分钟接住异步落库的晚到行，`INSERT OR IGNORE` 保证幂等）。
每拍都会看"上一拍距今多久"，超过 3 个周期就落一条 `gap`——**休眠不会让守护退出**
（`time.sleep` 只是被挂起），只在开机时查一次的话，睡过去那段就是静默漏记。

**每 24h 回头做一次全量对账**：增量只捞 `create_time > 水位 - 5 分钟`，而"落库晚、时间戳却更老"
的行（换机/重新登录时微信补历史、离线消息成批落库）永远进不来；打底只做一次是补不上这个洞的。

**归档库只增不减**，所以要控体积得自己指定：`--retain-days N`（默认 **0 = 永不删**）会在每天
全量对账那一拍删掉 N 天前的归档并压实文件。代价是**如实存在的**——删掉的那段，之后发生的
撤回/删除就查不到了。`daemon_status()` 的 `db_bytes` 能看出它涨多快（本机 4696 条 ≈ 1.9 MB）。

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
