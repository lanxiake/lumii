# 自主进化「完整真实用户」E2E 测试报告

**执行时间**: 2026-09-05T16:35:51.215Z
**结果**: 10 PASS / 0 FAIL（共 10）
**数据库**: `C:\Users\Administrator\.lumii\data\agent-runtime.db`
**驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/send abort/goals approve/goals reject/reflect），无 SQL 播种

## 明细

| 用例 | 结果 | 说明 |
|---|---|---|
| A1 | PASS | 满意度落库 overall=0.9470 (task=1.00 fb=0.85 eff=1.00) |
| A2 | PASS | 4 条能力测试落库，维度难度正确（document_analysis:0.35, code_generation:0.55）；capability_dimensions 3 维 |
| A3 | PASS | trial_count 7 → 8 |
| B1 | PASS | 2 次 abort 信号落 runtime_state（aborts=2） |
| B2 | PASS | overall=0.5971 → 生成 learning 目标（pending）"增强知识积累：主动学习相关领域知识" |
| B3 | PASS | 目标 goal_1788626111418_388hadi 已拒绝（rejected） |
| C1 | PASS | 生成 pending 目标 "增强知识积累：主动学习相关领域知识" |
| C2 | PASS | executing + evolution-decided 人格事件落库（personality update_count=6） |
| C3 | PASS | CLI goals list 可见 executing 目标（total=3） |
| D1 | PASS | 反思落库 trigger=user-request primaryIssue="当前输出在多数会话中未能稳定确认任务意图并形成可评估的知识沉淀，导致反馈波动且知…" |

## 覆盖范围

- 满意度评分：真实回合结束落库，字段不越界
- 能力追踪：真实工具调用 → capability_tests（维度难度与 DIMENSION_DIFFICULTY 对齐）
- Prompt 进化：变体反馈回写 trial_count 增长
- 反馈信号：真实 abort → runtime_state 计数 → user_feedback 扣分（2 abort = 0.35）
- 目标生成：低满意(<0.6) → pending learning 目标
- 审批/拒绝：CLI 真实操作 → executing/rejected + evolution-decided 人格事件
- 反思：CLI reflect 真实 LLM 调用 → reflections 落库

## 说明

真实对话一律走 assistant agent（CLI 无法指定 agent），测试数据进入 assistant 的自主进化记录。
会话标题带「自主进化E2E-」前缀，便于用户在客户端侧边栏核查对应对话与 AutonomousPage 数据。

证据文件: `autonomous-full-e2e-evidence.jsonl`
