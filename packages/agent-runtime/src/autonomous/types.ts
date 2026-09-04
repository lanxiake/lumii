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
 * 目标类型（P0 仅两类）
 */
export enum GoalType {
  LEARNING = 'learning',
  PROACTIVE_MESSAGE = 'proactive-message',
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
