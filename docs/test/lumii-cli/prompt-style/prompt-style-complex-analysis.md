# 提示词风格实验 P2：复杂任务双档实测分析（2026-09-13）

> 执行器：[run-prompt-style-complex.mjs](./run-prompt-style-complex.mjs)（CLI 驱动真实客户端 + 真实 LLM，无 SQL 播种）
> 原始数据：[prompt-style-complex-traces.json](./prompt-style-complex-traces.json)（完整工具轨迹）·
> [prompt-style-complex-evidence.jsonl](./prompt-style-complex-evidence.jsonl) · [prompt-style-complex-report.md](./prompt-style-complex-report.md)
> 被测代码：P2 完成态（`feat/prompt-style-experiment`；客户端 18:15 重建加载 P2 bundle）
> 重建方式：`node run-prompt-style-complex.mjs`（环境变量 `PC_ONLY / PC_NO_RESTORE / PC_TURN_TIMEOUT_MS`）

## 一、场景与干净数据（18:31–18:34，双档各一轮）

### PC-C1 文件工具链（建目录→示例文件→stats.py→运行→report.md）

| 档 | 调用数 | 工具序列 | 耗时 | 提示词 | 产物 |
|---|---|---|---|---|---|
| detailed | 15 | todo×6, file_write×5, bash×2, glob, task_complete | 39.3s | 33690 | stats.py + report.md ✓ |
| terse | 14 | todo×3, file_write×7, bash×1, list_dir×2, task_complete | 41.6s | 18223 | stats.py + report.md ✓ |

### PC-C2 调研简报（web_search → 3 条 → 落盘工作区）

| 档 | 调用数 | 工具序列 | 耗时 | 提示词 | 产物 |
|---|---|---|---|---|---|
| detailed | 12 | web_search×5, web_fetch×4, file_write, file_edit, task_complete | 39.9s | 33690 | `ai-coding-tools-brief-20260913.md`（outputs 根，1640 字符） |
| terse | 6 | web_search×3, web_fetch, file_write, task_complete | 34.3s | 18220 | `ai-coding-brief/AI编程工具动态简报-20260913.md`（任务子目录，1692 字符） |

### PC-C3 技能命中（查北京天气）

| 档 | 调用数 | 工具序列 | 耗时 | 提示词 | 结果 |
|---|---|---|---|---|---|
| detailed | 1 | web_fetch | — | 33690 | 直接抓取拿到温度（回答正确）；未走技能链 → 严格断言判 FAIL（误伤，见 §二.5） |
| terse | 2 | web_search, bash | 22.6s | 18742 | 搜索 + bash（curl）→ 温度 ✓ |

## 二、结论

1. **任务完成度双档等效**：6 轮真实任务全部落地（产物硬断言 5/6 + 1 例断言误伤），复杂多步链路（计划→写文件→运行→产出报告）两档均完整闭环。
2. **工具使用无退化**：两档都正确使用 todo 计划 + file 工具 + bash 运行 + task_complete；调用总量相当（C1：15 vs 14），terse 在 C2 更精炼（6 vs 12，详细档多做了 4 次 web_fetch 与 1 次改写）。terse 把简报放进了任务子目录、详细档放在 outputs 根——路径纪律上 terse 反而更贴 `fileOutput` 规范（单样本，不作定论）。
3. **提示词体量**：同一任务 terse 18220–18742 vs detailed 33690 → **−45%±1**（真实主助手上下文，含记忆/团队等全量内容）。
4. **技能系统未被触发（双档）**：C3 两档都没有走 `skill_search/skill_invoke`，而是 web_fetch / web_search+bash 直达结果。原因推测：天气任务可直接由通用工具完成，未触发"成套任务"的 skill 检索路径；且 terse 档技能列表仅列 top-12 名称（weather 可能不在列）。**观察项，非退化证据**（n 过小）；后续若要验证技能命中，应构造领域强绑定、通用工具难以替代的任务。
5. **C3-detailed 的 FAIL 属断言过严**：它用 `web_fetch` 直连 wttr.in 拿到温度——与技能文档描述的方法等价，属合理手段。断言未纳入 web_fetch 路径，记录为执行器已知误报（后续修断言或改软信号）。

## 三、观测器修复记录（首轮数据作废原因，供后续 CLI 套件复用）

1. **工具 part 结构与假设不符**：工具调用存于 `contentJson.parts`（JSON 字符串）内，类型为 `type:'tool'` + `name/args/result`；且一个回合的 parts 可能被拆分为多条 assistant 消息——只取"最后一条 assistant"会漏前置调用。修复：`fullToolTrace()` 遍历全部 assistant 消息。
2. **`sendAndWait` 提前返回**：该 harness 判定为"文本段两次轮询稳定"，但模型常先输出文本段再继续工具循环 → 回合未结束套件就继续，导致清理与模型写盘互相踩踏（首轮出现 32 次调用的"污染轨迹"与残留文件）。修复：新增 `waitSessionIdle()`（会话列表 `hasRunning=false` 连续 3 次确认）作为回合真正结束信号。
3. **清理加固**：C1 自底向上剪空目录（模型自建 `sub/` 等）；C2 删文件后回收空父目录（止于 outputs 根）。

> 结论：本套件以"完成度硬断言 + 手段软信号"为原则；工具序列用于双档对照分析，不做单一手段判死。
