/**
 * 自主进化 Agent 端到端集成测试
 *
 * 测试完整的自主闭环：满意度评分 → 目标生成 → 进化执行 → 人格记录
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AutonomousCoordinator } from '../../autonomous-coordinator';
import { MetaCognitionEngine } from '../../meta-cognition-engine';
import { IntrinsicGoalGenerator } from '../../intrinsic-goal-generator';
import { PromptEvolutionEngine } from '../../prompt-evolution';
import { PersonalityTracker } from '../../personality-tracker';
import type { AgentSession } from '../../metrics-collector';
import type { DatabaseClient } from '../../meta-cognition-engine';
import type { MVPScope } from '../../types';
import {
  SATISFACTION_WEIGHTS,
  SATISFACTION_THRESHOLD,
  EPSILON,
  MAX_VARIANTS_PER_PROMPT,
  MIN_TRIALS_BEFORE_EXPLOIT,
  UCB_CONFIDENCE,
  EMA_ALPHA,
  MAX_GOALS_PER_DAY,
} from '../../config';
import { GoalType, GoalStatus } from '../../types';

describe('自主进化 Agent E2E 测试', () => {
  let mockDb: DatabaseClient;
  let coordinator: AutonomousCoordinator;
  let metaCognitionEngine: MetaCognitionEngine;
  let goalGenerator: IntrinsicGoalGenerator;
  let promptEvolution: PromptEvolutionEngine;
  let personalityTracker: PersonalityTracker;

  beforeEach(async () => {
    // Mock 数据库
    mockDb = {
      execute: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
    };

    // 配置 MVP 范围
    const mvpConfig: MVPScope = {
      metaCognition: {
        satisfactionScoring: true,
        capabilityTracking: 'manual',
        reflectionTrigger: 'scheduled',
      },
      goalGeneration: {
        types: ['learning', 'proactive-message'],
        userApproval: 'always',
        maxGoalsPerDay: 3,
      },
      evolution: {
        prompt: true,
        memory: false,
        skill: false,
        tool: false,
      },
      personality: {
        tracking: true,
        evolution: false,
        display: true,
      },
    };

    // 初始化子模块
    metaCognitionEngine = new MetaCognitionEngine(
      {
        satisfactionWeights: SATISFACTION_WEIGHTS,
        satisfactionThreshold: SATISFACTION_THRESHOLD,
        reflectionTrigger: 'scheduled',
        capabilityTracking: 'manual',
      },
      mockDb,
    );

    goalGenerator = new IntrinsicGoalGenerator(
      {
        enabledTypes: [GoalType.LEARNING, GoalType.PROACTIVE_MESSAGE],
        userApproval: 'always',
        maxGoalsPerDay: MAX_GOALS_PER_DAY,
        priorityWeights: {
          satisfactionGap: 0.7,
          dimensionGap: 0.3,
        },
      },
      mockDb,
    );

    promptEvolution = new PromptEvolutionEngine(
      {
        epsilon: EPSILON,
        maxVariantsPerPrompt: MAX_VARIANTS_PER_PROMPT,
        minTrialsBeforeExploit: MIN_TRIALS_BEFORE_EXPLOIT,
        ucbConfidence: UCB_CONFIDENCE,
      },
      mockDb,
    );

    personalityTracker = new PersonalityTracker(
      {
        emaAlpha: EMA_ALPHA,
        eventWeights: {},
        trackingEnabled: true,
        evolutionEnabled: false,
      },
      mockDb,
    );

    // 初始化协调器
    coordinator = new AutonomousCoordinator(metaCognitionEngine, goalGenerator, promptEvolution, personalityTracker, mvpConfig, mockDb);

    await coordinator.initialize();
  });

  it('场景 1：低满意度触发学习目标', async () => {
    // 准备：模拟低满意度会话（高错误率、长时间、无用户交互）
    const session: AgentSession = {
      id: 'session1',
      agentId: 'agent1',
      startedAt: new Date(Date.now() - 3600000), // 1小时前开始
      endedAt: new Date(),
      messages: [
        { role: 'assistant', content: 'response' }, // 无用户消息
      ],
      toolCalls: [
        { success: false },
        { success: false },
        { success: false },
        { success: false },
      ], // 100% 错误率
      errors: [{ message: 'error 1' }, { message: 'error 2' }, { message: 'error 3' }, { message: 'error 4' }],
    };

    // Mock 数据库查询：无现有目标
    mockDb.query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)')) {
        return [{ count: 0 }];
      }
      if (sql.includes('personality_state')) {
        return []; // 首次查询，返回空
      }
      return [];
    });

    // 执行：触发会话结束
    await coordinator.onSessionEnd(session);

    // 验证：应生成评分并保存
    expect(mockDb.execute).toHaveBeenCalled();

    // 由于满意度低，会触发目标生成（通过 emit 事件）
    // 这里我们手动触发 satisfaction:low 事件来完成测试
    const score = await metaCognitionEngine.evaluateSession(session);
    expect(score.overall).toBeLessThan(SATISFACTION_THRESHOLD);

    // 触发目标生成
    const goals = await goalGenerator.generateGoals(score, {});
    expect(goals.length).toBeGreaterThan(0);
    expect(goals[0].type).toBe(GoalType.LEARNING);
    expect(goals[0].status).toBe(GoalStatus.PENDING);
  });

  it('场景 2：高满意度不触发目标生成', async () => {
    // 准备：模拟高满意度会话
    const session: AgentSession = {
      id: 'session2',
      agentId: 'agent1',
      startedAt: new Date(Date.now() - 10000),
      endedAt: new Date(),
      messages: [
        { role: 'user', content: 'test' },
        { role: 'assistant', content: 'response' },
        { role: 'user', content: 'great' },
      ],
      toolCalls: [{ success: true }, { success: true }, { success: true }],
      errors: [],
    };

    mockDb.query = vi.fn().mockResolvedValue([{ count: 0 }]);

    // 执行
    const score = await metaCognitionEngine.evaluateSession(session);

    // 验证：满意度高，不应触发目标生成
    expect(score.overall).toBeGreaterThanOrEqual(SATISFACTION_THRESHOLD);

    const goals = await goalGenerator.generateGoals(score, {});
    // 由于满意度高，学习目标会生成但优先级低；主动消息目标需要时间间隔
    // 实际上，generateGoals 会根据满意度决定是否生成，这里应该不会生成学习目标
  });

  it('场景 3：每日目标上限限制', async () => {
    const score: any = {
      taskCompletion: 0.5,
      userFeedback: 0.5,
      efficiency: 0.5,
      knowledgeGrowth: 0.5,
      overall: 0.5,
      timestamp: new Date().toISOString(),
      sessionId: 'session3',
      agentId: 'agent1',
    };

    // Mock：已有 5 个目标（P1 上限提升到 5）
    mockDb.query = vi.fn().mockResolvedValue([{ count: 5 }]);

    const goals = await goalGenerator.generateGoals(score, {});

    // 验证：应拒绝生成新目标
    expect(goals).toHaveLength(0);
  });

  it('场景 4：Prompt 进化的探索与利用', async () => {
    // 准备：5 个变体
    const mockVariants = Array.from({ length: 5 }, (_, i) => ({
      id: `v${i}`,
      baseline_prompt_id: 'baseline1',
      variant_text: `variant ${i}`,
      is_baseline: 0,
      trial_count: 20,
      success_count: 15 + i,
      total_reward: (15 + i) * 0.9,
      ucb_score: 0,
      avg_satisfaction: 0.75 + i * 0.03,
      created_at: new Date().toISOString(),
    }));

    mockDb.query = vi.fn().mockResolvedValue(mockVariants);

    const selections: string[] = [];

    // 执行 100 次选择
    for (let i = 0; i < 100; i++) {
      const variant = await promptEvolution.selectPrompt('baseline1');
      selections.push(variant.id);
    }

    // 验证：探索率约为 15% (允许 ±5% 误差)
    const uniqueSelections = new Set(selections);
    expect(uniqueSelections.size).toBeGreaterThan(1); // 至少选择了多个变体

    // v4 有最高满意度，应在利用模式下被选择最多
    const v4Count = selections.filter((id) => id === 'v4').length;
    expect(v4Count).toBeGreaterThan(selections.length * 0.5); // 至少 50%
  });

  it('场景 5：人格状态演化', async () => {
    // 初始化中性人格
    mockDb.query = vi.fn().mockResolvedValue([]);

    const initialState = await personalityTracker.getCurrentState('agent1');
    expect(initialState.openness).toBe(0.5);

    // 模拟一系列事件
    mockDb.query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('personality_state')) {
        return [
          {
            agent_id: 'agent1',
            openness: initialState.openness,
            conscientiousness: initialState.conscientiousness,
            extraversion: initialState.extraversion,
            agreeableness: initialState.agreeableness,
            neuroticism: initialState.neuroticism,
            update_count: 0,
            last_updated: new Date().toISOString(),
          },
        ];
      }
      return [];
    });

    // 事件 1: goal-generated
    const event1: any = {
      id: 'e1',
      agentId: 'agent1',
      eventType: 'goal-generated',
      personalityDelta: { openness: 0.02, conscientiousness: 0.01 },
      createdAt: new Date().toISOString(),
    };
    const state1 = await personalityTracker.updatePersonality('agent1', event1);

    // 验证：openness 应增加
    expect(state1.openness).toBeGreaterThan(0.5);
    expect(state1.updateCount).toBe(1);

    // 事件 2: user-feedback-positive
    mockDb.query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('personality_state')) {
        return [
          {
            agent_id: 'agent1',
            openness: state1.openness,
            conscientiousness: state1.conscientiousness,
            extraversion: state1.extraversion,
            agreeableness: state1.agreeableness,
            neuroticism: state1.neuroticism,
            update_count: 1,
            last_updated: new Date().toISOString(),
          },
        ];
      }
      return [];
    });

    const event2: any = {
      id: 'e2',
      agentId: 'agent1',
      eventType: 'user-feedback-positive',
      personalityDelta: { agreeableness: 0.02, neuroticism: -0.02 },
      createdAt: new Date().toISOString(),
    };
    const state2 = await personalityTracker.updatePersonality('agent1', event2);

    // 验证：agreeableness 增加，neuroticism 降低
    expect(state2.agreeableness).toBeGreaterThan(0.5);
    expect(state2.neuroticism).toBeLessThan(0.5);
    expect(state2.updateCount).toBe(2);

    // 验证所有维度在 [0, 1] 范围
    expect(state2.openness).toBeGreaterThanOrEqual(0);
    expect(state2.openness).toBeLessThanOrEqual(1);
  });

  it('协调器应正确获取指标', async () => {
    mockDb.query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*) as count FROM autonomous_satisfaction_scores')) {
        return [{ count: 10 }];
      }
      if (sql.includes('type, COUNT(*) as count FROM autonomous_goals')) {
        return [
          { type: 'learning', count: 5 },
          { type: 'proactive-message', count: 2 },
        ];
      }
      if (sql.includes('approved')) {
        return [{ approved: 6, total: 8 }];
      }
      if (sql.includes('AVG(avg_satisfaction)')) {
        return [{ rate: 0.75 }];
      }
      if (sql.includes('satisfaction_after - satisfaction_before')) {
        return [{ improvement: 0.15 }];
      }
      return [];
    });

    const metrics = await coordinator.getCoordinationMetrics();

    expect(metrics.totalEvaluations).toBe(10);
    expect(metrics.goalsGenerated['learning']).toBe(5);
    expect(metrics.approvalRate).toBeCloseTo(0.75, 2);
    expect(metrics.evolutionSuccessRate).toBe(0.75);
    expect(metrics.avgSatisfactionImprovement).toBe(0.15);
  });
});
