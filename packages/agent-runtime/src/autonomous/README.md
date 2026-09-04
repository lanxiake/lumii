# 自主进化 Agent MVP P0

## 概述

自主进化 Agent 系统为 Lumii Agent Runtime 提供了自主学习和进化能力。MVP P0 实现了核心闭环：**元认知感知 → 目标生成 → 进化执行 → 人格记录**。

## 核心能力

### 1. 满意度评分（Meta-Cognition）

自动评估每个会话的质量，基于四个维度：

- **任务完成度** (35%): 错误率、工具调用成功率
- **用户反馈** (30%): 用户交互频率
- **效率** (20%): 平均响应时间
- **知识增长** (15%): 知识查询频率

**触发阈值**: 低于 0.6 时触发内在目标生成

### 2. 内在目标生成（Intrinsic Goal Generation）

根据低满意度自动生成两类目标：

- **学习型目标** (`learning`): 针对最弱维度生成学习任务
- **主动消息目标** (`proactive-message`): 用户长时间无交互时主动汇报进展

**限制**: 每日最多 3 个目标，所有目标需用户审批（P0 阶段）

### 3. Prompt 进化（Prompt Evolution）

使用 **ε-greedy** 策略和 **多臂老虎机算法（UCB）** 选择最优 Prompt 变体：

- **探索率**: 15% (ε = 0.15)
- **变体池上限**: 每个基线 Prompt 最多 5 个变体
- **最小试验次数**: 10 次后开始利用最优变体
- **UCB 置信度**: 2.0

满意度分数作为奖励信号，自动淘汰表现差的变体。

### 4. 人格追踪（Personality Tracking）

使用 **Big Five 模型** 和 **EMA（指数移动平均）** 追踪 Agent 人格演化：

- **五大人格维度**: 开放性、尽责性、外向性、宜人性、神经质
- **EMA 系数**: α = 0.05（平滑更新）
- **事件驱动**: 目标生成、进化决策、用户反馈、错误处理等事件影响人格

## 快速开始

### 初始化

```typescript
import {
  AutonomousCoordinator,
  MetaCognitionEngine,
  IntrinsicGoalGenerator,
  PromptEvolutionEngine,
  PersonalityTracker,
  SATISFACTION_WEIGHTS,
  SATISFACTION_THRESHOLD,
} from '@mtbot/agent-runtime';

// 初始化数据库客户端
const db = createDatabaseClient();

// 创建子模块
const metaCognitionEngine = new MetaCognitionEngine(
  {
    satisfactionWeights: SATISFACTION_WEIGHTS,
    satisfactionThreshold: SATISFACTION_THRESHOLD,
    reflectionTrigger: 'scheduled',
    capabilityTracking: 'manual',
  },
  db
);

const goalGenerator = new IntrinsicGoalGenerator(
  {
    enabledTypes: ['learning', 'proactive-message'],
    userApproval: 'always',
    maxGoalsPerDay: 3,
    priorityWeights: { satisfactionGap: 0.7, dimensionGap: 0.3 },
  },
  db
);

const promptEvolution = new PromptEvolutionEngine(
  {
    epsilon: 0.15,
    maxVariantsPerPrompt: 5,
    minTrialsBeforeExploit: 10,
    ucbConfidence: 2.0,
  },
  db
);

const personalityTracker = new PersonalityTracker(
  {
    emaAlpha: 0.05,
    eventWeights: {},
    trackingEnabled: true,
    evolutionEnabled: false,
  },
  db
);

// 初始化协调器
const coordinator = new AutonomousCoordinator(
  metaCognitionEngine,
  goalGenerator,
  promptEvolution,
  personalityTracker,
  mvpConfig,
  db
);

await coordinator.initialize();
```

### 集成到 Agent Runtime

```typescript
// 在会话结束时触发满意度评分
sessionManager.on('session:end', async (session) => {
  if (AUTONOMOUS_ENABLED) {
    await coordinator.onSessionEnd(session).catch((err) => {
      console.error('自主评估失败:', err);
    });
  }
});

// 在 Prompt 加载时选择最优变体
async function loadPrompt(baselinePromptId: string): Promise<string> {
  if (AUTONOMOUS_ENABLED) {
    try {
      const variant = await promptEvolution.selectPrompt(baselinePromptId);
      return variant.variantText;
    } catch (err) {
      console.warn('Prompt 进化失败，使用基线版本');
    }
  }
  return getBaselinePrompt(baselinePromptId);
}
```

## 配置

### 环境变量

- `AUTONOMOUS_ENABLED`: 全局开关（默认 `true`）
- `AUTONOMOUS_GOAL_TYPES`: 允许的目标类型，逗号分隔（默认 `learning,proactive-message`）

### 算法参数

所有参数在 `src/autonomous/config.ts` 中集中定义：

```typescript
export const SATISFACTION_WEIGHTS = {
  task: 0.35,
  feedback: 0.30,
  efficiency: 0.20,
  knowledge: 0.15,
};

export const SATISFACTION_THRESHOLD = 0.6;
export const EPSILON = 0.15;
export const MAX_VARIANTS_PER_PROMPT = 5;
export const MIN_TRIALS_BEFORE_EXPLOIT = 10;
export const UCB_CONFIDENCE = 2.0;
export const EMA_ALPHA = 0.05;
export const MAX_GOALS_PER_DAY = 3;
```

## 数据库 Schema

自主进化系统使用 7 张表（Schema V28）：

1. **autonomous_satisfaction_scores**: 满意度评分历史
2. **autonomous_goals**: 自主生成的目标
3. **prompt_variants**: Prompt 变体池
4. **prompt_evolution_history**: Prompt 进化历史
5. **personality_state**: Agent 人格状态
6. **personality_events**: 人格事件记录
7. **evolution_coordination_history**: 协调事件历史

## 可观测性

### Telemetry

所有决策点记录结构化日志（JSON 格式）：

```json
{
  "event": "satisfaction-evaluated",
  "sessionId": "session123",
  "agentId": "agent1",
  "score": 0.75,
  "dimensions": {
    "task": 0.8,
    "feedback": 0.7,
    "efficiency": 0.75,
    "knowledge": 0.7
  },
  "timestamp": "2026-09-04T12:00:00Z"
}
```

### 指标查询

```typescript
// 获取协调指标
const metrics = await coordinator.getCoordinationMetrics();
console.log(metrics);
// {
//   totalEvaluations: 100,
//   goalsGenerated: { learning: 15, "proactive-message": 5 },
//   approvalRate: 0.75,
//   evolutionSuccessRate: 0.82,
//   avgSatisfactionImprovement: 0.18
// }

// 获取协调历史
const history = await coordinator.getCoordinationHistory(20);
```

## 测试

```bash
# 运行所有测试
pnpm --filter @mtbot/agent-runtime test autonomous/

# 运行单元测试
pnpm test autonomous/__tests__/config.test.ts
pnpm test autonomous/__tests__/meta-cognition-engine.test.ts
pnpm test autonomous/__tests__/intrinsic-goal-generator.test.ts
pnpm test autonomous/__tests__/prompt-evolution.test.ts
pnpm test autonomous/__tests__/personality-tracker.test.ts

# 运行集成测试
pnpm test autonomous/__tests__/integration/
```

**测试覆盖率**: 84 个测试，覆盖率 ≥ 80%

## MVP P0 范围

当前实现的功能：

✅ 满意度评分（四维度加权）  
✅ 目标生成（learning + proactive-message）  
✅ Prompt 进化（ε-greedy + UCB）  
✅ 人格追踪（Big Five + EMA）  
✅ 事件驱动协调器  
✅ 数据库持久化  
✅ 可观测性（Telemetry）  
✅ 灰度发布支持  

**不在 P0 范围**：

- ❌ 能力边界检测（Elo Rating）
- ❌ 自我反思（ReflectionOutput）
- ❌ 记忆进化（Learning-to-Rank）
- ❌ 技能进化（Thompson Sampling）
- ❌ 工具进化（UCB1）
- ❌ 人格主动进化

## 设计文档

完整设计参考：

- `docs/design/自主进化Agent/1-顶层设计.md`
- `docs/design/自主进化Agent/2-元认知引擎算法.md`
- `docs/design/自主进化Agent/3-内在目标生成器.md`
- `docs/design/自主进化Agent/4-Prompt进化引擎.md`
- `docs/design/自主进化Agent/5-人格追踪系统.md`
- `docs/design/自主进化Agent/6-实施计划.md`

## 故障降级

所有自主能力失败时降级为日志记录，**不阻塞现有 Agent 核心功能**：

- 数据库失败：仅记录日志，评分仍返回
- Prompt 选择失败：降级到基线 Prompt
- 目标生成失败：返回空数组
- 人格更新失败：返回当前状态

## 灰度发布

```bash
# 完全禁用
export AUTONOMOUS_ENABLED=false

# 仅启用学习型目标
export AUTONOMOUS_GOAL_TYPES=learning

# 逐步扩大范围
# 10% -> 30% -> 50% -> 100%
```

## 性能基准

- 满意度评分计算: < 50ms
- Prompt 变体选择: < 100ms（含 1 次数据库查询）
- 人格状态更新: < 30ms
- 协调器事件处理: < 200ms

## 安全与隐私

- ✅ Telemetry 不记录用户消息原文
- ✅ Telemetry 不记录 API Key
- ✅ Telemetry 不记录 Prompt 全文
- ✅ 仅记录元数据（长度、类型、摘要 hash）

## 贡献

欢迎贡献！请确保：

1. 所有新功能都有对应的单元测试（覆盖率 ≥ 80%）
2. 算法参数在 `config.ts` 中集中定义
3. 数据库操作失败时降级处理
4. Telemetry 不泄漏敏感数据

## 许可证

与主项目相同
