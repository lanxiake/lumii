# 自主进化 Agent 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 在不破坏现有 Agent Runtime 稳定性的前提下，为 Lumii 构建首个自主进化 Agent MVP（P0 范围）：实现满意度评分、内在目标生成、Prompt 进化、人格追踪四大核心能力，建立"元认知感知 → 目标生成 → 进化执行 → 人格记录"的第一阶段自主闭环。

**架构：** 在 `packages/agent-runtime/autonomous/` 新增独立模块，使用事件驱动协调器（`autonomous-coordinator.ts`）统一管理元认知引擎、目标生成器、Prompt 进化引擎和人格追踪器。所有能力通过数据库持久化（7 张新表），通过配置开关（`AUTONOMOUS_ENABLED`）控制启用，所有失败降级为日志记录，不阻塞现有业务。

**技术栈：** TypeScript, PostgreSQL, Vitest, 多臂老虎机算法（ε-greedy），Elo Rating System，指数移动平均（EMA），工程化保障（配置即代码、单元/集成测试、实验追踪、灰度发布）。

**规格：** `docs/design/自主进化Agent/1-顶层设计.md` 至 `6-实施计划.md`。

---

## 全局约束

- **MVP P0 范围严格限定：** 仅实现满意度评分、目标生成（learning + proactive-message 两类）、Prompt 进化、人格追踪；不实现能力边界检测（标记为手动）、自我反思（标记为定时触发但暂不实现）、记忆/技能/工具进化（标记为 false）。
- **用户审批必需：** P0 阶段所有自主生成的目标必须经用户明确同意后执行（`userApproval: 'always'`），每日目标上限 3 个（`maxGoalsPerDay: 3`）。
- **配置即代码：** 所有算法参数（满意度权重、epsilon、Elo K 值、EMA alpha 等）集中定义在 `autonomous/config.ts` 或 `types.ts` 常量区，禁止散布在业务代码中。
- **数据库 Schema 完整性：** 必须按照 `docs/design/自主进化Agent/6-实施计划.md` 中定义的 7 张表 Schema 创建迁移脚本（`autonomous_satisfaction_scores`, `autonomous_goals`, `prompt_evolution_history`, `prompt_variants`, `personality_events`, `personality_state`, `evolution_coordination_history`）。
- **算法实现一致性：** 满意度评分公式（task 0.35 + feedback 0.30 + efficiency 0.20 + knowledge 0.15）、ε-greedy 探索率（epsilon=0.15）、Elo Rating K 值（K=32）、人格 EMA 更新率（alpha=0.05）必须与设计文档完全一致。
- **可观测性强制要求：** 每个算法决策点必须记录 Telemetry（满意度分数、目标生成原因、Prompt 变体选择、人格更新事件），使用结构化日志（JSON 格式），支持按 runId/goalId/variantId 追踪。
- **单元测试优先：** 每个算法模块（`meta-cognition-engine.ts`, `intrinsic-goal-generator.ts`, `prompt-evolution.ts`, `personality-tracker.ts`）必须先编写失败测试，再实现功能代码，覆盖率要求 ≥ 80%。
- **集成测试必需：** 完整端到端测试场景（从满意度评分低于阈值 → 生成学习目标 → 用户同意 → 执行 Prompt 进化 → 记录人格事件）至少 2 个。
- **隐私与安全：** 禁止在日志、Telemetry、人格事件中记录用户消息原文、API Key、模型响应全文；仅记录元数据（长度、类型、摘要 hash）。
- **灰度发布支持：** 使用环境变量 `AUTONOMOUS_ENABLED=true/false` 控制全局开关，使用 `AUTONOMOUS_GOAL_TYPES=learning,proactive-message` 控制目标类型白名单。
- **回滚预案：** 所有数据库迁移必须提供 `down` 脚本，所有 Prompt 变体必须保留原始版本（`is_baseline=true`），可随时回退到基线 Prompt。
- **不引入新依赖：** 禁止引入外部 ML 框架（TensorFlow.js、ONNX 等）、图表库（D3、ECharts）、实时通信库（Socket.IO），使用现有技术栈（TypeScript、Node.js、PostgreSQL）实现轻量算法。
- **不修改现有 Agent 接口：** 不改变 `packages/agent-runtime/core/agent.ts` 的公开 API，不影响现有技能/工具/记忆系统的稳定性，自主能力通过事件监听器（EventEmitter）解耦接入。
- **模块文件命名严格遵循：** `packages/agent-runtime/autonomous/` 下文件命名必须与设计文档一致（`meta-cognition-engine.ts`, `metrics-collector.ts`, `intrinsic-goal-generator.ts`, `prompt-evolution.ts`, `personality-tracker.ts`, `personality-events.ts`, `autonomous-coordinator.ts`, `types.ts`, `config.ts`）。

---

## 1. 范围与文件映射

### 1.1 MVP P0 核心行为

- 每次 Agent 会话结束后自动计算满意度评分（使用加权公式：task 0.35 + feedback 0.30 + efficiency 0.20 + knowledge 0.15），评分低于阈值 0.6 时触发内在目标生成。
- 目标生成器仅生成两类目标：学习型目标（learning，用于知识积累）和主动消息目标（proactive-message，用于主动向用户反馈），每日上限 3 个，所有目标需用户明确同意后执行。
- Prompt 进化使用 ε-greedy 策略（epsilon=0.15），维护 Prompt 变体池（每个基线 Prompt 最多 5 个变体），通过多臂老虎机算法选择最优变体，满意度作为奖励信号更新变体 UCB 分数。
- 人格追踪记录关键事件（目标生成、进化决策、用户反馈、异常处理），使用 Big Five 模型维护人格状态（开放性、尽责性、外向性、宜人性、神经质），通过 EMA（alpha=0.05）更新人格向量。
- 所有能力通过 `AutonomousCoordinator` 统一调度，使用事件总线（EventEmitter）解耦模块间依赖，失败降级为日志记录，不影响现有 Agent 核心功能。

### 1.2 新增文件

```text
packages/agent-runtime/autonomous/
  types.ts                              # 所有公共类型定义（接口、枚举、常量）
  config.ts                             # 算法参数配置（权重、阈值、超参数）
  meta-cognition-engine.ts              # 元认知引擎（满意度评分）
  metrics-collector.ts                  # 指标收集器（从 Agent 会话提取数据）
  intrinsic-goal-generator.ts           # 内在目标生成器
  prompt-evolution.ts                   # Prompt 进化引擎（ε-greedy + 多臂老虎机）
  personality-tracker.ts                # 人格追踪器（Big Five + EMA）
  personality-events.ts                 # 人格事件记录器
  autonomous-coordinator.ts             # 自主协调器（事件驱动调度）
  
  __tests__/
    meta-cognition-engine.test.ts
    intrinsic-goal-generator.test.ts
    prompt-evolution.test.ts
    personality-tracker.test.ts
    autonomous-coordinator.test.ts
    integration/
      autonomous-e2e.test.ts            # 完整端到端测试

packages/database/migrations/
  YYYYMMDDHHMMSS_autonomous_satisfaction_scores.sql
  YYYYMMDDHHMMSS_autonomous_goals.sql
  YYYYMMDDHHMMSS_prompt_evolution_history.sql
  YYYYMMDDHHMMSS_prompt_variants.sql
  YYYYMMDDHHMMSS_personality_events.sql
  YYYYMMDDHHMMSS_personality_state.sql
  YYYYMMDDHHMMSS_evolution_coordination_history.sql
```

### 1.3 修改文件

```text
packages/agent-runtime/core/agent.ts              # 集成自主协调器生命周期钩子
packages/agent-runtime/core/session-manager.ts    # 会话结束时触发满意度评分
packages/agent-runtime/index.ts                   # 导出自主能力公开接口
```

### 1.4 明确不变的文件

`packages/agent-runtime/core/agent.ts` 的公开 API 不改变，现有技能/工具/记忆系统（`packages/agent-runtime/skills/`, `packages/agent-runtime/tools/`, `packages/agent-runtime/memory/`）不修改内部逻辑；自主能力仅通过事件监听器注入，保持解耦。

---

## 2. Task 1: 锁定数据契约与算法参数配置

**文件：**

- Create `packages/agent-runtime/autonomous/types.ts`
- Create `packages/agent-runtime/autonomous/config.ts`

**依赖：** 无。

### 2.1 定义共享类型（types.ts）

- [ ] 定义 `SatisfactionScore` 接口：包含 `taskCompletion`（任务完成度 0-1）、`userFeedback`（用户反馈质量 0-1）、`efficiency`（效率 0-1）、`knowledgeGrowth`（知识增长 0-1）、`overall`（总分 0-1）、`timestamp`、`sessionId`、`agentId`。
- [ ] 定义 `GoalType` 枚举：`LEARNING = 'learning'`, `PROACTIVE_MESSAGE = 'proactive-message'`（P0 仅这两类）。
- [ ] 定义 `GoalStatus` 枚举：`PENDING = 'pending'`, `APPROVED = 'approved'`, `REJECTED = 'rejected'`, `EXECUTING = 'executing'`, `COMPLETED = 'completed'`, `FAILED = 'failed'`。
- [ ] 定义 `AutonomousGoal` 接口：`id`（UUID）、`type`（GoalType）、`description`（目标描述文本）、`triggerReason`（触发原因：低满意度/用户请求/定时）、`status`、`priority`（优先级 0-1）、`createdAt`、`approvedAt`、`executedAt`、`completedAt`、`satisfactionBefore`（触发时的满意度）、`satisfactionAfter`（执行后的满意度，可选）、`metadata`（JSON，存储目标特定参数）。
- [ ] 定义 `PromptVariant` 接口：`id`（UUID）、`baselinePromptId`（基线 Prompt ID）、`variantText`（变体文本）、`isBaseline`（是否基线版本）、`createdAt`、`trialCount`（试验次数）、`successCount`（成功次数）、`totalReward`（累积奖励）、`ucbScore`（UCB 分数）、`avgSatisfaction`（平均满意度）。
- [ ] 定义 `PersonalityState` 接口：使用 Big Five 模型，包含 `openness`（开放性 0-1）、`conscientiousness`（尽责性 0-1）、`extraversion`（外向性 0-1）、`agreeableness`（宜人性 0-1）、`neuroticism`（神经质 0-1）、`lastUpdated`、`updateCount`（更新次数）。
- [ ] 定义 `PersonalityEvent` 接口：`eventType`（goal-generated/evolution-decided/user-feedback/error-handled）、`timestamp`、`personalityDelta`（人格向量变化，Big Five 各维度增量）、`triggerContext`（触发上下文元数据）。
- [ ] 定义 `EvolutionLayer` 枚举：`PROMPT = 'prompt'`, `MEMORY = 'memory'`, `SKILL = 'skill'`, `TOOL = 'tool'`（P0 仅实现 PROMPT）。
- [ ] 定义 `ExplorationMode` 枚举：`EXPLOIT = 'exploit'`, `EXPLORE_PROMPT = 'explore_prompt'`, `EXPLORE_MEMORY = 'explore_memory'`, `EXPLORE_SKILL = 'explore_skill'`, `EXPLORE_TOOL = 'explore_tool'`（P0 仅使用前两个）。
- [ ] 定义 `MetaCognitionConfig` 接口：`satisfactionWeights`（task/feedback/efficiency/knowledge 权重对象）、`satisfactionThreshold`（触发阈值）、`reflectionTrigger`（反思触发策略）、`capabilityTracking`（能力追踪模式）。
- [ ] 定义 `GoalGenerationConfig` 接口：`enabledTypes`（允许的目标类型数组）、`userApproval`（'always' | 'optional' | 'never'）、`maxGoalsPerDay`（每日上限）、`priorityWeights`（优先级计算权重）。
- [ ] 定义 `PromptEvolutionConfig` 接口：`epsilon`（ε-greedy 探索率）、`maxVariantsPerPrompt`（每个基线 Prompt 最大变体数）、`minTrialsBeforeExploit`（开始利用前的最小试验次数）、`ucbConfidence`（UCB 置信度参数）。
- [ ] 定义 `PersonalityConfig` 接口：`emaAlpha`（EMA 平滑系数）、`eventWeights`（不同事件类型对人格影响的权重）、`trackingEnabled`（是否启用追踪）、`evolutionEnabled`（是否启用进化，P0 为 false）。
- [ ] 定义 MVP 范围接口 `MVPScope`（与设计文档 6-实施计划.md 一致）：
  ```typescript
  interface MVPScope {
    metaCognition: {
      satisfactionScoring: true
      capabilityTracking: 'manual'
      reflectionTrigger: 'scheduled'
    }
    goalGeneration: {
      types: ['learning', 'proactive-message']
      userApproval: 'always'
      maxGoalsPerDay: 3
    }
    evolution: { prompt: true, memory: false, skill: false, tool: false }
    personality: { tracking: true, evolution: false, display: true }
  }
  ```

### 2.2 定义算法参数配置（config.ts）

- [ ] 导出 `SATISFACTION_WEIGHTS` 常量对象：`{ task: 0.35, feedback: 0.30, efficiency: 0.20, knowledge: 0.15 }`，总和必须为 1.0。
- [ ] 导出 `SATISFACTION_THRESHOLD` 常量：`0.6`（低于此值触发目标生成）。
- [ ] 导出 `EPSILON` 常量：`0.15`（ε-greedy 探索率）。
- [ ] 导出 `MAX_VARIANTS_PER_PROMPT` 常量：`5`（每个基线 Prompt 最大变体数）。
- [ ] 导出 `MIN_TRIALS_BEFORE_EXPLOIT` 常量：`10`（每个变体最少试验次数后才开始利用）。
- [ ] 导出 `UCB_CONFIDENCE` 常量：`2.0`（UCB 算法置信度参数 c）。
- [ ] 导出 `EMA_ALPHA` 常量：`0.05`（人格 EMA 更新率）。
- [ ] 导出 `MAX_GOALS_PER_DAY` 常量：`3`（P0 每日目标上限）。
- [ ] 导出 `ELO_K_FACTOR` 常量：`32`（Elo Rating K 值，虽然 P0 不实现能力边界检测，但预留类型定义）。
- [ ] 导出 `AUTONOMOUS_ENABLED` 读取环境变量：`process.env.AUTONOMOUS_ENABLED !== 'false'`（默认启用）。
- [ ] 导出 `AUTONOMOUS_GOAL_TYPES` 读取环境变量：`process.env.AUTONOMOUS_GOAL_TYPES?.split(',') || ['learning', 'proactive-message']`（灰度发布用）。
- [ ] 所有数值常量必须添加 JSDoc 注释，说明来源（引用设计文档章节）和含义。

### 2.3 测试与验收

- [ ] 编写 `config.test.ts`，验证 `SATISFACTION_WEIGHTS` 四个权重之和严格等于 1.0。
- [ ] 验证所有常量类型正确（使用 TypeScript 类型断言）。
- [ ] 验证环境变量读取逻辑：`AUTONOMOUS_ENABLED=false` 时返回 false，未设置时返回 true。
- [ ] 验证 `AUTONOMOUS_GOAL_TYPES` 支持逗号分隔的多类型解析（测试 `'learning'` 和 `'learning,proactive-message'`）。
- [ ] 运行 `pnpm --filter @lumii/agent-runtime exec vitest run autonomous/config.test.ts`。

**任务验收：** 所有公共类型定义一次，算法参数集中配置且带有文档引用，配置支持环境变量灰度控制，类型安全且无 `any` 类型泄漏。

---

## 3. Task 2: 实现纯函数满意度评分与指标收集

**文件：**

- Create `packages/agent-runtime/autonomous/meta-cognition-engine.ts`
- Create `packages/agent-runtime/autonomous/metrics-collector.ts`
- Create `packages/agent-runtime/autonomous/__tests__/meta-cognition-engine.test.ts`

**依赖：** Task 1。

### 3.1 实现指标收集器（metrics-collector.ts）

- [ ] 定义 `SessionMetrics` 接口：从 Agent 会话提取的原始指标，包含 `sessionId`、`agentId`、`startTime`、`endTime`、`messageCount`（消息数）、`toolCallCount`（工具调用次数）、`errorCount`（错误次数）、`userInteractionCount`（用户交互次数）、`knowledgeQueriesCount`（知识查询次数）、`taskDescription`（任务描述文本摘要）。
- [ ] 实现 `extractTaskCompletion(metrics: SessionMetrics): number` 纯函数：根据错误率和工具调用成功率计算任务完成度（0-1），公式：`1 - (errorCount / max(toolCallCount, 1)) * 0.5`，确保返回值在 [0, 1] 区间。
- [ ] 实现 `extractUserFeedback(metrics: SessionMetrics): number` 纯函数：根据用户交互频率和消息数计算反馈质量（0-1），公式：`min(userInteractionCount / max(messageCount, 1), 1.0)`，无交互时返回 0.5（中性）。
- [ ] 实现 `extractEfficiency(metrics: SessionMetrics): number` 纯函数：根据会话时长和消息数计算效率（0-1），公式：`1 / (1 + Math.log10(durationMs / max(messageCount, 1) / 1000))`，使用对数归一化避免极端值。
- [ ] 实现 `extractKnowledgeGrowth(metrics: SessionMetrics): number` 纯函数：根据知识查询次数和消息数计算知识增长（0-1），公式：`min(knowledgeQueriesCount / max(messageCount, 1) * 2, 1.0)`，查询占比超过 50% 则返回 1.0。
- [ ] 实现 `collectMetricsFromSession(session: AgentSession): SessionMetrics` 函数：从 Agent 会话对象提取所有原始指标，处理缺失字段（使用默认值 0）。
- [ ] 所有指标提取函数必须是纯函数（无副作用、无外部依赖），可独立测试。

### 3.2 实现元认知引擎（meta-cognition-engine.ts）

- [ ] 导出 `computeSatisfactionScore(metrics: SessionMetrics, weights: SatisfactionWeights): SatisfactionScore` 纯函数：
  - 使用 `extractTaskCompletion` 计算 `taskCompletion`
  - 使用 `extractUserFeedback` 计算 `userFeedback`
  - 使用 `extractEfficiency` 计算 `efficiency`
  - 使用 `extractKnowledgeGrowth` 计算 `knowledgeGrowth`
  - 计算加权总分：`overall = task * weights.task + feedback * weights.feedback + efficiency * weights.efficiency + knowledge * weights.knowledge`
  - 返回完整 `SatisfactionScore` 对象，包含各维度分数和总分
- [ ] 导出 `shouldTriggerGoalGeneration(score: SatisfactionScore, threshold: number): boolean` 纯函数：判断满意度是否低于阈值，触发目标生成。
- [ ] 导出 `categorizeSatisfactionLevel(score: number): 'low' | 'medium' | 'high'` 纯函数：分类满意度等级（< 0.6 low, 0.6-0.8 medium, > 0.8 high）。
- [ ] 导出 `MetaCognitionEngine` 类：
  - 构造函数注入 `config: MetaCognitionConfig` 和 `db: DatabaseClient`（数据库客户端）
  - 方法 `async evaluateSession(session: AgentSession): Promise<SatisfactionScore>`：收集指标 → 计算评分 → 持久化到数据库 `autonomous_satisfaction_scores` 表 → 返回评分
  - 方法 `async getRecentScores(agentId: string, limit: number): Promise<SatisfactionScore[]>`：查询最近 N 次评分
  - 方法 `async getAverageScore(agentId: string, days: number): Promise<number>`：计算最近 N 天平均满意度
  - 所有数据库操作失败时记录日志并抛出特定错误类型（`MetaCognitionError`），不阻塞调用方

### 3.3 测试优先实现与验收

- [ ] 编写 `meta-cognition-engine.test.ts`，测试纯函数：
  - 测试 `extractTaskCompletion`：无错误时返回 1.0，全部失败时返回 0.5，部分失败时在 [0.5, 1.0] 区间
  - 测试 `extractUserFeedback`：无交互返回 0.5，高交互返回接近 1.0
  - 测试 `extractEfficiency`：快速会话返回高分，超长会话返回低分
  - 测试 `extractKnowledgeGrowth`：无查询返回 0，高查询占比返回 1.0
  - 测试 `computeSatisfactionScore`：使用固定权重和已知指标，验证加权总分计算正确
  - 测试 `shouldTriggerGoalGeneration`：边界值测试（0.59 触发，0.6 不触发）
- [ ] 测试 `MetaCognitionEngine` 类：
  - Mock 数据库客户端，测试 `evaluateSession` 成功持久化评分
  - 测试数据库失败时抛出 `MetaCognitionError` 且不影响返回值
  - 测试 `getRecentScores` 和 `getAverageScore` 正确查询历史数据
- [ ] 运行 `pnpm --filter @lumii/agent-runtime exec vitest run autonomous/__tests__/meta-cognition-engine.test.ts` 并记录覆盖率（要求 ≥ 80%）。

**任务验收：** 满意度评分算法与设计文档公式完全一致，所有计算逻辑可独立测试（纯函数），数据库持久化失败不影响评分返回，测试覆盖率达标。

---

## 4. Task 3: 实现内在目标生成器与优先级计算

**文件：**

- Create `packages/agent-runtime/autonomous/intrinsic-goal-generator.ts`
- Create `packages/agent-runtime/autonomous/__tests__/intrinsic-goal-generator.test.ts`

**依赖：** Tasks 1-2。

### 4.1 实现目标生成逻辑

- [ ] 导出 `generateLearningGoal(score: SatisfactionScore, recentHistory: SessionMetrics[]): AutonomousGoal | null` 纯函数：
  - 分析满意度低的维度（task/feedback/efficiency/knowledge），找出最低的维度
  - 生成学习型目标描述（例如："提升任务完成度：学习更有效的工具使用策略"）
  - 计算优先级：`priority = (1 - score.overall) * 0.7 + (1 - lowestDimensionScore) * 0.3`
  - 返回 `AutonomousGoal` 对象（状态为 PENDING，triggerReason 为 'low-satisfaction'）
- [ ] 导出 `generateProactiveMessageGoal(score: SatisfactionScore, context: { lastUserMessageTime: Date }): AutonomousGoal | null` 纯函数：
  - 检查用户上次消息时间距今是否超过阈值（例如 6 小时）且满意度为 medium 或 high
  - 生成主动消息目标描述（例如："主动向用户汇报学习进展"）
  - 计算优先级：`priority = score.overall * 0.5 + timeSinceLastMessage / 86400 * 0.5`（归一化到 0-1）
  - 返回 `AutonomousGoal` 对象
- [ ] 导出 `IntrinsicGoalGenerator` 类：
  - 构造函数注入 `config: GoalGenerationConfig` 和 `db: DatabaseClient`
  - 方法 `async generateGoals(score: SatisfactionScore, context: GoalGenerationContext): Promise<AutonomousGoal[]>`：
    - 检查今日已生成目标数（查询数据库 `autonomous_goals` 表 `WHERE created_at > today AND status IN ('pending', 'approved', 'executing')`）
    - 若达到 `maxGoalsPerDay` 上限，返回空数组
    - 根据 `config.enabledTypes` 调用对应生成函数（learning/proactive-message）
    - 持久化生成的目标到数据库
    - 返回生成的目标数组
  - 方法 `async approveGoal(goalId: string): Promise<void>`：更新目标状态为 APPROVED，记录 `approvedAt` 时间
  - 方法 `async rejectGoal(goalId: string): Promise<void>`：更新目标状态为 REJECTED
  - 方法 `async getPendingGoals(agentId: string): Promise<AutonomousGoal[]>`：查询待审批目标

### 4.2 测试优先实现与验收

- [ ] 编写 `intrinsic-goal-generator.test.ts`：
  - 测试 `generateLearningGoal`：低任务完成度生成任务相关目标，低知识增长生成学习相关目标
  - 测试 `generateProactiveMessageGoal`：用户长时间无交互且满意度中等时生成主动消息目标
  - 测试优先级计算：验证公式正确性，极端情况（满意度 0 和 1）边界测试
  - 测试 `IntrinsicGoalGenerator` 类：
    - Mock 数据库，测试每日上限限制（生成 3 个目标后第 4 个被拒绝）
    - 测试 `enabledTypes` 过滤（仅启用 learning 时不生成 proactive-message）
    - 测试 `approveGoal` 和 `rejectGoal` 正确更新数据库状态
    - 测试 `getPendingGoals` 正确查询待审批目标
- [ ] 运行 `pnpm --filter @lumii/agent-runtime exec vitest run autonomous/__tests__/intrinsic-goal-generator.test.ts` 并验证覆盖率 ≥ 80%。

**任务验收：** 目标生成逻辑根据满意度低的维度智能选择目标类型，优先级计算合理，每日上限严格执行，用户审批流程完整，测试覆盖率达标。

---

## 5. Task 4: 实现 Prompt 进化引擎（ε-greedy + 多臂老虎机）

**文件：**

- Create `packages/agent-runtime/autonomous/prompt-evolution.ts`
- Create `packages/agent-runtime/autonomous/__tests__/prompt-evolution.test.ts`

**依赖：** Tasks 1-2。

### 5.1 实现 ε-greedy 策略与 UCB 算法

- [ ] 导出 `shouldExplore(epsilon: number): boolean` 纯函数：以概率 epsilon 返回 true（探索），否则返回 false（利用），使用 `Math.random()` 实现，测试时注入随机数生成器。
- [ ] 导出 `computeUCB(variant: PromptVariant, totalTrials: number, confidence: number): number` 纯函数：
  - 计算 UCB 分数：`avgSatisfaction + confidence * sqrt(ln(totalTrials) / variant.trialCount)`
  - 处理边界情况：`trialCount = 0` 时返回无穷大（确保未试验的变体优先选择）
  - 返回 UCB 分数（用于排序）
- [ ] 导出 `selectVariant(variants: PromptVariant[], epsilon: number, ucbConfidence: number, randomFn: () => number): PromptVariant` 纯函数：
  - 调用 `shouldExplore(epsilon)` 决定探索或利用
  - 探索模式：随机选择一个变体（包括基线）
  - 利用模式：计算所有变体的 UCB 分数，选择最高分的变体
  - 如果所有变体试验次数小于 `MIN_TRIALS_BEFORE_EXPLOIT`，强制探索模式
  - 返回选中的变体
- [ ] 导出 `updateVariantReward(variant: PromptVariant, satisfaction: number): PromptVariant` 纯函数：
  - 更新 `trialCount += 1`
  - 如果 `satisfaction > 0.6`，更新 `successCount += 1`
  - 更新 `totalReward += satisfaction`
  - 重新计算 `avgSatisfaction = totalReward / trialCount`
  - 返回更新后的变体对象（不可变更新）

### 5.2 实现 Prompt 进化引擎

- [ ] 导出 `PromptEvolutionEngine` 类：
  - 构造函数注入 `config: PromptEvolutionConfig` 和 `db: DatabaseClient`
  - 方法 `async selectPrompt(baselinePromptId: string): Promise<PromptVariant>`：
    - 从数据库查询该基线 Prompt 的所有变体（`prompt_variants` 表 `WHERE baseline_prompt_id = ?`）
    - 若无变体，返回基线版本（`isBaseline = true`）
    - 使用 `selectVariant` 选择最优变体
    - 记录选择事件到 `prompt_evolution_history` 表（记录 variantId、选择时间、探索/利用模式）
    - 返回选中的变体
  - 方法 `async recordFeedback(variantId: string, satisfaction: number): Promise<void>`：
    - 查询变体当前状态
    - 使用 `updateVariantReward` 计算更新后的状态
    - 更新数据库 `prompt_variants` 表（`trialCount`, `successCount`, `totalReward`, `avgSatisfaction`, `ucbScore`）
    - 记录反馈事件到 `prompt_evolution_history` 表
  - 方法 `async createVariant(baselinePromptId: string, variantText: string): Promise<PromptVariant>`：
    - 检查该基线 Prompt 的变体数量是否达到 `maxVariantsPerPrompt` 上限
    - 若达到上限，拒绝创建并返回错误
    - 创建新变体记录（初始 `trialCount = 0`, `successCount = 0`, `totalReward = 0`, `ucbScore = Infinity`）
    - 持久化到数据库
    - 返回新变体对象
  - 方法 `async getVariantPerformance(baselinePromptId: string): Promise<PromptVariant[]>`：查询该基线 Prompt 所有变体的性能统计

### 5.3 测试优先实现与验收

- [ ] 编写 `prompt-evolution.test.ts`：
  - 测试 `shouldExplore`：使用固定随机数生成器，验证探索概率为 epsilon
  - 测试 `computeUCB`：验证公式正确性，测试 `trialCount = 0` 返回无穷大
  - 测试 `selectVariant`：
    - 探索模式：验证随机选择（所有变体有相等概率）
    - 利用模式：验证选择最高 UCB 分数的变体
    - 强制探索：所有变体试验次数 < `MIN_TRIALS_BEFORE_EXPLOIT` 时强制探索
  - 测试 `updateVariantReward`：验证不可变更新，统计数据正确累加
  - 测试 `PromptEvolutionEngine` 类：
    - Mock 数据库，测试 `selectPrompt` 正确选择变体并记录历史
    - 测试 `recordFeedback` 正确更新变体奖励和 UCB 分数
    - 测试 `createVariant` 正确执行上限限制（第 6 个变体被拒绝）
    - 测试 `getVariantPerformance` 正确查询性能统计
- [ ] 运行 `pnpm --filter @lumii/agent-runtime exec vitest run autonomous/__tests__/prompt-evolution.test.ts` 并验证覆盖率 ≥ 80%。

**任务验收：** ε-greedy 策略与设计文档一致（epsilon=0.15），UCB 算法正确实现，变体池上限严格执行，奖励更新逻辑正确，测试覆盖率达标。

---

## 6. Task 5: 实现人格追踪与 EMA 更新

**文件：**

- Create `packages/agent-runtime/autonomous/personality-tracker.ts`
- Create `packages/agent-runtime/autonomous/personality-events.ts`
- Create `packages/agent-runtime/autonomous/__tests__/personality-tracker.test.ts`

**依赖：** Tasks 1-2。

### 6.1 实现人格事件记录器（personality-events.ts）

- [ ] 定义事件类型到人格影响的映射常量 `EVENT_PERSONALITY_IMPACT`：
  ```typescript
  const EVENT_PERSONALITY_IMPACT: Record<string, Partial<PersonalityState>> = {
    'goal-generated': { openness: 0.02, conscientiousness: 0.01 },       // 生成目标体现开放性和尽责性
    'evolution-decided': { openness: 0.03, conscientiousness: -0.01 },   // 进化决策体现开放性，略降尽责性（冒险）
    'user-feedback-positive': { agreeableness: 0.02, neuroticism: -0.02 }, // 正面反馈提升宜人性，降低神经质
    'user-feedback-negative': { neuroticism: 0.03, conscientiousness: 0.02 }, // 负面反馈提升神经质和尽责性（自我修正）
    'error-handled': { conscientiousness: 0.02, neuroticism: 0.01 },      // 错误处理体现尽责性，略增神经质
  }
  ```
- [ ] 导出 `recordPersonalityEvent(eventType: string, context: Record<string, any>, db: DatabaseClient): Promise<PersonalityEvent>` 函数：
  - 根据事件类型从 `EVENT_PERSONALITY_IMPACT` 获取人格增量
  - 构造 `PersonalityEvent` 对象（包含 eventType、timestamp、personalityDelta、triggerContext）
  - 持久化到数据库 `personality_events` 表
  - 返回事件对象

### 6.2 实现人格追踪器（personality-tracker.ts）

- [ ] 导出 `applyEMA(currentState: PersonalityState, delta: Partial<PersonalityState>, alpha: number): PersonalityState` 纯函数：
  - 对 Big Five 每个维度应用 EMA 更新：`newValue = currentValue + alpha * delta[dimension]`
  - 确保所有维度值限制在 [0, 1] 区间（使用 `Math.max(0, Math.min(1, newValue))`）
  - 返回更新后的人格状态（不可变更新）
- [ ] 导出 `PersonalityTracker` 类：
  - 构造函数注入 `config: PersonalityConfig` 和 `db: DatabaseClient`
  - 方法 `async getCurrentState(agentId: string): Promise<PersonalityState>`：
    - 从数据库查询当前人格状态（`personality_state` 表 `WHERE agent_id = ?`）
    - 若不存在，初始化默认状态（所有维度 0.5，中性状态）
    - 返回人格状态
  - 方法 `async updatePersonality(agentId: string, event: PersonalityEvent): Promise<PersonalityState>`：
    - 获取当前人格状态
    - 使用 `applyEMA` 应用事件带来的人格增量
    - 更新 `lastUpdated` 和 `updateCount`
    - 持久化到数据库 `personality_state` 表
    - 返回更新后的人格状态
  - 方法 `async getPersonalityHistory(agentId: string, limit: number): Promise<PersonalityEvent[]>`：查询最近 N 个人格事件
  - 方法 `async getPersonalityTrend(agentId: string, dimension: keyof PersonalityState, days: number): Promise<number[]>`：查询指定维度最近 N 天的趋势数据

### 6.3 测试优先实现与验收

- [ ] 编写 `personality-tracker.test.ts`：
  - 测试 `applyEMA`：
    - 验证 EMA 公式正确性（已知当前值和增量，计算预期新值）
    - 测试边界限制（增量导致值超出 [0, 1] 时正确截断）
    - 测试不可变更新（原对象不被修改）
  - 测试 `PersonalityTracker` 类：
    - Mock 数据库，测试 `getCurrentState` 正确初始化默认状态（首次）
    - 测试 `updatePersonality` 正确应用 EMA 更新并持久化
    - 测试多次更新：连续应用多个事件，验证累积效果
    - 测试 `getPersonalityHistory` 正确查询历史事件
    - 测试 `getPersonalityTrend` 正确提取维度趋势
  - 测试 `recordPersonalityEvent`：验证事件正确持久化且包含正确的人格增量
- [ ] 运行 `pnpm --filter @lumii/agent-runtime exec vitest run autonomous/__tests__/personality-tracker.test.ts` 并验证覆盖率 ≥ 80%。

**任务验收：** EMA 更新公式与设计文档一致（alpha=0.05），人格维度严格限制在 [0, 1] 区间，事件记录完整，趋势查询功能正常，测试覆盖率达标。

---

## 7. Task 6: 实现自主协调器（事件驱动调度）

**文件：**

- Create `packages/agent-runtime/autonomous/autonomous-coordinator.ts`
- Create `packages/agent-runtime/autonomous/__tests__/autonomous-coordinator.test.ts`

**依赖：** Tasks 1-5。

### 7.1 定义协调器架构

- [ ] 导出 `AutonomousCoordinator` 类，继承 `EventEmitter`：
  - 构造函数注入所有子模块：`metaCognitionEngine: MetaCognitionEngine`, `goalGenerator: IntrinsicGoalGenerator`, `promptEvolution: PromptEvolutionEngine`, `personalityTracker: PersonalityTracker`, `config: MVPScope`, `db: DatabaseClient`
  - 内部维护事件总线（使用 EventEmitter），支持以下事件：
    - `session:end` - 会话结束，触发满意度评分
    - `satisfaction:low` - 满意度低于阈值，触发目标生成
    - `goal:generated` - 目标生成完成，记录人格事件
    - `goal:approved` - 目标被用户批准，执行进化
    - `evolution:completed` - 进化完成，记录反馈
  - 方法 `initialize(): Promise<void>`：检查 `AUTONOMOUS_ENABLED` 配置，若禁用则跳过初始化
  - 方法 `shutdown(): Promise<void>`：清理所有事件监听器和数据库连接

### 7.2 实现核心协调流程

- [ ] 方法 `async onSessionEnd(session: AgentSession): Promise<void>`：
  - 调用 `metaCognitionEngine.evaluateSession(session)` 计算满意度评分
  - 记录 Telemetry（结构化日志）：`{ event: 'satisfaction-evaluated', sessionId, score, timestamp }`
  - 若 `shouldTriggerGoalGeneration(score, threshold)` 为 true，触发 `satisfaction:low` 事件
  - 调用 `promptEvolution.recordFeedback(variantId, score.overall)` 更新 Prompt 变体奖励
- [ ] 方法 `async onSatisfactionLow(score: SatisfactionScore, context: GoalGenerationContext): Promise<void>`：
  - 调用 `goalGenerator.generateGoals(score, context)` 生成目标
  - 记录 Telemetry：`{ event: 'goals-generated', count: goals.length, types: goals.map(g => g.type), timestamp }`
  - 对每个生成的目标触发 `goal:generated` 事件
  - 调用 `personalityTracker.updatePersonality(agentId, { eventType: 'goal-generated', ... })` 更新人格状态
- [ ] 方法 `async onGoalApproved(goal: AutonomousGoal): Promise<void>`：
  - 根据目标类型执行对应动作：
    - `learning`：调用 `promptEvolution.selectPrompt(baselinePromptId)` 选择最优 Prompt 变体
    - `proactive-message`：生成主动消息内容（暂时占位，P0 阶段仅记录日志）
  - 记录 Telemetry：`{ event: 'goal-executing', goalId, type, timestamp }`
  - 更新目标状态为 `EXECUTING`（数据库）
  - 调用 `personalityTracker.updatePersonality(agentId, { eventType: 'evolution-decided', ... })`
- [ ] 方法 `async onEvolutionCompleted(goalId: string, result: { success: boolean, satisfactionAfter?: number }): Promise<void>`：
  - 更新目标状态为 `COMPLETED` 或 `FAILED`（数据库）
  - 若成功，记录 `satisfactionAfter` 到 `autonomous_goals` 表
  - 记录 Telemetry：`{ event: 'evolution-completed', goalId, success, satisfactionDelta, timestamp }`
  - 触发 `evolution:completed` 事件

### 7.3 实现可观测性

- [ ] 方法 `async getCoordinationMetrics(): Promise<CoordinationMetrics>`：
  - 查询数据库统计信息：
    - 总满意度评分次数
    - 生成目标总数（按类型分组）
    - 目标审批率（approved / (approved + rejected)）
    - Prompt 进化成功率
    - 平均满意度提升（satisfactionAfter - satisfactionBefore）
  - 返回结构化指标对象
- [ ] 方法 `async getCoordinationHistory(limit: number): Promise<CoordinationEvent[]>`：
  - 查询 `evolution_coordination_history` 表最近 N 条记录
  - 返回协调事件历史（包含事件类型、时间戳、关联的 goalId/sessionId）

### 7.4 测试优先实现与验收

- [ ] 编写 `autonomous-coordinator.test.ts`：
  - Mock 所有子模块（`metaCognitionEngine`, `goalGenerator`, `promptEvolution`, `personalityTracker`）
  - 测试完整流程：
    - 会话结束 → 满意度评分 → 低满意度触发目标生成 → 用户批准 → 执行进化 → 记录完成
    - 验证每个步骤的事件顺序正确
    - 验证 Telemetry 记录完整（每个决策点都有日志）
    - 验证人格更新在正确时机被调用
  - 测试边界情况：
    - 满意度不低于阈值时不触发目标生成
    - 每日目标上限达到时拒绝生成新目标
    - 数据库失败时降级为日志记录，不抛出异常到调用方
  - 测试 `getCoordinationMetrics` 和 `getCoordinationHistory` 正确查询统计信息
- [ ] 运行 `pnpm --filter @lumii/agent-runtime exec vitest run autonomous/__tests__/autonomous-coordinator.test.ts` 并验证覆盖率 ≥ 80%。

**任务验收：** 协调器通过事件总线解耦所有子模块，完整流程端到端可追踪，Telemetry 覆盖所有决策点，数据库失败不影响核心流程，测试覆盖率达标。

---

## 8. Task 7: 创建数据库迁移脚本

**文件：**

- Create `packages/database/migrations/YYYYMMDDHHMMSS_autonomous_satisfaction_scores.sql`
- Create `packages/database/migrations/YYYYMMDDHHMMSS_autonomous_goals.sql`
- Create `packages/database/migrations/YYYYMMDDHHMMSS_prompt_evolution_history.sql`
- Create `packages/database/migrations/YYYYMMDDHHMMSS_prompt_variants.sql`
- Create `packages/database/migrations/YYYYMMDDHHMMSS_personality_events.sql`
- Create `packages/database/migrations/YYYYMMDDHHMMSS_personality_state.sql`
- Create `packages/database/migrations/YYYYMMDDHHMMSS_evolution_coordination_history.sql`

**依赖：** Task 1（类型定义）。

### 8.1 实现数据库表 Schema（严格遵循设计文档 6-实施计划.md）

- [ ] 创建 `autonomous_satisfaction_scores` 表：
  ```sql
  CREATE TABLE autonomous_satisfaction_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL,
    agent_id VARCHAR(255) NOT NULL,
    task_completion DECIMAL(3, 2) NOT NULL CHECK (task_completion BETWEEN 0 AND 1),
    user_feedback DECIMAL(3, 2) NOT NULL CHECK (user_feedback BETWEEN 0 AND 1),
    efficiency DECIMAL(3, 2) NOT NULL CHECK (efficiency BETWEEN 0 AND 1),
    knowledge_growth DECIMAL(3, 2) NOT NULL CHECK (knowledge_growth BETWEEN 0 AND 1),
    overall_score DECIMAL(3, 2) NOT NULL CHECK (overall_score BETWEEN 0 AND 1),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    INDEX idx_agent_created (agent_id, created_at DESC),
    INDEX idx_session (session_id)
  );
  ```
- [ ] 创建 `autonomous_goals` 表：
  ```sql
  CREATE TABLE autonomous_goals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('learning', 'proactive-message')),
    description TEXT NOT NULL,
    trigger_reason VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executing', 'completed', 'failed')),
    priority DECIMAL(3, 2) NOT NULL CHECK (priority BETWEEN 0 AND 1),
    satisfaction_before DECIMAL(3, 2),
    satisfaction_after DECIMAL(3, 2),
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    approved_at TIMESTAMP WITH TIME ZONE,
    executed_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    INDEX idx_agent_status_created (agent_id, status, created_at DESC),
    INDEX idx_created_at (created_at DESC)
  );
  ```
- [ ] 创建 `prompt_variants` 表：
  ```sql
  CREATE TABLE prompt_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    baseline_prompt_id VARCHAR(255) NOT NULL,
    variant_text TEXT NOT NULL,
    is_baseline BOOLEAN DEFAULT FALSE,
    trial_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    total_reward DECIMAL(10, 4) DEFAULT 0,
    avg_satisfaction DECIMAL(3, 2),
    ucb_score DECIMAL(10, 4),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    INDEX idx_baseline (baseline_prompt_id),
    INDEX idx_baseline_ucb (baseline_prompt_id, ucb_score DESC)
  );
  ```
- [ ] 创建 `prompt_evolution_history` 表：
  ```sql
  CREATE TABLE prompt_evolution_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id UUID NOT NULL REFERENCES prompt_variants(id),
    event_type VARCHAR(50) NOT NULL CHECK (event_type IN ('selected', 'feedback-recorded')),
    exploration_mode VARCHAR(50) CHECK (exploration_mode IN ('explore', 'exploit')),
    satisfaction DECIMAL(3, 2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    INDEX idx_variant_created (variant_id, created_at DESC)
  );
  ```
- [ ] 创建 `personality_state` 表：
  ```sql
  CREATE TABLE personality_state (
    agent_id VARCHAR(255) PRIMARY KEY,
    openness DECIMAL(3, 2) NOT NULL DEFAULT 0.5 CHECK (openness BETWEEN 0 AND 1),
    conscientiousness DECIMAL(3, 2) NOT NULL DEFAULT 0.5 CHECK (conscientiousness BETWEEN 0 AND 1),
    extraversion DECIMAL(3, 2) NOT NULL DEFAULT 0.5 CHECK (extraversion BETWEEN 0 AND 1),
    agreeableness DECIMAL(3, 2) NOT NULL DEFAULT 0.5 CHECK (agreeableness BETWEEN 0 AND 1),
    neuroticism DECIMAL(3, 2) NOT NULL DEFAULT 0.5 CHECK (neuroticism BETWEEN 0 AND 1),
    update_count INTEGER DEFAULT 0,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  );
  ```
- [ ] 创建 `personality_events` 表：
  ```sql
  CREATE TABLE personality_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    personality_delta JSONB NOT NULL,
    trigger_context JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    INDEX idx_agent_created (agent_id, created_at DESC)
  );
  ```
- [ ] 创建 `evolution_coordination_history` 表：
  ```sql
  CREATE TABLE evolution_coordination_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(100) NOT NULL,
    agent_id VARCHAR(255) NOT NULL,
    goal_id UUID,
    session_id UUID,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    INDEX idx_agent_created (agent_id, created_at DESC),
    INDEX idx_goal (goal_id)
  );
  ```

### 8.2 编写回滚脚本（每个迁移文件的 down 部分）

- [ ] 为每个表编写 `DROP TABLE` 语句（包含 `IF EXISTS` 和 `CASCADE`）
- [ ] 确保回滚脚本顺序正确（先删除有外键依赖的表，最后删除被引用的表）

### 8.3 测试与验收

- [ ] 在本地测试环境运行所有 up 迁移脚本，验证表创建成功
- [ ] 运行 down 迁移脚本，验证表删除成功且无残留
- [ ] 验证所有索引创建成功（使用 `\d <table_name>` 或 `SHOW INDEX`）
- [ ] 验证所有约束生效（插入超出范围的值应被拒绝）
- [ ] 验证 `CHECK` 约束正确（例如 `overall_score BETWEEN 0 AND 1`，插入 1.5 应失败）

**任务验收：** 所有表 Schema 与设计文档完全一致，约束正确生效，索引优化查询性能，回滚脚本可用，迁移脚本在本地测试通过。

---

## 9. Task 8: 集成到现有 Agent Runtime

**文件：**

- Modify `packages/agent-runtime/core/session-manager.ts`
- Modify `packages/agent-runtime/core/agent.ts`
- Modify `packages/agent-runtime/index.ts`

**依赖：** Tasks 1-7。

### 9.1 在 Session Manager 中集成满意度评分

- [ ] 在 `session-manager.ts` 中导入 `AutonomousCoordinator`
- [ ] 在 `SessionManager` 类中添加可选的 `autonomousCoordinator?: AutonomousCoordinator` 属性
- [ ] 在会话结束方法 `endSession(sessionId: string)` 中添加钩子：
  ```typescript
  async endSession(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId)
    // ... 现有结束逻辑
    
    // 自主进化钩子（非阻塞）
    if (this.autonomousCoordinator && AUTONOMOUS_ENABLED) {
      void this.autonomousCoordinator.onSessionEnd(session).catch(err => {
        logger.error('Autonomous evaluation failed', { sessionId, error: err.message })
      })
    }
  }
  ```
- [ ] 确保钩子是非阻塞的（使用 `void` + `.catch`），失败不影响会话正常结束

### 9.2 在 Agent 类中集成 Prompt 选择

- [ ] 在 `agent.ts` 中导入 `PromptEvolutionEngine`
- [ ] 在 Agent 构造函数中添加可选的 `promptEvolution?: PromptEvolutionEngine` 参数
- [ ] 在 Prompt 加载方法中添加变体选择逻辑：
  ```typescript
  async loadPrompt(baselinePromptId: string): Promise<string> {
    let promptText: string
    
    // 自主进化：选择最优 Prompt 变体
    if (this.promptEvolution && AUTONOMOUS_ENABLED) {
      try {
        const variant = await this.promptEvolution.selectPrompt(baselinePromptId)
        promptText = variant.variantText
        this.currentVariantId = variant.id // 记录当前使用的变体 ID
      } catch (err) {
        logger.warn('Prompt evolution failed, using baseline', { error: err.message })
        promptText = await this.getBaselinePrompt(baselinePromptId)
      }
    } else {
      promptText = await this.getBaselinePrompt(baselinePromptId)
    }
    
    return promptText
  }
  ```
- [ ] 确保失败时降级到基线 Prompt，不影响 Agent 正常运行

### 9.3 导出公开接口

- [ ] 在 `packages/agent-runtime/index.ts` 中导出自主能力模块：
  ```typescript
  // 自主进化 Agent 能力
  export { AutonomousCoordinator } from './autonomous/autonomous-coordinator'
  export { MetaCognitionEngine } from './autonomous/meta-cognition-engine'
  export { IntrinsicGoalGenerator } from './autonomous/intrinsic-goal-generator'
  export { PromptEvolutionEngine } from './autonomous/prompt-evolution'
  export { PersonalityTracker } from './autonomous/personality-tracker'
  
  // 类型导出
  export type {
    SatisfactionScore,
    AutonomousGoal,
    PromptVariant,
    PersonalityState,
    MVPScope,
  } from './autonomous/types'
  
  // 配置常量导出
  export {
    SATISFACTION_WEIGHTS,
    SATISFACTION_THRESHOLD,
    EPSILON,
    MAX_GOALS_PER_DAY,
    AUTONOMOUS_ENABLED,
  } from './autonomous/config'
  ```

### 9.4 测试与验收

- [ ] 编写集成测试 `autonomous/__tests__/integration/agent-runtime-integration.test.ts`：
  - 创建完整的 Agent Runtime 实例（包含自主协调器）
  - 模拟会话结束，验证满意度评分被自动触发
  - 模拟低满意度场景，验证目标生成流程
  - 验证 Prompt 选择时正确调用进化引擎
  - 验证失败降级逻辑（数据库不可用时仍能正常运行）
- [ ] 运行现有 Agent Runtime 测试套件，确保无回归：
  ```powershell
  pnpm --filter @lumii/agent-runtime test
  ```
- [ ] 运行类型检查：
  ```powershell
  pnpm --filter @lumii/agent-runtime typecheck
  ```

**任务验收：** 自主能力通过事件钩子无侵入式集成到现有 Agent Runtime，失败降级保证稳定性，公开接口清晰完整，现有测试无回归，类型检查通过。

---

## 10. Task 9: 端到端测试与可观测性验证

**文件：**

- Create `packages/agent-runtime/autonomous/__tests__/integration/autonomous-e2e.test.ts`
- 无新增生产代码文件

**依赖：** Tasks 1-8。

### 10.1 编写端到端测试场景

- [ ] **场景 1：低满意度触发学习目标**
  - 模拟会话结束，满意度评分 0.5（低于阈值 0.6）
  - 验证生成学习型目标（类型为 learning）
  - 验证目标状态为 PENDING，等待用户审批
  - 模拟用户批准目标
  - 验证 Prompt 进化引擎被调用，选择最优变体
  - 验证人格事件记录（goal-generated 和 evolution-decided）
  - 验证目标状态更新为 EXECUTING → COMPLETED
  - 验证 Telemetry 记录完整（每个步骤都有日志）

- [ ] **场景 2：高满意度不触发目标生成**
  - 模拟会话结束，满意度评分 0.85（高于阈值）
  - 验证未生成新目标
  - 验证 Prompt 变体奖励被更新（满意度作为奖励信号）
  - 验证无 goal-generated 人格事件

- [ ] **场景 3：每日目标上限限制**
  - 模拟连续 3 次低满意度会话
  - 验证生成 3 个目标后，第 4 次会话不再生成新目标
  - 验证 Telemetry 记录"达到每日上限"事件

- [ ] **场景 4：Prompt 进化的探索与利用**
  - 初始化 5 个 Prompt 变体（不同性能）
  - 模拟 100 次 Prompt 选择
  - 验证探索率约为 15%（epsilon=0.15，允许 ±5% 误差）
  - 验证利用模式下选择最高 UCB 分数的变体
  - 验证所有变体至少被试验 10 次后才开始利用

- [ ] **场景 5：人格状态演化**
  - 初始化中性人格状态（所有维度 0.5）
  - 依次触发事件：goal-generated → evolution-decided → user-feedback-positive
  - 验证人格维度变化符合 EMA 更新（alpha=0.05）
  - 验证所有维度值始终在 [0, 1] 区间
  - 验证 `updateCount` 正确累加

### 10.2 验证可观测性（Telemetry）

- [ ] 编写测试验证所有决策点都记录 Telemetry：
  - `satisfaction-evaluated`：包含 sessionId、score、timestamp
  - `goals-generated`：包含 count、types、timestamp
  - `goal-executing`：包含 goalId、type、timestamp
  - `prompt-selected`：包含 variantId、explorationMode、timestamp
  - `evolution-completed`：包含 goalId、success、satisfactionDelta、timestamp
- [ ] 验证 Telemetry 格式为结构化 JSON，可直接导入日志分析工具
- [ ] 验证敏感数据不出现在 Telemetry 中（用户消息原文、API Key、Prompt 全文）

### 10.3 性能与资源验收

- [ ] 验证满意度评分计算耗时 < 50ms（纯计算，不含数据库 I/O）
- [ ] 验证 Prompt 选择耗时 < 100ms（含数据库查询 1 次）
- [ ] 验证人格更新耗时 < 30ms（纯计算 + 数据库更新 1 次）
- [ ] 验证内存开销：协调器实例 < 10MB，变体池（5 个变体）< 1MB
- [ ] 验证数据库查询次数：每次会话结束触发 ≤ 5 次查询（满意度插入、目标查询、变体更新、人格更新、历史记录）

### 10.4 故障注入测试

- [ ] 数据库连接失败：验证降级为日志记录，不抛出异常到调用方
- [ ] 数据库查询超时：验证使用本地缓存或默认值
- [ ] Prompt 变体池为空：验证降级到基线 Prompt
- [ ] 满意度评分计算异常：验证返回中性分数 0.5

**任务验收：** 端到端测试覆盖所有核心流程，可观测性验证 Telemetry 完整且安全，性能符合预期，故障注入测试通过，所有测试通过率 100%。

---

## 11. Task 10: 实验追踪与灰度发布验证

**文件：**

- Create `docs/autonomous-experiment-tracking.md`（实验追踪文档）
- 无新增代码文件

**依赖：** Tasks 1-9。

### 11.1 编写实验追踪文档

- [ ] 记录实验参数配置（作为 baseline）：
  ```markdown
  ## Baseline 参数配置
  
  - 满意度权重：task=0.35, feedback=0.30, efficiency=0.20, knowledge=0.15
  - 满意度阈值：0.6
  - ε-greedy 探索率：0.15
  - 最大变体数：5
  - 最小试验次数：10
  - UCB 置信度：2.0
  - EMA alpha：0.05
  - 每日目标上限：3
  
  **来源：** `docs/design/自主进化Agent/2-元认知引擎算法.md`
  ```

- [ ] 定义实验指标（KPI）：
  - **核心指标**：
    - 平均满意度提升率：`(satisfactionAfter - satisfactionBefore) / satisfactionBefore`
    - 目标审批率：`approved / (approved + rejected)`
    - Prompt 进化成功率：`successCount / trialCount`（满意度 > 0.6 算成功）
    - 人格状态稳定性：Big Five 各维度的方差（越小越稳定）
  - **辅助指标**：
    - 目标生成频率（每日平均）
    - 探索率实际值（应接近 0.15）
    - 数据库查询耗时 p95
    - 协调器事件处理耗时 p95

- [ ] 定义实验追踪流程：
  ```markdown
  ## 实验追踪流程
  
  1. **Baseline 阶段**（第 1-2 周）：
     - 使用默认参数运行，收集基线数据
     - 监控所有核心指标和辅助指标
     - 记录异常情况和用户反馈
  
  2. **参数调优阶段**（第 3-4 周）：
     - 实验变量：epsilon（0.1, 0.15, 0.2），满意度阈值（0.5, 0.6, 0.7）
     - 使用 A/B 测试，每组 ≥ 100 次会话
     - 记录每组的核心指标对比
  
  3. **灰度发布阶段**（第 5-6 周）：
     - 逐步扩大启用范围：10% → 30% → 50% → 100%
     - 每个阶段运行 3 天，监控稳定性指标
     - 出现回归立即回滚
  
  4. **长期监控阶段**（第 7 周起）：
     - 每周生成实验报告
     - 追踪满意度趋势、目标完成率、用户反馈
     - 定期审查参数是否需要调整
  ```

### 11.2 实现灰度发布开关

- [ ] 验证环境变量 `AUTONOMOUS_ENABLED` 正确控制全局开关：
  - 设置 `AUTONOMOUS_ENABLED=false`，重启 Agent Runtime
  - 验证不初始化协调器，不触发满意度评分，不生成目标
  - 验证现有 Agent 功能完全不受影响

- [ ] 验证环境变量 `AUTONOMOUS_GOAL_TYPES` 正确控制目标类型白名单：
  - 设置 `AUTONOMOUS_GOAL_TYPES=learning`，重启
  - 验证仅生成 learning 类型目标，不生成 proactive-message 类型
  - 设置 `AUTONOMOUS_GOAL_TYPES=proactive-message`
  - 验证仅生成 proactive-message 类型目标

- [ ] 编写灰度发布脚本（可选，用于自动化部署）：
  ```bash
  # deploy-autonomous-gradual.sh
  # 10% 流量
  export AUTONOMOUS_ENABLED=true
  export AUTONOMOUS_ROLLOUT_PERCENTAGE=10
  # 部署到 10% 实例...
  
  # 监控 3 天后扩大到 30%
  export AUTONOMOUS_ROLLOUT_PERCENTAGE=30
  # ...
  ```

### 11.3 验收标准

- [ ] 实验追踪文档完整，包含参数配置、KPI 定义、追踪流程
- [ ] 灰度发布开关验证通过（可完全禁用自主能力）
- [ ] 目标类型白名单验证通过（可独立控制每种目标类型）
- [ ] 实验数据可导出为 CSV/JSON 格式（用于离线分析）

**任务验收：** 实验追踪文档完整可执行，灰度发布机制可靠，参数可按需调整，数据可导出分析，回滚预案经过验证。

---

## 12. 实施顺序与提交边界

按以下顺序执行任务，每个任务完成后创建独立提交：

1. **Task 1**：类型定义与配置 → `feat(autonomous): add types and config for autonomous agent MVP`
2. **Task 2**：满意度评分 → `feat(autonomous): implement satisfaction scoring and metrics collection`
3. **Task 3**：目标生成 → `feat(autonomous): implement intrinsic goal generation`
4. **Task 4**：Prompt 进化 → `feat(autonomous): implement prompt evolution with ε-greedy`
5. **Task 5**：人格追踪 → `feat(autonomous): implement personality tracking with EMA`
6. **Task 6**：自主协调器 → `feat(autonomous): implement autonomous coordinator`
7. **Task 7**：数据库迁移 → `feat(autonomous): add database migrations for 7 tables`
8. **Task 8**：集成到 Agent Runtime → `feat(autonomous): integrate autonomous capabilities into agent runtime`
9. **Task 9**：端到端测试 → `test(autonomous): add e2e tests and observability validation`
10. **Task 10**：实验追踪 → `docs(autonomous): add experiment tracking and gradual rollout plan`

每次提交前运行：
```powershell
pnpm --filter @lumii/agent-runtime test
pnpm --filter @lumii/agent-runtime typecheck
pnpm --filter @lumii/database test  # 仅 Task 7
```

---

## 13. 漂移防护检查清单

- [ ] 实施前，确认所有算法参数与设计文档一致（满意度权重、epsilon、Elo K、EMA alpha、UCB confidence）。
- [ ] 每次编辑算法代码前，验证参数来自 `config.ts`，不在业务代码中硬编码。
- [ ] 每次数据库操作前，验证失败时降级为日志记录，不抛出异常到调用方。
- [ ] 每次集成到现有代码前，验证使用事件钩子（非阻塞），失败不影响现有功能。
- [ ] 完成前，验证 `AUTONOMOUS_ENABLED=false` 时完全禁用自主能力，现有 Agent 零影响。
- [ ] 完成前，验证所有 Telemetry 不包含敏感数据（用户消息原文、API Key、Prompt 全文）。
- [ ] 搜索最终 diff 中是否存在 `any` 类型、硬编码参数、未捕获的异常、缺失的测试。
- [ ] 验证所有测试覆盖率 ≥ 80%，端到端测试通过率 100%。

---

## 14. 成功指标

MVP P0 验收标准：

1. **功能完整性**：
   - 满意度评分在每次会话结束后自动触发
   - 低满意度（< 0.6）自动生成目标（learning 或 proactive-message）
   - Prompt 进化使用 ε-greedy 策略选择最优变体
   - 人格状态通过 EMA 持续更新

2. **算法一致性**：
   - 满意度评分公式与设计文档完全一致（权重验证通过）
   - ε-greedy 探索率实际值为 15%（±5% 误差范围）
   - UCB 算法正确实现（未试验变体优先，利用模式选择最高分）
   - EMA 更新公式正确（alpha=0.05，维度值限制在 [0, 1]）

3. **工程质量**：
   - 所有单元测试覆盖率 ≥ 80%
   - 端到端测试通过率 100%
   - 性能指标达标（评分 < 50ms，选择 < 100ms，更新 < 30ms）
   - 数据库迁移可回滚

4. **可观测性**：
   - 所有决策点记录 Telemetry
   - Telemetry 格式为结构化 JSON
   - 无敏感数据泄漏

5. **稳定性**：
   - `AUTONOMOUS_ENABLED=false` 时零影响
   - 数据库失败时降级为日志记录，不阻塞业务
   - 现有 Agent Runtime 测试无回归

---

## 15. 风险缓解

| 风险 | 影响 | 缓解措施 | 验证方式 |
|------|------|----------|----------|
| 算法参数不准确导致性能不佳 | 高 | 参数集中配置，支持运行时调整，灰度发布验证 | 实验追踪文档，A/B 测试对比 |
| 数据库性能瓶颈 | 中 | 索引优化，查询次数限制（≤ 5 次/会话），异步非阻塞 | 性能测试，p95 耗时监控 |
| 与现有 Agent 功能冲突 | 高 | 事件钩子解耦，失败降级，独立测试套件 | 集成测试，回归测试 |
| 用户隐私泄漏 | 高 | Telemetry 过滤敏感数据，测试验证 | 端到端测试场景 5，人工审查日志 |
| 每日目标上限失效导致目标泛滥 | 中 | 数据库约束 + 代码双重检查，单元测试覆盖 | 集成测试场景 3 |
| Prompt 进化导致质量下降 | 中 | 保留基线 Prompt，失败降级，满意度作为奖励信号自动淘汰差变体 | 端到端测试场景 4，长期监控 |

---

## 16. 后续迭代（P1-P3，不在 MVP 范围）

**P1（第 7-10 周）**：
- 实现能力边界检测（Elo Rating System）
- 实现自我反思（ReflectionOutput 接口）
- 记忆进化（Learning-to-Rank）

**P2（第 11-14 周）**：
- 技能进化（Thompson Sampling）
- 工具进化（UCB1）
- 多层协同（Shapley Value 贡献归因）

**P3（第 15-18 周）**：
- 人格主动进化（不仅追踪，还主动调整）
- 协同探索调度（Coordinated Exploration Scheduling）
- Pareto 前沿多目标优化

当前 MVP P0 专注于建立自主闭环的最小可行路径，验证核心算法正确性和工程化保障机制，为后续迭代奠定基础。
