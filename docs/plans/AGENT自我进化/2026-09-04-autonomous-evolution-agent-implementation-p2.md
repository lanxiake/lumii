# P2 实施计划：多层进化协同

> **日期**：2026-09-04  
> **依赖**：P0（满意度评分、目标生成、Prompt 进化、人格追踪）已完成，P1（能力边界、自我反思）已完成  
> **状态**：设计阶段  
> **实施周期**：第 11-14 周（4 周，约 80 小时）

---

## 一、P2 范围与目标

### 1.1 核心能力扩展

P2 在 P0/P1 基础上新增**多层进化协同**能力，实现四个进化维度的统一优化：

1. **记忆策略进化（Memory Evolution）**
   - 使用 Learning-to-Rank 算法优化记忆检索策略
   - 根据记忆使用反馈动态调整权重
   - 识别无效记忆并触发清理

2. **技能策略进化（Skill Evolution）**
   - 根据能力缺口自动提出技能改进建议
   - 跟踪技能使用效果并优化选择策略

3. **工具选择进化（Tool Evolution）**
   - 使用 Thompson Sampling 算法优化工具选择
   - 自适应学习不同场景下的最优工具

4. **多层协同调度（Coordinated Evolution）**
   - 使用 Shapley Value 归因各层贡献
   - 协同探索调度（避免同时探索多层）
   - 冲突检测与自动修复
   - 帕累托前沿维护（多目标优化）

### 1.2 与 P0/P1 的集成关系

```
P0（已完成）：
  - 满意度评分 ✓
  - Prompt 进化（ε-greedy）✓
  - 人格追踪 ✓
  - 目标生成器 ✓

P1（已完成）：
  - 能力边界检测（Elo Rating）✓
  - 自我反思引擎（LLM）✓
  - 能力改进目标 ✓

P2（新增）：
  - 记忆策略进化 → 提升检索效率
  - 技能策略进化 → 扩展能力范围
  - 工具选择进化 → 优化执行效率
  - 多层协同 → 避免层间冲突，全局优化

协同效果：
  P0: Prompt 进化
  P1: 能力边界 + 反思
  P2: Memory + Skill + Tool 进化 + 全局协调
  → 四层统一优化，避免局部最优
```

### 1.3 MVP P2 范围定义

```typescript
export interface P2Scope {
  metaCognition: {
    satisfactionScoring: true;           // P0
    capabilityTracking: 'auto';          // P1
    reflectionTrigger: 'scheduled';      // P1
    multiLayerAttribution: true;         // P2 新增：多层贡献归因
  };
  
  goalGeneration: {
    types: [
      'learning',                         // P0
      'proactive-message',               // P0
      'capability-improvement',          // P1
      'skill-enhancement',               // P2 新增
      'memory-optimization'              // P2 新增
    ];
    userApproval: 'always';
    maxGoalsPerDay: 7;                   // P2 提升上限（从 5 到 7）
  };
  
  evolution: {
    prompt: true;                        // P0（ε-greedy）
    memory: true;                        // P2 新增（Learning-to-Rank）
    skill: true;                         // P2 新增（效果跟踪）
    tool: true;                          // P2 新增（Thompson Sampling）
    coordinated: true;                   // P2 新增（协同调度）
  };
  
  personality: {
    tracking: true;                      // P0
    evolution: true;                     // P2 启用（基于 P0/P1 积累的事件数据）
    display: true;
  };
}
```

---

## 二、架构设计

### 2.1 新增模块

```text
packages/agent-runtime/src/autonomous/
  memory-evolution.ts                # 记忆策略进化器
  memory-ranking-model.ts            # Learning-to-Rank 模型
  skill-evolution.ts                 # 技能策略进化器
  tool-evolution.ts                  # 工具选择进化器
  tool-thompson-sampling.ts          # Thompson Sampling 算法
  coordinated-scheduler.ts           # 协同探索调度器
  shapley-attribution.ts             # Shapley Value 贡献归因
  conflict-detector.ts               # 冲突检测器
  pareto-frontier.ts                 # 帕累托前沿维护
  
  __tests__/
    memory-evolution.test.ts
    memory-ranking-model.test.ts
    skill-evolution.test.ts
    tool-evolution.test.ts
    tool-thompson-sampling.ts.test.ts
    coordinated-scheduler.test.ts
    shapley-attribution.test.ts
    conflict-detector.test.ts
    pareto-frontier.test.ts
```

### 2.2 修改模块

```text
packages/agent-runtime/src/autonomous/
  types.ts                           # 新增 P2 相关类型
  config.ts                          # 新增 P2 配置参数
  intrinsic-goal-generator.ts        # 新增两类目标生成
  autonomous-coordinator.ts          # 集成多层进化调度
  personality-tracker.ts             # 启用人格自动更新
```

### 2.3 数据库扩展

```text
packages/database/migrations/
  YYYYMMDDHHMMSS_memory_ranking.sql          # 记忆排序特征表
  YYYYMMDDHHMMSS_skill_usage.sql             # 技能使用记录表
  YYYYMMDDHHMMSS_tool_selection.sql          # 工具选择历史表
  YYYYMMDDHHMMSS_coordinated_evolution.sql   # 协同进化历史表
  YYYYMMDDHHMMSS_pareto_frontier.sql         # 帕累托前沿表
```

---

## 三、核心算法实现

### 3.1 记忆策略进化（Learning-to-Rank）

#### 3.1.1 记忆排序特征定义

```typescript
/**
 * 记忆排序特征（用于 Learning-to-Rank）
 * 来源：分析 P0/P1 阶段记忆使用效果
 */
export interface MemoryRankingFeatures {
  // 查询相关性特征
  semanticSimilarity: number;          // 语义相似度 (0-1)
  keywordMatch: number;                // 关键词匹配数量
  queryLength: number;                 // 查询长度
  
  // 记忆质量特征
  memoryAge: number;                   // 记忆年龄（天）
  accessCount: number;                 // 历史访问次数
  lastAccessRecency: number;           // 最近访问距今时间（小时）
  memoryLength: number;                // 记忆长度（token）
  
  // 上下文特征
  topicRelevance: number;              // 主题相关性 (0-1)
  userFeedbackScore: number;           // 用户反馈得分 (0-1)
  taskTypeMatch: boolean;              // 任务类型是否匹配
  
  // 历史效果特征
  avgUtilityScore: number;             // 历史平均有用性 (0-1)
  retrievalSuccessRate: number;        // 被检索后任务成功率
}

/**
 * 记忆使用反馈
 */
export interface MemoryUsageFeedback {
  memoryId: string;
  sessionId: string;
  query: string;
  
  // 隐式反馈
  wasUsedInResponse: boolean;          // 是否被用于生成回复
  contributionScore: number;           // 对回复的贡献度 (0-1)
  
  // 显式反馈（用户评价）
  userSatisfaction?: number;           // 用户满意度 (0-1)
  
  // 特征快照
  features: MemoryRankingFeatures;
  
  timestamp: string;
}

/**
 * 记忆排序权重
 */
export interface MemoryRankingWeights {
  semanticSimilarity: number;
  keywordMatch: number;
  memoryAge: number;
  accessCount: number;
  lastAccessRecency: number;
  topicRelevance: number;
  userFeedbackScore: number;
  avgUtilityScore: number;
  retrievalSuccessRate: number;
}
```

#### 3.1.2 Learning-to-Rank 模型实现

```typescript
/**
 * Learning-to-Rank 模型（Point-wise 方法）
 * 使用线性回归预测记忆有用性得分
 */
export class MemoryRankingModel {
  private weights: MemoryRankingWeights;
  private learningRate: number;
  
  constructor(learningRate: number = 0.01) {
    this.learningRate = learningRate;
    // 初始权重（均匀分配）
    this.weights = {
      semanticSimilarity: 0.3,
      keywordMatch: 0.1,
      memoryAge: -0.05,
      accessCount: 0.1,
      lastAccessRecency: -0.05,
      topicRelevance: 0.2,
      userFeedbackScore: 0.15,
      avgUtilityScore: 0.15,
      retrievalSuccessRate: 0.1,
    };
  }
  
  /**
   * 预测记忆有用性得分
   */
  predict(features: MemoryRankingFeatures): number {
    const score = 
      this.weights.semanticSimilarity * features.semanticSimilarity +
      this.weights.keywordMatch * features.keywordMatch +
      this.weights.memoryAge * Math.log(features.memoryAge + 1) +
      this.weights.accessCount * Math.log(features.accessCount + 1) +
      this.weights.lastAccessRecency * Math.log(features.lastAccessRecency + 1) +
      this.weights.topicRelevance * features.topicRelevance +
      this.weights.userFeedbackScore * features.userFeedbackScore +
      this.weights.avgUtilityScore * features.avgUtilityScore +
      this.weights.retrievalSuccessRate * features.retrievalSuccessRate;
    
    // Sigmoid 归一化到 [0, 1]
    return 1 / (1 + Math.exp(-score));
  }
  
  /**
   * 在线学习（梯度下降）
   */
  learn(features: MemoryRankingFeatures, actualUtility: number): void {
    const prediction = this.predict(features);
    const error = actualUtility - prediction;
    
    // 梯度下降更新权重
    this.weights.semanticSimilarity += this.learningRate * error * features.semanticSimilarity;
    this.weights.keywordMatch += this.learningRate * error * features.keywordMatch;
    this.weights.memoryAge += this.learningRate * error * Math.log(features.memoryAge + 1);
    this.weights.accessCount += this.learningRate * error * Math.log(features.accessCount + 1);
    this.weights.lastAccessRecency += this.learningRate * error * Math.log(features.lastAccessRecency + 1);
    this.weights.topicRelevance += this.learningRate * error * features.topicRelevance;
    this.weights.userFeedbackScore += this.learningRate * error * features.userFeedbackScore;
    this.weights.avgUtilityScore += this.learningRate * error * features.avgUtilityScore;
    this.weights.retrievalSuccessRate += this.learningRate * error * features.retrievalSuccessRate;
  }
  
  /**
   * 批量学习（从历史反馈中学习）
   */
  batchLearn(feedbacks: MemoryUsageFeedback[], epochs: number = 10): void {
    for (let epoch = 0; epoch < epochs; epoch++) {
      for (const feedback of feedbacks) {
        const actualUtility = feedback.contributionScore;
        this.learn(feedback.features, actualUtility);
      }
    }
  }
  
  /**
   * 获取当前权重（用于可视化）
   */
  getWeights(): MemoryRankingWeights {
    return { ...this.weights };
  }
}
```

#### 3.1.3 记忆策略进化器实现

```typescript
/**
 * 记忆策略进化器
 * 负责收集反馈、训练模型、优化检索策略
 */
export class MemoryEvolution {
  private rankingModel: MemoryRankingModel;
  private db: DatabaseClient;
  
  constructor(db: DatabaseClient, learningRate: number = 0.01) {
    this.rankingModel = new MemoryRankingModel(learningRate);
    this.db = db;
  }
  
  /**
   * 记录记忆使用反馈
   */
  async recordFeedback(feedback: MemoryUsageFeedback): Promise<void> {
    // 1. 持久化反馈
    await this.db.insert('memory_usage_feedback', feedback);
    
    // 2. 在线学习
    this.rankingModel.learn(feedback.features, feedback.contributionScore);
    
    // 3. 记录 Telemetry
    logger.info('Memory feedback recorded', {
      event: 'memory-feedback-recorded',
      memoryId: feedback.memoryId,
      contributionScore: feedback.contributionScore,
      wasUsed: feedback.wasUsedInResponse,
    });
  }
  
  /**
   * 对记忆列表进行重新排序
   */
  async rankMemories(
    memories: Array<{ id: string; features: MemoryRankingFeatures }>,
    query: string
  ): Promise<Array<{ id: string; score: number }>> {
    const scored = memories.map(mem => ({
      id: mem.id,
      score: this.rankingModel.predict(mem.features),
    }));
    
    // 按得分降序排序
    return scored.sort((a, b) => b.score - a.score);
  }
  
  /**
   * 识别无效记忆（低效记忆清理）
   */
  async identifyIneffectiveMemories(
    agentId: string,
    threshold: number = 0.2
  ): Promise<string[]> {
    // 查询所有记忆的历史效果
    const memories = await this.db.find('memory_usage_feedback', {
      agent_id: agentId,
    });
    
    // 按记忆 ID 分组统计
    const memoryStats = new Map<string, { totalScore: number; count: number }>();
    for (const feedback of memories) {
      const stat = memoryStats.get(feedback.memoryId) || { totalScore: 0, count: 0 };
      stat.totalScore += feedback.contributionScore;
      stat.count += 1;
      memoryStats.set(feedback.memoryId, stat);
    }
    
    // 筛选平均得分低于阈值的记忆
    const ineffective: string[] = [];
    for (const [memId, stat] of memoryStats.entries()) {
      const avgScore = stat.totalScore / stat.count;
      if (avgScore < threshold && stat.count >= 5) {  // 至少 5 次使用才判定
        ineffective.push(memId);
      }
    }
    
    return ineffective;
  }
  
  /**
   * 批量重训练模型（从历史数据中学习）
   */
  async retrainModel(days: number = 30): Promise<void> {
    const since = new Date();
    since.setDate(since.getDate() - days);
    
    const feedbacks = await this.db.find('memory_usage_feedback', {
      timestamp: { $gte: since.toISOString() },
    });
    
    this.rankingModel.batchLearn(feedbacks, 10);
    
    logger.info('Memory ranking model retrained', {
      event: 'memory-model-retrained',
      feedbackCount: feedbacks.length,
      weights: this.rankingModel.getWeights(),
    });
  }
  
  /**
   * 获取记忆策略报告
   */
  async getReport(): Promise<{
    weights: MemoryRankingWeights;
    totalFeedbacks: number;
    avgContributionScore: number;
    ineffectiveMemoryCount: number;
  }> {
    const feedbacks = await this.db.find('memory_usage_feedback', {});
    const avgScore = feedbacks.reduce((sum, f) => sum + f.contributionScore, 0) / (feedbacks.length || 1);
    const ineffective = await this.identifyIneffectiveMemories('default', 0.2);
    
    return {
      weights: this.rankingModel.getWeights(),
      totalFeedbacks: feedbacks.length,
      avgContributionScore: avgScore,
      ineffectiveMemoryCount: ineffective.length,
    };
  }
}
```

---

### 3.2 工具选择进化（Thompson Sampling）

#### 3.2.1 工具选择状态定义

```typescript
/**
 * 工具选择统计（Beta 分布参数）
 */
export interface ToolSelectionStats {
  toolName: string;
  alpha: number;       // 成功次数 + 1
  beta: number;        // 失败次数 + 1
  totalUsage: number;
  lastUsed: string;
}

/**
 * 工具使用反馈
 */
export interface ToolUsageFeedback {
  toolName: string;
  sessionId: string;
  context: {
    taskType: string;
    difficulty: number;
  };
  result: 'success' | 'failure';
  executionTime: number;
  timestamp: string;
}
```

#### 3.2.2 Thompson Sampling 算法实现

```typescript
/**
 * Thompson Sampling for Tool Selection
 * 使用 Beta 分布建模工具成功率的不确定性
 */
export class ToolThompsonSampling {
  private stats: Map<string, ToolSelectionStats>;
  
  constructor() {
    this.stats = new Map();
  }
  
  /**
   * 初始化工具统计（Beta(1, 1) = 均匀先验）
   */
  initTool(toolName: string): void {
    if (!this.stats.has(toolName)) {
      this.stats.set(toolName, {
        toolName,
        alpha: 1,
        beta: 1,
        totalUsage: 0,
        lastUsed: new Date().toISOString(),
      });
    }
  }
  
  /**
   * 选择工具（Thompson Sampling）
   * @param availableTools 可用工具列表
   * @returns 选中的工具名称
   */
  selectTool(availableTools: string[]): string {
    // 确保所有工具都已初始化
    availableTools.forEach(tool => this.initTool(tool));
    
    // 从每个工具的 Beta 分布中采样
    let bestTool: string | null = null;
    let bestSample = -Infinity;
    
    for (const tool of availableTools) {
      const stat = this.stats.get(tool)!;
      const sample = this.sampleBeta(stat.alpha, stat.beta);
      
      if (sample > bestSample) {
        bestSample = sample;
        bestTool = tool;
      }
    }
    
    return bestTool!;
  }
  
  /**
   * 更新工具统计
   */
  updateStats(toolName: string, success: boolean): void {
    const stat = this.stats.get(toolName);
    if (!stat) {
      this.initTool(toolName);
      return this.updateStats(toolName, success);
    }
    
    if (success) {
      stat.alpha += 1;
    } else {
      stat.beta += 1;
    }
    stat.totalUsage += 1;
    stat.lastUsed = new Date().toISOString();
  }
  
  /**
   * 从 Beta 分布采样（使用逆变换方法）
   * 简化版：使用 Gamma 分布近似
   */
  private sampleBeta(alpha: number, beta: number): number {
    const x = this.sampleGamma(alpha, 1);
    const y = this.sampleGamma(beta, 1);
    return x / (x + y);
  }
  
  /**
   * 从 Gamma 分布采样（使用 Marsaglia-Tsang 方法）
   */
  private sampleGamma(shape: number, scale: number): number {
    if (shape < 1) {
      return this.sampleGamma(shape + 1, scale) * Math.pow(Math.random(), 1 / shape);
    }
    
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    
    while (true) {
      let x: number, v: number;
      do {
        x = this.sampleNormal(0, 1);
        v = 1 + c * x;
      } while (v <= 0);
      
      v = v * v * v;
      const u = Math.random();
      
      if (u < 1 - 0.0331 * x * x * x * x) {
        return d * v * scale;
      }
      
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
        return d * v * scale;
      }
    }
  }
  
  /**
   * 从标准正态分布采样（Box-Muller 变换）
   */
  private sampleNormal(mean: number, stddev: number): number {
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + stddev * z;
  }
  
  /**
   * 获取工具成功率估计
   */
  getSuccessRateEstimate(toolName: string): {
    mean: number;
    credibleInterval: [number, number];
  } {
    const stat = this.stats.get(toolName);
    if (!stat) {
      return { mean: 0.5, credibleInterval: [0, 1] };
    }
    
    const mean = stat.alpha / (stat.alpha + stat.beta);
    
    // 95% 可信区间（使用 Beta 分布的分位数近似）
    const lower = this.betaQuantile(stat.alpha, stat.beta, 0.025);
    const upper = this.betaQuantile(stat.alpha, stat.beta, 0.975);
    
    return { mean, credibleInterval: [lower, upper] };
  }
  
  /**
   * Beta 分布分位数（简化近似）
   */
  private betaQuantile(alpha: number, beta: number, p: number): number {
    // 使用正态近似（当 alpha, beta > 5 时较准确）
    const mean = alpha / (alpha + beta);
    const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
    const z = this.normalQuantile(p);
    return Math.max(0, Math.min(1, mean + z * Math.sqrt(variance)));
  }
  
  /**
   * 标准正态分布分位数（近似）
   */
  private normalQuantile(p: number): number {
    // Beasley-Springer-Moro 算法简化版
    if (p === 0.5) return 0;
    if (p < 0.5) return -this.normalQuantile(1 - p);
    
    const a0 = 2.50662823884;
    const a1 = -18.61500062529;
    const a2 = 41.39119773534;
    const a3 = -25.44106049637;
    const b1 = -8.47351093090;
    const b2 = 23.08336743743;
    const b3 = -21.06224101826;
    const b4 = 3.13082909833;
    
    const y = p - 0.5;
    const r = y * y;
    
    return y * (((a3 * r + a2) * r + a1) * r + a0) /
           ((((b4 * r + b3) * r + b2) * r + b1) * r + 1);
  }
  
  /**
   * 获取所有工具统计
   */
  getAllStats(): ToolSelectionStats[] {
    return Array.from(this.stats.values());
  }
}

/**
 * 工具选择进化器
 */
export class ToolEvolution {
  private thompsonSampling: ToolThompsonSampling;
  private db: DatabaseClient;
  
  constructor(db: DatabaseClient) {
    this.thompsonSampling = new ToolThompsonSampling();
    this.db = db;
  }
  
  /**
   * 选择工具
   */
  async selectTool(
    availableTools: string[],
    context: { taskType: string; difficulty: number }
  ): Promise<string> {
    // 使用 Thompson Sampling 选择工具
    const selectedTool = this.thompsonSampling.selectTool(availableTools);
    
    logger.info('Tool selected', {
      event: 'tool-selected',
      tool: selectedTool,
      availableTools,
      taskType: context.taskType,
    });
    
    return selectedTool;
  }
  
  /**
   * 记录工具使用反馈
   */
  async recordFeedback(feedback: ToolUsageFeedback): Promise<void> {
    // 1. 更新 Thompson Sampling 统计
    this.thompsonSampling.updateStats(
      feedback.toolName,
      feedback.result === 'success'
    );
    
    // 2. 持久化反馈
    await this.db.insert('tool_usage_feedback', feedback);
    
    // 3. 记录 Telemetry
    logger.info('Tool feedback recorded', {
      event: 'tool-feedback-recorded',
      tool: feedback.toolName,
      result: feedback.result,
      executionTime: feedback.executionTime,
    });
  }
  
  /**
   * 获取工具选择报告
   */
  async getReport(): Promise<{
    toolStats: Array<{
      tool: string;
      successRate: number;
      confidence: [number, number];
      totalUsage: number;
    }>;
  }> {
    const stats = this.thompsonSampling.getAllStats();
    
    const toolStats = stats.map(stat => {
      const estimate = this.thompsonSampling.getSuccessRateEstimate(stat.toolName);
      return {
        tool: stat.toolName,
        successRate: estimate.mean,
        confidence: estimate.credibleInterval,
        totalUsage: stat.totalUsage,
      };
    });
    
    return { toolStats };
  }
}
```

---

### 3.3 技能策略进化

#### 3.3.1 技能使用跟踪

```typescript
/**
 * 技能使用记录
 */
export interface SkillUsageRecord {
  skillName: string;
  sessionId: string;
  context: {
    taskType: string;
    complexity: 'low' | 'medium' | 'high';
  };
  outcome: {
    success: boolean;
    executionTime: number;
    userSatisfaction: number;
  };
  timestamp: string;
}

/**
 * 技能统计
 */
export interface SkillStats {
  skillName: string;
  usageCount: number;
  successRate: number;
  avgSatisfaction: number;
  avgExecutionTime: number;
  lastUsed: string;
}
```

#### 3.3.2 技能进化器实现

```typescript
/**
 * 技能策略进化器
 * 负责跟踪技能使用效果，识别技能缺口
 */
export class SkillEvolution {
  private db: DatabaseClient;
  
  constructor(db: DatabaseClient) {
    this.db = db;
  }
  
  /**
   * 记录技能使用
   */
  async recordUsage(record: SkillUsageRecord): Promise<void> {
    await this.db.insert('skill_usage_records', record);
    
    logger.info('Skill usage recorded', {
      event: 'skill-usage-recorded',
      skill: record.skillName,
      success: record.outcome.success,
      satisfaction: record.outcome.userSatisfaction,
    });
  }
  
  /**
   * 获取技能统计
   */
  async getSkillStats(skillName?: string): Promise<SkillStats[]> {
    const filter = skillName ? { skill_name: skillName } : {};
    const records = await this.db.find('skill_usage_records', filter);
    
    // 按技能名称分组统计
    const statsMap = new Map<string, {
      usageCount: number;
      successCount: number;
      totalSatisfaction: number;
      totalExecutionTime: number;
      lastUsed: string;
    }>();
    
    for (const record of records) {
      const stat = statsMap.get(record.skillName) || {
        usageCount: 0,
        successCount: 0,
        totalSatisfaction: 0,
        totalExecutionTime: 0,
        lastUsed: record.timestamp,
      };
      
      stat.usageCount += 1;
      if (record.outcome.success) stat.successCount += 1;
      stat.totalSatisfaction += record.outcome.userSatisfaction;
      stat.totalExecutionTime += record.outcome.executionTime;
      if (record.timestamp > stat.lastUsed) stat.lastUsed = record.timestamp;
      
      statsMap.set(record.skillName, stat);
    }
    
    // 转换为 SkillStats 数组
    return Array.from(statsMap.entries()).map(([name, stat]) => ({
      skillName: name,
      usageCount: stat.usageCount,
      successRate: stat.successCount / stat.usageCount,
      avgSatisfaction: stat.totalSatisfaction / stat.usageCount,
      avgExecutionTime: stat.totalExecutionTime / stat.usageCount,
      lastUsed: stat.lastUsed,
    }));
  }
  
  /**
   * 识别技能缺口（低成功率或低满意度的技能）
   */
  async identifySkillGaps(): Promise<Array<{
    skillName: string;
    issue: 'low-success-rate' | 'low-satisfaction' | 'high-execution-time';
    priority: number;
  }>> {
    const stats = await this.getSkillStats();
    const gaps: Array<{
      skillName: string;
      issue: 'low-success-rate' | 'low-satisfaction' | 'high-execution-time';
      priority: number;
    }> = [];
    
    for (const stat of stats) {
      // 至少使用 5 次才判定
      if (stat.usageCount < 5) continue;
      
      // 成功率低于 60%
      if (stat.successRate < 0.6) {
        gaps.push({
          skillName: stat.skillName,
          issue: 'low-success-rate',
          priority: (0.6 - stat.successRate) * stat.usageCount,
        });
      }
      
      // 满意度低于 0.5
      if (stat.avgSatisfaction < 0.5) {
        gaps.push({
          skillName: stat.skillName,
          issue: 'low-satisfaction',
          priority: (0.5 - stat.avgSatisfaction) * stat.usageCount,
        });
      }
      
      // 执行时间超过 30 秒
      if (stat.avgExecutionTime > 30000) {
        gaps.push({
          skillName: stat.skillName,
          issue: 'high-execution-time',
          priority: (stat.avgExecutionTime / 1000 - 30) * 0.1 * stat.usageCount,
        });
      }
    }
    
    // 按优先级降序排序
    return gaps.sort((a, b) => b.priority - a.priority);
  }
  
  /**
   * 生成技能改进目标
   */
  async generateImprovementGoals(): Promise<Array<{
    type: 'skill-enhancement';
    description: string;
    priority: number;
    relatedSkill: string;
  }>> {
    const gaps = await this.identifySkillGaps();
    
    return gaps.slice(0, 3).map(gap => ({
      type: 'skill-enhancement' as const,
      description: this.generateGoalDescription(gap),
      priority: gap.priority,
      relatedSkill: gap.skillName,
    }));
  }
  
  /**
   * 生成目标描述
   */
  private generateGoalDescription(gap: {
    skillName: string;
    issue: 'low-success-rate' | 'low-satisfaction' | 'high-execution-time';
  }): string {
    const issueMap = {
      'low-success-rate': '成功率较低',
      'low-satisfaction': '用户满意度不足',
      'high-execution-time': '执行时间过长',
    };
    
    return `改进技能"${gap.skillName}"：${issueMap[gap.issue]}`;
  }
}
```

---

## 四、数据库 Schema

### 4.1 记忆使用反馈表

```sql
CREATE TABLE memory_usage_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id VARCHAR(255) NOT NULL,
  session_id UUID NOT NULL,
  query TEXT NOT NULL,
  was_used_in_response BOOLEAN NOT NULL,
  contribution_score DECIMAL(3, 2) NOT NULL CHECK (contribution_score BETWEEN 0 AND 1),
  user_satisfaction DECIMAL(3, 2) CHECK (user_satisfaction BETWEEN 0 AND 1),
  features JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_memory_feedback_memory ON memory_usage_feedback(memory_id, created_at DESC);
CREATE INDEX idx_memory_feedback_session ON memory_usage_feedback(session_id);
COMMENT ON TABLE memory_usage_feedback IS '记忆使用反馈表，用于 Learning-to-Rank 训练';
```

### 4.2 技能使用记录表

```sql
CREATE TABLE skill_usage_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_name VARCHAR(255) NOT NULL,
  session_id UUID NOT NULL,
  task_type VARCHAR(100) NOT NULL,
  complexity VARCHAR(20) NOT NULL CHECK (complexity IN ('low', 'medium', 'high')),
  success BOOLEAN NOT NULL,
  execution_time INTEGER NOT NULL CHECK (execution_time >= 0),
  user_satisfaction DECIMAL(3, 2) NOT NULL CHECK (user_satisfaction BETWEEN 0 AND 1),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_skill_usage_name ON skill_usage_records(skill_name, created_at DESC);
CREATE INDEX idx_skill_usage_session ON skill_usage_records(session_id);
COMMENT ON TABLE skill_usage_records IS '技能使用效果记录表';
```

### 4.3 工具使用反馈表

```sql
CREATE TABLE tool_usage_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name VARCHAR(255) NOT NULL,
  session_id UUID NOT NULL,
  task_type VARCHAR(100) NOT NULL,
  difficulty DECIMAL(3, 2) NOT NULL CHECK (difficulty BETWEEN 0 AND 1),
  result VARCHAR(20) NOT NULL CHECK (result IN ('success', 'failure')),
  execution_time INTEGER NOT NULL CHECK (execution_time >= 0),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_tool_feedback_name ON tool_usage_feedback(tool_name, created_at DESC);
CREATE INDEX idx_tool_feedback_session ON tool_usage_feedback(session_id);
COMMENT ON TABLE tool_usage_feedback IS '工具选择与执行反馈表，用于 Thompson Sampling';
```

### 4.4 协同进化历史表

```sql
CREATE TABLE coordinated_evolution_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID,
  config_json JSONB NOT NULL,
  user_satisfaction DECIMAL(3, 2) NOT NULL CHECK (user_satisfaction BETWEEN 0 AND 1),
  response_time INTEGER NOT NULL CHECK (response_time >= 0),
  token_cost INTEGER NOT NULL CHECK (token_cost >= 0),
  consistency_score DECIMAL(3, 2) CHECK (consistency_score BETWEEN 0 AND 1),
  prompt_contribution DECIMAL(5, 4),
  memory_contribution DECIMAL(5, 4),
  skill_contribution DECIMAL(5, 4),
  tool_contribution DECIMAL(5, 4),
  exploration_mode VARCHAR(30) NOT NULL,
  conflicts_json JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_coordination_created ON coordinated_evolution_history(created_at DESC);
CREATE INDEX idx_coordination_session ON coordinated_evolution_history(session_id);
```

### 4.5 帕累托前沿表

```sql
CREATE TABLE pareto_frontier (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_hash VARCHAR(64) UNIQUE NOT NULL,
  config_json JSONB NOT NULL,
  user_satisfaction DECIMAL(3, 2) NOT NULL CHECK (user_satisfaction BETWEEN 0 AND 1),
  response_time INTEGER NOT NULL,
  token_cost INTEGER NOT NULL,
  consistency_score DECIMAL(3, 2) CHECK (consistency_score BETWEEN 0 AND 1),
  added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0)
);

CREATE INDEX idx_pareto_satisfaction ON pareto_frontier(user_satisfaction DESC);
```

### 4.6 Down 迁移

```sql
DROP TABLE IF EXISTS pareto_frontier CASCADE;
DROP TABLE IF EXISTS coordinated_evolution_history CASCADE;
DROP TABLE IF EXISTS tool_usage_feedback CASCADE;
DROP TABLE IF EXISTS skill_usage_records CASCADE;
DROP TABLE IF EXISTS memory_usage_feedback CASCADE;
```

> **迁移约束**：P2 迁移必须遵循当前数据库迁移工具和命名规范；上面的 SQL 是逻辑 Schema，不得直接假设数据库支持在 `CREATE TABLE` 中声明 `INDEX`。迁移前必须确认现有会话、记忆、技能、工具表的真实主键类型，并按实际类型建立外键或仅保留关联 ID。

---

## 五、实施任务拆解

### Task 1：P2 类型与配置扩展（4h）

**文件：**
- Modify `packages/agent-runtime/src/autonomous/types.ts`
- Modify `packages/agent-runtime/src/autonomous/config.ts`
- Modify `packages/agent-runtime/src/autonomous/index.ts`

**依赖：** P1 类型与配置

**任务清单：**
- [ ] 新增 `MemoryRankingFeatures`、`MemoryUsageFeedback`、`MemoryRankingWeights`
- [ ] 新增 `ToolSelectionStats`、`ToolUsageFeedback`
- [ ] 新增 `SkillUsageRecord`、`SkillStats`
- [ ] 新增 `LayerConfigs`、`LayerContribution`、`OptimizationObjectives`
- [ ] 新增 `ExplorationMode`、`SchedulerState`、`P2Scope`
- [ ] 扩展 `GoalType`：`SKILL_ENHANCEMENT`、`MEMORY_OPTIMIZATION`
- [ ] 增加配置常量：学习率、探索预算、最小样本数、帕累托前沿上限
- [ ] 从公共入口导出 P2 类型和模块
- [ ] 为所有分数、时间、计数类型增加明确边界约束或运行时校验

**验收标准：** 类型检查通过；P0/P1 调用方无需修改即可编译；配置集中管理，不在业务代码中散落魔数。

---

### Task 2：记忆排序模型（8h）

**文件：**
- Create `packages/agent-runtime/src/autonomous/memory-ranking-model.ts`
- Create `packages/agent-runtime/src/autonomous/__tests__/memory-ranking-model.test.ts`

**依赖：** Task 1

**任务清单：**
- [ ] 实现特征归一化，避免年龄、访问次数等大数值主导模型
- [ ] 实现 point-wise Learning-to-Rank 预测
- [ ] 实现在线梯度更新和批量重训练
- [ ] 对权重、预测值、学习样本做边界校验
- [ ] 支持模型权重快照和恢复
- [ ] 测试相关记忆排序靠前、训练后损失下降、空样本和异常特征处理
- [ ] 验证模型更新不会阻塞会话主链路

**验收标准：** 排序结果可复现（测试注入随机源）；训练权重可持久化；离线评估 NDCG@5 相比基线不下降，并有最小样本量保护。

> **实现修正要求**：不得直接采用未归一化的 `queryLength`、`memoryAge`、`accessCount`；必须明确特征尺度和缺失值策略。在线更新失败时保留上一份有效权重。

---

### Task 3：记忆进化器集成（8h）

**文件：**
- Create `packages/agent-runtime/src/autonomous/memory-evolution.ts`
- Modify 现有记忆检索适配层（先定位实际实现）
- Create `packages/agent-runtime/src/autonomous/__tests__/memory-evolution.test.ts`

**依赖：** Task 2、P1 能力与满意度数据

**任务清单：**
- [ ] 在真实记忆检索入口接入排序器，保留原有检索作为 fallback
- [ ] 记录检索候选、排序特征、使用情况和贡献反馈
- [ ] 使用显式满意度与隐式使用信号构造训练标签
- [ ] 实现低效记忆识别，但 P2 默认只标记不删除
- [ ] 实现定期批量重训练和模型版本记录
- [ ] 对查询和记忆内容做脱敏或仅保存 ID/特征
- [ ] 测试检索失败、数据库失败、模型失败时不影响正常回答

**验收标准：** 记忆策略可灰度启用/关闭；原检索行为无回归；未经过用户批准不得删除记忆；反馈数据可追溯到 session。

---

### Task 4：Thompson Sampling 工具选择（8h）

**文件：**
- Create `packages/agent-runtime/src/autonomous/tool-thompson-sampling.ts`
- Create `packages/agent-runtime/src/autonomous/tool-evolution.ts`
- Create `packages/agent-runtime/src/autonomous/__tests__/tool-thompson-sampling.test.ts`

**依赖：** Task 1、P1 协调器和工具调用记录

**任务清单：**
- [ ] 为每个工具维护 Beta(α, β) 后验，使用 Beta(1, 1) 先验
- [ ] 实现可用工具过滤、采样选择和成功/失败更新
- [ ] 按任务类型和难度隔离统计，避免不同场景相互污染
- [ ] 持久化状态并在启动时恢复
- [ ] 处理空工具列表、单工具、工具移除和并发更新
- [ ] 对超时、权限拒绝、参数错误定义统一结果映射
- [ ] 测试探索新工具、成功率收敛、采样边界和恢复逻辑

**验收标准：** 工具选择不越过现有权限白名单；失败自动回退到既有选择策略；后验更新具备幂等键，重复事件不会重复计数。

> **实现修正要求**：采样器必须使用可靠的 Beta/Gamma 实现或经过充分测试的依赖；禁止无界 `while(true)`，要有最大重试和异常兜底。

---

### Task 5：技能策略进化（8h）

**文件：**
- Create `packages/agent-runtime/src/autonomous/skill-evolution.ts`
- Modify 技能注册/调用适配层（先定位实际实现）
- Create `packages/agent-runtime/src/autonomous/__tests__/skill-evolution.test.ts`

**依赖：** Task 1、P1 能力缺口数据

**任务清单：**
- [ ] 记录技能使用、成功率、满意度、执行耗时和上下文
- [ ] 计算技能统计并识别低成功率、低满意度、超时缺口
- [ ] 将 P1 能力缺口映射为技能改进候选
- [ ] 生成 `skill-enhancement` 目标，沿用用户批准和每日上限
- [ ] 技能自动生成仅输出候选方案，P2 不自动写入或执行任意代码
- [ ] 处理技能不存在、版本变化和执行失败
- [ ] 测试统计窗口、最小样本量、目标排序和降级路径

**验收标准：** 技能策略只影响选择，不改变技能安全边界；任何新技能安装、代码生成或外部操作均进入批准流程。

---

### Task 6：贡献归因与协同调度（10h）

**文件：**
- Create `packages/agent-runtime/src/autonomous/shapley-attribution.ts`
- Create `packages/agent-runtime/src/autonomous/coordinated-scheduler.ts`
- Modify `autonomous-coordinator.ts`
- Create 对应单元测试

**依赖：** Tasks 2-5、P1 满意度评分

**任务清单：**
- [ ] 定义单次会话的四层配置快照和版本号
- [ ] 实现四层边际贡献近似（默认路径）
- [ ] 在样本量足够时支持完整 Shapley 估计；限制组合数量和计算预算
- [ ] 实现基于全局满意度的探索预算
- [ ] 保证一次会话最多探索一层，避免同时改变多个变量
- [ ] 使用 EMA 更新层级优先级，维护最近探索历史
- [ ] 为归因不足、未知配置、负贡献提供稳定处理
- [ ] 测试轮流探索、利用比例、贡献归一化和状态恢复

**验收标准：** 协调逻辑不阻塞主对话；每次决策可解释（层、模式、原因）；历史记录能重放配置选择。

---

### Task 7：冲突检测与帕累托前沿（8h）

**文件：**
- Create `packages/agent-runtime/src/autonomous/conflict-detector.ts`
- Create `packages/agent-runtime/src/autonomous/pareto-frontier.ts`
- Create 对应单元测试

**依赖：** Task 6

**任务清单：**
- [ ] 建立 Prompt/Memory、Skill/Tool、成本/质量等冲突规则
- [ ] 区分 `critical` 与 `warning`
- [ ] 只对确定且安全的 critical 冲突自动修复，warning 仅记录
- [ ] 修复后重新校验，限制规则迭代次数，防止规则循环
- [ ] 实现满意度、响应时间、Token 成本、一致性四目标支配判断
- [ ] 限制帕累托前沿大小，采用确定性淘汰策略
- [ ] 支持按满意度、速度、成本、平衡偏好选择
- [ ] 测试互不支配、被支配、相同配置、空前沿和异常指标

**验收标准：** 冲突修复不得扩大工具权限或绕过用户批准；帕累托前沿不含被支配配置；指标方向和归一化规则有测试覆盖。

---

### Task 8：数据库迁移与持久化（6h）

**文件：**
- Create `packages/database/migrations/*_memory_ranking.sql`
- Create `packages/database/migrations/*_skill_usage.sql`
- Create `packages/database/migrations/*_tool_selection.sql`
- Create `packages/database/migrations/*_coordinated_evolution.sql`
- Create `packages/database/migrations/*_pareto_frontier.sql`

**依赖：** Task 1

**任务清单：**
- [ ] 按仓库现有迁移命名和上下行规范创建迁移
- [ ] 核对真实数据库方言、UUID/整数主键和时间字段类型
- [ ] 添加必要索引、唯一约束、CHECK 约束
- [ ] 为配置 JSON 设置大小上限或清理策略
- [ ] 支持迁移回滚，禁止误删 P0/P1 数据
- [ ] 在本地数据库验证正向迁移、非法值拒绝和 Down 迁移
- [ ] 对写入失败实现队列或日志降级，不阻塞对话

**验收标准：** 新鲜数据库和已有 P0/P1 数据库均可成功迁移；回滚仅影响 P2 表；关键查询 p95 满足性能目标。

---

### Task 9：人格自动更新与目标生成集成（6h）

**文件：**
- Modify `personality-tracker.ts`
- Modify `intrinsic-goal-generator.ts`
- Modify 相关测试

**依赖：** Tasks 3-7、P0/P1 人格事件数据

**任务清单：**
- [ ] 基于 P0 已积累事件启用 EMA 更新，沿用设计文档 alpha=0.05
- [ ] 增加更新前后边界校验和变更审计
- [ ] 将技能缺口和记忆优化候选接入目标生成器
- [ ] 统一优先级、去重、合法性检查和每日上限（7）
- [ ] 保持所有外部操作始终需要用户批准
- [ ] 支持配置关闭人格自动更新和 P2 各层进化
- [ ] 测试人格更新、目标共存、去重、限流和回滚

**验收标准：** P0/P1 目标行为不变；人格变化可解释、可追溯、可回滚；目标不会因新增来源突破全局限制。

---

### Task 10：协调器集成、端到端测试与可观测性（14h）

**文件：**
- Modify `packages/agent-runtime/src/autonomous/autonomous-coordinator.ts`
- Create `packages/agent-runtime/src/autonomous/__tests__/integration/p2-e2e.test.ts`
- Create `docs/plans/AGENT自我进化/P2监控指标.md`

**依赖：** Tasks 1-9

**任务清单：**
- [ ] 会话开始前读取协调状态并选择配置
- [ ] 会话结束后异步记录四层反馈、贡献度和全局指标
- [ ] 对关键路径使用超时、熔断和错误降级
- [ ] 定时执行模型重训练、前沿清理和无效记忆标记
- [ ] 场景测试：记忆排序、工具探索、技能缺口、冲突修复、帕累托选择
- [ ] 场景测试：单层探索和 P0/P1/P2 目标协同
- [ ] 验证数据库失败、LLM/Embedding 失败、工具超时不会影响主流程
- [ ] 验证敏感内容不进入反馈、Telemetry 和配置快照
- [ ] 增加事件关联 ID、模型版本、策略版本和耗时字段
- [ ] 运行 agent-runtime 全量测试、typecheck 和数据库迁移测试

**验收标准：** P2 E2E 通过率 100%；P0/P1 回归测试通过；关键异步流程可观测且失败可恢复。

---

## 六、实施顺序与提交边界

按依赖顺序实施，每个任务完成后独立提交：

1. `feat(autonomous-p2): add multi-layer evolution types and config`
2. `feat(autonomous-p2): implement memory ranking model`
3. `feat(autonomous-p2): integrate memory evolution`
4. `feat(autonomous-p2): implement Thompson Sampling tool selection`
5. `feat(autonomous-p2): implement skill evolution tracking`
6. `feat(autonomous-p2): add coordinated attribution and scheduling`
7. `feat(autonomous-p2): add conflict detection and Pareto frontier`
8. `feat(autonomous-p2): add persistence migrations for multi-layer evolution`
9. `feat(autonomous-p2): integrate personality and goal evolution`
10. `test(autonomous-p2): add end-to-end coverage and observability`

每次提交前运行（以仓库实际 scripts 为准）：

```powershell
pnpm --filter @lumii/agent-runtime test
pnpm --filter @lumii/agent-runtime typecheck
pnpm --filter @lumii/database test
```

---

## 七、工程化保障

### 7.1 算法一致性

- [ ] Learning-to-Rank 的特征、标签、归一化策略和模型版本可追踪
- [ ] Thompson Sampling 使用 Beta 后验，默认先验为 Beta(1, 1)
- [ ] Shapley 近似与设计文档一致；完整计算有组合预算上限
- [ ] 协同探索一次最多改变一层，探索预算由满意度决定
- [ ] EMA 参数、目标权重、帕累托目标方向集中配置
- [ ] 所有随机算法支持测试注入 RNG 或 deterministic seed

### 7.2 性能要求

- 单次配置选择纯计算 p95 < 50ms
- 单次反馈记录异步提交，不增加主流程 p95 超过 100ms
- 记忆排序候选 100 条以内 p95 < 50ms
- 工具采样选择 p95 < 10ms
- 单次重训练不超过配置的 CPU/时间预算，禁止占满事件循环
- 帕累托前沿默认不超过 100 个配置

### 7.3 可靠性与一致性

- P2 所有模块均可独立关闭并回退到 P0/P1 策略
- 反馈写入采用幂等事件 ID，避免重试重复计数
- 模型和策略更新采用版本化快照，失败时恢复上一版本
- 后台任务具备超时、重试上限、熔断和启动恢复
- 协调器关闭时清理定时器、队列和数据库连接
- 配置快照与反馈事件使用同一 session/correlation ID

### 7.4 安全、隐私与用户控制

- 不将用户消息原文、密钥、令牌或完整记忆写入训练反馈和 Telemetry
- 工具选择严格受现有权限、批准和沙箱策略约束
- 技能生成、安装、文件修改、网络写入等行为不自动执行
- 记忆只允许标记为低效，删除必须显式批准或遵循现有保留策略
- 所有自动策略提供停用开关、审计日志和恢复入口

---

## 八、测试策略

### 8.1 单元测试

- Learning-to-Rank：特征归一化、预测、在线学习、持久化和异常输入
- Thompson Sampling：Beta 采样、后验更新、工具过滤、空列表、幂等
- 技能统计：聚合、阈值、时间窗口、缺口优先级
- Shapley：边际贡献、零贡献平均分配、负贡献截断和归一化
- 调度器：探索预算、最近历史、单层变更、随机源注入
- 冲突检测：规则命中、critical 修复、warning 记录、循环防护
- Pareto：支配关系、前沿更新、偏好选择、容量上限

### 8.2 集成测试

- 真实数据库迁移与 CRUD
- 记忆检索 → 排序 → 回复反馈 → 模型更新闭环
- 工具候选 → Thompson 选择 → 执行 → 后验更新闭环
- 能力缺口 → 技能候选 → 用户批准 → 目标反馈闭环
- 配置选择 → 冲突修复 → 会话执行 → 贡献归因闭环

### 8.3 端到端场景

1. 高满意度场景：主要利用最优配置，探索频率符合预算。
2. 低满意度场景：只探索一个优先层，不同时改变其他层。
3. 记忆检索失败：回退 P1/P0 检索，不阻断回答。
4. 工具全部失败：保留安全错误路径，不无限重试或扩大权限。
5. 发现技能缺口：生成待批准目标，不自动生成/安装技能。
6. 检测层间冲突：critical 自动安全修复，warning 可观测。
7. P0/P1/P2 目标同时出现：去重并遵守每日 7 个上限。
8. 重启恢复：恢复模型、采样统计、调度状态和帕累托前沿。

---

## 九、可观测性与监控指标

建议创建 `docs/plans/AGENT自我进化/P2监控指标.md`，至少记录：

| 指标 | 类型 | 目标/告警 |
|------|------|-----------|
| memory-ranking-ndcg | Gauge | 相对基线不下降；连续下降告警 |
| memory-feedback-latency | Histogram | p95 < 100ms |
| tool-selection-success-rate | Gauge | 按工具、任务类型观察 |
| tool-selection-exploration-rate | Gauge | 偏离配置预算时告警 |
| skill-success-rate | Gauge | 连续低于 60% 触发缺口 |
| layer-contribution | Gauge | 四层贡献趋势，总和应接近 1 |
| exploration-mode | Counter | 检查是否同时探索多层 |
| conflict-detected/resolved | Counter | critical 未解决需告警 |
| pareto-frontier-size | Gauge | 不超过上限 |
| p2-fallback-count | Counter | 异常升高需告警 |
| p2-feedback-write-failure | Counter | 失败率 > 10% 告警 |

Telemetry 统一包含：`agentId`（如现有规范要求）、`sessionId`、`correlationId`、`strategyVersion`、`modelVersion`、`durationMs`。禁止包含用户内容原文和工具敏感参数。

---

## 十、成功指标与发布门槛

### 10.1 功能指标

- [ ] 记忆排序、技能跟踪、工具选择三条闭环均可独立运行
- [ ] 协调器能在会话前后完成配置选择和反馈归因
- [ ] 冲突可检测，确定性 critical 冲突可安全修复
- [ ] 帕累托前沿可持久化、加载和按偏好选择
- [ ] 人格更新和 P2 目标生成可关闭、可审计

### 10.2 质量指标

- [ ] P2 单元测试覆盖率 ≥ 80%
- [ ] P2 E2E 通过率 100%
- [ ] P0/P1 全量回归测试通过
- [ ] 类型检查和 lint 通过
- [ ] 数据库迁移正向/回滚验证通过
- [ ] 关键后台任务无未处理 Promise rejection

### 10.3 效果指标

在离线回放或灰度实验中验证：

- 记忆检索 NDCG@5 相比 P1 基线提升 ≥ 10%，或至少不下降
- 工具选择成功率相比固定策略提升 ≥ 5%
- 技能相关任务满意度相比 P1 基线提升 ≥ 5%
- 层间冲突导致的失败率下降 ≥ 20%
- P2 fallback 率稳定低于 10%

> 效果指标必须基于预先定义的对照组、时间窗口和最小样本量计算；不能仅凭单次会话判断策略有效。

---

## 十一、风险与缓解措施

| 风险 | 影响 | 缓解措施 | 验证方式 |
|------|------|----------|----------|
| 排序模型学习到错误反馈 | 高 | 显式反馈优先、最小样本量、离线评估、可回滚权重 | 回放集和 A/B 测试 |
| Thompson Sampling 偏向偶然成功 | 中 | Beta 先验、上下文隔离、后验可信区间、探索预算 | 模拟不同成功率 |
| 同时探索导致归因失真 | 高 | 调度器单层探索、配置快照、相关 ID | 协同集成测试 |
| Shapley 估计成本过高 | 中 | 默认增量近似、组合数上限、异步计算 | 性能基准测试 |
| 冲突自动修复改变用户意图 | 高 | 仅修复确定性规则、权限不扩大、记录审计 | 安全回归测试 |
| 低效记忆被误删 | 高 | P2 只标记不删除，删除需批准 | 数据保留测试 |
| P2 故障影响回答 | 高 | feature flag、fallback、熔断和异步写入 | 故障注入测试 |
| 人格漂移过快 | 中 | EMA alpha=0.05、变化阈值、快照回滚 | 长期模拟测试 |
| 反馈数据泄漏隐私 | 高 | 脱敏、字段白名单、日志审计 | 敏感数据扫描 |
| 用户不在电脑前导致审批无法进行 | 高 | 风险分级自动审批 + 渠道推送 + 超时兜底，见前端方案第十节 | 离线 8h 场景测试 |

> **P2 前置依赖**：P2 新增的 `skill-enhancement`、`memory-optimization` 目标同样进入审批流程。
> 在「离线审批架构」（`前端可视化实施方案.md` 第十节）落地前，这两类目标会和 P0/P1 目标一起
> 堆积在 `pending` 且无人可批。因此 **A1-A5 审批链路应先于 Task 9（目标生成集成）完成**。
> 其中 `skill-enhancement` 属 L2（有副作用），**超时也不得自动批准**。

---

## 十二、里程碑

| 周期 | 里程碑 | 交付物 | 退出标准 |
|------|--------|--------|----------|
| 第 11 周 | 记忆与工具进化 | Tasks 1-4 | 单测通过，fallback 可用 |
| 第 12 周 | 技能进化与数据层 | Tasks 5、8 | 技能反馈闭环，迁移可回滚 |
| 第 13 周 | 多层协同 | Tasks 6-7 | 单层探索、冲突修复、前沿维护通过 |
| 第 14 周 | 集成与灰度 | Tasks 9-10 | 回归/E2E/安全/性能门槛全部通过 |

发布采用 feature flag：先离线回放，再 5% 灰度，观察至少 7 天；未达到门槛时保持 P1 策略，不自动扩大灰度范围。

---

## 十三、P3 衔接

P2 完成后为 P3 提供：

- 四层可比较的贡献度和效果历史
- 稳定的协同探索调度接口
- 可持久化的多目标 Pareto 前沿
- 已版本化的策略、模型和人格状态

P3 再考虑人格主动进化、协同探索调度的高级策略和 Pareto 多目标动态权重。P2 不提前实现跨层自动代码生成、无批准外部操作或不可回滚的自我修改。
