/**
 * Prompt 进化引擎
 *
 * 使用 ε-greedy 策略和多臂老虎机算法（UCB）选择最优 Prompt 变体
 * 来源：设计文档 4-Prompt进化引擎.md
 */

import type { PromptVariant, PromptEvolutionConfig } from './types';
import type { DatabaseClient } from './meta-cognition-engine';

/**
 * 判断是否探索（纯函数）
 *
 * @param epsilon 探索率
 * @param randomFn 随机数生成器（默认 Math.random）
 * @returns 是否探索
 */
export function shouldExplore(epsilon: number, randomFn: () => number = Math.random): boolean {
  return randomFn() < epsilon;
}

/**
 * 计算 UCB 分数（纯函数）
 *
 * 公式：avgSatisfaction + confidence * sqrt(ln(totalTrials) / variant.trialCount)
 *
 * @param variant Prompt 变体
 * @param totalTrials 总试验次数
 * @param confidence 置信度参数
 * @returns UCB 分数
 */
export function computeUCB(variant: PromptVariant, totalTrials: number, confidence: number): number {
  // 未试验的变体返回无穷大，确保优先选择
  if (variant.trialCount === 0) {
    return Infinity;
  }

  const exploitation = variant.avgSatisfaction;
  const exploration = confidence * Math.sqrt(Math.log(Math.max(totalTrials, 1)) / variant.trialCount);

  return exploitation + exploration;
}

/**
 * 选择 Prompt 变体（纯函数）
 *
 * @param variants 变体列表
 * @param epsilon 探索率
 * @param ucbConfidence UCB 置信度
 * @param minTrials 最小试验次数
 * @param randomFn 随机数生成器
 * @returns 选中的变体
 */
export function selectVariant(
  variants: PromptVariant[],
  epsilon: number,
  ucbConfidence: number,
  minTrials: number,
  randomFn: () => number = Math.random,
): PromptVariant {
  if (variants.length === 0) {
    throw new Error('变体列表为空');
  }

  // 检查是否所有变体都达到最小试验次数
  const allTrialed = variants.every((v) => v.trialCount >= minTrials);

  // 强制探索：如果有变体未达到最小试验次数
  if (!allTrialed || shouldExplore(epsilon, randomFn)) {
    // 探索模式：随机选择
    const index = Math.floor(randomFn() * variants.length);
    return variants[index];
  }

  // 利用模式：选择最高 UCB 分数的变体
  const totalTrials = variants.reduce((sum, v) => sum + v.trialCount, 0);
  let bestVariant = variants[0];
  let bestUCB = computeUCB(bestVariant, totalTrials, ucbConfidence);

  for (let i = 1; i < variants.length; i++) {
    const ucb = computeUCB(variants[i], totalTrials, ucbConfidence);
    if (ucb > bestUCB) {
      bestUCB = ucb;
      bestVariant = variants[i];
    }
  }

  return bestVariant;
}

/**
 * 更新变体奖励（纯函数，不可变更新）
 *
 * @param variant 当前变体
 * @param satisfaction 本次满意度
 * @returns 更新后的变体
 */
export function updateVariantReward(variant: PromptVariant, satisfaction: number): PromptVariant {
  const newTrialCount = variant.trialCount + 1;
  const newSuccessCount = satisfaction > 0.6 ? variant.successCount + 1 : variant.successCount;
  const newTotalReward = variant.totalReward + satisfaction;
  const newAvgSatisfaction = newTotalReward / newTrialCount;

  return {
    ...variant,
    trialCount: newTrialCount,
    successCount: newSuccessCount,
    totalReward: newTotalReward,
    avgSatisfaction: newAvgSatisfaction,
  };
}

/**
 * Prompt 进化引擎
 */
export class PromptEvolutionEngine {
  constructor(
    private readonly config: PromptEvolutionConfig,
    private readonly db: DatabaseClient,
  ) {}

  /**
   * 选择 Prompt 变体
   *
   * @param baselinePromptId 基线 Prompt ID
   * @returns 选中的变体
   */
  async selectPrompt(baselinePromptId: string): Promise<PromptVariant> {
    try {
      // 查询所有变体
      const variants = await this.getVariants(baselinePromptId);

      // 若无变体，返回基线版本
      if (variants.length === 0) {
        return this.getOrCreateBaseline(baselinePromptId);
      }

      // 使用 ε-greedy + UCB 选择变体
      const selected = selectVariant(variants, this.config.epsilon, this.config.ucbConfidence, this.config.minTrialsBeforeExploit);

      // 记录选择事件
      await this.recordSelectionEvent(selected.id, shouldExplore(this.config.epsilon) ? 'explore' : 'exploit');

      return selected;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[PromptEvolutionEngine] 选择 Prompt 失败:', err.message);
      throw err;
    }
  }

  /**
   * 记录反馈
   *
   * @param variantId 变体 ID
   * @param satisfaction 满意度
   */
  async recordFeedback(variantId: string, satisfaction: number): Promise<void> {
    try {
      // 查询当前变体状态
      const sql = `SELECT * FROM prompt_variants WHERE id = ?`;
      const rows = await this.db.query<any>(sql, [variantId]);

      if (rows.length === 0) {
        console.warn(`[PromptEvolutionEngine] 变体 ${variantId} 不存在`);
        return;
      }

      const variant = this.mapRowToVariant(rows[0]);

      // 计算更新后的状态
      const updated = updateVariantReward(variant, satisfaction);

      // 更新数据库
      const updateSql = `
        UPDATE prompt_variants
        SET trial_count = ?, success_count = ?, total_reward = ?, avg_satisfaction = ?
        WHERE id = ?
      `;
      await this.db.execute(updateSql, [updated.trialCount, updated.successCount, updated.totalReward, updated.avgSatisfaction, variantId]);

      // 记录反馈事件
      await this.recordFeedbackEvent(variantId, satisfaction);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[PromptEvolutionEngine] 记录反馈失败:', err.message);
    }
  }

  /**
   * 创建新变体
   *
   * @param baselinePromptId 基线 Prompt ID
   * @param variantText 变体文本
   * @returns 新变体
   */
  async createVariant(baselinePromptId: string, variantText: string): Promise<PromptVariant> {
    // 检查变体数量限制
    const existingVariants = await this.getVariants(baselinePromptId);
    if (existingVariants.length >= this.config.maxVariantsPerPrompt) {
      throw new Error(`已达到最大变体数量 ${this.config.maxVariantsPerPrompt}`);
    }

    const variant: PromptVariant = {
      id: this.generateId(),
      baselinePromptId,
      variantText,
      isBaseline: false,
      trialCount: 0,
      successCount: 0,
      totalReward: 0,
      ucbScore: Infinity, // 初始 UCB 为无穷大
      avgSatisfaction: 0,
      createdAt: new Date().toISOString(),
    };

    // 持久化
    const sql = `
      INSERT INTO prompt_variants (
        id, baseline_prompt_id, variant_text, is_baseline,
        trial_count, success_count, total_reward, ucb_score, avg_satisfaction, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    await this.db.execute(sql, [variant.id, variant.baselinePromptId, variant.variantText, variant.isBaseline ? 1 : 0, variant.trialCount, variant.successCount, variant.totalReward, variant.ucbScore, variant.avgSatisfaction, variant.createdAt]);

    return variant;
  }

  /**
   * 获取变体性能统计
   */
  async getVariantPerformance(baselinePromptId: string): Promise<PromptVariant[]> {
    return this.getVariants(baselinePromptId);
  }

  /**
   * 获取所有变体
   */
  private async getVariants(baselinePromptId: string): Promise<PromptVariant[]> {
    const sql = `
      SELECT * FROM prompt_variants
      WHERE baseline_prompt_id = ?
      ORDER BY avg_satisfaction DESC
    `;
    const rows = await this.db.query<any>(sql, [baselinePromptId]);
    return rows.map(this.mapRowToVariant);
  }

  /**
   * 获取或创建基线版本
   */
  private async getOrCreateBaseline(baselinePromptId: string): Promise<PromptVariant> {
    const sql = `SELECT * FROM prompt_variants WHERE baseline_prompt_id = ? AND is_baseline = 1`;
    const rows = await this.db.query<any>(sql, [baselinePromptId]);

    if (rows.length > 0) {
      return this.mapRowToVariant(rows[0]);
    }

    // 创建基线版本
    const baseline: PromptVariant = {
      id: this.generateId(),
      baselinePromptId,
      variantText: '', // 基线文本由调用方管理
      isBaseline: true,
      trialCount: 0,
      successCount: 0,
      totalReward: 0,
      ucbScore: 0,
      avgSatisfaction: 0.5,
      createdAt: new Date().toISOString(),
    };

    const insertSql = `
      INSERT INTO prompt_variants (
        id, baseline_prompt_id, variant_text, is_baseline,
        trial_count, success_count, total_reward, ucb_score, avg_satisfaction, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    await this.db.execute(insertSql, [baseline.id, baseline.baselinePromptId, baseline.variantText, 1, baseline.trialCount, baseline.successCount, baseline.totalReward, baseline.ucbScore, baseline.avgSatisfaction, baseline.createdAt]);

    return baseline;
  }

  /**
   * 记录选择事件
   */
  private async recordSelectionEvent(variantId: string, mode: 'explore' | 'exploit'): Promise<void> {
    const sql = `
      INSERT INTO prompt_evolution_history (variant_id, event_type, exploration_mode, created_at)
      VALUES (?, 'selected', ?, ?)
    `;
    await this.db.execute(sql, [variantId, mode, new Date().toISOString()]);
  }

  /**
   * 记录反馈事件
   */
  private async recordFeedbackEvent(variantId: string, satisfaction: number): Promise<void> {
    const sql = `
      INSERT INTO prompt_evolution_history (variant_id, event_type, satisfaction, created_at)
      VALUES (?, 'feedback-recorded', ?, ?)
    `;
    await this.db.execute(sql, [variantId, satisfaction, new Date().toISOString()]);
  }

  /**
   * 映射数据库行到变体对象
   */
  private mapRowToVariant(row: any): PromptVariant {
    return {
      id: row.id,
      baselinePromptId: row.baseline_prompt_id,
      variantText: row.variant_text,
      isBaseline: Boolean(row.is_baseline),
      trialCount: row.trial_count,
      successCount: row.success_count,
      totalReward: row.total_reward,
      ucbScore: row.ucb_score,
      avgSatisfaction: row.avg_satisfaction,
      createdAt: row.created_at,
    };
  }

  /**
   * 生成 ID
   */
  private generateId(): string {
    return `variant_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
