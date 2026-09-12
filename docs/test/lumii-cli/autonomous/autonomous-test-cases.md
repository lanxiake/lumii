# 自主进化 Agent CLI 测试用例

## 测试目标

验证自主进化 Agent 系统的完整功能，通过真实的 CLI 命令和数据库操作确保：

1. 满意度评分正确计算和持久化
2. 目标生成按照预期触发和保存
3. Prompt 变体选择和奖励更新正确
4. 人格状态正确演化
5. 协调器事件正确记录

## 测试环境

- **数据库**: `~/.lumii/data/agent-runtime.db`
- **CLI 工具**: `apps/windows/resources/app-ui-cli/lumii-ui.mjs`
- **测试探针前缀**: `autonomous-test-`
- **清理策略**: 测试后删除所有 `autonomous-test-` 前缀的数据

## 测试用例

### TC1: 数据库 Schema 验证

**目标**: 验证 7 张自主进化表已正确创建

**步骤**:
1. 连接数据库
2. 查询 sqlite_master 表
3. 验证 7 张表存在：
   - autonomous_satisfaction_scores
   - autonomous_goals
   - prompt_variants
   - prompt_evolution_history
   - personality_state
   - personality_events
   - evolution_coordination_history

**期望**:
- 所有表存在
- 表结构符合 Schema V28 定义

### TC2: 满意度评分计算

**目标**: 验证满意度评分算法正确性

**步骤**:
1. 模拟插入会话数据
2. 触发满意度评分计算
3. 查询 autonomous_satisfaction_scores 表
4. 验证各维度分数和总分

**输入**:
- 任务完成度: 0.8 (无错误)
- 用户反馈: 0.6 (中等交互)
- 效率: 0.7 (正常时长)
- 知识增长: 0.5 (少量查询)

**期望**:
- overall_score = 0.8 * 0.35 + 0.6 * 0.30 + 0.7 * 0.20 + 0.5 * 0.15 = 0.695
- 数据正确持久化到数据库

### TC3: 低满意度触发目标生成

**目标**: 验证低满意度（< 0.6）触发学习目标生成

**步骤**:
1. 插入低满意度评分（overall < 0.6）
2. 触发目标生成
3. 查询 autonomous_goals 表
4. 验证目标类型、状态、优先级

**输入**:
- 满意度评分: 0.55
- 最低维度: knowledge (0.3)

**期望**:
- 生成 1 个 learning 类型目标
- 状态为 pending
- 描述包含 "知识增长"
- priority > 0.5

### TC4: 每日目标上限限制

**目标**: 验证每日最多 3 个目标限制

**步骤**:
1. 插入 3 个今日已生成的目标
2. 尝试生成第 4 个目标
3. 验证被拒绝

**期望**:
- 第 4 个目标不被创建
- 日志记录 "已达到每日目标上限"

### TC5: Prompt 变体选择（探索模式）

**目标**: 验证 ε-greedy 探索模式随机选择变体

**步骤**:
1. 插入 3 个 Prompt 变体（不同性能）
2. 执行 100 次选择
3. 统计各变体被选中次数
4. 验证探索率

**期望**:
- 探索率约为 15% (±5%)
- 所有变体都被选中至少 1 次
- 记录选择历史到 prompt_evolution_history

### TC6: Prompt 变体选择（利用模式）

**目标**: 验证 UCB 算法选择最优变体

**步骤**:
1. 插入 3 个变体（均已试验 20 次）
2. v1: avgSatisfaction = 0.95
3. v2: avgSatisfaction = 0.70
4. v3: avgSatisfaction = 0.80
5. 执行 20 次选择（强制利用）

**期望**:
- v1 被选中次数最多（> 70%）
- 记录探索模式为 'exploit'

### TC7: Prompt 奖励更新

**目标**: 验证满意度更新变体统计数据

**步骤**:
1. 插入 1 个变体（初始 trialCount=10）
2. 记录反馈：satisfaction=0.8
3. 查询变体状态

**期望**:
- trialCount = 11
- successCount = +1 (0.8 > 0.6)
- totalReward = +0.8
- avgSatisfaction 重新计算

### TC8: 人格状态初始化

**目标**: 验证首次获取返回默认中性状态

**步骤**:
1. 查询不存在的 agent_id
2. 验证返回值

**期望**:
- openness = 0.5
- conscientiousness = 0.5
- extraversion = 0.5
- agreeableness = 0.5
- neuroticism = 0.5
- updateCount = 0

### TC9: 人格状态 EMA 更新

**目标**: 验证 EMA 算法正确更新人格

**步骤**:
1. 插入初始人格状态（全 0.5）
2. 触发 goal-generated 事件
3. 查询更新后的状态

**输入**:
- delta: { openness: 0.02, conscientiousness: 0.01 }
- alpha: 0.05

**期望**:
- openness = 0.5 + 0.05 * 0.02 = 0.501
- conscientiousness = 0.5 + 0.05 * 0.01 = 0.5005
- updateCount = 1
- 人格事件正确记录

### TC10: 人格边界限制

**目标**: 验证人格维度限制在 [0, 1] 区间

**步骤**:
1. 插入极端增量（delta = 10.0）
2. 更新人格
3. 验证结果

**期望**:
- 所有维度 ≤ 1.0
- 所有维度 ≥ 0.0

### TC11: 协调器指标查询

**目标**: 验证协调指标计算正确

**步骤**:
1. 插入测试数据（评分、目标、变体）
2. 查询协调指标
3. 验证统计数据

**期望**:
- totalEvaluations 正确
- goalsGenerated 按类型统计
- approvalRate 计算正确
- avgSatisfactionImprovement 计算正确

### TC12: 灰度发布开关

**目标**: 验证 AUTONOMOUS_ENABLED 控制全局开关

**步骤**:
1. 设置 AUTONOMOUS_ENABLED=false
2. 尝试触发评分
3. 验证不执行

**期望**:
- 不创建任何记录
- 日志显示 "自主能力已禁用"

### TC13: 目标类型白名单

**目标**: 验证 AUTONOMOUS_GOAL_TYPES 过滤

**步骤**:
1. 设置 AUTONOMOUS_GOAL_TYPES=learning
2. 触发目标生成
3. 验证仅生成 learning 类型

**期望**:
- 不生成 proactive-message 类型
- 仅生成 learning 类型

### TC14: 故障降级测试

**目标**: 验证数据库失败不影响评分返回

**步骤**:
1. 模拟数据库连接失败
2. 执行满意度评分
3. 验证评分仍返回

**期望**:
- 评分计算完成
- 日志记录 "保存评分失败"
- 不抛出异常

### TC15: 端到端完整流程

**目标**: 验证完整的自主闭环

**步骤**:
1. 模拟低满意度会话
2. 触发满意度评分
3. 验证目标生成
4. 模拟用户批准目标
5. 触发 Prompt 选择
6. 记录反馈
7. 更新人格
8. 查询协调历史

**期望**:
- 所有步骤成功执行
- 数据正确持久化
- 事件正确记录
- Telemetry 完整

## 测试数据清理

测试完成后，删除所有测试数据：

```sql
DELETE FROM autonomous_satisfaction_scores WHERE agent_id LIKE 'autonomous-test-%';
DELETE FROM autonomous_goals WHERE agent_id LIKE 'autonomous-test-%';
DELETE FROM prompt_variants WHERE baseline_prompt_id LIKE 'autonomous-test-%';
DELETE FROM prompt_evolution_history WHERE variant_id IN (
  SELECT id FROM prompt_variants WHERE baseline_prompt_id LIKE 'autonomous-test-%'
);
DELETE FROM personality_state WHERE agent_id LIKE 'autonomous-test-%';
DELETE FROM personality_events WHERE agent_id LIKE 'autonomous-test-%';
DELETE FROM evolution_coordination_history WHERE agent_id LIKE 'autonomous-test-%';
```

## 测试报告

测试完成后生成报告：
- `autonomous-cli-evidence.jsonl` - 每个测试用例的执行记录
- `autonomous-cli-test-report.md` - 测试结果汇总

## 成功标准

- **所有测试用例通过**: 15/15
- **数据完整性**: 所有数据正确持久化
- **算法正确性**: 计算结果与设计文档一致
- **性能要求**: 每个操作 < 200ms
- **无回归**: 现有功能不受影响
