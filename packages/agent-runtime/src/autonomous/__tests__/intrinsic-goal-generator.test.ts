/**
 * 内在目标生成器测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generateLearningGoal,
  generateProactiveMessageGoal,
  IntrinsicGoalGenerator,
  type GoalGenerationContext,
} from '../intrinsic-goal-generator';
import type { SatisfactionScore } from '../types';
import { GoalType, GoalStatus } from '../types';
import type { DatabaseClient } from '../meta-cognition-engine';

describe('目标生成纯函数', () => {
  describe('generateLearningGoal', () => {
    it('应根据最低维度生成相应目标', () => {
      const score: SatisfactionScore = {
        taskCompletion: 0.9,
        userFeedback: 0.8,
        efficiency: 0.7,
        knowledgeGrowth: 0.3, // 最低
        overall: 0.5,
        timestamp: new Date().toISOString(),
        sessionId: 'session1',
        agentId: 'agent1',
      };

      const goal = generateLearningGoal(score);

      expect(goal).not.toBeNull();
      expect(goal!.type).toBe(GoalType.LEARNING);
      expect(goal!.description).toContain('知识');
      expect(goal!.status).toBe(GoalStatus.PENDING);
      expect(goal!.triggerReason).toBe('low-satisfaction');
      expect(goal!.metadata?.lowestDimension).toBe('knowledge');
    });

    it('任务完成度最低应生成任务相关目标', () => {
      const score: SatisfactionScore = {
        taskCompletion: 0.2, // 最低
        userFeedback: 0.8,
        efficiency: 0.7,
        knowledgeGrowth: 0.6,
        overall: 0.5,
        timestamp: new Date().toISOString(),
        sessionId: 'session1',
        agentId: 'agent1',
      };

      const goal = generateLearningGoal(score);

      expect(goal).not.toBeNull();
      expect(goal!.description).toContain('任务完成');
      expect(goal!.metadata?.lowestDimension).toBe('task');
    });

    it('优先级应正确计算', () => {
      const score: SatisfactionScore = {
        taskCompletion: 0.3,
        userFeedback: 0.3,
        efficiency: 0.3,
        knowledgeGrowth: 0.3,
        overall: 0.3,
        timestamp: new Date().toISOString(),
        sessionId: 'session1',
        agentId: 'agent1',
      };

      const goal = generateLearningGoal(score);

      expect(goal).not.toBeNull();
      // priority = (1 - 0.3) * 0.7 + (1 - 0.3) * 0.3 = 0.7
      expect(goal!.priority).toBeCloseTo(0.7, 1);
      expect(goal!.priority).toBeGreaterThanOrEqual(0);
      expect(goal!.priority).toBeLessThanOrEqual(1);
    });
  });

  describe('generateProactiveMessageGoal', () => {
    it('用户长时间无交互且满意度中等应生成目标', () => {
      const score: SatisfactionScore = {
        taskCompletion: 0.7,
        userFeedback: 0.7,
        efficiency: 0.7,
        knowledgeGrowth: 0.7,
        overall: 0.7,
        timestamp: new Date().toISOString(),
        sessionId: 'session1',
        agentId: 'agent1',
      };

      const sevenHoursAgo = new Date(Date.now() - 7 * 3600 * 1000);
      const goal = generateProactiveMessageGoal(score, { lastUserMessageTime: sevenHoursAgo });

      expect(goal).not.toBeNull();
      expect(goal!.type).toBe(GoalType.PROACTIVE_MESSAGE);
      expect(goal!.description).toContain('主动');
      expect(goal!.triggerReason).toBe('scheduled');
    });

    it('用户最近有交互不应生成目标', () => {
      const score: SatisfactionScore = {
        taskCompletion: 0.7,
        userFeedback: 0.7,
        efficiency: 0.7,
        knowledgeGrowth: 0.7,
        overall: 0.7,
        timestamp: new Date().toISOString(),
        sessionId: 'session1',
        agentId: 'agent1',
      };

      const oneHourAgo = new Date(Date.now() - 1 * 3600 * 1000);
      const goal = generateProactiveMessageGoal(score, { lastUserMessageTime: oneHourAgo });

      expect(goal).toBeNull();
    });

    it('满意度低不应生成主动消息目标', () => {
      const score: SatisfactionScore = {
        taskCompletion: 0.5,
        userFeedback: 0.5,
        efficiency: 0.5,
        knowledgeGrowth: 0.5,
        overall: 0.5,
        timestamp: new Date().toISOString(),
        sessionId: 'session1',
        agentId: 'agent1',
      };

      const sevenHoursAgo = new Date(Date.now() - 7 * 3600 * 1000);
      const goal = generateProactiveMessageGoal(score, { lastUserMessageTime: sevenHoursAgo });

      expect(goal).toBeNull();
    });
  });
});

describe('IntrinsicGoalGenerator', () => {
  let mockDb: DatabaseClient;
  let generator: IntrinsicGoalGenerator;

  beforeEach(() => {
    mockDb = {
      execute: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
    };

    generator = new IntrinsicGoalGenerator(
      {
        enabledTypes: [GoalType.LEARNING, GoalType.PROACTIVE_MESSAGE],
        userApproval: 'always',
        maxGoalsPerDay: 3,
        priorityWeights: {
          satisfactionGap: 0.7,
          dimensionGap: 0.3,
        },
      },
      mockDb,
    );
  });

  it('应成功生成目标', async () => {
    mockDb.query = vi.fn().mockResolvedValue([{ count: 0 }]);

    const score: SatisfactionScore = {
      taskCompletion: 0.5,
      userFeedback: 0.5,
      efficiency: 0.5,
      knowledgeGrowth: 0.5,
      overall: 0.5,
      timestamp: new Date().toISOString(),
      sessionId: 'session1',
      agentId: 'agent1',
    };

    const goals = await generator.generateGoals(score, {});

    expect(goals.length).toBeGreaterThan(0);
    expect(mockDb.execute).toHaveBeenCalled();
  });

  it('达到每日上限应拒绝生成', async () => {
    mockDb.query = vi.fn().mockResolvedValue([{ count: 3 }]); // 已有 3 个

    const score: SatisfactionScore = {
      taskCompletion: 0.5,
      userFeedback: 0.5,
      efficiency: 0.5,
      knowledgeGrowth: 0.5,
      overall: 0.5,
      timestamp: new Date().toISOString(),
      sessionId: 'session1',
      agentId: 'agent1',
    };

    const goals = await generator.generateGoals(score, {});

    expect(goals).toHaveLength(0);
  });

  it('仅启用 learning 时不应生成 proactive-message', async () => {
    generator = new IntrinsicGoalGenerator(
      {
        enabledTypes: [GoalType.LEARNING],
        userApproval: 'always',
        maxGoalsPerDay: 3,
        priorityWeights: {
          satisfactionGap: 0.7,
          dimensionGap: 0.3,
        },
      },
      mockDb,
    );

    mockDb.query = vi.fn().mockResolvedValue([{ count: 0 }]);

    const score: SatisfactionScore = {
      taskCompletion: 0.7,
      userFeedback: 0.7,
      efficiency: 0.7,
      knowledgeGrowth: 0.7,
      overall: 0.7,
      timestamp: new Date().toISOString(),
      sessionId: 'session1',
      agentId: 'agent1',
    };

    const sevenHoursAgo = new Date(Date.now() - 7 * 3600 * 1000);
    const goals = await generator.generateGoals(score, { lastUserMessageTime: sevenHoursAgo });

    // 应仅包含 learning 类型（如果有）
    expect(goals.every((g) => g.type === GoalType.LEARNING)).toBe(true);
  });

  it('应正确批准目标', async () => {
    await generator.approveGoal('goal1');

    expect(mockDb.execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE autonomous_goals'), expect.arrayContaining([GoalStatus.APPROVED]));
  });

  it('应正确拒绝目标', async () => {
    await generator.rejectGoal('goal1');

    expect(mockDb.execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE autonomous_goals'), expect.arrayContaining([GoalStatus.REJECTED]));
  });

  it('应正确查询待审批目标', async () => {
    const mockGoals = [
      {
        id: 'goal1',
        agent_id: 'agent1',
        type: 'learning',
        description: 'test',
        trigger_reason: 'low-satisfaction',
        status: 'pending',
        priority: 0.8,
        satisfaction_before: 0.5,
        metadata: '{}',
        created_at: new Date().toISOString(),
      },
    ];
    mockDb.query = vi.fn().mockResolvedValue(mockGoals);

    const goals = await generator.getPendingGoals('agent1');

    expect(goals).toHaveLength(1);
    expect(goals[0].id).toBe('goal1');
    expect(goals[0].status).toBe(GoalStatus.PENDING);
  });
});
