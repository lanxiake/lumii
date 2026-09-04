/**
 * 自主进化 Agent 能力模块导出
 *
 * MVP P0 范围：满意度评分、目标生成、Prompt 进化、人格追踪
 */

// 核心模块
export { MetaCognitionEngine, type DatabaseClient, MetaCognitionError } from './meta-cognition-engine';
export { IntrinsicGoalGenerator, type GoalGenerationContext } from './intrinsic-goal-generator';
export { PromptEvolutionEngine } from './prompt-evolution';
export { PersonalityTracker, recordPersonalityEvent, EVENT_PERSONALITY_IMPACT } from './personality-tracker';
export { AutonomousCoordinator } from './autonomous-coordinator';

// 指标收集
export type { SessionMetrics, AgentSession } from './metrics-collector';
export { extractTaskCompletion, extractUserFeedback, extractEfficiency, extractKnowledgeGrowth, collectMetricsFromSession } from './metrics-collector';

// 纯函数导出
export { computeSatisfactionScore, shouldTriggerGoalGeneration, categorizeSatisfactionLevel } from './meta-cognition-engine';
export { generateLearningGoal, generateProactiveMessageGoal } from './intrinsic-goal-generator';
export { shouldExplore, computeUCB, selectVariant, updateVariantReward } from './prompt-evolution';
export { applyEMA } from './personality-tracker';

// 类型导出
export type {
  SatisfactionScore,
  SatisfactionWeights,
  AutonomousGoal,
  PromptVariant,
  PersonalityState,
  PersonalityEvent,
  MetaCognitionConfig,
  GoalGenerationConfig,
  PromptEvolutionConfig,
  PersonalityConfig,
  MVPScope,
  CoordinationEvent,
  CoordinationMetrics,
  // P1 types
  CapabilityState,
  CapabilityTest,
  CapabilityGap,
  ReflectionOutput,
  P1Scope,
  // P2 types
  MemoryRankingFeatures,
  MemoryUsageFeedback,
  MemoryRankingWeights,
  ToolSelectionStats,
  ToolUsageFeedback,
  SkillUsageRecord,
  SkillStats,
  LayerConfigs,
  LayerContribution,
  OptimizationObjectives,
  SchedulerState,
  Conflict,
  ConflictSeverity,
  ParetoConfig,
  ParetoPreference,
  P2Scope,
} from './types';

// 枚举导出
export { GoalType, GoalStatus, EvolutionLayer, ExplorationMode } from './types';

// 配置导出
export {
  SATISFACTION_WEIGHTS,
  SATISFACTION_THRESHOLD,
  EPSILON,
  MAX_VARIANTS_PER_PROMPT,
  MIN_TRIALS_BEFORE_EXPLOIT,
  UCB_CONFIDENCE,
  EMA_ALPHA,
  MAX_GOALS_PER_DAY,
  ELO_K_FACTOR,
  AUTONOMOUS_ENABLED,
  AUTONOMOUS_GOAL_TYPES,
  // P2 config
  MEMORY_LEARNING_RATE,
  MEMORY_MIN_SAMPLES,
  MEMORY_INEFFECTIVE_THRESHOLD,
  MEMORY_RETRAIN_INTERVAL_DAYS,
  SKILL_MIN_USAGE_COUNT,
  SKILL_SUCCESS_RATE_THRESHOLD,
  SKILL_SATISFACTION_THRESHOLD,
  SKILL_EXECUTION_TIME_THRESHOLD,
  THOMPSON_SAMPLING_MAX_ITERATIONS,
  SHAPLEY_MAX_COMBINATIONS,
  EXPLORATION_BUDGET_BASE,
  EXPLORATION_BUDGET_MAX,
  PARETO_FRONTIER_MAX_SIZE,
  LAYER_PRIORITY_EMA_ALPHA,
  validateConfig,
} from './config';
