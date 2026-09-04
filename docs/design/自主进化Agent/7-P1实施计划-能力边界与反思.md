# P1 实施计划：能力边界检测与自我反思

> **日期**：2026-09-04  
> **依赖**：P0 已完成（满意度评分、目标生成、Prompt 进化、人格追踪）  
> **状态**：设计阶段  
> **实施周期**：第 7-10 周

---

## 一、P1 范围与目标

### 1.1 核心能力扩展

P1 在 P0 基础上新增两大核心能力：

1. **能力边界检测（Capability Boundary Detection）**
   - 使用 Elo Rating System 动态追踪 Agent 在不同维度的能力水平
   - 识别能力缺口（当前水平 vs 期望水平）
   - 生成基于能力提升的学习目标

2. **自我反思（Self-Reflection）**
   - 定时触发深度反思（每日 23:00）
   - 使用 LLM 分析满意度低的根本原因
   - 生成结构化反思输出（问题诊断 + 改进建议）

### 1.2 与 P0 的集成关系

```
P0 基础设施（已完成）：
  - 满意度评分 ✓
  - 目标生成器 ✓
  - Prompt 进化 ✓
  - 人格追踪 ✓
  - 自主协调器 ✓

P1 扩展（新增）：
  - 能力边界检测 → 提供新的学习目标来源
  - 自我反思 → 提升目标生成质量
  
协同效果：
  P0: 低满意度 → 生成通用学习目标
  P1: 低满意度 → 反思根本原因 → 能力缺口分析 → 生成针对性目标
```

### 1.3 MVP P1 范围定义

```typescript
export interface P1Scope {
  metaCognition: {
    satisfactionScoring: true;           // P0 已实现
    capabilityTracking: 'auto';          // P1 新增：从 manual 升级到 auto
    reflectionTrigger: 'scheduled';      // P1 实现：定时触发
  };
  goalGeneration: {
    types: ['learning', 'proactive-message', 'capability-improvement']; // P1 新增第三类
    userApproval: 'always';
    maxGoalsPerDay: 5;                   // P1 提升上限（从 3 到 5）
  };
  evolution: {
    prompt: true;                        // P0 已实现
    memory: false;                       // P2
    skill: false;                        // P2
    tool: false;                         // P2
  };
  personality: {
    tracking: true;                      // P0 已实现
    evolution: false;                    // P3
    display: true;
  };
}
```

---

## 二、架构设计

### 2.1 新增模块

```text
packages/agent-runtime/src/autonomous/
  capability-tracker.ts           # 能力边界追踪器
  capability-rating-system.ts     # Elo Rating 算法实现
  reflection-engine.ts            # 自我反思引擎
  reflection-prompts.ts           # 反思提示词模板
  
  __tests__/
    capability-tracker.test.ts
    capability-rating-system.test.ts
    reflection-engine.test.ts
```

### 2.2 修改模块

```text
packages/agent-runtime/src/autonomous/
  types.ts                        # 新增能力相关类型
  config.ts                       # 新增能力检测参数
  intrinsic-goal-generator.ts     # 新增 capability-improvement 目标类型
  autonomous-coordinator.ts       # 集成能力追踪和反思触发
```

### 2.3 数据库扩展

```text
packages/database/migrations/
  YYYYMMDDHHMMSS_capability_dimensions.sql    # 能力维度表
  YYYYMMDDHHMMSS_capability_tests.sql         # 能力测试记录表
  YYYYMMDDHHMMSS_reflections.sql              # 反思记录表
```

---

## 三、核心算法实现

### 3.1 能力边界检测算法

#### 3.1.1 能力维度定义

```typescript
/**
 * 能力维度（基于实际 Agent 使用场景）
 * 来源：分析 P0 阶段用户任务类型分布
 */
export enum CapabilityDimension {
  CODE_GENERATION = 'code_generation',         // 代码生成
  DOCUMENT_ANALYSIS = 'document_analysis',     // 文档分析
  WEB_SEARCH = 'web_search',                   // 网络搜索
  DATA_PROCESSING = 'data_processing',         // 数据处理
  API_INTEGRATION = 'api_integration',         // API 集成
  CREATIVE_WRITING = 'creative_writing',       // 创意写作
  LOGICAL_REASONING = 'logical_reasoning',     // 逻辑推理
  MULTI_STEP_PLANNING = 'multi_step_planning', // 多步规划
}

/**
 * 能力状态
 */
export interface CapabilityState {
  dimension: CapabilityDimension;
  /** 当前能力水平 (0-1，使用 Elo Rating 归一化) */
  level: number;
  /** 对该能力评估的置信度 (0-1，基于测试样本量) */
  confidence: number;
  /** 能力边界（50% 成功率的难度阈值） */
  boundary: number;
  /** 最后更新时间 */
  lastUpdated: string;
  /** 测试次数 */
  testCount: number;
}

/**
 * 能力测试记录
 */
export interface CapabilityTest {
  id: string;
  agentId: string;
  dimension: CapabilityDimension;
  /** 任务描述摘要（脱敏） */
  taskSummary: string;
  /** 任务难度估计 (0-1) */
  difficulty: number;
  /** 测试结果 */
  result: 'success' | 'partial' | 'failure';
  /** 会话 ID（关联到具体对话） */
  sessionId: string;
  /** 测试时间 */
  createdAt: string;
}

/**
 * 能力缺口
 */
export interface CapabilityGap {
  dimension: CapabilityDimension;
  /** 当前能力水平 */
  currentLevel: number;
  /** 期望能力水平（基于用户需求频率） */
  desiredLevel: number;
  /** 缺口大小 */
  gap: number;
  /** 优先级（需求频率 × 缺口大小） */
  priority: number;
  /** 用户需求频率 (0-1) */
  demandFrequency: number;
}
```

#### 3.1.2 Elo Rating System 实现

```typescript
/**
 * Elo Rating System for Capability Tracking
 * 
 * 参考设计文档：docs/design/自主进化Agent/2-元认知引擎算法.md
 * 公式：newLevel = level + K × (actual - expected)
 * 
 * K = 32（学习率，与设计文档一致）
 */
export class CapabilityRatingSystem {
  private readonly K: number;
  
  constructor(K: number = 32) {
    this.K = K;
  }
  
  /**
   * 更新能力评级
   * @param currentLevel 当前能力水平 (0-1)
   * @param difficulty 任务难度 (0-1)
   * @param result 测试结果
   * @returns 更新后的能力水平 (0-1)
   */
  updateRating(
    currentLevel: number,
    difficulty: number,
    result: 'success' | 'partial' | 'failure'
  ): number {
    // 预期表现概率（Logistic 函数）
    const expected = this.expectedPerformance(currentLevel, difficulty);
    
    // 实际表现得分
    const actual = result === 'success' ? 1.0 :
                   result === 'partial' ? 0.5 : 0.0;
    
    // Elo 更新公式（归一化 K 值到 0-1 范围）
    const normalizedK = this.K / 100;
    const newLevel = currentLevel + normalizedK * (actual - expected);
    
    // 边界约束 [0, 1]
    return Math.max(0, Math.min(1, newLevel));
  }
  
  /**
   * 预期表现概率
   * @param level 能力水平
   * @param difficulty 任务难度
   * @returns 预期成功概率 (0-1)
   */
  private expectedPerformance(level: number, difficulty: number): number {
    // Logistic 函数：P = 1 / (1 + e^(-10 × (level - difficulty)))
    const diff = level - difficulty;
    return 1 / (1 + Math.exp(-10 * diff));
  }
  
  /**
   * 计算能力边界（50% 成功率的难度阈值）
   * 在当前能力水平下，expected = 0.5 时的 difficulty 值
   * 
   * 求解：0.5 = 1 / (1 + e^(-10 × (level - boundary)))
   * 得：boundary = level
   */
  findBoundary(level: number): number {
    return level;
  }
  
  /**
   * 计算置信度（基于测试样本量）
   * 使用指数饱和函数，样本量越多置信度越高
   * 
   * @param testCount 测试次数
   * @returns 置信度 (0-1)
   */
  computeConfidence(testCount: number): number {
    // 置信度 = 1 - e^(-n / 20)
    // n = 20 时约 0.63，n = 60 时约 0.95
    return 1 - Math.exp(-testCount / 20);
  }
}
```

#### 3.1.3 能力追踪器实现

```typescript
/**
 * 能力追踪器
 * 负责记录能力测试、更新能力评级、识别能力缺口
 */
export class CapabilityTracker {
  private ratingSystem: CapabilityRatingSystem;
  private db: DatabaseClient;
  
  constructor(db: DatabaseClient, K: number = 32) {
    this.ratingSystem = new CapabilityRatingSystem(K);
    this.db = db;
  }
  
  /**
   * 记录能力测试
   * @param test 测试记录
   * @returns 更新后的能力状态
   */
  async recordTest(test: Omit<CapabilityTest, 'id' | 'createdAt'>): Promise<CapabilityState> {
    // 1. 获取当前能力状态
    const currentState = await this.getCapabilityState(test.agentId, test.dimension);
    
    // 2. 使用 Elo Rating 更新能力水平
    const newLevel = this.ratingSystem.updateRating(
      currentState.level,
      test.difficulty,
      test.result
    );
    
    // 3. 更新测试次数和置信度
    const newTestCount = currentState.testCount + 1;
    const newConfidence = this.ratingSystem.computeConfidence(newTestCount);
    
    // 4. 计算新的能力边界
    const newBoundary = this.ratingSystem.findBoundary(newLevel);
    
    // 5. 持久化测试记录
    await this.db.insert('capability_tests', {
      ...test,
      id: generateUUID(),
      createdAt: new Date().toISOString(),
    });
    
    // 6. 更新能力状态
    const updatedState: CapabilityState = {
      dimension: test.dimension,
      level: newLevel,
      confidence: newConfidence,
      boundary: newBoundary,
      lastUpdated: new Date().toISOString(),
      testCount: newTestCount,
    };
    
    await this.db.upsert('capability_dimensions', {
      agent_id: test.agentId,
      dimension: test.dimension,
    }, updatedState);
    
    // 7. 记录 Telemetry
    logger.info('Capability test recorded', {
      event: 'capability-test-recorded',
      agentId: test.agentId,
      dimension: test.dimension,
      difficulty: test.difficulty,
      result: test.result,
      levelBefore: currentState.level,
      levelAfter: newLevel,
      confidence: newConfidence,
    });
    
    return updatedState;
  }
  
  /**
   * 获取能力状态
   */
  async getCapabilityState(agentId: string, dimension: CapabilityDimension): Promise<CapabilityState> {
    const state = await this.db.findOne('capability_dimensions', {
      agent_id: agentId,
      dimension,
    });
    
    // 初始状态：中等水平 0.5，零置信度
    return state || {
      dimension,
      level: 0.5,
      confidence: 0,
      boundary: 0.5,
      lastUpdated: new Date().toISOString(),
      testCount: 0,
    };
  }
  
  /**
   * 识别能力缺口
   * @param agentId Agent ID
   * @returns 按优先级排序的能力缺口列表
   */
  async identifyGaps(agentId: string): Promise<CapabilityGap[]> {
    // 1. 获取所有维度的当前状态
    const allDimensions = Object.values(CapabilityDimension);
    const states = await Promise.all(
      allDimensions.map(d => this.getCapabilityState(agentId, d))
    );
    
    // 2. 分析用户需求频率（基于最近 30 天的任务类型分布）
    const demandMap = await this.analyzeDemandFrequency(agentId, 30);
    
    // 3. 计算能力缺口
    const gaps: CapabilityGap[] = [];
    for (const state of states) {
      const demand = demandMap.get(state.dimension) || 0;
      
      // 期望水平 = 0.5（基线）+ demand × 0.5（需求越高期望越高）
      // 上限 0.9（保留 10% 空间用于持续优化）
      const desiredLevel = Math.min(0.9, 0.5 + demand * 0.5);
      
      if (state.level < desiredLevel) {
        const gap = desiredLevel - state.level;
        gaps.push({
          dimension: state.dimension,
          currentLevel: state.level,
          desiredLevel,
          gap,
          priority: demand * gap,  // 优先级 = 需求频率 × 缺口大小
          demandFrequency: demand,
        });
      }
    }
    
    // 4. 按优先级降序排序
    return gaps.sort((a, b) => b.priority - a.priority);
  }
  
  /**
   * 分析用户需求频率
   * 从历史会话中提取任务类型分布
   */
  private async analyzeDemandFrequency(
    agentId: string,
    days: number
  ): Promise<Map<CapabilityDimension, number>> {
    const since = new Date();
    since.setDate(since.getDate() - days);
    
    // 查询最近的能力测试记录
    const tests = await this.db.find('capability_tests', {
      agent_id: agentId,
      created_at: { $gte: since.toISOString() },
    });
    
    // 统计各维度出现频率
    const counts = new Map<CapabilityDimension, number>();
    for (const test of tests) {
      counts.set(test.dimension, (counts.get(test.dimension) || 0) + 1);
    }
    
    // 归一化到 [0, 1]
    const total = tests.length || 1;
    const frequencies = new Map<CapabilityDimension, number>();
    for (const [dim, count] of counts.entries()) {
      frequencies.set(dim, count / total);
    }
    
    return frequencies;
  }
  
  /**
   * 获取能力报告（用于展示）
   */
  async getCapabilityReport(agentId: string): Promise<{
    states: CapabilityState[];
    gaps: CapabilityGap[];
    overallLevel: number;
  }> {
    const allDimensions = Object.values(CapabilityDimension);
    const states = await Promise.all(
      allDimensions.map(d => this.getCapabilityState(agentId, d))
    );
    
    const gaps = await this.identifyGaps(agentId);
    
    // 计算加权平均能力水平（权重 = 置信度）
    const totalWeight = states.reduce((sum, s) => sum + s.confidence, 0) || 1;
    const overallLevel = states.reduce(
      (sum, s) => sum + s.level * s.confidence,
      0
    ) / totalWeight;
    
    return { states, gaps, overallLevel };
  }
}
```

### 3.2 自我反思引擎

#### 3.2.1 反思输出结构

```typescript
/**
 * 反思输出（LLM 生成）
 * 来源：设计文档 2-元认知引擎算法.md
 */
export interface ReflectionOutput {
  /** 反思 ID */
  id: string;
  /** Agent ID */
  agentId: string;
  /** 触发原因 */
  triggerReason: 'scheduled' | 'low-satisfaction' | 'user-request';
  
  /** 问题诊断 */
  diagnosis: {
    /** 主要问题描述 */
    primaryIssue: string;
    /** 影响的满意度维度 */
    affectedDimensions: Array<'task' | 'feedback' | 'efficiency' | 'knowledge'>;
    /** 根本原因分析 */
    rootCause: string;
  };
  
  /** 改进建议 */
  recommendations: Array<{
    /** 建议类型 */
    type: 'prompt' | 'capability' | 'memory' | 'workflow';
    /** 建议描述 */
    description: string;
    /** 预期改善的维度 */
    targetDimensions: Array<'task' | 'feedback' | 'efficiency' | 'knowledge'>;
    /** 可行性评估 (0-1) */
    feasibility: number;
    /** 预期影响 (0-1) */
    impact: number;
  }>;
  
  /** 学习目标建议 */
  suggestedGoals: Array<{
    type: GoalType;
    description: string;
    priority: number;
  }>;
  
  /** 反思时间 */
  createdAt: string;
  /** 分析的时间窗口 */
  analysisWindow: {
    start: string;
    end: string;
  };
}
```

#### 3.2.2 反思提示词模板

```typescript
/**
 * 反思提示词模板
 * 输入：满意度评分历史 + 能力报告 + 最近会话摘要
 * 输出：结构化反思 JSON
 */
export const REFLECTION_PROMPT_TEMPLATE = `
你是一个自主进化 Agent 的元认知引擎，负责分析自身表现并提出改进建议。

## 输入数据

### 满意度评分历史（最近 7 天）
{{satisfactionHistory}}

### 能力状态报告
{{capabilityReport}}

### 最近会话摘要（最近 10 次对话）
{{recentSessions}}

## 任务

请进行深度自我反思，回答以下问题：

1. **问题诊断**
   - 主要问题是什么？（一句话概括）
   - 哪些满意度维度受到影响？（task/feedback/efficiency/knowledge）
   - 根本原因是什么？（深入分析，不要停留在表面）

2. **改进建议**
   - 针对根本原因，提出 2-4 条具体改进建议
   - 每条建议需说明：
     * 类型（prompt/capability/memory/workflow）
     * 具体描述（可操作的步骤）
     * 预期改善的维度
     * 可行性评估（0-1，考虑实施难度）
     * 预期影响（0-1，改善程度）

3. **学习目标建议**
   - 基于改进建议，生成 1-3 个学习目标
   - 每个目标需说明：
     * 目标类型（learning/proactive-message/capability-improvement）
     * 目标描述
     * 优先级（0-1）

## 输出格式

严格按照以下 JSON Schema 输出（不要包含其他文字）：

\`\`\`json
{
  "diagnosis": {
    "primaryIssue": "string",
    "affectedDimensions": ["task" | "feedback" | "efficiency" | "knowledge"],
    "rootCause": "string"
  },
  "recommendations": [
    {
      "type": "prompt" | "capability" | "memory" | "workflow",
      "description": "string",
      "targetDimensions": ["task" | "feedback" | "efficiency" | "knowledge"],
      "feasibility": 0.0-1.0,
      "impact": 0.0-1.0
    }
  ],
  "suggestedGoals": [
    {
      "type": "learning" | "proactive-message" | "capability-improvement",
      "description": "string",
      "priority": 0.0-1.0
    }
  ]
}
\`\`\`

## 约束

- 只分析数据中体现的问题，不要臆测
- 改进建议必须具体可操作，避免空泛建议（如"多学习"）
- 优先考虑高可行性、高影响的建议
- 学习目标不超过 3 个，聚焦最重要的改进方向
`;
```

#### 3.2.3 反思引擎实现

```typescript
/**
 * 自我反思引擎
 * 定时触发，使用 LLM 分析满意度低的根本原因
 */
export class ReflectionEngine {
  private db: DatabaseClient;
  private llmClient: LLMClient;
  private metaCognitionEngine: MetaCognitionEngine;
  private capabilityTracker: CapabilityTracker;
  
  constructor(
    db: DatabaseClient,
    llmClient: LLMClient,
    metaCognitionEngine: MetaCognitionEngine,
    capabilityTracker: CapabilityTracker
  ) {
    this.db = db;
    this.llmClient = llmClient;
    this.metaCognitionEngine = metaCognitionEngine;
    this.capabilityTracker = capabilityTracker;
  }
  
  /**
   * 执行反思
   * @param agentId Agent ID
   * @param triggerReason 触发原因
   * @returns 反思输出
   */
  async reflect(
    agentId: string,
    triggerReason: 'scheduled' | 'low-satisfaction' | 'user-request'
  ): Promise<ReflectionOutput> {
    // 1. 收集输入数据
    const satisfactionHistory = await this.metaCognitionEngine.getRecentScores(agentId, 7);
    const capabilityReport = await this.capabilityTracker.getCapabilityReport(agentId);
    const recentSessions = await this.getRecentSessionSummaries(agentId, 10);
    
    // 2. 构造提示词
    const prompt = this.buildReflectionPrompt(
      satisfactionHistory,
      capabilityReport,
      recentSessions
    );
    
    // 3. 调用 LLM 生成反思
    const llmResponse = await this.llmClient.complete({
      model: 'claude-opus-5',  // 使用最强模型进行反思
      prompt,
      temperature: 0.3,  // 低温度，确保输出稳定
      maxTokens: 2000,
    });
    
    // 4. 解析 LLM 输出
    const reflection = this.parseReflectionOutput(llmResponse.content, agentId, triggerReason);
    
    // 5. 持久化反思记录
    await this.db.insert('reflections', reflection);
    
    // 6. 记录 Telemetry
    logger.info('Reflection completed', {
      event: 'reflection-completed',
      agentId,
      triggerReason,
      primaryIssue: reflection.diagnosis.primaryIssue,
      recommendationCount: reflection.recommendations.length,
      suggestedGoalCount: reflection.suggestedGoals.length,
    });
    
    return reflection;
  }
  
  /**
   * 构造反思提示词
   */
  private buildReflectionPrompt(
    satisfactionHistory: SatisfactionScore[],
    capabilityReport: any,
    recentSessions: any[]
  ): string {
    // 格式化满意度历史
    const historyText = satisfactionHistory.map(s => 
      `[${s.timestamp}] 总分: ${s.overall.toFixed(2)} (任务: ${s.taskCompletion.toFixed(2)}, 反馈: ${s.userFeedback.toFixed(2)}, 效率: ${s.efficiency.toFixed(2)}, 知识: ${s.knowledgeGrowth.toFixed(2)})`
    ).join('\n');
    
    // 格式化能力报告
    const capabilityText = capabilityReport.states.map((s: CapabilityState) =>
      `- ${s.dimension}: 水平 ${s.level.toFixed(2)}, 置信度 ${s.confidence.toFixed(2)}, 测试次数 ${s.testCount}`
    ).join('\n');
    
    const gapsText = capabilityReport.gaps.length > 0
      ? capabilityReport.gaps.map((g: CapabilityGap) =>
          `- ${g.dimension}: 当前 ${g.currentLevel.toFixed(2)} → 期望 ${g.desiredLevel.toFixed(2)} (缺口: ${g.gap.toFixed(2)}, 优先级: ${g.priority.toFixed(2)})`
        ).join('\n')
      : '无明显能力缺口';
    
    // 格式化会话摘要（脱敏）
    const sessionsText = recentSessions.map(s =>
      `[${s.timestamp}] 任务: ${s.taskSummary}, 满意度: ${s.satisfaction.toFixed(2)}, 工具使用: ${s.toolCount}, 错误: ${s.errorCount}`
    ).join('\n');
    
    // 替换模板占位符
    return REFLECTION_PROMPT_TEMPLATE
      .replace('{{satisfactionHistory}}', historyText)
      .replace('{{capabilityReport}}', `能力状态:\n${capabilityText}\n\n能力缺口:\n${gapsText}`)
      .replace('{{recentSessions}}', sessionsText);
  }
  
  /**
   * 解析 LLM 反思输出
   */
  private parseReflectionOutput(
    llmContent: string,
    agentId: string,
    triggerReason: string
  ): ReflectionOutput {
    // 提取 JSON 块
    const jsonMatch = llmContent.match(/```json\s*([\s\S]*?)\s*```/);
    if (!jsonMatch) {
      throw new Error('Failed to extract JSON from reflection output');
    }
    
    const parsed = JSON.parse(jsonMatch[1]);
    
    // 构造完整反思输出
    const now = new Date().toISOString();
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    return {
      id: generateUUID(),
      agentId,
      triggerReason: triggerReason as any,
      diagnosis: parsed.diagnosis,
      recommendations: parsed.recommendations,
      suggestedGoals: parsed.suggestedGoals,
      createdAt: now,
      analysisWindow: {
        start: sevenDaysAgo.toISOString(),
        end: now,
      },
    };
  }
  
  /**
   * 获取最近会话摘要（脱敏）
   */
  private async getRecentSessionSummaries(agentId: string, limit: number): Promise<any[]> {
    const sessions = await this.db.find('autonomous_satisfaction_scores', {
      agent_id: agentId,
    }, {
      limit,
      orderBy: { created_at: 'DESC' },
    });
    
    // 提取摘要信息（不包含用户消息原文）
    return sessions.map(s => ({
      timestamp: s.created_at,
      taskSummary: s.task_summary || '未知任务',
      satisfaction: s.overall_score,
      toolCount: s.tool_call_count || 0,
      errorCount: s.error_count || 0,
    }));
  }
  
  /**
   * 获取最近的反思记录
   */
  async getRecentReflections(agentId: string, limit: number = 5): Promise<ReflectionOutput[]> {
    return await this.db.find('reflections', {
      agent_id: agentId,
    }, {
      limit,
      orderBy: { created_at: 'DESC' },
    });
  }
}
```

---

## 四、数据库 Schema

### 4.1 能力维度表（capability_dimensions）

```sql
CREATE TABLE capability_dimensions (
  agent_id VARCHAR(255) NOT NULL,
  dimension VARCHAR(50) NOT NULL,
  level DECIMAL(3, 2) NOT NULL DEFAULT 0.5 CHECK (level BETWEEN 0 AND 1),
  confidence DECIMAL(3, 2) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  boundary DECIMAL(3, 2) NOT NULL DEFAULT 0.5 CHECK (boundary BETWEEN 0 AND 1),
  test_count INTEGER NOT NULL DEFAULT 0,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  PRIMARY KEY (agent_id, dimension),
  INDEX idx_agent_dimension (agent_id, dimension)
);

COMMENT ON TABLE capability_dimensions IS '能力维度追踪表，记录 Agent 在各维度的能力水平';
COMMENT ON COLUMN capability_dimensions.level IS '当前能力水平 (0-1)，使用 Elo Rating 更新';
COMMENT ON COLUMN capability_dimensions.confidence IS '评估置信度 (0-1)，基于测试样本量';
COMMENT ON COLUMN capability_dimensions.boundary IS '能力边界，50% 成功率的难度阈值';
```

### 4.2 能力测试表（capability_tests）

```sql
CREATE TABLE capability_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id VARCHAR(255) NOT NULL,
  dimension VARCHAR(50) NOT NULL,
  session_id UUID NOT NULL,
  task_summary TEXT NOT NULL,
  difficulty DECIMAL(3, 2) NOT NULL CHECK (difficulty BETWEEN 0 AND 1),
  result VARCHAR(20) NOT NULL CHECK (result IN ('success', 'partial', 'failure')),
  level_before DECIMAL(3, 2),
  level_after DECIMAL(3, 2),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  INDEX idx_agent_dimension_created (agent_id, dimension, created_at DESC),
  INDEX idx_session (session_id)
);

COMMENT ON TABLE capability_tests IS '能力测试记录表，存储每次任务执行的能力测试结果';
COMMENT ON COLUMN capability_tests.task_summary IS '任务描述摘要（脱敏，不含用户消息原文）';
COMMENT ON COLUMN capability_tests.difficulty IS '任务难度估计 (0-1)，由启发式规则或 LLM 评估';
```

### 4.3 反思记录表（reflections）

```sql
CREATE TABLE reflections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id VARCHAR(255) NOT NULL,
  trigger_reason VARCHAR(50) NOT NULL CHECK (trigger_reason IN ('scheduled', 'low-satisfaction', 'user-request')),
  
  -- 问题诊断
  primary_issue TEXT NOT NULL,
  affected_dimensions JSONB NOT NULL,
  root_cause TEXT NOT NULL,
  
  -- 改进建议（JSON 数组）
  recommendations JSONB NOT NULL,
  
  -- 学习目标建议（JSON 数组）
  suggested_goals JSONB NOT NULL,
  
  -- 分析时间窗口
  analysis_window_start TIMESTAMP WITH TIME ZONE NOT NULL,
  analysis_window_end TIMESTAMP WITH TIME ZONE NOT NULL,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  INDEX idx_agent_created (agent_id, created_at DESC)
);

COMMENT ON TABLE reflections IS '自我反思记录表，存储 LLM 生成的深度反思输出';
COMMENT ON COLUMN reflections.recommendations IS 'JSON 数组，格式：[{type, description, targetDimensions, feasibility, impact}]';
COMMENT ON COLUMN reflections.suggested_goals IS 'JSON 数组，格式：[{type, description, priority}]';
```

### 4.4 迁移脚本（Down）

```sql
-- Down migration for P1
DROP TABLE IF EXISTS reflections CASCADE;
DROP TABLE IF EXISTS capability_tests CASCADE;
DROP TABLE IF EXISTS capability_dimensions CASCADE;
```

---

## 五、实施任务拆解

### Task 1: 类型定义与配置扩展（2h）

**文件：**
- Modify `packages/agent-runtime/src/autonomous/types.ts`
- Modify `packages/agent-runtime/src/autonomous/config.ts`

**依赖：** 无（基于 P0 已完成的基础）

**任务清单：**
- [ ] 在 `types.ts` 中新增 `CapabilityDimension` 枚举（8 个维度）
- [ ] 新增 `CapabilityState` 接口（level, confidence, boundary, testCount）
- [ ] 新增 `CapabilityTest` 接口（dimension, difficulty, result, sessionId）
- [ ] 新增 `CapabilityGap` 接口（currentLevel, desiredLevel, gap, priority）
- [ ] 新增 `ReflectionOutput` 接口（diagnosis, recommendations, suggestedGoals）
- [ ] 在 `GoalType` 枚举中新增 `CAPABILITY_IMPROVEMENT = 'capability-improvement'`
- [ ] 更新 `P1Scope` 接口（capabilityTracking: 'auto', maxGoalsPerDay: 5）
- [ ] 在 `config.ts` 中新增 `ELO_K_FACTOR = 32`（Elo Rating 学习率）
- [ ] 新增 `REFLECTION_SCHEDULE = '0 23 * * *'`（每日 23:00）
- [ ] 编写单元测试验证类型完整性

**验收标准：** 所有新增类型定义完整，与设计文档 2-元认知引擎算法.md 一致，类型检查通过。

---

### Task 2: 实现 Elo Rating System（6h）

**文件：**
- Create `packages/agent-runtime/src/autonomous/capability-rating-system.ts`
- Create `packages/agent-runtime/src/autonomous/__tests__/capability-rating-system.test.ts`

**依赖：** Task 1

**任务清单：**
- [ ] 实现 `CapabilityRatingSystem` 类构造函数（注入 K 值）
- [ ] 实现 `updateRating(currentLevel, difficulty, result)` 方法：
  - 计算预期表现概率（Logistic 函数）
  - 应用 Elo 更新公式：`newLevel = level + K × (actual - expected)`
  - 边界约束 [0, 1]
- [ ] 实现 `expectedPerformance(level, difficulty)` 方法：
  - Logistic 函数：`1 / (1 + e^(-10 × (level - difficulty)))`
- [ ] 实现 `findBoundary(level)` 方法（返回 level 本身）
- [ ] 实现 `computeConfidence(testCount)` 方法：
  - 指数饱和：`1 - e^(-testCount / 20)`
- [ ] 编写单元测试：
  - 测试 Elo 更新公式正确性（已知输入 → 验证输出）
  - 测试预期表现概率（level = difficulty 时应为 0.5）
  - 测试边界约束（更新后不超出 [0, 1]）
  - 测试置信度饱和曲线
- [ ] 运行测试：`pnpm --filter @lumii/agent-runtime exec vitest run autonomous/__tests__/capability-rating-system.test.ts`

**验收标准：** Elo Rating 算法与设计文档公式完全一致，测试覆盖率 ≥ 80%，所有边界情况正确处理。

---

### Task 3: 实现能力追踪器（8h）

**文件：**
- Create `packages/agent-runtime/src/autonomous/capability-tracker.ts`
- Create `packages/agent-runtime/src/autonomous/__tests__/capability-tracker.test.ts`

**依赖：** Tasks 1-2

**任务清单：**
- [ ] 实现 `CapabilityTracker` 类构造函数（注入 db 和 K 值）
- [ ] 实现 `recordTest(test)` 方法：
  - 获取当前能力状态
  - 调用 Elo Rating System 更新能力水平
  - 更新测试次数和置信度
  - 持久化测试记录和能力状态
  - 记录 Telemetry
- [ ] 实现 `getCapabilityState(agentId, dimension)` 方法：
  - 从数据库查询，若不存在返回默认状态（level: 0.5, confidence: 0）
- [ ] 实现 `identifyGaps(agentId)` 方法：
  - 获取所有维度的当前状态
  - 分析用户需求频率（最近 30 天任务类型分布）
  - 计算能力缺口（期望水平 = 0.5 + demand × 0.5，上限 0.9）
  - 按优先级（需求 × 缺口）排序
- [ ] 实现 `analyzeDemandFrequency(agentId, days)` 私有方法：
  - 查询最近 N 天的能力测试记录
  - 统计各维度出现频率并归一化
- [ ] 实现 `getCapabilityReport(agentId)` 方法：
  - 返回所有维度状态、缺口列表、加权平均能力水平
- [ ] 编写单元测试：
  - Mock 数据库，测试 recordTest 正确更新能力状态
  - 测试 identifyGaps 正确计算缺口和优先级
  - 测试需求频率分析逻辑
  - 测试 getCapabilityReport 返回完整报告
- [ ] 运行测试并验证覆盖率 ≥ 80%

**验收标准：** 能力追踪器正确记录测试、更新评级、识别缺口，数据库操作失败时降级为日志记录，测试覆盖率达标。

---

### Task 4: 实现反思提示词与 LLM 集成（4h）

**文件：**
- Create `packages/agent-runtime/src/autonomous/reflection-prompts.ts`
- Create `packages/agent-runtime/src/autonomous/__tests__/reflection-prompts.test.ts`

**依赖：** Task 1

**任务清单：**
- [ ] 定义 `REFLECTION_PROMPT_TEMPLATE` 常量（完整提示词模板）
- [ ] 实现 `buildReflectionPrompt(satisfactionHistory, capabilityReport, recentSessions)` 函数：
  - 格式化满意度历史（时间戳 + 各维度分数）
  - 格式化能力报告（各维度状态 + 缺口列表）
  - 格式化会话摘要（脱敏，仅元数据）
  - 替换模板占位符
- [ ] 实现 `parseReflectionOutput(llmContent)` 函数：
  - 提取 JSON 块（正则匹配 \`\`\`json ... \`\`\`）
  - 解析 JSON 并验证 Schema
  - 处理解析失败（抛出明确错误）
- [ ] 编写单元测试：
  - 测试提示词构造（验证占位符正确替换）
  - 测试 LLM 输出解析（已知 JSON → 验证解析结果）
  - 测试解析失败处理（格式错误的 JSON）
- [ ] 运行测试并验证覆盖率 ≥ 80%

**验收标准：** 反思提示词模板完整，支持结构化输出，解析逻辑健壮，测试覆盖率达标。

---

### Task 5: 实现反思引擎（6h）

**文件：**
- Create `packages/agent-runtime/src/autonomous/reflection-engine.ts`
- Create `packages/agent-runtime/src/autonomous/__tests__/reflection-engine.test.ts`

**依赖：** Tasks 1, 3, 4

**任务清单：**
- [ ] 实现 `ReflectionEngine` 类构造函数（注入 db, llmClient, metaCognitionEngine, capabilityTracker）
- [ ] 实现 `reflect(agentId, triggerReason)` 方法：
  - 收集输入数据（满意度历史 + 能力报告 + 会话摘要）
  - 构造反思提示词
  - 调用 LLM（claude-opus-5, temperature 0.3）
  - 解析反思输出
  - 持久化到数据库 reflections 表
  - 记录 Telemetry
- [ ] 实现 `getRecentSessionSummaries(agentId, limit)` 私有方法：
  - 查询最近 N 次会话的满意度记录
  - 提取摘要信息（脱敏）
- [ ] 实现 `getRecentReflections(agentId, limit)` 方法：
  - 查询最近的反思记录
- [ ] 编写单元测试：
  - Mock LLM 客户端，测试反思流程完整执行
  - 测试 LLM 调用失败时错误处理
  - 测试反思记录持久化
  - 测试 getRecentReflections 正确查询
- [ ] 运行测试并验证覆盖率 ≥ 80%

**验收标准：** 反思引擎完整集成 LLM，输出结构化反思，LLM 失败时降级处理，测试覆盖率达标。

---

### Task 6: 集成能力追踪到协调器（8h）

**文件：**
- Modify `packages/agent-runtime/src/autonomous/autonomous-coordinator.ts`
- Modify `packages/agent-runtime/src/autonomous/__tests__/autonomous-coordinator.test.ts`

**依赖：** Tasks 1-3, 5

**任务清单：**
- [ ] 在 `AutonomousCoordinator` 构造函数中初始化 `capabilityTracker` 和 `reflectionEngine`
- [ ] 修改 `onSessionEnd(session)` 方法，新增能力测试记录：
  - 实现 `extractTasksFromSession(session)` 方法（启发式规则识别任务类型）
  - 实现 `mapTaskToCapability(taskType)` 方法（映射任务到能力维度）
  - 实现 `estimateDifficulty(task)` 方法（启发式估计难度）
  - 实现 `determineResult(task, score)` 方法（判断 success/partial/failure）
  - 调用 `capabilityTracker.recordTest()` 记录测试
- [ ] 实现 `scheduleReflection()` 方法：
  - 计算下次执行时间（每日 23:00）
  - 使用 setTimeout 递归调度
- [ ] 实现 `triggerScheduledReflection()` 方法：
  - 获取活跃 Agent 列表（最近 7 天有会话）
  - 为每个 Agent 执行反思
  - 根据反思结果生成目标
- [ ] 实现 `generateGoalsFromReflection(agentId, reflection)` 方法：
  - 将反思建议的目标转换为 AutonomousGoal
  - 调用目标生成器创建目标
- [ ] 修改 `shutdown()` 方法，清理反思定时任务
- [ ] 编写集成测试：
  - 测试会话结束时正确记录能力测试
  - 测试任务类型识别启发式规则（代码生成、文档分析等）
  - 测试难度估计和结果判断逻辑
  - 测试反思调度和执行流程
  - 测试从反思生成目标
- [ ] 运行测试并验证覆盖率 ≥ 80%

**验收标准：** 能力追踪和反思无侵入式集成到协调器，会话结束自动记录能力测试，反思定时触发，测试覆盖率达标。

---

### Task 7: 扩展目标生成器（4h）

**文件：**
- Modify `packages/agent-runtime/src/autonomous/intrinsic-goal-generator.ts`
- Modify `packages/agent-runtime/src/autonomous/__tests__/intrinsic-goal-generator.test.ts`

**依赖：** Tasks 1, 3

**任务清单：**
- [ ] 在 `GoalType` 枚举中确认已添加 `CAPABILITY_IMPROVEMENT`
- [ ] 实现 `generateCapabilityImprovementGoal(gaps)` 方法：
  - 选择优先级最高的缺口
  - 构造目标描述（能力维度 + 当前水平 + 目标水平）
  - 设置优先级为缺口优先级
- [ ] 实现 `buildCapabilityGoalDescription(gap)` 私有方法：
  - 映射能力维度到中文名称
  - 格式化为用户友好的描述
- [ ] 修改 `generateGoals()` 方法，新增参数 `capabilityGaps?: CapabilityGap[]`：
  - 保留 P0 的 learning 和 proactive-message 目标生成
  - 新增 capability-improvement 目标生成
  - 按优先级排序
  - 检查每日上限（提升到 5）
- [ ] 编写单元测试：
  - 测试 capability-improvement 目标生成
  - 测试目标描述格式化
  - 测试每日上限限制（5 个）
  - 测试优先级排序
- [ ] 运行测试并验证覆盖率 ≥ 80%

**验收标准：** 目标生成器支持第三类目标，能力缺口正确转换为学习目标，每日上限提升到 5，测试覆盖率达标。

---

### Task 8: 创建数据库迁移脚本（3h）

**文件：**
- Create `packages/database/migrations/YYYYMMDDHHMMSS_capability_dimensions.sql`
- Create `packages/database/migrations/YYYYMMDDHHMMSS_capability_tests.sql`
- Create `packages/database/migrations/YYYYMMDDHHMMSS_reflections.sql`

**依赖：** Task 1

**任务清单：**
- [ ] 创建 `capability_dimensions` 表迁移脚本：
  - PRIMARY KEY (agent_id, dimension)
  - CHECK 约束（level, confidence, boundary BETWEEN 0 AND 1）
  - 索引优化
  - 列注释
- [ ] 创建 `capability_tests` 表迁移脚本：
  - UUID 主键
  - CHECK 约束（difficulty BETWEEN 0 AND 1, result IN ('success', 'partial', 'failure')）
  - 外键关联（session_id 关联 autonomous_satisfaction_scores）
  - 索引优化（agent_id, dimension, created_at）
- [ ] 创建 `reflections` 表迁移脚本：
  - UUID 主键
  - JSONB 字段（affected_dimensions, recommendations, suggested_goals）
  - CHECK 约束（trigger_reason 枚举）
  - 索引优化
- [ ] 编写 Down 迁移脚本（DROP TABLE IF EXISTS ... CASCADE）
- [ ] 在本地测试环境运行迁移：
  - 验证表创建成功
  - 验证约束生效（插入非法值应失败）
  - 验证索引创建成功
  - 运行 Down 迁移验证回滚
- [ ] 更新数据库迁移文档

**验收标准：** 所有表 Schema 与设计文档一致，约束正确生效，索引优化查询，回滚脚本可用。

---

### Task 9: 端到端测试（6h）

**文件：**
- Create `packages/agent-runtime/src/autonomous/__tests__/integration/p1-e2e.test.ts`

**依赖：** Tasks 1-8

**任务清单：**
- [ ] **场景 1：能力测试记录与评级更新**
  - 模拟会话结束（包含代码生成任务）
  - 验证能力测试被记录到数据库
  - 验证 code_generation 维度能力水平更新
  - 验证置信度随测试次数增加
- [ ] **场景 2：能力缺口识别与目标生成**
  - 模拟多次会话（偏重某个能力维度）
  - 验证需求频率分析正确
  - 验证能力缺口识别（当前水平 < 期望水平）
  - 验证生成 capability-improvement 目标
- [ ] **场景 3：定时反思触发**
  - 模拟反思定时任务触发
  - 验证收集满意度历史、能力报告、会话摘要
  - Mock LLM 返回反思输出
  - 验证反思记录持久化
  - 验证从反思生成目标
- [ ] **场景 4：反思输出质量验证**
  - 使用真实 LLM（非 Mock）执行反思
  - 验证输出符合 JSON Schema
  - 验证建议具体可操作
  - 验证学习目标合理
- [ ] **场景 5：P1 与 P0 协同工作**
  - 低满意度 → 触发 P0 学习目标 + P1 能力改进目标
  - 验证两类目标共存
  - 验证每日上限 5 个生效
  - 验证优先级排序
- [ ] 运行所有测试并验证通过率 100%

**验收标准：** 端到端测试覆盖完整流程，P1 新功能与 P0 无冲突，测试通过率 100%。

---

### Task 10: 可观测性与监控（3h）

**文件：**
- Modify `packages/agent-runtime/src/autonomous/capability-tracker.ts`（新增 Telemetry）
- Modify `packages/agent-runtime/src/autonomous/reflection-engine.ts`（新增 Telemetry）
- Create `docs/autonomous-p1-metrics.md`（监控指标文档）

**依赖：** Tasks 1-9

**任务清单：**
- [ ] 在 `capability-tracker.ts` 中添加 Telemetry：
  - `capability-test-recorded`：记录 dimension, difficulty, result, levelBefore, levelAfter
  - `capability-gap-identified`：记录 dimension, gap, priority
- [ ] 在 `reflection-engine.ts` 中添加 Telemetry：
  - `reflection-started`：记录 agentId, triggerReason
  - `reflection-completed`：记录 primaryIssue, recommendationCount, suggestedGoalCount
  - `reflection-failed`：记录 error
- [ ] 编写监控指标文档 `docs/autonomous-p1-metrics.md`：
  - 核心指标：能力水平变化趋势、反思触发频率、目标完成率
  - 辅助指标：能力测试次数分布、反思 LLM 调用耗时
  - 告警阈值：能力水平连续下降、反思失败率 > 10%
- [ ] 验证 Telemetry 输出格式（结构化 JSON）
- [ ] 验证敏感数据不出现在 Telemetry 中

**验收标准：** 所有决策点记录 Telemetry，监控指标文档完整，无敏感数据泄漏。

---

## 六、实施顺序与提交边界

按以下顺序执行任务，每个任务完成后创建独立提交：

1. **Task 1**：类型定义与配置扩展 → `feat(autonomous-p1): add capability and reflection types`
2. **Task 2**：Elo Rating System → `feat(autonomous-p1): implement Elo Rating system`
3. **Task 3**：能力追踪器 → `feat(autonomous-p1): implement capability tracker`
4. **Task 4**：反思提示词 → `feat(autonomous-p1): add reflection prompts and LLM integration`
5. **Task 5**：反思引擎 → `feat(autonomous-p1): implement reflection engine`
6. **Task 6**：集成到协调器 → `feat(autonomous-p1): integrate capability tracking into coordinator`
7. **Task 7**：扩展目标生成器 → `feat(autonomous-p1): add capability-improvement goal type`
8. **Task 8**：数据库迁移 → `feat(autonomous-p1): add database migrations for P1`
9. **Task 9**：端到端测试 → `test(autonomous-p1): add P1 e2e tests`
10. **Task 10**：可观测性 → `feat(autonomous-p1): add telemetry and monitoring for P1`

每次提交前运行：
```powershell
pnpm --filter @lumii/agent-runtime test
pnpm --filter @lumii/agent-runtime typecheck
pnpm --filter @lumii/database test  # 仅 Task 8
```

---

## 七、工程化保障

### 7.1 算法一致性检查清单

- [ ] Elo Rating K 值 = 32（与设计文档 2-元认知引擎算法.md 一致）
- [ ] Logistic 函数参数 = -10（与设计文档一致）
- [ ] 置信度饱和参数 = 20（与设计文档一致）
- [ ] 能力水平初始值 = 0.5（中性）
- [ ] 期望水平计算公式 = 0.5 + demand × 0.5，上限 0.9
- [ ] 优先级计算公式 = demandFrequency × gap

### 7.2 性能要求

- [ ] 能力测试记录耗时 < 100ms（含数据库写入）
- [ ] 能力缺口识别耗时 < 200ms（查询 + 计算）
- [ ] 反思 LLM 调用耗时 < 30s（使用 claude-opus-5）
- [ ] 定时反思不阻塞主流程（异步执行）

### 7.3 可靠性保障

- [ ] 能力追踪失败不影响会话结束
- [ ] 反思 LLM 调用失败时降级（记录日志，不阻塞）
- [ ] 数据库连接失败时使用本地缓存
- [ ] 定时任务崩溃后自动重启

### 7.4 隐私保护

- [ ] 能力测试记录不包含用户消息原文
- [ ] 反思提示词使用脱敏会话摘要
- [ ] Telemetry 不记录敏感数据

---

## 八、成功指标

### 8.1 功能完整性

- [ ] 能力追踪在每次会话结束后自动执行
- [ ] 能力评级使用 Elo Rating System 动态更新
- [ ] 能力缺口正确识别并生成 capability-improvement 目标
- [ ] 反思定时触发（每日 23:00）
- [ ] 反思使用 LLM 生成结构化输出

### 8.2 算法一致性

- [ ] Elo Rating 更新公式与设计文档完全一致
- [ ] Logistic 预期表现函数正确实现
- [ ] 置信度计算公式正确（指数饱和）
- [ ] 能力缺口识别算法正确（需求 × 缺口）

### 8.3 工程质量

- [ ] 所有单元测试覆盖率 ≥ 80%
- [ ] 端到端测试通过率 100%
- [ ] 性能指标达标（能力测试 < 100ms，反思 < 30s）
- [ ] 数据库迁移可回滚

### 8.4 可观测性

- [ ] 所有决策点记录 Telemetry
- [ ] Telemetry 格式为结构化 JSON
- [ ] 无敏感数据泄漏

### 8.5 与 P0 集成

- [ ] P1 新功能不破坏 P0 现有功能
- [ ] 能力改进目标与学习目标共存
- [ ] 每日目标上限提升到 5
- [ ] 现有 Agent Runtime 测试无回归

---

## 九、风险缓解

| 风险 | 影响 | 缓解措施 | 验证方式 |
|------|------|----------|----------|
| 能力测试识别不准确 | 中 | 启发式规则经过 P0 数据验证，支持手动校准 | 统计分析能力测试准确率 |
| 反思 LLM 输出格式不稳定 | 高 | 使用低温度（0.3），JSON Schema 校验，重试机制 | 端到端测试 + 真实 LLM 验证 |
| 反思 LLM 调用成本高 | 中 | 定时触发（每日 1 次），仅活跃 Agent | 监控 LLM API 调用量 |
| 能力追踪影响会话性能 | 低 | 异步非阻塞，失败降级 | 性能测试，验证耗时 < 100ms |
| 数据库性能瓶颈 | 低 | 索引优化，查询次数限制 | 压力测试，监控查询耗时 p95 |

---

## 十、后续迭代（P2-P3）

**P2（第 11-14 周）**：
- 记忆进化（Learning-to-Rank）
- 技能进化（Thompson Sampling）
- 工具进化（UCB1）
- 多层协同（Shapley Value 贡献归因）

**P3（第 15-18 周）**：
- 人格主动进化（不仅追踪，还主动调整）
- 协同探索调度（Coordinated Exploration Scheduling）
- Pareto 前沿多目标优化

P1 专注于能力边界检测和自我反思，为 P2 多层进化提供能力评估基础和目标生成质量保障。


