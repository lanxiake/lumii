/**
 * 能力追踪器
 * 负责记录能力测试、更新能力评级、识别能力缺口
 *
 * 使用 Elo Rating System 动态追踪 Agent 在不同维度的能力水平
 */

import type {
  CapabilityTest,
  CapabilityState,
  CapabilityGap,
  CapabilityDimension,
} from './types';
import type { ExtendedDatabaseClient } from './db-adapter';
import { CapabilityRatingSystem } from './capability-rating-system';
import {
  ELO_K_FACTOR,
  CAPABILITY_DEMAND_WINDOW_DAYS,
} from './config';
import { logger } from './logger';

/**
 * 生成 UUID（简单实现）
 */
function generateUUID(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * 能力追踪器
 */
export class CapabilityTracker {
  private ratingSystem: CapabilityRatingSystem;
  private db: ExtendedDatabaseClient;

  constructor(db: ExtendedDatabaseClient, K: number = ELO_K_FACTOR) {
    this.ratingSystem = new CapabilityRatingSystem(K);
    this.db = db;
  }

  /**
   * 记录能力测试
   * @param test 测试记录
   * @returns 更新后的能力状态
   */
  async recordTest(test: Omit<CapabilityTest, 'id' | 'createdAt'>): Promise<CapabilityState> {
    try {
      // 1. 获取当前能力状态
      const currentState = await this.getCapabilityState(test.agentId, test.dimension);

      // 2. 使用 Elo Rating 更新能力水平
      const newLevel = this.ratingSystem.updateRating(
        currentState.level,
        test.difficulty,
        test.result
      );

      // 3. 更新测试次数和置信度
      const newTestCount = currentState.testCount + 1;
      const newConfidence = this.ratingSystem.computeConfidence(newTestCount);

      // 4. 计算新的能力边界
      const newBoundary = this.ratingSystem.findBoundary(newLevel);

      // 5. 持久化测试记录
      await this.db.insert('capability_tests', {
        id: generateUUID(),
        agent_id: test.agentId,
        dimension: test.dimension,
        session_id: test.sessionId,
        task_summary: test.taskSummary,
        difficulty: test.difficulty,
        result: test.result,
        level_before: currentState.level,
        level_after: newLevel,
        created_at: new Date().toISOString(),
      });

      // 6. 更新能力状态
      const updatedState: CapabilityState = {
        dimension: test.dimension,
        level: newLevel,
        confidence: newConfidence,
        boundary: newBoundary,
        lastUpdated: new Date().toISOString(),
        testCount: newTestCount,
      };

      await this.db.upsert(
        'capability_dimensions',
        {
          agent_id: test.agentId,
          dimension: test.dimension,
        },
        {
          level: newLevel,
          confidence: newConfidence,
          boundary: newBoundary,
          test_count: newTestCount,
          last_updated: new Date().toISOString(),
        }
      );

      // 7. 记录 Telemetry
      logger.info('Capability test recorded', {
        event: 'capability-test-recorded',
        agentId: test.agentId,
        dimension: test.dimension,
        difficulty: test.difficulty,
        result: test.result,
        levelBefore: currentState.level,
        levelAfter: newLevel,
        confidence: newConfidence,
      });

      return updatedState;
    } catch (error) {
      logger.error('Failed to record capability test', { error, test });
      throw error;
    }
  }

  /**
   * 获取能力状态
   */
  async getCapabilityState(
    agentId: string,
    dimension: CapabilityDimension
  ): Promise<CapabilityState> {
    const state = await this.db.findOne<any>('capability_dimensions', {
      agent_id: agentId,
      dimension,
    });

    // 初始状态：中等水平 0.5，零置信度
    if (!state) {
      return {
        dimension,
        level: 0.5,
        confidence: 0,
        boundary: 0.5,
        lastUpdated: new Date().toISOString(),
        testCount: 0,
      };
    }

    return {
      dimension: state.dimension,
      level: state.level,
      confidence: state.confidence,
      boundary: state.boundary,
      lastUpdated: state.last_updated,
      testCount: state.test_count,
    };
  }

  /**
   * 识别能力缺口
   * @param agentId Agent ID
   * @returns 按优先级排序的能力缺口列表
   */
  async identifyGaps(agentId: string): Promise<CapabilityGap[]> {
    try {
      // 1. 获取所有维度的当前状态
      const allDimensions = [
        'code_generation',
        'document_analysis',
        'web_search',
        'data_processing',
        'api_integration',
        'creative_writing',
        'logical_reasoning',
        'multi_step_planning',
      ] as CapabilityDimension[];

      const states = await Promise.all(
        allDimensions.map((d) => this.getCapabilityState(agentId, d))
      );

      // 2. 分析用户需求频率（基于最近 N 天的任务类型分布）
      const demandMap = await this.analyzeDemandFrequency(
        agentId,
        CAPABILITY_DEMAND_WINDOW_DAYS
      );

      // 3. 计算能力缺口
      const gaps: CapabilityGap[] = [];
      for (const state of states) {
        const demand = demandMap.get(state.dimension) || 0;

        // 期望水平 = 0.5（基线）+ demand × 0.5（需求越高期望越高）
        // 上限 0.9（保留 10% 空间用于持续优化）
        const desiredLevel = Math.min(0.9, 0.5 + demand * 0.5);

        if (state.level < desiredLevel) {
          const gap = desiredLevel - state.level;
          gaps.push({
            dimension: state.dimension,
            currentLevel: state.level,
            desiredLevel,
            gap,
            priority: demand * gap, // 优先级 = 需求频率 × 缺口大小
            demandFrequency: demand,
          });
        }
      }

      // 4. 按优先级降序排序
      gaps.sort((a, b) => b.priority - a.priority);

      logger.info('Capability gaps identified', {
        event: 'capability-gap-identified',
        agentId,
        gapCount: gaps.length,
        topGaps: gaps.slice(0, 3).map((g) => ({
          dimension: g.dimension,
          gap: g.gap,
          priority: g.priority,
        })),
      });

      return gaps;
    } catch (error) {
      logger.error('Failed to identify capability gaps', { error, agentId });
      return [];
    }
  }

  /**
   * 分析用户需求频率
   * 从历史会话中提取任务类型分布
   */
  private async analyzeDemandFrequency(
    agentId: string,
    days: number
  ): Promise<Map<CapabilityDimension, number>> {
    try {
      const since = new Date();
      since.setDate(since.getDate() - days);

      // 查询最近的能力测试记录
      const tests = await this.db.find<any>('capability_tests', {
        agent_id: agentId,
      });

      // 过滤时间范围
      const recentTests = tests.filter(
        (t) => new Date(t.created_at) >= since
      );

      if (recentTests.length === 0) {
        return new Map();
      }

      // 统计各维度出现频率
      const counts = new Map<CapabilityDimension, number>();
      for (const test of recentTests) {
        counts.set(test.dimension, (counts.get(test.dimension) || 0) + 1);
      }

      // 归一化到 [0, 1]
      const total = recentTests.length;
      const frequencies = new Map<CapabilityDimension, number>();
      for (const [dim, count] of counts.entries()) {
        frequencies.set(dim, count / total);
      }

      return frequencies;
    } catch (error) {
      logger.error('Failed to analyze demand frequency', { error, agentId });
      return new Map();
    }
  }

  /**
   * 获取能力报告（用于展示）
   */
  async getCapabilityReport(agentId: string): Promise<{
    states: CapabilityState[];
    gaps: CapabilityGap[];
    overallLevel: number;
  }> {
    const allDimensions = [
      'code_generation',
      'document_analysis',
      'web_search',
      'data_processing',
      'api_integration',
      'creative_writing',
      'logical_reasoning',
      'multi_step_planning',
    ] as CapabilityDimension[];

    const states = await Promise.all(
      allDimensions.map((d) => this.getCapabilityState(agentId, d))
    );

    const gaps = await this.identifyGaps(agentId);

    // 计算加权平均能力水平（权重 = 置信度）
    const totalWeight = states.reduce((sum, s) => sum + s.confidence, 0) || 1;
    const overallLevel =
      states.reduce((sum, s) => sum + s.level * s.confidence, 0) / totalWeight;

    return { states, gaps, overallLevel };
  }
}
