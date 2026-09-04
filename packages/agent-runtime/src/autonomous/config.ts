/**
 * 自主进化 Agent 算法参数配置
 *
 * 所有参数来自设计文档：docs/design/自主进化Agent/2-元认知引擎算法.md
 * 集中定义，禁止在业务代码中硬编码
 */

import type { SatisfactionWeights } from './types';

/**
 * 满意度权重配置
 * 来源：设计文档 2-元认知引擎算法.md
 * 四个维度权重总和必须为 1.0
 */
export const SATISFACTION_WEIGHTS: SatisfactionWeights = {
  task: 0.35,       // 任务完成度权重
  feedback: 0.30,   // 用户反馈权重
  efficiency: 0.20, // 效率权重
  knowledge: 0.15,  // 知识增长权重
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
 * 来源：设计文档 6-实施计划.md
 * P0 阶段限制每日生成目标数量
 */
export const MAX_GOALS_PER_DAY = 3;

/**
 * Elo Rating K 值
 * 来源：设计文档 2-元认知引擎算法.md
 * 用于能力边界检测（P0 不实现，预留）
 */
export const ELO_K_FACTOR = 32;

/**
 * 自主能力全局开关
 * 环境变量 AUTONOMOUS_ENABLED
 * 默认启用，设置为 'false' 禁用
 */
export const AUTONOMOUS_ENABLED = process.env.AUTONOMOUS_ENABLED !== 'false';

/**
 * 允许的目标类型白名单
 * 环境变量 AUTONOMOUS_GOAL_TYPES
 * 逗号分隔，用于灰度发布控制
 */
export const AUTONOMOUS_GOAL_TYPES = process.env.AUTONOMOUS_GOAL_TYPES?.split(',') || ['learning', 'proactive-message'];

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

  return {
    valid: errors.length === 0,
    errors,
  };
}
