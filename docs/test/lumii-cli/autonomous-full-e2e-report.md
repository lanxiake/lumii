# 自主进化「完整真实用户」E2E 测试报告

**执行时间**: 2026-09-05T16:51:41.110Z
**结果**: 11 PASS / 0 FAIL（共 11）
**数据库**: `C:\Users\Administrator\.lumii\data\agent-runtime.db`
**驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/send abort/goals approve/goals reject/reflect），无 SQL 播种

## 明细

| 用例 | 结果 | 说明 |
|---|---|---|
| A1 | PASS | 满意度落库 overall=0.9470 (task=1.00 fb=0.85 eff=1.00) |
| A2 | PASS | 3 条能力测试落库，维度难度正确（document_analysis:0.35, code_generation:0.55）；capability_dimensions 3 维 |
| A3 | PASS | trial_count 23 → 24 |
| A4 | PASS | 1 条失败测试（result=failure，难度正确），task=0.75（含失败惩罚） |
| B1 | PASS | 2 次 abort 信号落 runtime_state（aborts=2） |
| B2 | PASS | overall=0.5971 → 生成 learning 目标（pending）"增强知识积累：主动学习相关领域知识" |
| B3 | PASS | 目标 goal_1788626987690_nu3yawr 已拒绝（rejected） |
| C1 | PASS | 生成 pending 目标 "增强知识积累：主动学习相关领域知识" |
| C2 | PASS | executing + evolution-decided 人格事件落库（personality update_count=11） |
| C3 | PASS | CLI goals list 可见 executing 目标（total=7） |
| D1 | PASS | 反思落库 trigger=user-request primaryIssue="满意度波动主要源于反馈维度不稳定和知识维度缺失，而非明显工具执行错误。…" |

## 覆盖范围

- 满意度评分：真实回合结束落库，字段不越界
- 能力追踪：真实工具调用 → capability_tests（维度难度与 DIMENSION_DIFFICULTY 对齐）
- Prompt 进化：变体反馈回写 trial_count 增长
- 反馈信号：真实 abort → runtime_state 计数 → user_feedback 扣分（2 abort = 0.35）
- 目标生成：低满意(<0.6) → pending learning 目标
- 审批/拒绝：CLI 真实操作 → executing/rejected + evolution-decided 人格事件
- 反思：CLI reflect 真实 LLM 调用 → reflections 落库

## 未覆盖 / 已知限制（诚实声明，非遗漏即失真）

- **编辑/重发反馈信号（edit -0.10 / resend -0.20）**：采集点挂在 `message-commands.ts`(edit) 与 `misc-commands.ts`(edit-and-resend)，只经前端 UI 触发，CLI 无 `edit`/`resend` 子命令。本脚本只实测了 CLI 可达的 `abort`（-0.25）。两路信号共用 `recordFeedbackSignal`，接线一致，差异仅触发入口。
- **主动消息目标（proactive-message）**：需「满意度 ≥ 0.6 且用户 6 小时无交互」才生成，无法在单次测试运行内真实触发；且当前实现为 P0 占位（不实际发消息）。
- **反思定时触发（scheduled，每日 23:00）**：cron 接线已在上轮验证（启动日志「反思定时触发已启动（0 23 * * *）」）；本脚本只触发手动 `user-request`，`scheduled` 走同一 `reflectAutonomous` 路径。
- **agent 数据隔离**：真实对话经 CLI 一律走 assistant agent，无法用真实对话验证多 agent 隔离；隔离已由 `run-autonomous-cli-suite.mjs` TC21 用探针 agent 覆盖。
- **目标去重（dedup）**：P2 特性，单测覆盖。本脚本运行前清理了残留 pending 目标（否则同描述学习目标会被去重拦截）——该行为在测试准备阶段已实际观察到。

## 说明

真实对话一律走 assistant agent（CLI 无法指定 agent），测试数据进入 assistant 的自主进化记录。
会话标题带「自主进化E2E-」前缀，便于用户在客户端侧边栏核查对应对话与 AutonomousPage 数据。

证据文件: `autonomous-full-e2e-evidence.jsonl`
