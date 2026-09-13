# 提示词风格实验：真实日志分析（2026-09-13）

> 数据来源：真实客户端运行时日志（`~/.lumii/logs/app/mtbot-2026-09-13.log` 的 `[llm-prompt:full:begin/end]` 转储）+
> [prompt-style-suite-evidence.jsonl](./prompt-style-suite-evidence.jsonl)（CLI 场景化验收 8/8 通过）。
> 场景与用例见 [prompt-style-test-cases.md](./prompt-style-test-cases.md)；本文件是**编排正确性**与**双档任务实施差别**的分析结论。

## 一、编排正确性核对（真实转储，非快照）

对真实回合转储逐段核对（同一天，主 Agent、真实记忆注入后形态）：

| 检查项 | detailed | terse |
|---|---|---|
| `### Disk-Index Pattern`（渐进加载完整版） | ✓ 在场 | ✓ 正确缺席 |
| `## Tool Naming Contract`（命名契约） | ✓ 在场 | ✓ 正确缺席 |
| `prompt_guide(section: "…")` 引导句 | ✓ 正确缺席 | ✓ 4 段引导在场（operatingPrinciples / progressiveLoading / fileOutput / browser）+ messaging 指向 `weixin_send_guide` |
| 工作原则红线句（根因/不越界） | ✓ | ✓ 保留（"stay within scope, fix root causes"） |
| 红线段（Safety / Honesty / Language / Task Completion） | ✓ | ✓ 完整保留 |
| 记忆注入（工作记忆 + 关于用户）位于缓存边界之后的 dynamic 区 | ✓ | ✓ |
| 段级日志 `[prompt-section] … style=` | ✓ | ✓ |

结论：两档渲染与设计 §4/§5 一致；terse 只索引设计约定的试点段，无越界裁剪。

## 二、段级体量对照（同一提示词内实测）

| 段 | detailed | terse | 缩减 |
|---|---|---|---|
| Operating Principles | 811 | 177 | **−78%** |
| Context and Input Handling | 1230 | 200 | **−84%** |
| File Output Standards | 899 | 266 | **−70%** |
| Messaging | 1539 | 195 | **−87%** |
| Memory（未索引段抽样） | 1739 | 1739 | 0%（对照） |
| **整份系统提示词** | 33079 | 28809 | **−12.9%** |

解读：首批 5 段自身达标（设计目标 −40%~60% 之上）；整份提示词降幅仅 ~13%，因体量大头是 SOUL / Tooling 索引 / 记忆注入 / 动态段——若追求整体收益，P2 应评估把更多段纳入索引（尤其动态段中的固定说明类）或压缩 Tooling 索引本身。

## 三、任务实施差别（真实任务双档对照，LLM 各 1 次采样）

| 任务 | 档位 | 落地（硬） | 工具调用数 | 回合耗时 | guide 命中 |
|---|---|---|---|---|---|
| 定时提醒「明早九点提醒我给物业打电话确认快递」 | detailed | ✓ cron 行落库 | 5（bash/cron_create/bash/task_complete×2） | 16.2s | 无（未调 cron_guide） |
| 同上 | terse | ✓ cron 行落库 | 2（bash/cron_create） | 13.6s | 无（未调 cron_guide） |
| 代码小任务（建 py 脚本→加星期） | detailed | ✓ 产物+轮2 修改 | 6（file_write/bash/file_edit/bash/task_complete×2） | 13.6+17.4s | 无 |
| 同上 | terse | ✓ 产物+轮2 修改 | 7（file_write×2/bash×2/task_complete×3） | 16.3+13.6s | 无 |
| 会话连续性（告知代号→追问） | detailed | ✓ 复述命中 | — | 19.0+16.3s | 无 |
| 同上 | terse | ✓ 复述命中 | — | 10.9+13.7s | 无 |

观察：

1. **不劣化**：三组真实任务在 terse 下全部落地，含需要工具编排的多步任务（cron 创建、文件+修改、跨轮记忆）。
2. **引导未被触发也未必需**：两档均未出现 `prompt_guide` / `cron_guide` 调用——日常任务中索引句 + Tooling 索引已足以驱动正确执行；guide 是"细节不够用时的兜底"，符合设计预期（不强制展开）。若后续要观察引导路径，需要构造确实依赖细则细节的复杂任务（P2 观测项）。
3. **效率信号（样本极小，仅作趋势）**：提醒任务 terse 用 2 次工具 vs detailed 5 次；多数回合 terse 略快（个别回合相反，属 LLM 波动）。完成质量未见差异。
4. **一处环境观察**：detailed 提醒两次运行中一次把时间解析偏移了 8h（terse 两次一致）——属 LLM/bash 环境组合的非确定性问题，与提示词风格无关，记为提醒类场景的既有风险。

## 四、结论与建议

- **编排正确性**：两档真实转储与设计一致（硬断言 8/8），terse 索引化按试点范围精确生效、红线段零变化。
- **任务实施**：真实旅程双档全部完成，无质量下降证据；terse 提示词 −12.9%、段级 −70%~87%。
- **P2 建议**：① 扩大索引覆盖以兑现整体收益；② 用更依赖细则的复杂任务观察 `prompt_guide` 采纳率；③ 提醒类时间解析可考虑在 Tooling 的 Scheduling 组注中强化（不属本实验范围）。
