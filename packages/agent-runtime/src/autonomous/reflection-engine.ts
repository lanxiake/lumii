/**
 * 自我反思引擎
 * 定时触发，使用 LLM 分析满意度低的根本原因
 */

import type { ReflectionOutput, SatisfactionScore, GoalType } from './types';
import type { ExtendedDatabaseClient } from './db-adapter';
import { GoalType as GoalTypeEnum } from './types';
import { buildReflectionPrompt, parseReflectionOutput } from './reflection-prompts';
import { REFLECTION_WINDOW_DAYS, REFLECTION_SESSION_LIMIT } from './config';
import { logger } from './logger';

// LLM 客户端接口
interface LLMClient {
  complete(params: {
    model: string;
    prompt: string;
    temperature: number;
    maxTokens: number;
  }): Promise<{ content: string }>;
}

// 元认知引擎接口
interface MetaCognitionEngine {
  getRecentScores(agentId: string, days: number): Promise<SatisfactionScore[]>;
}

// 能力追踪器接口
interface CapabilityTracker {
  getCapabilityReport(agentId: string): Promise<{
    states: any[];
    gaps: any[];
    overallLevel: number;
  }>;
}

/**
 * 生成 UUID
 */
function generateUUID(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * 自我反思引擎
 */
export class ReflectionEngine {
  private db: ExtendedDatabaseClient;
  private llmClient: LLMClient;
  private metaCognitionEngine: MetaCognitionEngine;
  private capabilityTracker: CapabilityTracker;

  constructor(
    db: ExtendedDatabaseClient,
    llmClient: LLMClient,
    metaCognitionEngine: MetaCognitionEngine,
    capabilityTracker: CapabilityTracker
  ) {
    this.db = db;
    this.llmClient = llmClient;
    this.metaCognitionEngine = metaCognitionEngine;
    this.capabilityTracker = capabilityTracker;
  }

  /**
   * 执行反思
   * @param agentId Agent ID
   * @param triggerReason 触发原因
   * @returns 反思输出
   */
  async reflect(
    agentId: string,
    triggerReason: 'scheduled' | 'low-satisfaction' | 'user-request'
  ): Promise<ReflectionOutput> {
    try {
      logger.info('Reflection started', {
        event: 'reflection-started',
        agentId,
        triggerReason,
      });

      // 1. 收集输入数据
      const satisfactionHistory = await this.metaCognitionEngine.getRecentScores(
        agentId,
        REFLECTION_WINDOW_DAYS
      );
      const capabilityReport = await this.capabilityTracker.getCapabilityReport(agentId);
      const recentSessions = await this.getRecentSessionSummaries(
        agentId,
        REFLECTION_SESSION_LIMIT
      );

      // 2. 构造提示词
      const prompt = buildReflectionPrompt(
        satisfactionHistory,
        capabilityReport,
        recentSessions
      );

      // 3. 调用 LLM 生成反思
      const llmResponse = await this.llmClient.complete({
        model: 'claude-opus-5', // 使用最强模型进行反思
        prompt,
        temperature: 0.3, // 低温度，确保输出稳定
        maxTokens: 2000,
      });

      // 4. 解析 LLM 输出
      const parsed = parseReflectionOutput(llmResponse.content);

      // 5. 构造完整反思输出
      const now = new Date().toISOString();
      const windowStart = new Date();
      windowStart.setDate(windowStart.getDate() - REFLECTION_WINDOW_DAYS);

      const reflection: ReflectionOutput = {
        id: generateUUID(),
        agentId,
        triggerReason,
        diagnosis: parsed.diagnosis,
        recommendations: parsed.recommendations,
        suggestedGoals: parsed.suggestedGoals.map((goal) => ({
          ...goal,
          type: goal.type as GoalType,
        })),
        createdAt: now,
        analysisWindow: {
          start: windowStart.toISOString(),
          end: now,
        },
      };

      // 6. 持久化反思记录
      await this.db.insert('reflections', {
        id: reflection.id,
        agent_id: agentId,
        trigger_reason: triggerReason,
        primary_issue: reflection.diagnosis.primaryIssue,
        affected_dimensions: JSON.stringify(reflection.diagnosis.affectedDimensions),
        root_cause: reflection.diagnosis.rootCause,
        recommendations: JSON.stringify(reflection.recommendations),
        suggested_goals: JSON.stringify(reflection.suggestedGoals),
        analysis_window_start: reflection.analysisWindow.start,
        analysis_window_end: reflection.analysisWindow.end,
        created_at: reflection.createdAt,
      });

      // 7. 记录 Telemetry
      logger.info('Reflection completed', {
        event: 'reflection-completed',
        agentId,
        triggerReason,
        primaryIssue: reflection.diagnosis.primaryIssue,
        recommendationCount: reflection.recommendations.length,
        suggestedGoalCount: reflection.suggestedGoals.length,
      });

      return reflection;
    } catch (error) {
      logger.error('Reflection failed', {
        event: 'reflection-failed',
        agentId,
        triggerReason,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * 获取最近会话摘要（脱敏）
   */
  private async getRecentSessionSummaries(
    agentId: string,
    limit: number
  ): Promise<
    Array<{
      timestamp: string;
      taskSummary: string;
      satisfaction: number;
      toolCount: number;
      errorCount: number;
    }>
  > {
    try {
      const sessions = await this.db.find<any>(
        'autonomous_satisfaction_scores',
        {
          agent_id: agentId,
        },
        {
          limit,
          orderBy: { created_at: 'DESC' },
        }
      );

      // 提取摘要信息（不包含用户消息原文）
      return sessions.map((s) => ({
        timestamp: s.created_at,
        taskSummary: s.task_summary || '未知任务',
        satisfaction: s.overall_score,
        toolCount: s.tool_call_count || 0,
        errorCount: s.error_count || 0,
      }));
    } catch (error) {
      logger.error('Failed to get recent sessions', {
        error: error instanceof Error ? error.message : String(error),
        agentId,
      });
      return [];
    }
  }

  /**
   * 获取最近的反思记录
   */
  async getRecentReflections(
    agentId: string,
    limit: number = 5
  ): Promise<ReflectionOutput[]> {
    try {
      const rows = await this.db.find<any>(
        'reflections',
        {
          agent_id: agentId,
        },
        {
          limit,
          orderBy: { created_at: 'DESC' },
        }
      );

      return rows.map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        triggerReason: row.trigger_reason,
        diagnosis: {
          primaryIssue: row.primary_issue,
          affectedDimensions: JSON.parse(row.affected_dimensions),
          rootCause: row.root_cause,
        },
        recommendations: JSON.parse(row.recommendations),
        suggestedGoals: JSON.parse(row.suggested_goals),
        createdAt: row.created_at,
        analysisWindow: {
          start: row.analysis_window_start,
          end: row.analysis_window_end,
        },
      }));
    } catch (error) {
      logger.error('Failed to get recent reflections', {
        error: error instanceof Error ? error.message : String(error),
        agentId,
      });
      return [];
    }
  }
}
