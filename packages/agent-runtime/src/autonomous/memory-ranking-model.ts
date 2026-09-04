/**
 * P2: 记忆排序模型（Learning-to-Rank）
 *
 * 使用 Point-wise Learning-to-Rank 方法预测记忆有用性
 * 算法：线性回归 + 梯度下降在线学习
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 */

import type { MemoryRankingFeatures, MemoryRankingWeights } from './types';
import { MEMORY_LEARNING_RATE } from './config';

/**
 * 记忆排序模型
 * 使用线性回归预测记忆有用性得分
 */
export class MemoryRankingModel {
  private weights: MemoryRankingWeights;
  private learningRate: number;
  private version: number;

  constructor(learningRate: number = MEMORY_LEARNING_RATE) {
    // 验证学习率
    if (learningRate <= 0 || learningRate > 1) {
      throw new Error(`Learning rate must be in (0, 1], got ${learningRate}`);
    }

    this.learningRate = learningRate;
    this.version = 1;

    // 初始权重（均匀分配，基于领域知识）
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
   * 归一化特征
   * 避免大数值特征主导模型
   */
  private normalizeFeatures(features: MemoryRankingFeatures): MemoryRankingFeatures {
    return {
      // 已归一化特征 (0-1)
      semanticSimilarity: this.clamp(features.semanticSimilarity, 0, 1),
      topicRelevance: this.clamp(features.topicRelevance, 0, 1),
      userFeedbackScore: this.clamp(features.userFeedbackScore, 0, 1),
      avgUtilityScore: this.clamp(features.avgUtilityScore, 0, 1),
      retrievalSuccessRate: this.clamp(features.retrievalSuccessRate, 0, 1),
      taskTypeMatch: features.taskTypeMatch,

      // 需要归一化的特征
      keywordMatch: Math.min(features.keywordMatch / 10, 1), // 假设最多 10 个关键词
      queryLength: Math.min(features.queryLength / 100, 1), // 假设最长 100 字符
      memoryAge: Math.min(features.memoryAge / 365, 1), // 归一化到 1 年
      accessCount: Math.min(Math.log(features.accessCount + 1) / Math.log(101), 1), // log 归一化
      lastAccessRecency: Math.min(features.lastAccessRecency / (24 * 30), 1), // 归一化到 30 天
      memoryLength: Math.min(features.memoryLength / 2000, 1), // 假设最长 2000 tokens
    };
  }

  /**
   * 限制值在范围内
   */
  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  /**
   * 预测记忆有用性得分
   */
  predict(features: MemoryRankingFeatures): number {
    const normalized = this.normalizeFeatures(features);

    // 线性组合
    const score =
      this.weights.semanticSimilarity * normalized.semanticSimilarity +
      this.weights.keywordMatch * normalized.keywordMatch +
      this.weights.memoryAge * Math.log(normalized.memoryAge + 0.01) + // log 变换
      this.weights.accessCount * Math.log(normalized.accessCount + 0.01) +
      this.weights.lastAccessRecency * Math.log(normalized.lastAccessRecency + 0.01) +
      this.weights.topicRelevance * normalized.topicRelevance +
      this.weights.userFeedbackScore * normalized.userFeedbackScore +
      this.weights.avgUtilityScore * normalized.avgUtilityScore +
      this.weights.retrievalSuccessRate * normalized.retrievalSuccessRate +
      (normalized.taskTypeMatch ? 0.1 : 0); // 布尔特征奖励

    // Sigmoid 归一化到 [0, 1]
    return 1 / (1 + Math.exp(-score));
  }

  /**
   * 在线学习（梯度下降）
   */
  learn(features: MemoryRankingFeatures, actualUtility: number): void {
    // 验证实际效用值
    if (actualUtility < 0 || actualUtility > 1) {
      throw new Error(`Actual utility must be in [0, 1], got ${actualUtility}`);
    }

    const prediction = this.predict(features);
    const error = actualUtility - prediction;
    const normalized = this.normalizeFeatures(features);

    // 梯度下降更新权重
    // derivative of sigmoid: sigmoid * (1 - sigmoid)
    const gradient = prediction * (1 - prediction) * error;

    this.weights.semanticSimilarity += this.learningRate * gradient * normalized.semanticSimilarity;
    this.weights.keywordMatch += this.learningRate * gradient * normalized.keywordMatch;
    this.weights.memoryAge += this.learningRate * gradient * Math.log(normalized.memoryAge + 0.01);
    this.weights.accessCount += this.learningRate * gradient * Math.log(normalized.accessCount + 0.01);
    this.weights.lastAccessRecency += this.learningRate * gradient * Math.log(normalized.lastAccessRecency + 0.01);
    this.weights.topicRelevance += this.learningRate * gradient * normalized.topicRelevance;
    this.weights.userFeedbackScore += this.learningRate * gradient * normalized.userFeedbackScore;
    this.weights.avgUtilityScore += this.learningRate * gradient * normalized.avgUtilityScore;
    this.weights.retrievalSuccessRate += this.learningRate * gradient * normalized.retrievalSuccessRate;

    // 增加版本号
    this.version += 1;
  }

  /**
   * 批量学习（从历史反馈中学习）
   */
  batchLearn(samples: Array<{ features: MemoryRankingFeatures; actualUtility: number }>, epochs: number = 10): void {
    if (samples.length === 0) {
      return;
    }

    for (let epoch = 0; epoch < epochs; epoch++) {
      for (const sample of samples) {
        this.learn(sample.features, sample.actualUtility);
      }
    }
  }

  /**
   * 获取当前权重（用于可视化和持久化）
   */
  getWeights(): MemoryRankingWeights {
    return { ...this.weights };
  }

  /**
   * 设置权重（用于恢复）
   */
  setWeights(weights: MemoryRankingWeights, version?: number): void {
    this.weights = { ...weights };
    if (version !== undefined) {
      this.version = version;
    }
  }

  /**
   * 获取模型版本
   */
  getVersion(): number {
    return this.version;
  }

  /**
   * 创建权重快照
   */
  createSnapshot(): { weights: MemoryRankingWeights; version: number } {
    return {
      weights: this.getWeights(),
      version: this.version,
    };
  }

  /**
   * 从快照恢复
   */
  restoreSnapshot(snapshot: { weights: MemoryRankingWeights; version: number }): void {
    this.setWeights(snapshot.weights, snapshot.version);
  }
}

/**
 * 计算预测误差（用于模型评估）
 */
export function computeMeanSquaredError(
  model: MemoryRankingModel,
  samples: Array<{ features: MemoryRankingFeatures; actualUtility: number }>
): number {
  if (samples.length === 0) {
    return 0;
  }

  let totalError = 0;
  for (const sample of samples) {
    const prediction = model.predict(sample.features);
    const error = prediction - sample.actualUtility;
    totalError += error * error;
  }

  return totalError / samples.length;
}
