/**
 * P2: 技能策略进化器
 *
 * 负责跟踪技能使用效果，识别技能缺口
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 */

import type { DatabaseClient } from './meta-cognition-engine';
import type { SkillUsageRecord, SkillStats } from './types';
import { SKILL_MIN_USAGE_COUNT, SKILL_SUCCESS_RATE_THRESHOLD, SKILL_SATISFACTION_THRESHOLD, SKILL_EXECUTION_TIME_THRESHOLD } from './config';

/**
 * 技能缺口类型
 */
export type SkillGapIssue = 'low-success-rate' | 'low-satisfaction' | 'high-execution-time';

/**
 * 技能缺口定义
 */
export interface SkillGap {
  skillName: string;
  issue: SkillGapIssue;
  priority: number;
  currentValue: number;
  threshold: number;
}

/**
 * 技能策略进化器
 */
export class SkillEvolution {
  private db: DatabaseClient;

  constructor(db: DatabaseClient) {
    this.db = db;
  }

  /**
   * 记录技能使用
   */
  async recordUsage(record: SkillUsageRecord): Promise<void> {
    try {
      // 1. 验证记录数据
      this.validateRecord(record);

      // 2. 持久化记录
      await this.db.insert('skill_usage_records', {
        skill_name: record.skillName,
        session_id: record.sessionId,
        task_type: record.context.taskType,
        complexity: record.context.complexity,
        success: record.outcome.success,
        execution_time: record.outcome.executionTime,
        user_satisfaction: record.outcome.userSatisfaction,
        created_at: record.timestamp,
      });

      console.info('[SkillEvolution] Skill usage recorded', {
        event: 'skill-usage-recorded',
        skill: record.skillName,
        success: record.outcome.success,
        satisfaction: record.outcome.userSatisfaction,
        executionTime: record.outcome.executionTime,
      });
    } catch (error) {
      console.error('[SkillEvolution] Failed to record usage', {
        error: error instanceof Error ? error.message : String(error),
      });
      // 不抛出错误，避免阻断主流程
    }
  }

  /**
   * 验证记录数据
   */
  private validateRecord(record: SkillUsageRecord): void {
    if (record.outcome.userSatisfaction < 0 || record.outcome.userSatisfaction > 1) {
      throw new Error(`User satisfaction must be in [0, 1], got ${record.outcome.userSatisfaction}`);
    }
    if (record.outcome.executionTime < 0) {
      throw new Error(`Execution time must be non-negative, got ${record.outcome.executionTime}`);
    }
    if (!['low', 'medium', 'high'].includes(record.context.complexity)) {
      throw new Error(`Invalid complexity: ${record.context.complexity}`);
    }
  }

  /**
   * 获取技能统计
   */
  async getSkillStats(skillName?: string): Promise<SkillStats[]> {
    try {
      const filter = skillName ? { skill_name: skillName } : {};
      const records = await this.db.find('skill_usage_records', filter);

      // 按技能名称分组统计
      const statsMap = new Map<
        string,
        {
          usageCount: number;
          successCount: number;
          totalSatisfaction: number;
          totalExecutionTime: number;
          lastUsed: string;
        }
      >();

      for (const record of records) {
        const name = record.skill_name as string;
        const stat = statsMap.get(name) || {
          usageCount: 0,
          successCount: 0,
          totalSatisfaction: 0,
          totalExecutionTime: 0,
          lastUsed: record.created_at as string,
        };

        stat.usageCount += 1;
        if (record.success) stat.successCount += 1;
        stat.totalSatisfaction += record.user_satisfaction as number;
        stat.totalExecutionTime += record.execution_time as number;
        if ((record.created_at as string) > stat.lastUsed) {
          stat.lastUsed = record.created_at as string;
        }

        statsMap.set(name, stat);
      }

      // 转换为 SkillStats 数组
      return Array.from(statsMap.entries()).map(([name, stat]) => ({
        skillName: name,
        usageCount: stat.usageCount,
        successRate: stat.usageCount > 0 ? stat.successCount / stat.usageCount : 0,
        avgSatisfaction: stat.usageCount > 0 ? stat.totalSatisfaction / stat.usageCount : 0,
        avgExecutionTime: stat.usageCount > 0 ? stat.totalExecutionTime / stat.usageCount : 0,
        lastUsed: stat.lastUsed,
      }));
    } catch (error) {
      console.error('[SkillEvolution] Failed to get skill stats', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * 识别技能缺口（低成功率或低满意度的技能）
   */
  async identifySkillGaps(): Promise<SkillGap[]> {
    try {
      const stats = await this.getSkillStats();
      const gaps: SkillGap[] = [];

      for (const stat of stats) {
        // 至少使用 N 次才判定
        if (stat.usageCount < SKILL_MIN_USAGE_COUNT) {
          continue;
        }

        // 成功率低于阈值
        if (stat.successRate < SKILL_SUCCESS_RATE_THRESHOLD) {
          gaps.push({
            skillName: stat.skillName,
            issue: 'low-success-rate',
            priority: (SKILL_SUCCESS_RATE_THRESHOLD - stat.successRate) * stat.usageCount,
            currentValue: stat.successRate,
            threshold: SKILL_SUCCESS_RATE_THRESHOLD,
          });
        }

        // 满意度低于阈值
        if (stat.avgSatisfaction < SKILL_SATISFACTION_THRESHOLD) {
          gaps.push({
            skillName: stat.skillName,
            issue: 'low-satisfaction',
            priority: (SKILL_SATISFACTION_THRESHOLD - stat.avgSatisfaction) * stat.usageCount,
            currentValue: stat.avgSatisfaction,
            threshold: SKILL_SATISFACTION_THRESHOLD,
          });
        }

        // 执行时间超过阈值
        if (stat.avgExecutionTime > SKILL_EXECUTION_TIME_THRESHOLD) {
          gaps.push({
            skillName: stat.skillName,
            issue: 'high-execution-time',
            priority: ((stat.avgExecutionTime / 1000 - SKILL_EXECUTION_TIME_THRESHOLD / 1000) * 0.1 * stat.usageCount),
            currentValue: stat.avgExecutionTime,
            threshold: SKILL_EXECUTION_TIME_THRESHOLD,
          });
        }
      }

      // 按优先级降序排序
      gaps.sort((a, b) => b.priority - a.priority);

      console.info('[SkillEvolution] Skill gaps identified', {
        event: 'skill-gaps-identified',
        gapCount: gaps.length,
        topGaps: gaps.slice(0, 3).map((g) => ({ skill: g.skillName, issue: g.issue, priority: g.priority })),
      });

      return gaps;
    } catch (error) {
      console.error('[SkillEvolution] Failed to identify skill gaps', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * 生成技能改进目标
   */
  async generateImprovementGoals(): Promise<
    Array<{
      type: 'skill-enhancement';
      description: string;
      priority: number;
      relatedSkill: string;
      metadata: {
        issue: SkillGapIssue;
        currentValue: number;
        threshold: number;
      };
    }>
  > {
    try {
      const gaps = await this.identifySkillGaps();

      // 取前 3 个最高优先级的缺口
      return gaps.slice(0, 3).map((gap) => ({
        type: 'skill-enhancement' as const,
        description: this.generateGoalDescription(gap),
        priority: gap.priority,
        relatedSkill: gap.skillName,
        metadata: {
          issue: gap.issue,
          currentValue: gap.currentValue,
          threshold: gap.threshold,
        },
      }));
    } catch (error) {
      console.error('[SkillEvolution] Failed to generate improvement goals', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * 生成目标描述
   */
  private generateGoalDescription(gap: SkillGap): string {
    const issueMap: Record<SkillGapIssue, string> = {
      'low-success-rate': `成功率较低（当前 ${(gap.currentValue * 100).toFixed(1)}%，期望 ≥ ${(gap.threshold * 100).toFixed(1)}%）`,
      'low-satisfaction': `用户满意度不足（当前 ${gap.currentValue.toFixed(2)}，期望 ≥ ${gap.threshold.toFixed(2)}）`,
      'high-execution-time': `执行时间过长（当前 ${(gap.currentValue / 1000).toFixed(1)}s，期望 ≤ ${(gap.threshold / 1000).toFixed(1)}s）`,
    };

    return `改进技能"${gap.skillName}"：${issueMap[gap.issue]}`;
  }

  /**
   * 获取技能进化报告
   */
  async getReport(): Promise<{
    totalSkills: number;
    totalUsages: number;
    avgSuccessRate: number;
    avgSatisfaction: number;
    gapCount: number;
    topGaps: SkillGap[];
  }> {
    try {
      const stats = await this.getSkillStats();
      const gaps = await this.identifySkillGaps();

      const totalUsages = stats.reduce((sum, s) => sum + s.usageCount, 0);
      const avgSuccessRate = stats.length > 0 ? stats.reduce((sum, s) => sum + s.successRate, 0) / stats.length : 0;
      const avgSatisfaction = stats.length > 0 ? stats.reduce((sum, s) => sum + s.avgSatisfaction, 0) / stats.length : 0;

      return {
        totalSkills: stats.length,
        totalUsages,
        avgSuccessRate,
        avgSatisfaction,
        gapCount: gaps.length,
        topGaps: gaps.slice(0, 5),
      };
    } catch (error) {
      console.error('[SkillEvolution] Failed to get report', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        totalSkills: 0,
        totalUsages: 0,
        avgSuccessRate: 0,
        avgSatisfaction: 0,
        gapCount: 0,
        topGaps: [],
      };
    }
  }
}
