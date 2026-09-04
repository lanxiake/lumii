/**
 * 元认知引擎测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  extractTaskCompletion,
  extractUserFeedback,
  extractEfficiency,
  extractKnowledgeGrowth,
  collectMetricsFromSession,
  type SessionMetrics,
  type AgentSession,
} from '../metrics-collector';
import {
  computeSatisfactionScore,
  shouldTriggerGoalGeneration,
  categorizeSatisfactionLevel,
  MetaCognitionEngine,
  type DatabaseClient,
} from '../meta-cognition-engine';
import { SATISFACTION_WEIGHTS, SATISFACTION_THRESHOLD } from '../config';

describe('指标提取函数', () => {
  describe('extractTaskCompletion', () => {
    it('无错误时应返回 1.0', () => {
      const metrics: SessionMetrics = {
        sessionId: 'test',
        agentId: 'agent1',
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        messageCount: 10,
        toolCallCount: 5,
        errorCount: 0,
        userInteractionCount: 3,
        knowledgeQueriesCount: 2,
      };
      expect(extractTaskCompletion(metrics)).toBe(1.0);
    });

    it('全部失败时应返回 0.5', () => {
      const metrics: SessionMetrics = {
        sessionId: 'test',
        agentId: 'agent1',
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        messageCount: 10,
        toolCallCount: 5,
        errorCount: 5,
        userInteractionCount: 3,
        knowledgeQueriesCount: 2,
      };
      expect(extractTaskCompletion(metrics)).toBe(0.5);
    });

    it('部分失败应在 [0.5, 1.0] 区间', () => {
      const metrics: SessionMetrics = {
        sessionId: 'test',
        agentId: 'agent1',
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        messageCount: 10,
        toolCallCount: 10,
        errorCount: 2,
        userInteractionCount: 3,
        knowledgeQueriesCount: 2,
      };
      const result = extractTaskCompletion(metrics);
      expect(result).toBeGreaterThan(0.5);
      expect(result).toBeLessThan(1.0);
    });
  });

  describe('extractUserFeedback', () => {
    it('无交互应返回 0.5（中性）', () => {
      const metrics: SessionMetrics = {
        sessionId: 'test',
        agentId: 'agent1',
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        messageCount: 10,
        toolCallCount: 5,
        errorCount: 0,
        userInteractionCount: 0,
        knowledgeQueriesCount: 2,
      };
      expect(extractUserFeedback(metrics)).toBe(0.5);
    });

    it('高交互应返回接近 1.0', () => {
      const metrics: SessionMetrics = {
        sessionId: 'test',
        agentId: 'agent1',
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        messageCount: 10,
        toolCallCount: 5,
        errorCount: 0,
        userInteractionCount: 12,
        knowledgeQueriesCount: 2,
      };
      expect(extractUserFeedback(metrics)).toBe(1.0);
    });
  });

  describe('extractEfficiency', () => {
    it('快速会话应返回高分', () => {
      const start = new Date();
      const end = new Date(start.getTime() + 1000); // 1秒
      const metrics: SessionMetrics = {
        sessionId: 'test',
        agentId: 'agent1',
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        messageCount: 10,
        toolCallCount: 5,
        errorCount: 0,
        userInteractionCount: 3,
        knowledgeQueriesCount: 2,
      };
      const result = extractEfficiency(metrics);
      expect(result).toBeGreaterThan(0.5);
    });

    it('超长会话应返回低分', () => {
      const start = new Date();
      const end = new Date(start.getTime() + 3600000); // 1小时
      const metrics: SessionMetrics = {
        sessionId: 'test',
        agentId: 'agent1',
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        messageCount: 10,
        toolCallCount: 5,
        errorCount: 0,
        userInteractionCount: 3,
        knowledgeQueriesCount: 2,
      };
      const result = extractEfficiency(metrics);
      expect(result).toBeLessThan(0.5);
    });
  });

  describe('extractKnowledgeGrowth', () => {
    it('无查询应返回 0', () => {
      const metrics: SessionMetrics = {
        sessionId: 'test',
        agentId: 'agent1',
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        messageCount: 10,
        toolCallCount: 5,
        errorCount: 0,
        userInteractionCount: 3,
        knowledgeQueriesCount: 0,
      };
      expect(extractKnowledgeGrowth(metrics)).toBe(0);
    });

    it('高查询占比应返回 1.0', () => {
      const metrics: SessionMetrics = {
        sessionId: 'test',
        agentId: 'agent1',
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        messageCount: 10,
        toolCallCount: 5,
        errorCount: 0,
        userInteractionCount: 3,
        knowledgeQueriesCount: 6, // 60% 占比
      };
      expect(extractKnowledgeGrowth(metrics)).toBe(1.0);
    });
  });
});

describe('满意度评分计算', () => {
  it('应正确计算加权总分', () => {
    const metrics: SessionMetrics = {
      sessionId: 'test',
      agentId: 'agent1',
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      messageCount: 10,
      toolCallCount: 10,
      errorCount: 0,
      userInteractionCount: 5,
      knowledgeQueriesCount: 3,
    };

    const score = computeSatisfactionScore(metrics, SATISFACTION_WEIGHTS);

    expect(score.taskCompletion).toBe(1.0);
    expect(score.userFeedback).toBeLessThanOrEqual(1.0);
    expect(score.efficiency).toBeGreaterThan(0);
    expect(score.knowledgeGrowth).toBeGreaterThan(0);
    expect(score.overall).toBeGreaterThan(0);
    expect(score.overall).toBeLessThanOrEqual(1.0);
  });

  it('总分应在 [0, 1] 范围', () => {
    const metrics: SessionMetrics = {
      sessionId: 'test',
      agentId: 'agent1',
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      messageCount: 1,
      toolCallCount: 1,
      errorCount: 100, // 极端情况
      userInteractionCount: 0,
      knowledgeQueriesCount: 0,
    };

    const score = computeSatisfactionScore(metrics, SATISFACTION_WEIGHTS);
    expect(score.overall).toBeGreaterThanOrEqual(0);
    expect(score.overall).toBeLessThanOrEqual(1.0);
  });
});

describe('目标生成触发判断', () => {
  it('低于阈值应触发', () => {
    const score: any = { overall: 0.59 };
    expect(shouldTriggerGoalGeneration(score, SATISFACTION_THRESHOLD)).toBe(true);
  });

  it('等于阈值不应触发', () => {
    const score: any = { overall: 0.6 };
    expect(shouldTriggerGoalGeneration(score, SATISFACTION_THRESHOLD)).toBe(false);
  });

  it('高于阈值不应触发', () => {
    const score: any = { overall: 0.8 };
    expect(shouldTriggerGoalGeneration(score, SATISFACTION_THRESHOLD)).toBe(false);
  });
});

describe('满意度等级分类', () => {
  it('< 0.6 应为 low', () => {
    expect(categorizeSatisfactionLevel(0.5)).toBe('low');
  });

  it('0.6-0.8 应为 medium', () => {
    expect(categorizeSatisfactionLevel(0.7)).toBe('medium');
  });

  it('> 0.8 应为 high', () => {
    expect(categorizeSatisfactionLevel(0.9)).toBe('high');
  });
});

describe('MetaCognitionEngine', () => {
  let mockDb: DatabaseClient;
  let engine: MetaCognitionEngine;

  beforeEach(() => {
    mockDb = {
      execute: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
    };

    engine = new MetaCognitionEngine(
      {
        satisfactionWeights: SATISFACTION_WEIGHTS,
        satisfactionThreshold: SATISFACTION_THRESHOLD,
        reflectionTrigger: 'scheduled',
        capabilityTracking: 'manual',
      },
      mockDb,
    );
  });

  it('应成功评估会话', async () => {
    const session: AgentSession = {
      id: 'session1',
      agentId: 'agent1',
      startedAt: new Date(),
      endedAt: new Date(),
      messages: [
        { role: 'user', content: 'test' },
        { role: 'assistant', content: 'response' },
      ],
      toolCalls: [{ success: true }],
      errors: [],
    };

    const score = await engine.evaluateSession(session);

    expect(score).toBeDefined();
    expect(score.sessionId).toBe('session1');
    expect(score.agentId).toBe('agent1');
    expect(mockDb.execute).toHaveBeenCalled();
  });

  it('数据库失败不应影响评分返回', async () => {
    mockDb.execute = vi.fn().mockRejectedValue(new Error('DB error'));

    const session: AgentSession = {
      id: 'session1',
      agentId: 'agent1',
      startedAt: new Date(),
      endedAt: new Date(),
      messages: [],
      toolCalls: [],
      errors: [],
    };

    const score = await engine.evaluateSession(session);
    expect(score).toBeDefined();
  });

  it('应正确查询最近评分', async () => {
    const mockScores = [
      {
        session_id: 's1',
        agent_id: 'agent1',
        task_completion: 0.9,
        user_feedback: 0.8,
        efficiency: 0.7,
        knowledge_growth: 0.6,
        overall_score: 0.8,
        created_at: new Date().toISOString(),
      },
    ];
    mockDb.query = vi.fn().mockResolvedValue(mockScores);

    const scores = await engine.getRecentScores('agent1', 10);

    expect(scores).toHaveLength(1);
    expect(scores[0].sessionId).toBe('s1');
    expect(scores[0].overall).toBe(0.8);
  });

  it('应正确计算平均满意度', async () => {
    mockDb.query = vi.fn().mockResolvedValue([{ avg_score: 0.75 }]);

    const avg = await engine.getAverageScore('agent1', 7);

    expect(avg).toBe(0.75);
  });
});
