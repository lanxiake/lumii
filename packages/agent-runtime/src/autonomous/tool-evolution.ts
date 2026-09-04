/**
 * P2: 工具选择进化器
 *
 * 使用 Thompson Sampling 优化工具选择策略
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 */

import { ToolThompsonSampling } from './tool-thompson-sampling';
import type { DatabaseClient } from './meta-cognition-engine';
import type { ToolUsageFeedback, ToolSelectionStats } from './types';

/**
 * 工具选择进化器
 */
export class ToolEvolution {
  private thompsonSampling: ToolThompsonSampling;
  private db: DatabaseClient;
  private contextStrategies: Map<string, ToolThompsonSampling>;

  constructor(db: DatabaseClient) {
    this.thompsonSampling = new ToolThompsonSampling();
    this.db = db;
    this.contextStrategies = new Map();
  }

  /**
   * 选择工具（按上下文隔离）
   */
  async selectTool(
    availableTools: string[],
    context: { taskType: string; difficulty: number }
  ): Promise<string> {
    if (availableTools.length === 0) {
      throw new Error('No available tools to select from');
    }

    if (availableTools.length === 1) {
      return availableTools[0];
    }

    try {
      // 根据任务类型获取或创建上下文特定的策略
      const contextKey = this.getContextKey(context);
      let strategy = this.contextStrategies.get(contextKey);

      if (!strategy) {
        strategy = new ToolThompsonSampling();
        this.contextStrategies.set(contextKey, strategy);
      }

      // 使用 Thompson Sampling 选择工具
      const selectedTool = strategy.selectTool(availableTools);

      console.info('[ToolEvolution] Tool selected', {
        event: 'tool-selected',
        tool: selectedTool,
        availableTools,
        taskType: context.taskType,
        difficulty: context.difficulty,
        contextKey,
      });

      return selectedTool;
    } catch (error) {
      console.error('[ToolEvolution] Failed to select tool, using first available', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Fallback: 返回第一个可用工具
      return availableTools[0];
    }
  }

  /**
   * 生成上下文键（用于隔离不同场景）
   */
  private getContextKey(context: { taskType: string; difficulty: number }): string {
    // 将难度离散化为三个级别
    const difficultyLevel = context.difficulty < 0.33 ? 'low' : context.difficulty < 0.67 ? 'medium' : 'high';
    return `${context.taskType}:${difficultyLevel}`;
  }

  /**
   * 记录工具使用反馈
   */
  async recordFeedback(feedback: ToolUsageFeedback): Promise<void> {
    try {
      // 1. 验证反馈数据
      this.validateFeedback(feedback);

      // 2. 更新 Thompson Sampling 统计
      const contextKey = this.getContextKey(feedback.context);
      let strategy = this.contextStrategies.get(contextKey);

      if (!strategy) {
        strategy = new ToolThompsonSampling();
        this.contextStrategies.set(contextKey, strategy);
      }

      strategy.updateStats(feedback.toolName, feedback.result === 'success');

      // 3. 持久化反馈
      const sql = `INSERT INTO tool_usage_feedback (tool_name, session_id, task_type, difficulty, result, execution_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
      await this.db.execute(sql, [
        feedback.toolName,
        feedback.sessionId,
        feedback.context.taskType,
        feedback.context.difficulty,
        feedback.result,
        feedback.executionTime,
        feedback.timestamp,
      ]);

      console.info('[ToolEvolution] Tool feedback recorded', {
        event: 'tool-feedback-recorded',
        tool: feedback.toolName,
        result: feedback.result,
        executionTime: feedback.executionTime,
        contextKey,
      });
    } catch (error) {
      console.error('[ToolEvolution] Failed to record feedback', {
        error: error instanceof Error ? error.message : String(error),
      });
      // 不抛出错误，避免阻断主流程
    }
  }

  /**
   * 验证反馈数据
   */
  private validateFeedback(feedback: ToolUsageFeedback): void {
    if (feedback.context.difficulty < 0 || feedback.context.difficulty > 1) {
      throw new Error(`Difficulty must be in [0, 1], got ${feedback.context.difficulty}`);
    }
    if (feedback.executionTime < 0) {
      throw new Error(`Execution time must be non-negative, got ${feedback.executionTime}`);
    }
    if (feedback.result !== 'success' && feedback.result !== 'failure') {
      throw new Error(`Result must be 'success' or 'failure', got ${feedback.result}`);
    }
  }

  /**
   * 获取工具选择报告
   */
  async getReport(): Promise<{
    toolStats: Array<{
      tool: string;
      successRate: number;
      confidence: [number, number];
      totalUsage: number;
      contexts: string[];
    }>;
  }> {
    try {
      // 聚合所有上下文的统计
      const toolMap = new Map<
        string,
        {
          stats: ToolSelectionStats[];
          contexts: Set<string>;
        }
      >();

      for (const [contextKey, strategy] of this.contextStrategies.entries()) {
        const stats = strategy.getAllStats();
        for (const stat of stats) {
          let entry = toolMap.get(stat.toolName);
          if (!entry) {
            entry = { stats: [], contexts: new Set() };
            toolMap.set(stat.toolName, entry);
          }
          entry.stats.push(stat);
          entry.contexts.add(contextKey);
        }
      }

      // 计算每个工具的总体统计
      const toolStats = Array.from(toolMap.entries()).map(([toolName, entry]) => {
        // 合并所有上下文的 alpha 和 beta
        let totalAlpha = 0;
        let totalBeta = 0;
        let totalUsage = 0;

        for (const stat of entry.stats) {
          totalAlpha += stat.alpha - 1; // 减去先验
          totalBeta += stat.beta - 1;
          totalUsage += stat.totalUsage;
        }

        // 加回先验
        totalAlpha += 1;
        totalBeta += 1;

        const successRate = totalAlpha / (totalAlpha + totalBeta);

        // 计算可信区间（简化）
        const variance = (totalAlpha * totalBeta) / ((totalAlpha + totalBeta) ** 2 * (totalAlpha + totalBeta + 1));
        const margin = 1.96 * Math.sqrt(variance); // 95% CI
        const lower = Math.max(0, successRate - margin);
        const upper = Math.min(1, successRate + margin);

        return {
          tool: toolName,
          successRate,
          confidence: [lower, upper] as [number, number],
          totalUsage,
          contexts: Array.from(entry.contexts),
        };
      });

      return { toolStats };
    } catch (error) {
      console.error('[ToolEvolution] Failed to get report', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { toolStats: [] };
    }
  }

  /**
   * 从数据库加载历史统计
   */
  async loadFromDatabase(days: number = 30): Promise<void> {
    try {
      const since = new Date();
      since.setDate(since.getDate() - days);

      const sql = `SELECT tool_name, task_type, difficulty, result FROM tool_usage_feedback WHERE created_at >= ?`;
      const rows = await this.db.query<any>(sql, [since.toISOString()]);

      console.info('[ToolEvolution] Loading tool statistics from database', {
        event: 'tool-stats-loading',
        rowCount: rows.length,
        days,
      });

      // 清空后重建统计，避免重复加载导致后验被重复计数
      this.contextStrategies.clear();

      // 重建统计
      for (const row of rows) {
        const context = {
          taskType: row.task_type as string,
          difficulty: row.difficulty as number,
        };
        const contextKey = this.getContextKey(context);

        let strategy = this.contextStrategies.get(contextKey);
        if (!strategy) {
          strategy = new ToolThompsonSampling();
          this.contextStrategies.set(contextKey, strategy);
        }

        strategy.updateStats(row.tool_name as string, row.result === 'success');
      }

      console.info('[ToolEvolution] Tool statistics loaded', {
        event: 'tool-stats-loaded',
        contextCount: this.contextStrategies.size,
      });
    } catch (error) {
      console.error('[ToolEvolution] Failed to load statistics', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
