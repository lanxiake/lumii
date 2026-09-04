/**
 * P2 端到端测试：多层进化协同
 *
 * 覆盖设计文档 8.3 节的场景清单：
 * 1. 高满意度 → 主要利用，探索受预算约束
 * 2. 低满意度 → 只探索一层，不同时改变多层
 * 3. 记忆检索失败 → 回退，不阻断回答
 * 4. 工具全部失败 → 安全错误路径，不扩大权限
 * 5. 技能缺口 → 生成待批准目标，不自动安装技能
 * 6. 层间冲突 → critical 自动安全修复，warning 可观测
 * 7. P0/P1/P2 目标共存 → 去重并遵守每日 7 个上限
 * 8. 重启恢复 → 恢复模型、采样统计、调度状态和帕累托前沿
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryEvolution } from '../../memory-evolution';
import { MemoryRankingModel } from '../../memory-ranking-model';
import { ToolEvolution } from '../../tool-evolution';
import { SkillEvolution } from '../../skill-evolution';
import { CoordinatedScheduler, computeExplorationBudget } from '../../coordinated-scheduler';
import { ConflictDetector } from '../../conflict-detector';
import { ParetoFrontier } from '../../pareto-frontier';
import { computeMarginalContribution, isContributionNormalized } from '../../shapley-attribution';
import {
  generateSkillEnhancementGoal,
  generateMemoryOptimizationGoal,
  IntrinsicGoalGenerator,
} from '../../intrinsic-goal-generator';
import { EvolutionLayer, ExplorationMode, GoalType, GoalStatus } from '../../types';
import type { DatabaseClient } from '../../meta-cognition-engine';
import type { LayerConfigs, MemoryRankingFeatures, OptimizationObjectives, SatisfactionScore } from '../../types';
import { MAX_GOALS_PER_DAY } from '../../config';

function makeFeatures(overrides: Partial<MemoryRankingFeatures> = {}): MemoryRankingFeatures {
  return {
    semanticSimilarity: 0.6,
    keywordMatch: 3,
    queryLength: 20,
    memoryAge: 10,
    accessCount: 5,
    lastAccessRecency: 10,
    memoryLength: 250,
    topicRelevance: 0.6,
    userFeedbackScore: 0.6,
    taskTypeMatch: true,
    avgUtilityScore: 0.6,
    retrievalSuccessRate: 0.6,
    ...overrides,
  };
}

function makeConfigs(overrides: Partial<LayerConfigs> = {}): LayerConfigs {
  return {
    promptVariantId: 'variant-1',
    memoryWeightsVersion: 'v2',
    skillStrategy: 'balanced',
    toolStrategy: 'thompson',
    ...overrides,
  };
}

function makeObjectives(overrides: Partial<OptimizationObjectives> = {}): OptimizationObjectives {
  return {
    userSatisfaction: 0.75,
    responseTime: 4000,
    tokenCost: 2500,
    consistencyScore: 0.8,
    ...overrides,
  };
}

function makeScore(overall: number): SatisfactionScore {
  return {
    taskCompletion: overall,
    userFeedback: overall,
    efficiency: overall,
    knowledgeGrowth: overall,
    overall,
    timestamp: '2026-09-04T00:00:00.000Z',
    sessionId: 'session-1',
    agentId: 'agent-1',
  };
}

function makeDb(queryImpl?: (sql: string, params?: any[]) => any[]) {
  const executed: Array<{ sql: string; params: any[] }> = [];
  const db: DatabaseClient = {
    execute: vi.fn(async (sql: string, params?: any[]) => {
      executed.push({ sql, params: params ?? [] });
      return undefined;
    }),
    query: vi.fn(async (sql: string, params?: any[]) => (queryImpl ? queryImpl(sql, params) : []) as any),
  };
  return { db, executed };
}

/** 始终失败的数据库，用于故障注入 */
function makeFailingDb(): DatabaseClient {
  return {
    execute: vi.fn(async () => {
      throw new Error('database unavailable');
    }),
    query: vi.fn(async () => {
      throw new Error('database unavailable');
    }),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('场景 1：高满意度主要利用最优配置', () => {
  it('高满意度下探索预算保持在基准水平', () => {
    const scheduler = new CoordinatedScheduler({ random: () => 0.99 });
    for (let i = 0; i < 100; i++) scheduler.updateGlobalSatisfaction(0.95);

    const decision = scheduler.decide();

    expect(decision.mode).toBe(ExplorationMode.EXPLOIT);
    expect(decision.explorationBudget).toBeCloseTo(computeExplorationBudget(0.95));
  });

  it('探索频率符合预算（大量会话统计）', () => {
    const trials = 1000;
    const values = Array.from({ length: trials }, (_, i) => i / trials);
    let idx = 0;
    const scheduler = new CoordinatedScheduler({ random: () => values[idx++ % trials] });
    for (let i = 0; i < 100; i++) scheduler.updateGlobalSatisfaction(0.9);

    let explorations = 0;
    for (let i = 0; i < trials; i++) {
      const d = scheduler.decide();
      if (d.mode !== ExplorationMode.EXPLOIT) {
        explorations++;
        scheduler.recordExploration(d.layer!, 0.9);
      }
    }

    expect(explorations / trials).toBeCloseTo(computeExplorationBudget(0.9), 1);
  });

  it('利用模式从帕累托前沿选出配置', () => {
    const frontier = new ParetoFrontier();
    frontier.add(makeConfigs({ promptVariantId: 'best' }), makeObjectives({ userSatisfaction: 0.95 }));
    frontier.add(makeConfigs({ promptVariantId: 'fast' }), makeObjectives({ userSatisfaction: 0.6, responseTime: 400 }));

    expect(frontier.select('satisfaction')!.config.promptVariantId).toBe('best');
  });
});

describe('场景 2：低满意度只探索一层', () => {
  it('低满意度提升探索预算', () => {
    const high = computeExplorationBudget(0.9);
    const low = computeExplorationBudget(0.15);

    expect(low).toBeGreaterThan(high);
  });

  it('单次决策最多只指定一个探索层', () => {
    const scheduler = new CoordinatedScheduler({ random: () => 0.0 });
    for (let i = 0; i < 100; i++) scheduler.updateGlobalSatisfaction(0.1);

    for (let i = 0; i < 20; i++) {
      const decision = scheduler.decide();
      expect(decision.layer).not.toBeNull();

      // 模式与层一一对应，不存在"同时探索多层"的模式
      const exploringModes = [
        ExplorationMode.EXPLORE_PROMPT,
        ExplorationMode.EXPLORE_MEMORY,
        ExplorationMode.EXPLORE_SKILL,
        ExplorationMode.EXPLORE_TOOL,
      ];
      expect(exploringModes).toContain(decision.mode);

      scheduler.recordExploration(decision.layer!, 0.2);
    }
  });

  it('探索历史中每条记录只涉及一层，便于归因', () => {
    const scheduler = new CoordinatedScheduler({ random: () => 0.0 });

    for (let i = 0; i < 8; i++) {
      const d = scheduler.decide();
      scheduler.recordExploration(d.layer!, 0.5);
    }

    const history = scheduler.getState().recentExplorations;
    expect(history).toHaveLength(8);
    for (const record of history) {
      expect(Object.values(EvolutionLayer)).toContain(record.layer);
    }
  });

  it('贡献归因在单层探索后仍然归一化', () => {
    const contribution = computeMarginalContribution([
      { layer: EvolutionLayer.PROMPT, score: 0.8, sampleCount: 20 },
      { layer: EvolutionLayer.MEMORY, score: 0.5, sampleCount: 20 },
      { layer: EvolutionLayer.SKILL, score: 0.5, sampleCount: 20 },
      { layer: EvolutionLayer.TOOL, score: 0.5, sampleCount: 20 },
    ]);

    expect(isContributionNormalized(contribution)).toBe(true);
    expect(contribution.prompt).toBeGreaterThan(contribution.memory);
  });
});

describe('场景 3：记忆检索失败时回退，不阻断回答', () => {
  it('数据库不可用时排序仍返回全部候选', async () => {
    const evolution = new MemoryEvolution(makeFailingDb());

    const ranked = await evolution.rankMemories(
      [
        { id: 'm1', features: makeFeatures() },
        { id: 'm2', features: makeFeatures({ semanticSimilarity: 0.9 }) },
      ],
      'query'
    );

    expect(ranked).toHaveLength(2);
    expect(ranked.map((r) => r.id).sort()).toEqual(['m1', 'm2']);
  });

  it('低效记忆识别失败时降级为空列表，不抛错', async () => {
    const evolution = new MemoryEvolution(makeFailingDb());

    await expect(evolution.identifyIneffectiveMemories('agent-1')).resolves.toEqual([]);
  });

  it('重训练失败时不抛错，模型保持可用', async () => {
    const evolution = new MemoryEvolution(makeFailingDb());

    await expect(evolution.retrainModel(30)).resolves.toBeUndefined();

    const ranked = await evolution.rankMemories([{ id: 'm', features: makeFeatures() }], 'q');
    expect(ranked).toHaveLength(1);
  });

  it('反馈写入失败时模型权重回滚，后续排序仍然确定', async () => {
    const evolution = new MemoryEvolution(makeFailingDb());
    const features = makeFeatures();

    const before = await evolution.rankMemories([{ id: 'm', features }], 'q');

    await expect(
      evolution.recordFeedback({
        memoryId: 'm',
        sessionId: 's',
        query: 'q',
        wasUsedInResponse: true,
        contributionScore: 0.9,
        features,
        timestamp: '2026-09-04T00:00:00.000Z',
      })
    ).rejects.toThrow();

    const after = await evolution.rankMemories([{ id: 'm', features }], 'q');
    expect(after[0].score).toBe(before[0].score);
  });
});

describe('场景 4：工具全部失败时保留安全错误路径', () => {
  it('连续失败不会扩大候选工具范围', async () => {
    const { db } = makeDb();
    const evolution = new ToolEvolution(db);
    const context = { taskType: 'search', difficulty: 0.5 };

    for (let i = 0; i < 40; i++) {
      await evolution.recordFeedback({
        toolName: i % 2 === 0 ? 'tool-a' : 'tool-b',
        sessionId: 's',
        context,
        result: 'failure',
        executionTime: 100,
        timestamp: '2026-09-04T00:00:00.000Z',
      });
    }

    // 即使全部失败，也只在给定候选中选择
    for (let i = 0; i < 20; i++) {
      const selected = await evolution.selectTool(['tool-a', 'tool-b'], context);
      expect(['tool-a', 'tool-b']).toContain(selected);
    }
  });

  it('空候选列表抛出明确错误，不静默兜底到任意工具', async () => {
    const { db } = makeDb();

    await expect(new ToolEvolution(db).selectTool([], { taskType: 'x', difficulty: 0.5 })).rejects.toThrow();
  });

  it('数据库失败时选择回退到候选中的第一个工具', async () => {
    const evolution = new ToolEvolution(makeFailingDb());

    const selected = await evolution.selectTool(['safe-a', 'safe-b'], { taskType: 'x', difficulty: 0.5 });

    expect(['safe-a', 'safe-b']).toContain(selected);
  });

  it('全部失败后成功率估计趋近 0，反映真实风险', async () => {
    const { db } = makeDb();
    const evolution = new ToolEvolution(db);

    for (let i = 0; i < 50; i++) {
      await evolution.recordFeedback({
        toolName: 'broken',
        sessionId: 's',
        context: { taskType: 'search', difficulty: 0.5 },
        result: 'failure',
        executionTime: 50,
        timestamp: '2026-09-04T00:00:00.000Z',
      });
    }

    expect((await evolution.getReport()).toolStats[0].successRate).toBeLessThan(0.1);
  });
});

describe('场景 5：技能缺口生成待批准目标', () => {
  const gapRows = Array.from({ length: 12 }, () => ({
    skill_name: 'web-scrape',
    success: 0,
    execution_time: 2000,
    user_satisfaction: 0.2,
    created_at: '2026-09-01T00:00:00.000Z',
  }));

  it('识别缺口并生成 skill-enhancement 目标', async () => {
    const { db } = makeDb(() => gapRows);
    const goals = await new SkillEvolution(db).generateImprovementGoals();

    expect(goals.length).toBeGreaterThan(0);
    expect(goals[0].type).toBe('skill-enhancement');
    expect(goals[0].relatedSkill).toBe('web-scrape');
  });

  it('目标处于 pending 状态并标记需要批准', () => {
    const goal = generateSkillEnhancementGoal(
      [{ skillName: 'web-scrape', issue: 'low-success-rate', priority: 3, currentValue: 0.2, threshold: 0.6 }],
      'agent-1'
    )!;

    expect(goal.status).toBe(GoalStatus.PENDING);
    expect(goal.metadata!.requiresApproval).toBe(true);
  });

  it('目标优先级被归一化到 [0, 1]', () => {
    const goal = generateSkillEnhancementGoal(
      [{ skillName: 's', issue: 'low-success-rate', priority: 999, currentValue: 0, threshold: 0.6 }],
      'agent-1'
    )!;

    expect(goal.priority).toBeGreaterThanOrEqual(0);
    expect(goal.priority).toBeLessThanOrEqual(1);
  });

  it('不自动安装或执行技能（仅产生目标记录）', async () => {
    const { db, executed } = makeDb(() => gapRows);

    await new SkillEvolution(db).generateImprovementGoals();

    // 生成候选目标阶段不应产生任何写操作
    expect(executed).toHaveLength(0);
  });

  it('记忆优化目标只复核不删除', () => {
    const goal = generateMemoryOptimizationGoal(['m1', 'm2', 'm3'], 'agent-1')!;

    expect(goal.type).toBe(GoalType.MEMORY_OPTIMIZATION);
    expect(goal.metadata!.action).toBe('review-only');
    expect(goal.metadata!.requiresApproval).toBe(true);
  });

  it('记忆优化目标只携带 ID，不含记忆内容', () => {
    const goal = generateMemoryOptimizationGoal(['m1', 'm2'], 'agent-1')!;

    expect(goal.metadata!.memoryIds).toEqual(['m1', 'm2']);
    expect(JSON.stringify(goal.metadata)).not.toContain('content');
  });
});

describe('场景 6：层间冲突检测与安全修复', () => {
  it('critical 冲突被自动修复为保守默认值', () => {
    const detector = new ConflictDetector();
    const result = detector.detectAndResolve({ configs: makeConfigs({ memoryWeightsVersion: '', skillStrategy: '' }) });

    expect(result.resolved.length).toBeGreaterThan(0);
    expect(result.configs.memoryWeightsVersion).toBe('baseline');
    expect(result.configs.skillStrategy).toBe('default');
  });

  it('warning 只记录，配置保持不变', () => {
    const detector = new ConflictDetector();
    const configs = makeConfigs();

    const result = detector.detectAndResolve({
      configs,
      objectives: { tokenCost: 15000, userSatisfaction: 0.35 },
    });

    expect(result.configs).toEqual(configs);
    expect(result.unresolved.some((c) => c.severity === 'warning')).toBe(true);
  });

  it('修复后重新校验，不留下可修复的 critical 冲突', () => {
    const detector = new ConflictDetector();
    const result = detector.detectAndResolve({
      configs: makeConfigs({ memoryWeightsVersion: '', skillStrategy: '', toolStrategy: '' }),
    });

    const stillFixable = result.unresolved.filter((c) => c.severity === 'critical' && c.suggestedFix);
    expect(stillFixable).toHaveLength(0);
  });

  it('修复不改变无关层，也不引入扩权策略', () => {
    const detector = new ConflictDetector();
    const result = detector.detectAndResolve({
      configs: makeConfigs({ memoryWeightsVersion: '', promptVariantId: 'user-chosen' }),
    });

    expect(result.configs.promptVariantId).toBe('user-chosen');
    expect(result.configs.toolStrategy).toBe('thompson');
  });

  it('修复后的配置可直接进入帕累托前沿', () => {
    const detector = new ConflictDetector();
    const { configs } = detector.detectAndResolve({ configs: makeConfigs({ memoryWeightsVersion: '' }) });

    const frontier = new ParetoFrontier();
    expect(frontier.add(configs, makeObjectives())).toBe(true);
  });
});

describe('场景 7：P0/P1/P2 目标共存与限流', () => {
  /** 允许全部五种目标类型的生成器 */
  function makeGenerator(todayCount: number, existing: any[] = []) {
    const db: DatabaseClient = {
      execute: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('COUNT(*)')) return [{ count: todayCount }] as any;
        return existing as any;
      }),
    };

    const generator = new IntrinsicGoalGenerator(
      {
        enabledTypes: [
          GoalType.LEARNING,
          GoalType.PROACTIVE_MESSAGE,
          GoalType.CAPABILITY_IMPROVEMENT,
          GoalType.SKILL_ENHANCEMENT,
          GoalType.MEMORY_OPTIMIZATION,
        ],
        userApproval: 'always',
        maxGoalsPerDay: MAX_GOALS_PER_DAY,
        priorityWeights: { satisfactionGap: 0.5, dimensionGap: 0.5 },
      },
      db
    );

    return { generator, db };
  }

  const richContext = {
    capabilityGaps: [
      {
        dimension: 'code_generation' as any,
        currentLevel: 0.3,
        desiredLevel: 0.8,
        gap: 0.5,
        priority: 0.7,
        demandFrequency: 0.9,
      },
    ],
    skillGaps: [
      { skillName: 'web-scrape', issue: 'low-success-rate' as const, priority: 0.6, currentValue: 0.2, threshold: 0.6 },
    ],
    ineffectiveMemoryIds: ['m1', 'm2', 'm3'],
  };

  it('多来源目标可以同时生成', async () => {
    const { generator } = makeGenerator(0);

    const goals = await generator.generateGoals(makeScore(0.3), richContext);

    const types = new Set(goals.map((g) => g.type));
    expect(types.size).toBeGreaterThan(1);
    expect(types.has(GoalType.SKILL_ENHANCEMENT) || types.has(GoalType.MEMORY_OPTIMIZATION)).toBe(true);
  });

  it('新增来源不会突破每日 7 个上限', async () => {
    const { generator } = makeGenerator(MAX_GOALS_PER_DAY - 1);

    const goals = await generator.generateGoals(makeScore(0.2), richContext);

    expect(goals.length).toBeLessThanOrEqual(1);
  });

  it('达到上限后不再生成任何目标', async () => {
    const { generator, db } = makeGenerator(MAX_GOALS_PER_DAY);

    const goals = await generator.generateGoals(makeScore(0.2), richContext);

    expect(goals).toHaveLength(0);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('与已存在的未完成目标去重', async () => {
    // 先算出未去重时会生成的技能目标描述
    const skillGoal = generateSkillEnhancementGoal(richContext.skillGaps, 'agent-1')!;

    const { generator } = makeGenerator(0, [{ type: skillGoal.type, description: skillGoal.description }]);

    const goals = await generator.generateGoals(makeScore(0.2), richContext);

    expect(goals.some((g) => g.description === skillGoal.description)).toBe(false);
  });

  it('目标按优先级降序生成', async () => {
    const { generator } = makeGenerator(0);

    const goals = await generator.generateGoals(makeScore(0.2), richContext);

    for (let i = 1; i < goals.length; i++) {
      expect(goals[i - 1].priority).toBeGreaterThanOrEqual(goals[i].priority);
    }
  });

  it('所有生成的目标都处于 pending，等待用户批准', async () => {
    const { generator } = makeGenerator(0);

    const goals = await generator.generateGoals(makeScore(0.2), richContext);

    for (const goal of goals) {
      expect(goal.status).toBe(GoalStatus.PENDING);
    }
  });
});

describe('场景 8：重启恢复', () => {
  it('记忆排序模型权重可持久化并恢复', () => {
    const original = new MemoryRankingModel(0.3);
    const features = makeFeatures({ semanticSimilarity: 0.9 });
    for (let i = 0; i < 40; i++) original.learn(features, 1.0);

    const snapshot = original.createSnapshot();

    const restored = new MemoryRankingModel(0.3);
    restored.restoreSnapshot(snapshot);

    expect(restored.predict(features)).toBe(original.predict(features));
    expect(restored.getVersion()).toBe(original.getVersion());
  });

  it('工具采样统计可从数据库恢复', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      tool_name: 'grep',
      task_type: 'search',
      difficulty: 0.5,
      result: i < 40 ? 'success' : 'failure',
    }));
    const { db } = makeDb(() => rows);

    const evolution = new ToolEvolution(db);
    await evolution.loadFromDatabase(30);

    const stats = (await evolution.getReport()).toolStats[0];
    expect(stats.totalUsage).toBe(50);
    expect(stats.successRate).toBeGreaterThan(0.7);
  });

  it('调度器状态可完整恢复，决策保持一致', () => {
    const original = new CoordinatedScheduler({ random: () => 0.0 });
    for (let i = 0; i < 6; i++) {
      const d = original.decide();
      original.recordExploration(d.layer!, 0.4 + i * 0.05);
    }
    original.updateGlobalSatisfaction(0.42);

    const restored = new CoordinatedScheduler({ random: () => 0.0, state: original.getState() });

    expect(restored.getState()).toEqual(original.getState());
    expect(restored.decide().layer).toBe(original.decide().layer);
  });

  it('帕累托前沿可加载并过滤被支配配置', () => {
    const original = new ParetoFrontier();
    original.add(makeConfigs({ promptVariantId: 'a' }), makeObjectives({ userSatisfaction: 0.9, responseTime: 1000 }));
    original.add(makeConfigs({ promptVariantId: 'b' }), makeObjectives({ userSatisfaction: 0.6, responseTime: 300 }));

    const restored = new ParetoFrontier();
    restored.load(original.getAll());

    expect(restored.size()).toBe(original.size());
    expect(restored.select('speed')!.config.promptVariantId).toBe(
      original.select('speed')!.config.promptVariantId
    );
  });

  it('四层状态可在同一次重启中协同恢复', async () => {
    // 组装一个"重启前"的完整 P2 状态
    const model = new MemoryRankingModel(0.2);
    for (let i = 0; i < 20; i++) model.learn(makeFeatures({ semanticSimilarity: 0.9 }), 1.0);

    const scheduler = new CoordinatedScheduler({ random: () => 0.0 });
    scheduler.recordExploration(EvolutionLayer.MEMORY, 0.7);

    const frontier = new ParetoFrontier();
    frontier.add(makeConfigs(), makeObjectives());

    const snapshot = {
      weights: model.createSnapshot(),
      schedulerState: scheduler.getState(),
      frontier: frontier.getAll(),
    };

    // 重启后恢复
    const restoredModel = new MemoryRankingModel(0.2);
    restoredModel.restoreSnapshot(snapshot.weights);
    const restoredScheduler = new CoordinatedScheduler({ random: () => 0.0, state: snapshot.schedulerState });
    const restoredFrontier = new ParetoFrontier();
    restoredFrontier.load(snapshot.frontier);

    expect(restoredModel.getVersion()).toBe(model.getVersion());
    expect(restoredScheduler.getState().recentExplorations).toHaveLength(1);
    expect(restoredFrontier.size()).toBe(1);
  });
});

describe('隐私与可观测性', () => {
  it('记忆反馈不写入查询原文', async () => {
    const { db, executed } = makeDb();
    const sensitive = '我的 API key 是 sk-secret-123';

    await new MemoryEvolution(db).recordFeedback({
      memoryId: 'm1',
      sessionId: 's1',
      query: sensitive,
      wasUsedInResponse: true,
      contributionScore: 0.7,
      features: makeFeatures(),
      timestamp: '2026-09-04T00:00:00.000Z',
    });

    const serialized = JSON.stringify(executed);
    expect(serialized).not.toContain('sk-secret-123');
    expect(serialized).not.toContain(sensitive);
  });

  it('工具反馈只记录工具名与结果，不含参数', async () => {
    const { db, executed } = makeDb();

    await new ToolEvolution(db).recordFeedback({
      toolName: 'bash',
      sessionId: 's1',
      context: { taskType: 'exec', difficulty: 0.5 },
      result: 'success',
      executionTime: 300,
      timestamp: '2026-09-04T00:00:00.000Z',
    });

    const params = executed[0].params;
    expect(params).toContain('bash');
    expect(params).toContain('success');
    // 参数数量固定为 7 个字段，不存在额外的自由文本
    expect(params).toHaveLength(7);
  });

  it('贡献归因结果总和接近 1，便于趋势监控', () => {
    const contribution = computeMarginalContribution([
      { layer: EvolutionLayer.PROMPT, score: 0.9, sampleCount: 30 },
      { layer: EvolutionLayer.MEMORY, score: 0.7, sampleCount: 30 },
      { layer: EvolutionLayer.SKILL, score: 0.6, sampleCount: 30 },
      { layer: EvolutionLayer.TOOL, score: 0.5, sampleCount: 30 },
    ]);

    expect(isContributionNormalized(contribution)).toBe(true);
  });

  it('调度决策携带可解释的原因，便于审计', () => {
    const scheduler = new CoordinatedScheduler({ random: () => 0.0 });
    const decision = scheduler.decide();

    expect(decision.reason).toBeTruthy();
    expect(decision.reason).toContain('budget');
  });
});

describe('性能门槛', () => {
  it('配置选择纯计算 p95 < 50ms', () => {
    const frontier = new ParetoFrontier();
    for (let i = 0; i < 100; i++) {
      frontier.add(
        makeConfigs({ promptVariantId: `v${i}` }),
        makeObjectives({ userSatisfaction: i / 100, responseTime: 60000 - i * 500 })
      );
    }

    const durations: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      frontier.select('balanced');
      durations.push(performance.now() - start);
    }

    durations.sort((a, b) => a - b);
    expect(durations[94]).toBeLessThan(50);
  });

  it('工具采样选择 p95 < 10ms', async () => {
    const { db } = makeDb();
    const evolution = new ToolEvolution(db);
    const context = { taskType: 'search', difficulty: 0.5 };
    const tools = Array.from({ length: 10 }, (_, i) => `tool-${i}`);

    const durations: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      await evolution.selectTool(tools, context);
      durations.push(performance.now() - start);
    }

    durations.sort((a, b) => a - b);
    expect(durations[94]).toBeLessThan(10);
  });

  it('100 条记忆候选排序 p95 < 50ms', async () => {
    const { db } = makeDb();
    const evolution = new MemoryEvolution(db);
    const candidates = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, features: makeFeatures() }));

    const durations: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      await evolution.rankMemories(candidates, 'q');
      durations.push(performance.now() - start);
    }

    durations.sort((a, b) => a - b);
    expect(durations[47]).toBeLessThan(50);
  });

  it('帕累托前沿不超过配置上限', () => {
    const frontier = new ParetoFrontier(100);
    for (let i = 0; i < 500; i++) {
      frontier.add(
        makeConfigs({ promptVariantId: `v${i}` }),
        makeObjectives({ userSatisfaction: i / 500, responseTime: 60000 - i * 100 })
      );
    }

    expect(frontier.size()).toBeLessThanOrEqual(100);
  });
});
