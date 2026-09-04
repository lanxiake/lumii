/**
 * P2: 记忆策略进化器测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryEvolution } from '../memory-evolution';
import type { DatabaseClient } from '../meta-cognition-engine';
import type { MemoryRankingFeatures, MemoryUsageFeedback } from '../types';
import { MEMORY_MIN_SAMPLES } from '../config';

function makeFeatures(overrides: Partial<MemoryRankingFeatures> = {}): MemoryRankingFeatures {
  return {
    semanticSimilarity: 0.6,
    keywordMatch: 3,
    queryLength: 25,
    memoryAge: 10,
    accessCount: 4,
    lastAccessRecency: 12,
    memoryLength: 300,
    topicRelevance: 0.6,
    userFeedbackScore: 0.7,
    taskTypeMatch: true,
    avgUtilityScore: 0.6,
    retrievalSuccessRate: 0.7,
    ...overrides,
  };
}

function makeFeedback(overrides: Partial<MemoryUsageFeedback> = {}): MemoryUsageFeedback {
  return {
    memoryId: 'mem-1',
    sessionId: 'session-1',
    query: '如何配置数据库连接',
    wasUsedInResponse: true,
    contributionScore: 0.8,
    userSatisfaction: 0.9,
    features: makeFeatures(),
    timestamp: '2026-09-04T00:00:00.000Z',
    ...overrides,
  };
}

/** 可编程的数据库桩 */
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

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordFeedback 反馈记录', () => {
  it('合法反馈被持久化且推进模型版本', async () => {
    const { db } = makeDb();
    const evolution = new MemoryEvolution(db);
    const v0 = evolution.getModelVersion();

    await evolution.recordFeedback(makeFeedback());

    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(evolution.getModelVersion()).toBeGreaterThan(v0);
  });

  it('只写入查询长度，不写入查询原文（隐私保护）', async () => {
    const { db, executed } = makeDb();
    const evolution = new MemoryEvolution(db);
    const query = '包含敏感信息的用户查询';

    await evolution.recordFeedback(makeFeedback({ query }));

    expect(executed[0].params).toContain(query.length);
    expect(executed[0].params).not.toContain(query);
    expect(executed[0].sql).not.toContain(' query,');
  });

  it('贡献度越界时抛错且不写库', async () => {
    const { db } = makeDb();
    const evolution = new MemoryEvolution(db);

    await expect(evolution.recordFeedback(makeFeedback({ contributionScore: 1.5 }))).rejects.toThrow();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('用户满意度越界时抛错', async () => {
    const { db } = makeDb();
    const evolution = new MemoryEvolution(db);

    await expect(evolution.recordFeedback(makeFeedback({ userSatisfaction: -0.2 }))).rejects.toThrow();
  });

  it('缺失用户满意度时以 null 写入', async () => {
    const { db, executed } = makeDb();
    const evolution = new MemoryEvolution(db);

    await evolution.recordFeedback(makeFeedback({ userSatisfaction: undefined }));

    expect(executed[0].params).toContain(null);
  });

  it('写库失败时权重回滚到上一份有效快照', async () => {
    const db: DatabaseClient = {
      execute: vi.fn(async () => {
        throw new Error('db down');
      }),
      query: vi.fn(async () => [] as any),
    };
    const evolution = new MemoryEvolution(db);
    const features = makeFeatures();

    const rankedBefore = await evolution.rankMemories([{ id: 'm', features }], 'q');

    await expect(evolution.recordFeedback(makeFeedback())).rejects.toThrow();

    const rankedAfter = await evolution.rankMemories([{ id: 'm', features }], 'q');
    expect(rankedAfter[0].score).toBe(rankedBefore[0].score);
  });
});

describe('rankMemories 排序', () => {
  it('空候选返回空数组', async () => {
    const { db } = makeDb();
    expect(await new MemoryEvolution(db).rankMemories([], 'q')).toEqual([]);
  });

  it('按预测得分降序排列', async () => {
    const { db } = makeDb();
    const evolution = new MemoryEvolution(db);

    const ranked = await evolution.rankMemories(
      [
        { id: 'low', features: makeFeatures({ semanticSimilarity: 0.1, topicRelevance: 0.1 }) },
        { id: 'high', features: makeFeatures({ semanticSimilarity: 0.95, topicRelevance: 0.95 }) },
      ],
      'q'
    );

    expect(ranked[0].id).toBe('high');
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
  });

  it('保留所有候选，不丢失记忆', async () => {
    const { db } = makeDb();
    const candidates = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, features: makeFeatures() }));

    const ranked = await new MemoryEvolution(db).rankMemories(candidates, 'q');

    expect(ranked).toHaveLength(20);
    expect(new Set(ranked.map((r) => r.id)).size).toBe(20);
  });

  it('100 条候选的排序在 50ms 内完成', async () => {
    const { db } = makeDb();
    const candidates = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, features: makeFeatures() }));

    const start = performance.now();
    await new MemoryEvolution(db).rankMemories(candidates, 'q');
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe('identifyIneffectiveMemories 低效记忆识别', () => {
  it('在数据库侧聚合并返回命中的记忆 ID', async () => {
    const { db } = makeDb(() => [
      { memory_id: 'bad-1', avg_score: 0.05, use_count: 9 },
      { memory_id: 'bad-2', avg_score: 0.1, use_count: 6 },
    ]);

    const ineffective = await new MemoryEvolution(db).identifyIneffectiveMemories('agent-1');

    expect(ineffective).toEqual(['bad-1', 'bad-2']);
  });

  it('聚合查询带最小使用次数和阈值参数', async () => {
    const { db } = makeDb(() => []);
    const query = db.query as any;

    await new MemoryEvolution(db).identifyIneffectiveMemories('agent-1', 0.25);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('GROUP BY memory_id');
    expect(params).toContain(0.25);
  });

  it('无命中时返回空数组', async () => {
    const { db } = makeDb(() => []);
    expect(await new MemoryEvolution(db).identifyIneffectiveMemories('agent-1')).toEqual([]);
  });

  it('查询失败时降级为空数组，不抛错', async () => {
    const db: DatabaseClient = {
      execute: vi.fn(),
      query: vi.fn(async () => {
        throw new Error('boom');
      }),
    };

    expect(await new MemoryEvolution(db).identifyIneffectiveMemories('agent-1')).toEqual([]);
  });

  it('只返回 ID，不返回记忆内容', async () => {
    const { db } = makeDb(() => [{ memory_id: 'bad-1', avg_score: 0.05, use_count: 9, content: '敏感内容' }]);

    const ineffective = await new MemoryEvolution(db).identifyIneffectiveMemories('agent-1');

    expect(ineffective).toEqual(['bad-1']);
  });
});

describe('retrainModel 批量重训练', () => {
  /** 生成 n 条训练行 */
  function trainingRows(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      features: JSON.stringify(makeFeatures({ semanticSimilarity: i % 2 === 0 ? 0.95 : 0.05 })),
      contribution_score: i % 2 === 0 ? 1 : 0,
    }));
  }

  it('样本量不足时跳过训练，模型版本不变', async () => {
    const { db } = makeDb(() => trainingRows(MEMORY_MIN_SAMPLES - 1));
    const evolution = new MemoryEvolution(db);
    const v0 = evolution.getModelVersion();

    await evolution.retrainModel(30);

    expect(evolution.getModelVersion()).toBe(v0);
  });

  it('样本充足时执行训练', async () => {
    const { db } = makeDb(() => trainingRows(MEMORY_MIN_SAMPLES + 20));
    const evolution = new MemoryEvolution(db);
    const v0 = evolution.getModelVersion();

    await evolution.retrainModel(30);

    expect(evolution.getModelVersion()).toBeGreaterThan(v0);
  });

  it('跳过无法解析的特征快照', async () => {
    const rows = [...trainingRows(MEMORY_MIN_SAMPLES + 10), { features: '{invalid json', contribution_score: 0.5 }];
    const { db } = makeDb(() => rows);

    await expect(new MemoryEvolution(db).retrainModel(30)).resolves.toBeUndefined();
  });

  it('跳过贡献度越界的记录', async () => {
    const rows = [
      ...trainingRows(MEMORY_MIN_SAMPLES + 10),
      { features: JSON.stringify(makeFeatures()), contribution_score: 5 },
      { features: JSON.stringify(makeFeatures()), contribution_score: NaN },
    ];
    const { db } = makeDb(() => rows);

    await expect(new MemoryEvolution(db).retrainModel(30)).resolves.toBeUndefined();
  });

  it('有效样本不足时跳过训练', async () => {
    // 行数够，但全部损坏
    const rows = Array.from({ length: MEMORY_MIN_SAMPLES + 10 }, () => ({
      features: '{broken',
      contribution_score: 0.5,
    }));
    const { db } = makeDb(() => rows);
    const evolution = new MemoryEvolution(db);
    const v0 = evolution.getModelVersion();

    await evolution.retrainModel(30);

    expect(evolution.getModelVersion()).toBe(v0);
  });

  it('查询失败时不抛错', async () => {
    const db: DatabaseClient = {
      execute: vi.fn(),
      query: vi.fn(async () => {
        throw new Error('boom');
      }),
    };

    await expect(new MemoryEvolution(db).retrainModel(30)).resolves.toBeUndefined();
  });

  it('训练窗口按天数传参', async () => {
    const { db } = makeDb(() => []);
    const query = db.query as any;

    await new MemoryEvolution(db).retrainModel(7);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('created_at >= ?');
    expect(typeof params[0]).toBe('string');
  });
});

describe('getReport 报告', () => {
  it('返回权重、版本和聚合指标', async () => {
    const { db } = makeDb((sql) => {
      if (sql.includes('COUNT(*) AS total')) {
        return [{ total: 42, avg_score: 0.66 }];
      }
      return [{ memory_id: 'bad-1', avg_score: 0.05, use_count: 8 }];
    });

    const report = await new MemoryEvolution(db).getReport();

    expect(report.totalFeedbacks).toBe(42);
    expect(report.avgContributionScore).toBeCloseTo(0.66);
    expect(report.ineffectiveMemoryCount).toBe(1);
    expect(report.weights).toBeDefined();
    expect(report.modelVersion).toBeGreaterThan(0);
  });

  it('空表时平均值为 0 而非 NaN', async () => {
    const { db } = makeDb((sql) => (sql.includes('COUNT(*) AS total') ? [{ total: 0, avg_score: null }] : []));

    const report = await new MemoryEvolution(db).getReport();

    expect(report.totalFeedbacks).toBe(0);
    expect(report.avgContributionScore).toBe(0);
  });

  it('查询失败时返回降级报告', async () => {
    const db: DatabaseClient = {
      execute: vi.fn(),
      query: vi.fn(async () => {
        throw new Error('boom');
      }),
    };

    const report = await new MemoryEvolution(db).getReport();

    expect(report.totalFeedbacks).toBe(0);
    expect(report.weights).toBeDefined();
  });
});
