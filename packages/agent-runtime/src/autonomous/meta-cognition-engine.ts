/**
 * 元认知引擎
 *
 * 实现满意度评分算法，评估 Agent 会话质量
 * 来源：设计文档 2-元认知引擎算法.md
 */

import type { SatisfactionScore, SatisfactionWeights, MetaCognitionConfig } from './types';
import type { SessionMetrics, AgentSession } from './metrics-collector';
import {
  extractTaskCompletion,
  extractUserFeedback,
  extractEfficiency,
  extractKnowledgeGrowth,
  collectMetricsFromSession,
} from './metrics-collector';

/**
 * 数据库客户端接口（简化版）
 */
export interface DatabaseClient {
  execute(sql: string, params?: any[]): Promise<any>;
  query<T>(sql: string, params?: any[]): Promise<T[]>;
}

/**
 * 元认知引擎错误
 */
export class MetaCognitionError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'MetaCognitionError';
  }
}

/**
 * 计算满意度评分（纯函数）
 *
 * @param metrics 会话指标
 * @param weights 满意度权重
 * @returns 满意度评分
 */
export function computeSatisfactionScore(metrics: SessionMetrics, weights: SatisfactionWeights): SatisfactionScore {
  const taskCompletion = extractTaskCompletion(metrics);
  const userFeedback = extractUserFeedback(metrics);
  const efficiency = extractEfficiency(metrics);
  const knowledgeGrowth = extractKnowledgeGrowth(metrics);

  // 计算加权总分
  const overall = taskCompletion * weights.task + userFeedback * weights.feedback + efficiency * weights.efficiency + knowledgeGrowth * weights.knowledge;

  return {
    taskCompletion,
    userFeedback,
    efficiency,
    knowledgeGrowth,
    overall: Math.max(0, Math.min(1, overall)), // 确保在 [0, 1] 范围
    timestamp: new Date().toISOString(),
    sessionId: metrics.sessionId,
    agentId: metrics.agentId,
  };
}

/**
 * 判断是否应触发目标生成
 *
 * @param score 满意度评分
 * @param threshold 阈值
 * @returns 是否触发
 */
export function shouldTriggerGoalGeneration(score: SatisfactionScore, threshold: number): boolean {
  return score.overall < threshold;
}

/**
 * 分类满意度等级
 *
 * @param score 满意度分数
 * @returns 满意度等级
 */
export function categorizeSatisfactionLevel(score: number): 'low' | 'medium' | 'high' {
  if (score < 0.6) return 'low';
  if (score < 0.8) return 'medium';
  return 'high';
}

/**
 * 元认知引擎
 */
export class MetaCognitionEngine {
  constructor(
    private readonly config: MetaCognitionConfig,
    private readonly db: DatabaseClient,
  ) {}

  /**
   * 评估会话满意度
   *
   * @param session Agent 会话
   * @returns 满意度评分
   */
  async evaluateSession(session: AgentSession): Promise<SatisfactionScore> {
    try {
      // 收集指标
      const metrics = collectMetricsFromSession(session);

      // 计算评分
      const score = computeSatisfactionScore(metrics, this.config.satisfactionWeights);

      // 持久化到数据库
      await this.saveScore(score);

      return score;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw new MetaCognitionError(`评估会话失败: ${err.message}`, err);
    }
  }

  /**
   * 保存评分到数据库
   */
  private async saveScore(score: SatisfactionScore): Promise<void> {
    try {
      const sql = `
        INSERT INTO autonomous_satisfaction_scores (
          session_id, agent_id, task_completion, user_feedback,
          efficiency, knowledge_growth, overall_score, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;
      await this.db.execute(sql, [score.sessionId, score.agentId, score.taskCompletion, score.userFeedback, score.efficiency, score.knowledgeGrowth, score.overall, score.timestamp]);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      // 数据库失败仅记录日志，不影响评分返回
      console.error('[MetaCognitionEngine] 保存评分失败:', err.message);
    }
  }

  /**
   * 获取最近 N 次评分
   *
   * @param agentId Agent ID
   * @param limit 数量限制
   * @returns 评分列表
   */
  async getRecentScores(agentId: string, limit: number): Promise<SatisfactionScore[]> {
    try {
      const sql = `
        SELECT session_id, agent_id, task_completion, user_feedback,
               efficiency, knowledge_growth, overall_score, created_at
        FROM autonomous_satisfaction_scores
        WHERE agent_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `;
      const rows = await this.db.query<any>(sql, [agentId, limit]);

      return rows.map((row) => ({
        sessionId: row.session_id,
        agentId: row.agent_id,
        taskCompletion: row.task_completion,
        userFeedback: row.user_feedback,
        efficiency: row.efficiency,
        knowledgeGrowth: row.knowledge_growth,
        overall: row.overall_score,
        timestamp: row.created_at,
      }));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw new MetaCognitionError(`查询历史评分失败: ${err.message}`, err);
    }
  }

  /**
   * 计算最近 N 天平均满意度
   *
   * @param agentId Agent ID
   * @param days 天数
   * @returns 平均满意度
   */
  async getAverageScore(agentId: string, days: number): Promise<number> {
    try {
      const sql = `
        SELECT AVG(overall_score) as avg_score
        FROM autonomous_satisfaction_scores
        WHERE agent_id = ?
          AND created_at >= datetime('now', '-' || ? || ' days')
      `;
      const rows = await this.db.query<any>(sql, [agentId, days]);

      return rows[0]?.avg_score ?? 0.5; // 无数据时返回中性值
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw new MetaCognitionError(`计算平均满意度失败: ${err.message}`, err);
    }
  }
}
