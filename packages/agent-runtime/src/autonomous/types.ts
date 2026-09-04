/**
 * 自主进化 Agent 类型定义
 *
 * MVP P0 范围：满意度评分、目标生成（learning + proactive-message）、
 * Prompt 进化、人格追踪
 */

/**
 * 满意度评分结构
 * 包含四个维度的评分和加权总分
 */
export interface SatisfactionScore {
  /** 任务完成度 (0-1) */
  taskCompletion: number;
  /** 用户反馈质量 (0-1) */
  userFeedback: number;
  /** 效率 (0-1) */
  efficiency: number;
  /** 知识增长 (0-1) */
  knowledgeGrowth: number;
  /** 加权总分 (0-1) */
  overall: number;
  /** 评分时间戳 */
  timestamp: string;
  /** 会话 ID */
  sessionId: string;
  /** Agent ID */
  agentId: string;
}

/**
 * 满意度权重配置
 */
export interface SatisfactionWeights {
  task: number;
  feedback: number;
  efficiency: number;
  knowledge: number;
}

/**
 * 目标类型（P1 新增 capability-improvement, P2 新增 skill-enhancement, memory-optimization）
 */
export enum GoalType {
  LEARNING = 'learning',
  PROACTIVE_MESSAGE = 'proactive-message',
  CAPABILITY_IMPROVEMENT = 'capability-improvement',
  SKILL_ENHANCEMENT = 'skill-enhancement',
  MEMORY_OPTIMIZATION = 'memory-optimization',
}

/**
 * 目标状态
 */
export enum GoalStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  EXECUTING = 'executing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/**
 * 自主目标
 */
export interface AutonomousGoal {
  /** 目标 ID (UUID) */
  id: string;
  /** Agent ID */
  agentId: string;
  /** 目标类型 */
  type: GoalType;
  /** 目标描述 */
  description: string;
  /** 触发原因 */
  triggerReason: 'low-satisfaction' | 'user-request' | 'scheduled';
  /** 目标状态 */
  status: GoalStatus;
  /** 优先级 (0-1) */
  priority: number;
  /** 触发时的满意度 */
  satisfactionBefore?: number;
  /** 执行后的满意度 */
  satisfactionAfter?: number;
  /** 目标特定元数据 */
  metadata?: Record<string, any>;
  /** 创建时间 */
  createdAt: string;
  /** 批准时间 */
  approvedAt?: string;
  /** 执行时间 */
  executedAt?: string;
  /** 完成时间 */
  completedAt?: string;
}

/**
 * Prompt 变体
 */
export interface PromptVariant {
  /** 变体 ID (UUID) */
  id: string;
  /** 基线 Prompt ID */
  baselinePromptId: string;
  /** 变体文本 */
  variantText: string;
  /** 是否为基线版本 */
  isBaseline: boolean;
  /** 试验次数 */
  trialCount: number;
  /** 成功次数 */
  successCount: number;
  /** 累积奖励 */
  totalReward: number;
  /** UCB 分数 */
  ucbScore: number;
  /** 平均满意度 */
  avgSatisfaction: number;
  /** 创建时间 */
  createdAt: string;
}

/**
 * Big Five 人格状态
 */
export interface PersonalityState {
  /** 开放性 (0-1) */
  openness: number;
  /** 尽责性 (0-1) */
  conscientiousness: number;
  /** 外向性 (0-1) */
  extraversion: number;
  /** 宜人性 (0-1) */
  agreeableness: number;
  /** 神经质 (0-1) */
  neuroticism: number;
  /** 最后更新时间 */
  lastUpdated: string;
  /** 更新次数 */
  updateCount: number;
}

/**
 * 人格事件
 */
export interface PersonalityEvent {
  /** 事件 ID */
  id: string;
  /** Agent ID */
  agentId: string;
  /** 事件类型 */
  eventType: 'goal-generated' | 'evolution-decided' | 'user-feedback-positive' | 'user-feedback-negative' | 'error-handled';
  /** 人格向量变化 */
  personalityDelta: Partial<PersonalityState>;
  /** 触发上下文 */
  triggerContext?: Record<string, any>;
  /** 事件时间 */
  createdAt: string;
}

/**
 * 进化层级（P0 仅实现 PROMPT）
 */
export enum EvolutionLayer {
  PROMPT = 'prompt',
  MEMORY = 'memory',
  SKILL = 'skill',
  TOOL = 'tool',
}

/**
 * 探索模式
 */
export enum ExplorationMode {
  EXPLOIT = 'exploit',
  EXPLORE_PROMPT = 'explore_prompt',
  EXPLORE_MEMORY = 'explore_memory',
  EXPLORE_SKILL = 'explore_skill',
  EXPLORE_TOOL = 'explore_tool',
}

/**
 * 元认知配置
 */
export interface MetaCognitionConfig {
  /** 满意度权重 */
  satisfactionWeights: SatisfactionWeights;
  /** 满意度阈值 */
  satisfactionThreshold: number;
  /** 反思触发策略 */
  reflectionTrigger: 'manual' | 'scheduled' | 'auto';
  /** 能力追踪模式 */
  capabilityTracking: 'manual' | 'auto';
}

/**
 * 目标生成配置
 */
export interface GoalGenerationConfig {
  /** 允许的目标类型 */
  enabledTypes: GoalType[];
  /** 用户审批模式 */
  userApproval: 'always' | 'optional' | 'never';
  /** 每日目标上限 */
  maxGoalsPerDay: number;
  /** 优先级权重 */
  priorityWeights: {
    satisfactionGap: number;
    dimensionGap: number;
  };
}

/**
 * Prompt 进化配置
 */
export interface PromptEvolutionConfig {
  /** ε-greedy 探索率 */
  epsilon: number;
  /** 每个基线 Prompt 最大变体数 */
  maxVariantsPerPrompt: number;
  /** 开始利用前的最小试验次数 */
  minTrialsBeforeExploit: number;
  /** UCB 置信度参数 */
  ucbConfidence: number;
}

/**
 * 人格配置
 */
export interface PersonalityConfig {
  /** EMA 平滑系数 */
  emaAlpha: number;
  /** 事件权重 */
  eventWeights: Record<string, number>;
  /** 是否启用追踪 */
  trackingEnabled: boolean;
  /** 是否启用进化（P0 为 false）*/
  evolutionEnabled: boolean;
}

/**
 * MVP P0 范围定义
 */
export interface MVPScope {
  metaCognition: {
    satisfactionScoring: true;
    capabilityTracking: 'manual';
    reflectionTrigger: 'scheduled';
  };
  goalGeneration: {
    types: ['learning', 'proactive-message'];
    userApproval: 'always';
    maxGoalsPerDay: 3;
  };
  evolution: {
    prompt: true;
    memory: false;
    skill: false;
    tool: false;
  };
  personality: {
    tracking: true;
    evolution: false;
    display: true;
  };
}

/**
 * 协调事件
 */
export interface CoordinationEvent {
  id: string;
  eventType: string;
  agentId: string;
  goalId?: string;
  sessionId?: string;
  metadata?: Record<string, any>;
  createdAt: string;
}

/**
 * 协调指标
 */
export interface CoordinationMetrics {
  totalEvaluations: number;
  goalsGenerated: Record<string, number>;
  approvalRate: number;
  evolutionSuccessRate: number;
  avgSatisfactionImprovement: number;
}

/**
 * P1: 能力维度定义
 * 基于实际 Agent 使用场景的能力分类
 */
export enum CapabilityDimension {
  CODE_GENERATION = 'code_generation',
  DOCUMENT_ANALYSIS = 'document_analysis',
  WEB_SEARCH = 'web_search',
  DATA_PROCESSING = 'data_processing',
  API_INTEGRATION = 'api_integration',
  CREATIVE_WRITING = 'creative_writing',
  LOGICAL_REASONING = 'logical_reasoning',
  MULTI_STEP_PLANNING = 'multi_step_planning',
}

/**
 * P1: 能力状态
 */
export interface CapabilityState {
  /** 能力维度 */
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
 * P1: 能力测试记录
 */
export interface CapabilityTest {
  /** 测试 ID */
  id: string;
  /** Agent ID */
  agentId: string;
  /** 能力维度 */
  dimension: CapabilityDimension;
  /** 任务描述摘要（脱敏） */
  taskSummary: string;
  /** 任务难度估计 (0-1) */
  difficulty: number;
  /** 测试结果 */
  result: 'success' | 'partial' | 'failure';
  /** 会话 ID */
  sessionId: string;
  /** 更新前的能力水平 */
  levelBefore?: number;
  /** 更新后的能力水平 */
  levelAfter?: number;
  /** 测试时间 */
  createdAt: string;
}

/**
 * P1: 能力缺口
 */
export interface CapabilityGap {
  /** 能力维度 */
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

/**
 * P1: 反思输出结构
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

/**
 * MVP P1 范围定义
 */
export interface P1Scope {
  metaCognition: {
    satisfactionScoring: true;
    capabilityTracking: 'auto';  // P1 升级到 auto
    reflectionTrigger: 'scheduled';
  };
  goalGeneration: {
    types: ['learning', 'proactive-message', 'capability-improvement'];
    userApproval: 'always';
    maxGoalsPerDay: 5;  // P1 提升上限
  };
  evolution: {
    prompt: true;
    memory: false;
    skill: false;
    tool: false;
  };
  personality: {
    tracking: true;
    evolution: false;
    display: true;
  };
}

/**
 * ==========================================
 * P2: 多层进化协同类型定义
 * ==========================================
 */

/**
 * P2: 记忆排序特征（用于 Learning-to-Rank）
 * 来源：分析 P0/P1 阶段记忆使用效果
 */
export interface MemoryRankingFeatures {
  // 查询相关性特征
  /** 语义相似度 (0-1) */
  semanticSimilarity: number;
  /** 关键词匹配数量 */
  keywordMatch: number;
  /** 查询长度 */
  queryLength: number;

  // 记忆质量特征
  /** 记忆年龄（天） */
  memoryAge: number;
  /** 历史访问次数 */
  accessCount: number;
  /** 最近访问距今时间（小时） */
  lastAccessRecency: number;
  /** 记忆长度（token） */
  memoryLength: number;

  // 上下文特征
  /** 主题相关性 (0-1) */
  topicRelevance: number;
  /** 用户反馈得分 (0-1) */
  userFeedbackScore: number;
  /** 任务类型是否匹配 */
  taskTypeMatch: boolean;

  // 历史效果特征
  /** 历史平均有用性 (0-1) */
  avgUtilityScore: number;
  /** 被检索后任务成功率 */
  retrievalSuccessRate: number;
}

/**
 * P2: 记忆使用反馈
 */
export interface MemoryUsageFeedback {
  /** 记忆 ID */
  memoryId: string;
  /** 会话 ID */
  sessionId: string;
  /** 查询文本 */
  query: string;

  // 隐式反馈
  /** 是否被用于生成回复 */
  wasUsedInResponse: boolean;
  /** 对回复的贡献度 (0-1) */
  contributionScore: number;

  // 显式反馈（用户评价）
  /** 用户满意度 (0-1) */
  userSatisfaction?: number;

  // 特征快照
  /** 特征快照 */
  features: MemoryRankingFeatures;

  /** 时间戳 */
  timestamp: string;
}

/**
 * P2: 记忆排序权重
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

/**
 * P2: 工具选择统计（Beta 分布参数）
 */
export interface ToolSelectionStats {
  /** 工具名称 */
  toolName: string;
  /** 成功次数 + 1 */
  alpha: number;
  /** 失败次数 + 1 */
  beta: number;
  /** 总使用次数 */
  totalUsage: number;
  /** 最后使用时间 */
  lastUsed: string;
}

/**
 * P2: 工具使用反馈
 */
export interface ToolUsageFeedback {
  /** 工具名称 */
  toolName: string;
  /** 会话 ID */
  sessionId: string;
  /** 上下文 */
  context: {
    /** 任务类型 */
    taskType: string;
    /** 难度 (0-1) */
    difficulty: number;
  };
  /** 执行结果 */
  result: 'success' | 'failure';
  /** 执行时间（毫秒） */
  executionTime: number;
  /** 时间戳 */
  timestamp: string;
}

/**
 * P2: 技能使用记录
 */
export interface SkillUsageRecord {
  /** 技能名称 */
  skillName: string;
  /** 会话 ID */
  sessionId: string;
  /** 上下文 */
  context: {
    /** 任务类型 */
    taskType: string;
    /** 复杂度 */
    complexity: 'low' | 'medium' | 'high';
  };
  /** 执行结果 */
  outcome: {
    /** 是否成功 */
    success: boolean;
    /** 执行时间（毫秒） */
    executionTime: number;
    /** 用户满意度 (0-1) */
    userSatisfaction: number;
  };
  /** 时间戳 */
  timestamp: string;
}

/**
 * P2: 技能统计
 */
export interface SkillStats {
  /** 技能名称 */
  skillName: string;
  /** 使用次数 */
  usageCount: number;
  /** 成功率 (0-1) */
  successRate: number;
  /** 平均满意度 (0-1) */
  avgSatisfaction: number;
  /** 平均执行时间（毫秒） */
  avgExecutionTime: number;
  /** 最后使用时间 */
  lastUsed: string;
}

/**
 * P2: 层级配置
 */
export interface LayerConfigs {
  /** Prompt 配置 ID */
  promptVariantId: string;
  /** Memory 排序权重版本 */
  memoryWeightsVersion: string;
  /** Skill 选择策略 */
  skillStrategy: string;
  /** Tool 选择策略参数 */
  toolStrategy: string;
}

/**
 * P2: 层级贡献度
 */
export interface LayerContribution {
  /** Prompt 层贡献 (0-1) */
  prompt: number;
  /** Memory 层贡献 (0-1) */
  memory: number;
  /** Skill 层贡献 (0-1) */
  skill: number;
  /** Tool 层贡献 (0-1) */
  tool: number;
}

/**
 * P2: 优化目标
 */
export interface OptimizationObjectives {
  /** 用户满意度 (0-1) */
  userSatisfaction: number;
  /** 响应时间（毫秒） */
  responseTime: number;
  /** Token 成本 */
  tokenCost: number;
  /** 一致性得分 (0-1) */
  consistencyScore: number;
}

/**
 * P2: 调度器状态
 */
export interface SchedulerState {
  /** 全局平均满意度 (0-1) */
  globalSatisfaction: number;
  /** 探索预算 (0-1) */
  explorationBudget: number;
  /** 最近探索历史 */
  recentExplorations: Array<{
    /** 探索的层 */
    layer: EvolutionLayer;
    /** 探索时间 */
    timestamp: string;
    /** 探索后满意度 */
    satisfactionAfter: number;
  }>;
  /** 各层优先级 */
  layerPriorities: Record<EvolutionLayer, number>;
}

/**
 * P2: 冲突类型
 */
export type ConflictSeverity = 'critical' | 'warning';

/**
 * P2: 冲突定义
 */
export interface Conflict {
  /** 冲突 ID */
  id: string;
  /** 冲突严重性 */
  severity: ConflictSeverity;
  /** 冲突描述 */
  description: string;
  /** 涉及的层 */
  involvedLayers: EvolutionLayer[];
  /** 建议的修复 */
  suggestedFix?: Partial<LayerConfigs>;
}

/**
 * P2: Pareto 前沿配置项
 */
export interface ParetoConfig {
  /** 配置 ID */
  id: string;
  /** 配置哈希 */
  configHash: string;
  /** 层级配置 */
  config: LayerConfigs;
  /** 优化目标指标 */
  objectives: OptimizationObjectives;
  /** 使用次数 */
  usageCount: number;
  /** 添加时间 */
  addedAt: string;
}

/**
 * P2: Pareto 偏好
 */
export type ParetoPreference = 'satisfaction' | 'speed' | 'cost' | 'balanced';

/**
 * MVP P2 范围定义
 */
export interface P2Scope {
  metaCognition: {
    satisfactionScoring: true;
    capabilityTracking: 'auto';
    reflectionTrigger: 'scheduled';
    multiLayerAttribution: true;  // P2 新增：多层贡献归因
  };

  goalGeneration: {
    types: [
      'learning',
      'proactive-message',
      'capability-improvement',
      'skill-enhancement',       // P2 新增
      'memory-optimization'      // P2 新增
    ];
    userApproval: 'always';
    maxGoalsPerDay: 7;           // P2 提升上限（从 5 到 7）
  };

  evolution: {
    prompt: true;                // P0（ε-greedy）
    memory: true;                // P2 新增（Learning-to-Rank）
    skill: true;                 // P2 新增（效果跟踪）
    tool: true;                  // P2 新增（Thompson Sampling）
    coordinated: true;           // P2 新增（协同调度）
  };

  personality: {
    tracking: true;              // P0
    evolution: true;             // P2 启用（基于 P0/P1 积累的事件数据）
    display: true;
  };
}
