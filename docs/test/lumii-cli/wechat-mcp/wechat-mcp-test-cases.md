# 微信 MCP 集成 · CLI E2E 测试用例（WM 套件）

> 驱动方式：**全部经 `lumii-ui` CLI** 驱动真实运行的客户端 + 真实 LLM；微信侧断言用
> `apps/windows/resources/wechat-mcp/devcli.py`（只读、固定动作脚本，不经 LLM）。
> 规范：[`../CLI-TEST-SPEC.md`](../CLI-TEST-SPEC.md) ｜ Runner：[`run-wechat-mcp-e2e.mjs`](./run-wechat-mcp-e2e.mjs)

## 背景

Lumii 通过本机 **MCP server**（`apps/windows/resources/wechat-mcp/`）给 Agent 提供微信读/写能力：
- 读：`list_sessions` / `read_history` / `poll_new`（不需微信窗口）
- 环境：`check_env`（进程/窗口/可见/最小化/前台/尺寸·比例/DPI）
- 写：`send_text`（**默认 dry-run**；真发需显式 `dry_run=false`；四道 fail-closed 校验）

**红线**：探针消息只发到「文件传输助手」（自己给自己），不打扰任何他人；会话统一 `[wechat-mcp]` 前缀。

## 用例

| ID | 目标 | 判据 | 断言方式 |
|---|---|---|---|
| WM-00 | 预检 | Lumii 在运行 + 微信进程在运行 + 窗口 ok | CLI `status` / `devcli status` |
| WM-01 | 工具注册 | `tools list` 含 ≥5 个 `mcp__wechat-local__*` 且全部 enabled | CLI `tools list` |
| WM-02 | 环境检查 | `check_env` 返回 ok=true 且字段齐全（进程/可见/最小化/前台/尺寸/比例/DPI） | 直接调工具 |
| WM-03 | Agent 读会话 | 让 Agent 调 `list_sessions`，回复含「文件传输助手」 | 真实 LLM 回合 |
| WM-04 | Agent 读历史 | 让 Agent 调 `read_history(filehelper,3)`，回复含库内最近一条消息 | 真实 LLM 回合 + 库比对 |
| WM-05 | **dry-run 不应发出去** | Agent 调 `send_text(dry_run=true)` → 报成功；**全库扫描标记 0 命中** | 真实 LLM 回合 + `devcli scan` |
| WM-06 | **真发送应落库** | Agent 调 `send_text(dry_run=false)` → 轮询库内出现该标记 | 真实 LLM 回合 + `devcli history` |
| WM-07 | **fail-closed** | 目标不存在 → Agent 报失败；**全库扫描标记 0 命中** | 真实 LLM 回合 + `devcli scan` |
| WM-08 | 回归 | 普通聊天（不涉微信工具）仍正常回复 | 真实 LLM 回合 |
| WM-09 | **环境不满足应拒绝** | 把微信**最小化** → 发送被拒（`ok=false`，理由含「最小化」）且**无新消息落库**；结束后自动还原窗口 | `devcli status/send` + 时间戳基线 |
| WM-10 | Agent 发**图片** | 让 Agent 调 `send_file(path=*.png)` → 库内出现 **type=3（图片）** 新消息 | 真实 LLM 回合 + 库内消息类型 |
| WM-11 | Agent 发**文件** | 让 Agent 调 `send_file(path=*.txt)` → 库内出现 **type=49（附件）** 新消息 | 真实 LLM 回合 + 库内消息类型 |
| WM-12 | **会话定位** | 让 Agent 调 `list_sessions(query="测试")` → 回复里含「测试微信群」与其 talker（`50313322756@chatroom`） | 真实 LLM 回合 + 会话名/talker |
| WM-13 | **稳定错误码** | 让 Agent 向不存在的会话发消息 → 返回含稳定 `error_code=target_not_found` | 真实 LLM 回合 + 工具返回串 |
| WM-14 | **并发互斥** | 进程内先拿 UI 锁 → 再次 `_acquire_ui` 返回 `None`（busy）→ 释放后可重入 | 直接驱动 `wechat_sender`（确定性，不走 LLM） |
| WM-15 | **批量发送演练** | 让 Agent 调 `send_batch(dry_run=true)` → 报成功但**库内无痕** | 真实 LLM 回合 + 全库扫描 |
| WM-16 | **群/单聊结构反证** | 合成行数据直接驱动 `verify_target`：目标单聊却开着群、目标群却开着单聊 → **两个方向都返回 `False`** | 直接驱动 `wechat_sender`（确定性，不走 LLM/UI） |
| WM-17 | **引用回复演练** | 让 Agent 调 `reply_to(quote,talker,text,dry_run=true)` → 报成功（已引用并填入）但**库内无痕** | 真实 LLM 回合 + 全库扫描 |

## 为什么这样断言

- **WM-05 / WM-07 用「全库扫描」**：这是唯一能证明「消息真的没发出去」的方法——
  只看工具返回 `ok=false` 不够（可能返回失败但已发出），必须扫微信库确认无痕。
- **WM-06 用轮询**：微信落库有延迟（实测数秒），不能立刻断言。
- **WM-03/04 断言关键字而非全文**：LLM 措辞会变，只校验「确实读到了」的关键信号。

## 运行

```bash
# 全量
node docs/test/lumii-cli/wechat-mcp/run-wechat-mcp-e2e.mjs
# 选择性子集
WM_ONLY=WM-05,WM-06 node docs/test/lumii-cli/wechat-mcp/run-wechat-mcp-e2e.mjs
```

环境变量：`WM_ONLY`、`WM_TURN_TIMEOUT_MS`（默认 240000）、`LUMII_WECHAT_PYTHON`（默认 `python`）。

## 已知限制（未纳入自动用例）

- 发送依赖固定窗口尺寸（1280×820）与 OCR；换显示器/DPI 后需重新实测锚点。
- 「窗口不可用时拒绝」已用 **WM-09** 覆盖（程序化最小化→断言拒绝→还原）。
  但**锁屏 / 切换虚拟桌面**这类状态无法在不打断当前会话的前提下模拟，仍未覆盖。
