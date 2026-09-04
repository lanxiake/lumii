/**
 * Elo Rating System for Capability Tracking
 *
 * 参考设计文档：docs/design/自主进化Agent/2-元认知引擎算法.md
 * 公式：newLevel = level + K × (actual - expected)
 *
 * K = 32（学习率，与设计文档一致）
 */

import { ELO_K_FACTOR } from './config';

/**
 * 能力评级系统
 * 使用 Elo Rating 算法动态追踪能力水平
 */
export class CapabilityRatingSystem {
  private readonly K: number;

  constructor(K: number = ELO_K_FACTOR) {
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
    const actual = result === 'success' ? 1.0 : result === 'partial' ? 0.5 : 0.0;

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
  expectedPerformance(level: number, difficulty: number): number {
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
