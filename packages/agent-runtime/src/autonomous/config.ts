/**
 * 自主进化 Agent 算法参数配置
 *
 * 所有参数来自设计文档：docs/design/自主进化Agent/2-元认知引擎算法.md
 * 集中定义，禁止在业务代码中硬编码
 */

import { GoalType, type SatisfactionWeights } from './types';

/**
 * 满意度权重配置
 * 来源：设计文档 2-元认知引擎算法.md
 * 四个维度权重总和必须为 1.0
 *
 * V1.0 口径（2026-09-05 后）：
 * - knowledge_growth 因工具分类器未实现而暂时禁用（权重 0），剩余三维归一化
 * - 原权重 task:0.35 / feedback:0.30 / efficiency:0.20 / knowledge:0.15
 * - 归一化后 task:0.41176 / feedback:0.35294 / efficiency:0.23529 / knowledge:0
 */
export const SATISFACTION_WEIGHTS: SatisfactionWeights = {
  task: 0.41176,       // 任务完成度权重（0.35 / 0.85 归一化）
  feedback: 0.35294,   // 用户反馈权重（0.30 / 0.85 归一化）
  efficiency: 0.23529, // 效率权重（0.20 / 0.85 归一化）
  knowledge: 0,        // 知识增长权重（暂时禁用，等工具分类器实现）
};

/**
 * 满意度阈值
 * 来源：设计文档 2-元认知引擎算法.md
 * 低于此值触发内在目标生成
 */
export const SATISFACTION_THRESHOLD = 0.6;

/**
 * ε-greedy 探索率
 * 来源：设计文档 3-内在目标生成器.md
 * 以 15% 概率探索新 Prompt 变体
 */
export const EPSILON = 0.15;

/**
 * 每个基线 Prompt 最大变体数
 * 来源：设计文档 4-Prompt进化引擎.md
 * 限制变体池大小，防止无限增长
 */
export const MAX_VARIANTS_PER_PROMPT = 5;

/**
 * 开始利用前的最小试验次数
 * 来源：设计文档 4-Prompt进化引擎.md
 * 每个变体至少试验 10 次后才开始利用最优变体
 */
export const MIN_TRIALS_BEFORE_EXPLOIT = 10;

/**
 * UCB 置信度参数
 * 来源：设计文档 4-Prompt进化引擎.md
 * 控制探索-利用权衡，值越大越倾向探索
 */
export const UCB_CONFIDENCE = 2.0;

/**
 * EMA 平滑系数
 * 来源：设计文档 5-人格追踪系统.md
 * 控制人格更新速度，值越小越平滑
 */
export const EMA_ALPHA = 0.05;

/**
 * 每日目标上限
 * 来源：设计文档 7-P1实施计划-能力边界与反思.md
 * P1 阶段提升上限到 5
 * P2 阶段提升上限到 7
 */
export const MAX_GOALS_PER_DAY = 7;

/**
 * Elo Rating K 值
 * 来源：设计文档 2-元认知引擎算法.md
 * P1 实现：用于能力边界检测
 */
export const ELO_K_FACTOR = 32;

/**
 * 反思调度时间（Cron 表达式）
 * 来源：设计文档 7-P1实施计划-能力边界与反思.md
 * 每日 23:00 触发反思
 */
export const REFLECTION_SCHEDULE = '0 23 * * *';

/**
 * 能力需求分析时间窗口（天）
 * 来源：设计文档 7-P1实施计划-能力边界与反思.md
 * 分析最近 30 天的任务类型分布
 */
export const CAPABILITY_DEMAND_WINDOW_DAYS = 30;

/**
 * 反思分析时间窗口（天）
 * 来源：设计文档 7-P1实施计划-能力边界与反思.md
 * 分析最近 7 天的满意度历史
 */
export const REFLECTION_WINDOW_DAYS = 7;

/**
 * 反思会话摘要数量
 * 来源：设计文档 7-P1实施计划-能力边界与反思.md
 * 包含最近 10 次会话摘要
 */
export const REFLECTION_SESSION_LIMIT = 10;

/**
 * 自主能力全局开关
 * 环境变量 AUTONOMOUS_ENABLED
 * 默认启用，设置为 'false' 禁用
 */
export const AUTONOMOUS_ENABLED = process.env.AUTONOMOUS_ENABLED !== 'false';

/**
 * 允许的目标类型白名单
 * 环境变量 AUTONOMOUS_GOAL_TYPES
 * 逗号分隔,用于灰度发布控制
 * P1 新增 capability-improvement
 * P2 新增 skill-enhancement, memory-optimization
 */
export const AUTONOMOUS_GOAL_TYPES: GoalType[] = (process.env.AUTONOMOUS_GOAL_TYPES?.split(',') || [
  'learning',
  'proactive-message',
  'capability-improvement',
  'skill-enhancement',
  'memory-optimization',
]) as GoalType[];

/**
 * ==========================================
 * P2: 多层进化协同配置参数
 * ==========================================
 */

/**
 * P2: Learning-to-Rank 学习率
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 * 控制记忆排序模型的权重更新速度
 */
export const MEMORY_LEARNING_RATE = 0.01;

/**
 * P2: 记忆排序最小样本量
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 * 至少收集此数量的样本才开始训练模型
 */
export const MEMORY_MIN_SAMPLES = 50;

/**
 * P2: 低效记忆识别阈值
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 * 平均贡献度低于此值且至少使用 5 次的记忆被标记为低效
 */
export const MEMORY_INEFFECTIVE_THRESHOLD = 0.2;

/**
 * P2: 低效记忆判定最小使用次数
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 * 记忆至少被使用此次数后才参与低效判定，避免小样本误判
 */
export const MEMORY_INEFFECTIVE_MIN_USES = 5;

/**
 * P2: 记忆排序批量重训练周期（天）
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 * 每隔此天数重新训练记忆排序模型
 */
export const MEMORY_RETRAIN_INTERVAL_DAYS = 7;

/**
 * P2: 技能统计最小样本量
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 * 至少使用此次数才判定技能缺口
 */
export const SKILL_MIN_USAGE_COUNT = 5;

/**
 * P2: 技能成功率阈值
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 * 成功率低于此值触发技能改进
 */
export const SKILL_SUCCESS_RATE_THRESHOLD = 0.6;

/**
 * P2: 技能满意度阈值
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 * 满意度低于此值触发技能改进
 */
export const SKILL_SATISFACTION_THRESHOLD = 0.5;

/**
 * P2: 技能执行时间阈值（毫秒）
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 * 平均执行时间超过此值触发技能优化
 */
export const SKILL_EXECUTION_TIME_THRESHOLD = 30000;

/**
 * P2: Thompson Sampling 采样迭代上限
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 * Beta/Gamma 采样最大重试次数，防止无限循环
 */
export const THOMPSON_SAMPLING_MAX_ITERATIONS = 1000;

/**
 * P2: Shapley Value 最大组合数
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 * 完整 Shapley 计算的组合数上限
 */
export const SHAPLEY_MAX_COMBINATIONS = 100;

/**
 * P2: 协同探索预算基准
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 * 满意度 >= 0.7 时的探索概率
 */
export const EXPLORATION_BUDGET_BASE = 0.15;

/**
 * P2: 协同探索预算最大值
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 * 满意度很低时的最大探索概率
 */
export const EXPLORATION_BUDGET_MAX = 0.5;

/**
 * P2: Pareto 前沿配置上限
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 * 限制 Pareto 前沿的配置数量
 */
export const PARETO_FRONTIER_MAX_SIZE = 100;

/**
 * P2: 层级优先级 EMA 平滑系数
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 * 控制层级优先级更新速度
 */
export const LAYER_PRIORITY_EMA_ALPHA = 0.1;

/**
 * 验证配置参数有效性
 */
export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // 验证满意度权重总和为 1.0
  const weightSum = SATISFACTION_WEIGHTS.task + SATISFACTION_WEIGHTS.feedback + SATISFACTION_WEIGHTS.efficiency + SATISFACTION_WEIGHTS.knowledge;
  if (Math.abs(weightSum - 1.0) > 0.0001) {
    errors.push(`SATISFACTION_WEIGHTS 总和必须为 1.0，当前为 ${weightSum}`);
  }

  // 验证阈值在有效范围
  if (SATISFACTION_THRESHOLD < 0 || SATISFACTION_THRESHOLD > 1) {
    errors.push(`SATISFACTION_THRESHOLD 必须在 [0, 1] 范围，当前为 ${SATISFACTION_THRESHOLD}`);
  }

  // 验证 epsilon 在有效范围
  if (EPSILON < 0 || EPSILON > 1) {
    errors.push(`EPSILON 必须在 [0, 1] 范围，当前为 ${EPSILON}`);
  }

  // 验证 EMA alpha 在有效范围
  if (EMA_ALPHA < 0 || EMA_ALPHA > 1) {
    errors.push(`EMA_ALPHA 必须在 [0, 1] 范围，当前为 ${EMA_ALPHA}`);
  }

  // P2: 验证记忆学习率
  if (MEMORY_LEARNING_RATE <= 0 || MEMORY_LEARNING_RATE > 1) {
    errors.push(`MEMORY_LEARNING_RATE 必须在 (0, 1] 范围，当前为 ${MEMORY_LEARNING_RATE}`);
  }

  // P2: 验证阈值范围
  if (MEMORY_INEFFECTIVE_THRESHOLD < 0 || MEMORY_INEFFECTIVE_THRESHOLD > 1) {
    errors.push(`MEMORY_INEFFECTIVE_THRESHOLD 必须在 [0, 1] 范围，当前为 ${MEMORY_INEFFECTIVE_THRESHOLD}`);
  }

  if (SKILL_SUCCESS_RATE_THRESHOLD < 0 || SKILL_SUCCESS_RATE_THRESHOLD > 1) {
    errors.push(`SKILL_SUCCESS_RATE_THRESHOLD 必须在 [0, 1] 范围，当前为 ${SKILL_SUCCESS_RATE_THRESHOLD}`);
  }

  if (SKILL_SATISFACTION_THRESHOLD < 0 || SKILL_SATISFACTION_THRESHOLD > 1) {
    errors.push(`SKILL_SATISFACTION_THRESHOLD 必须在 [0, 1] 范围，当前为 ${SKILL_SATISFACTION_THRESHOLD}`);
  }

  if (EXPLORATION_BUDGET_BASE < 0 || EXPLORATION_BUDGET_BASE > 1) {
    errors.push(`EXPLORATION_BUDGET_BASE 必须在 [0, 1] 范围，当前为 ${EXPLORATION_BUDGET_BASE}`);
  }

  if (EXPLORATION_BUDGET_MAX < 0 || EXPLORATION_BUDGET_MAX > 1) {
    errors.push(`EXPLORATION_BUDGET_MAX 必须在 [0, 1] 范围，当前为 ${EXPLORATION_BUDGET_MAX}`);
  }

  if (LAYER_PRIORITY_EMA_ALPHA < 0 || LAYER_PRIORITY_EMA_ALPHA > 1) {
    errors.push(`LAYER_PRIORITY_EMA_ALPHA 必须在 [0, 1] 范围，当前为 ${LAYER_PRIORITY_EMA_ALPHA}`);
  }

  // P2: 验证正整数参数
  if (MEMORY_MIN_SAMPLES <= 0 || !Number.isInteger(MEMORY_MIN_SAMPLES)) {
    errors.push(`MEMORY_MIN_SAMPLES 必须为正整数，当前为 ${MEMORY_MIN_SAMPLES}`);
  }

  if (SKILL_MIN_USAGE_COUNT <= 0 || !Number.isInteger(SKILL_MIN_USAGE_COUNT)) {
    errors.push(`SKILL_MIN_USAGE_COUNT 必须为正整数，当前为 ${SKILL_MIN_USAGE_COUNT}`);
  }

  if (THOMPSON_SAMPLING_MAX_ITERATIONS <= 0 || !Number.isInteger(THOMPSON_SAMPLING_MAX_ITERATIONS)) {
    errors.push(`THOMPSON_SAMPLING_MAX_ITERATIONS 必须为正整数，当前为 ${THOMPSON_SAMPLING_MAX_ITERATIONS}`);
  }

  if (PARETO_FRONTIER_MAX_SIZE <= 0 || !Number.isInteger(PARETO_FRONTIER_MAX_SIZE)) {
    errors.push(`PARETO_FRONTIER_MAX_SIZE 必须为正整数，当前为 ${PARETO_FRONTIER_MAX_SIZE}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
