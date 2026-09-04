/**
 * P2: 记忆策略进化器
 *
 * 负责收集反馈、训练模型、优化检索策略
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 */

import { MemoryRankingModel, computeMeanSquaredError } from './memory-ranking-model';
import type { DatabaseClient } from './meta-cognition-engine';
import type { MemoryUsageFeedback, MemoryRankingFeatures, MemoryRankingWeights } from './types';
import {
  MEMORY_LEARNING_RATE,
  MEMORY_INEFFECTIVE_THRESHOLD,
  MEMORY_INEFFECTIVE_MIN_USES,
  MEMORY_MIN_SAMPLES,
} from './config';

/**
 * 记忆策略进化器
 */
export class MemoryEvolution {
  private rankingModel: MemoryRankingModel;
  private db: DatabaseClient;
  private lastSnapshot: { weights: MemoryRankingWeights; version: number } | null;

  constructor(db: DatabaseClient, learningRate: number = MEMORY_LEARNING_RATE) {
    this.rankingModel = new MemoryRankingModel(learningRate);
    this.db = db;
    this.lastSnapshot = null;
  }

  /**
   * 记录记忆使用反馈
   */
  async recordFeedback(feedback: MemoryUsageFeedback): Promise<void> {
    try {
      // 1. 验证反馈数据
      this.validateFeedback(feedback);

      // 2. 保存快照（用于回滚）
      if (!this.lastSnapshot) {
        this.lastSnapshot = this.rankingModel.createSnapshot();
      }

      // 3. 在线学习
      this.rankingModel.learn(feedback.features, feedback.contributionScore);

      // 4. 持久化反馈（不写入查询原文，仅保存脱敏摘要长度）
      const sql = `INSERT INTO memory_usage_feedback (memory_id, session_id, query_length, was_used_in_response, contribution_score, user_satisfaction, features, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
      await this.db.execute(sql, [
        feedback.memoryId,
        feedback.sessionId,
        feedback.query.length,
        feedback.wasUsedInResponse ? 1 : 0,
        feedback.contributionScore,
        feedback.userSatisfaction ?? null,
        JSON.stringify(feedback.features),
        feedback.timestamp,
      ]);

      // 5. 更新快照
      this.lastSnapshot = this.rankingModel.createSnapshot();

      console.info('[MemoryEvolution] Feedback recorded', {
        event: 'memory-feedback-recorded',
        memoryId: feedback.memoryId,
        contributionScore: feedback.contributionScore,
        wasUsed: feedback.wasUsedInResponse,
        modelVersion: this.rankingModel.getVersion(),
      });
    } catch (error) {
      // 回滚到上一个快照
      if (this.lastSnapshot) {
        this.rankingModel.restoreSnapshot(this.lastSnapshot);
        console.warn('[MemoryEvolution] Failed to record feedback, rolled back', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  /**
   * 验证反馈数据
   */
  private validateFeedback(feedback: MemoryUsageFeedback): void {
    if (feedback.contributionScore < 0 || feedback.contributionScore > 1) {
      throw new Error(`Contribution score must be in [0, 1], got ${feedback.contributionScore}`);
    }
    if (feedback.userSatisfaction !== undefined && (feedback.userSatisfaction < 0 || feedback.userSatisfaction > 1)) {
      throw new Error(`User satisfaction must be in [0, 1], got ${feedback.userSatisfaction}`);
    }
  }

  /**
   * 对记忆列表进行重新排序
   */
  async rankMemories(
    memories: Array<{ id: string; features: MemoryRankingFeatures }>,
    query: string
  ): Promise<Array<{ id: string; score: number }>> {
    if (memories.length === 0) {
      return [];
    }

    try {
      const scored = memories.map((mem) => ({
        id: mem.id,
        score: this.rankingModel.predict(mem.features),
      }));

      // 按得分降序排序
      return scored.sort((a, b) => b.score - a.score);
    } catch (error) {
      console.error('[MemoryEvolution] Failed to rank memories, using original order', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Fallback: 返回原始顺序
      return memories.map((mem) => ({ id: mem.id, score: 0.5 }));
    }
  }

  /**
   * 识别无效记忆（低效记忆清理）
   */
  async identifyIneffectiveMemories(agentId: string, threshold: number = MEMORY_INEFFECTIVE_THRESHOLD): Promise<string[]> {
    try {
      // 在数据库侧聚合，避免全表加载
      const sql = `SELECT memory_id, AVG(contribution_score) AS avg_score, COUNT(*) AS use_count
                   FROM memory_usage_feedback
                   GROUP BY memory_id
                   HAVING COUNT(*) >= ? AND AVG(contribution_score) < ?`;
      const rows = await this.db.query<any>(sql, [MEMORY_INEFFECTIVE_MIN_USES, threshold]);

      const ineffective = rows.map((row) => row.memory_id as string);

      console.info('[MemoryEvolution] Identified ineffective memories', {
        event: 'ineffective-memories-identified',
        count: ineffective.length,
        threshold,
      });

      return ineffective;
    } catch (error) {
      console.error('[MemoryEvolution] Failed to identify ineffective memories', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * 批量重训练模型（从历史数据中学习）
   */
  async retrainModel(days: number = 30): Promise<void> {
    try {
      const since = new Date();
      since.setDate(since.getDate() - days);

      const sql = `SELECT features, contribution_score FROM memory_usage_feedback WHERE created_at >= ?`;
      const rows = await this.db.query<any>(sql, [since.toISOString()]);

      if (rows.length < MEMORY_MIN_SAMPLES) {
        console.info('[MemoryEvolution] Not enough samples for retraining', {
          event: 'retrain-skipped',
          sampleCount: rows.length,
          required: MEMORY_MIN_SAMPLES,
        });
        return;
      }

      // 准备训练样本（跳过损坏或越界的记录）
      const samples: Array<{ features: MemoryRankingFeatures; actualUtility: number }> = [];
      for (const row of rows) {
        try {
          const features = typeof row.features === 'string' ? JSON.parse(row.features) : row.features;
          const actualUtility = Number(row.contribution_score);
          if (!features || !Number.isFinite(actualUtility) || actualUtility < 0 || actualUtility > 1) {
            continue;
          }
          samples.push({ features, actualUtility });
        } catch {
          // 忽略无法解析的特征快照
        }
      }

      if (samples.length < MEMORY_MIN_SAMPLES) {
        console.info('[MemoryEvolution] Not enough valid samples for retraining', {
          event: 'retrain-skipped',
          validSampleCount: samples.length,
          required: MEMORY_MIN_SAMPLES,
        });
        return;
      }

      // 保存当前快照
      const snapshot = this.rankingModel.createSnapshot();

      // 计算训练前误差
      const errorBefore = computeMeanSquaredError(this.rankingModel, samples);

      // 批量学习
      this.rankingModel.batchLearn(samples, 10);

      // 计算训练后误差
      const errorAfter = computeMeanSquaredError(this.rankingModel, samples);

      // 如果误差没有改善，回滚
      if (errorAfter > errorBefore) {
        this.rankingModel.restoreSnapshot(snapshot);
        console.warn('[MemoryEvolution] Training did not improve, rolled back', {
          event: 'retrain-rolled-back',
          errorBefore,
          errorAfter,
        });
        return;
      }

      // 更新快照
      this.lastSnapshot = this.rankingModel.createSnapshot();

      console.info('[MemoryEvolution] Memory ranking model retrained', {
        event: 'memory-model-retrained',
        feedbackCount: samples.length,
        errorBefore,
        errorAfter,
        weights: this.rankingModel.getWeights(),
        version: this.rankingModel.getVersion(),
      });
    } catch (error) {
      console.error('[MemoryEvolution] Failed to retrain model', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 获取记忆策略报告
   */
  async getReport(): Promise<{
    weights: MemoryRankingWeights;
    modelVersion: number;
    totalFeedbacks: number;
    avgContributionScore: number;
    ineffectiveMemoryCount: number;
  }> {
    try {
      const sql = `SELECT COUNT(*) AS total, AVG(contribution_score) AS avg_score FROM memory_usage_feedback`;
      const rows = await this.db.query<any>(sql);
      const total = Number(rows[0]?.total ?? 0);
      const avgScore = Number(rows[0]?.avg_score ?? 0);
      const ineffective = await this.identifyIneffectiveMemories('default', MEMORY_INEFFECTIVE_THRESHOLD);

      return {
        weights: this.rankingModel.getWeights(),
        modelVersion: this.rankingModel.getVersion(),
        totalFeedbacks: total,
        avgContributionScore: Number.isFinite(avgScore) ? avgScore : 0,
        ineffectiveMemoryCount: ineffective.length,
      };
    } catch (error) {
      console.error('[MemoryEvolution] Failed to get report', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        weights: this.rankingModel.getWeights(),
        modelVersion: this.rankingModel.getVersion(),
        totalFeedbacks: 0,
        avgContributionScore: 0,
        ineffectiveMemoryCount: 0,
      };
    }
  }

  /**
   * 获取模型版本
   */
  getModelVersion(): number {
    return this.rankingModel.getVersion();
  }
}
