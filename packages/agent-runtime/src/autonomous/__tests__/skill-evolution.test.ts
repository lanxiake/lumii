/**
 * P2: 技能策略进化测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SkillEvolution } from '../skill-evolution';
import type { DatabaseClient } from '../meta-cognition-engine';
import type { SkillUsageRecord } from '../types';
import {
  SKILL_MIN_USAGE_COUNT,
  SKILL_SUCCESS_RATE_THRESHOLD,
  SKILL_SATISFACTION_THRESHOLD,
  SKILL_EXECUTION_TIME_THRESHOLD,
} from '../config';

/** 内存数据库桩：只支持本模块用到的查询形状 */
function makeDb(rows: any[] = []) {
  const inserted: any[][] = [];
  const db: DatabaseClient = {
    execute: vi.fn(async (_sql: string, params?: any[]) => {
      inserted.push(params ?? []);
      return undefined;
    }),
    query: vi.fn(async (sql: string, params?: any[]) => {
      if (params && params.length > 0) {
        return rows.filter((r) => r.skill_name === params[0]) as any;
      }
      return rows as any;
    }),
  };
  return { db, inserted };
}

/** 构造一条数据库行 */
function row(overrides: Partial<Record<string, any>> = {}) {
  return {
    skill_name: 'search',
    success: 1,
    execution_time: 1000,
    user_satisfaction: 0.8,
    created_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 构造一条使用记录 */
function makeRecord(overrides: Partial<SkillUsageRecord> = {}): SkillUsageRecord {
  return {
    skillName: 'search',
    sessionId: 'session-1',
    context: { taskType: 'lookup', complexity: 'medium' },
    outcome: { success: true, executionTime: 1200, userSatisfaction: 0.85 },
    timestamp: '2026-09-04T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordUsage 记录技能使用', () => {
  it('合法记录被持久化', async () => {
    const { db, inserted } = makeDb();
    const evolution = new SkillEvolution(db);

    await evolution.recordUsage(makeRecord());

    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(inserted[0]).toContain('search');
  });

  it('布尔值以 0/1 写入（SQLite 兼容）', async () => {
    const { db, inserted } = makeDb();
    const evolution = new SkillEvolution(db);

    await evolution.recordUsage(makeRecord({ outcome: { success: false, executionTime: 10, userSatisfaction: 0.1 } }));

    expect(inserted[0]).toContain(0);
  });

  it('满意度越界时不写入数据库', async () => {
    const { db } = makeDb();
    const evolution = new SkillEvolution(db);

    await evolution.recordUsage(makeRecord({ outcome: { success: true, executionTime: 10, userSatisfaction: 1.5 } }));

    expect(db.execute).not.toHaveBeenCalled();
  });

  it('负执行时间时不写入数据库', async () => {
    const { db } = makeDb();
    const evolution = new SkillEvolution(db);

    await evolution.recordUsage(makeRecord({ outcome: { success: true, executionTime: -5, userSatisfaction: 0.5 } }));

    expect(db.execute).not.toHaveBeenCalled();
  });

  it('非法复杂度时不写入数据库', async () => {
    const { db } = makeDb();
    const evolution = new SkillEvolution(db);

    await evolution.recordUsage(makeRecord({ context: { taskType: 'x', complexity: 'extreme' as any } }));

    expect(db.execute).not.toHaveBeenCalled();
  });

  it('数据库失败不抛出，避免阻断主流程', async () => {
    const db: DatabaseClient = {
      execute: vi.fn(async () => {
        throw new Error('db down');
      }),
      query: vi.fn(async () => [] as any),
    };
    const evolution = new SkillEvolution(db);

    await expect(evolution.recordUsage(makeRecord())).resolves.toBeUndefined();
  });
});

describe('getSkillStats 技能统计', () => {
  it('无记录时返回空数组', async () => {
    const { db } = makeDb([]);
    expect(await new SkillEvolution(db).getSkillStats()).toEqual([]);
  });

  it('正确聚合成功率、满意度与耗时', async () => {
    const { db } = makeDb([
      row({ success: 1, user_satisfaction: 1.0, execution_time: 1000 }),
      row({ success: 1, user_satisfaction: 0.8, execution_time: 2000 }),
      row({ success: 0, user_satisfaction: 0.2, execution_time: 3000 }),
      row({ success: 0, user_satisfaction: 0.4, execution_time: 4000 }),
    ]);

    const [stats] = await new SkillEvolution(db).getSkillStats();

    expect(stats.usageCount).toBe(4);
    expect(stats.successRate).toBeCloseTo(0.5);
    expect(stats.avgSatisfaction).toBeCloseTo(0.6);
    expect(stats.avgExecutionTime).toBeCloseTo(2500);
  });

  it('按技能分组统计', async () => {
    const { db } = makeDb([row({ skill_name: 'a' }), row({ skill_name: 'b' }), row({ skill_name: 'a' })]);

    const stats = await new SkillEvolution(db).getSkillStats();

    expect(stats).toHaveLength(2);
    expect(stats.find((s) => s.skillName === 'a')!.usageCount).toBe(2);
    expect(stats.find((s) => s.skillName === 'b')!.usageCount).toBe(1);
  });

  it('lastUsed 取最新时间戳', async () => {
    const { db } = makeDb([
      row({ created_at: '2026-09-01T00:00:00.000Z' }),
      row({ created_at: '2026-09-03T00:00:00.000Z' }),
      row({ created_at: '2026-09-02T00:00:00.000Z' }),
    ]);

    const [stats] = await new SkillEvolution(db).getSkillStats();

    expect(stats.lastUsed).toBe('2026-09-03T00:00:00.000Z');
  });

  it('按技能名过滤', async () => {
    const { db } = makeDb([row({ skill_name: 'a' }), row({ skill_name: 'b' })]);

    const stats = await new SkillEvolution(db).getSkillStats('a');

    expect(stats).toHaveLength(1);
    expect(stats[0].skillName).toBe('a');
  });

  it('查询失败时降级为空数组', async () => {
    const db: DatabaseClient = {
      execute: vi.fn(),
      query: vi.fn(async () => {
        throw new Error('query failed');
      }),
    };

    expect(await new SkillEvolution(db).getSkillStats()).toEqual([]);
  });
});

describe('identifySkillGaps 缺口识别', () => {
  /** 生成 n 条同一技能的记录 */
  function rows(n: number, overrides: Record<string, any> = {}) {
    return Array.from({ length: n }, () => row(overrides));
  }

  it('样本量不足的技能不判定缺口', async () => {
    const { db } = makeDb(rows(SKILL_MIN_USAGE_COUNT - 1, { success: 0, user_satisfaction: 0.1 }));

    expect(await new SkillEvolution(db).identifySkillGaps()).toEqual([]);
  });

  it('达到样本量且成功率过低时识别为缺口', async () => {
    const { db } = makeDb(rows(10, { success: 0, user_satisfaction: 0.9 }));

    const gaps = await new SkillEvolution(db).identifySkillGaps();

    const gap = gaps.find((g) => g.issue === 'low-success-rate');
    expect(gap).toBeDefined();
    expect(gap!.threshold).toBe(SKILL_SUCCESS_RATE_THRESHOLD);
  });

  it('满意度过低时识别为缺口', async () => {
    const { db } = makeDb(rows(10, { success: 1, user_satisfaction: 0.1 }));

    const gaps = await new SkillEvolution(db).identifySkillGaps();

    const gap = gaps.find((g) => g.issue === 'low-satisfaction');
    expect(gap).toBeDefined();
    expect(gap!.threshold).toBe(SKILL_SATISFACTION_THRESHOLD);
  });

  it('执行时间过长时识别为缺口', async () => {
    const { db } = makeDb(rows(10, { success: 1, user_satisfaction: 0.9, execution_time: SKILL_EXECUTION_TIME_THRESHOLD + 20000 }));

    const gaps = await new SkillEvolution(db).identifySkillGaps();

    expect(gaps.some((g) => g.issue === 'high-execution-time')).toBe(true);
  });

  it('健康技能不产生缺口', async () => {
    const { db } = makeDb(rows(20, { success: 1, user_satisfaction: 0.95, execution_time: 800 }));

    expect(await new SkillEvolution(db).identifySkillGaps()).toEqual([]);
  });

  it('缺口按优先级降序排序', async () => {
    const { db } = makeDb([
      ...rows(10, { skill_name: 'mild', success: 0, user_satisfaction: 0.9 }),
      ...rows(40, { skill_name: 'severe', success: 0, user_satisfaction: 0.9 }),
    ]);

    const gaps = await new SkillEvolution(db).identifySkillGaps();

    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i - 1].priority).toBeGreaterThanOrEqual(gaps[i].priority);
    }
    expect(gaps[0].skillName).toBe('severe');
  });

  it('同一技能可同时命中多个缺口', async () => {
    const { db } = makeDb(rows(10, { success: 0, user_satisfaction: 0.1, execution_time: 60000 }));

    const gaps = await new SkillEvolution(db).identifySkillGaps();

    expect(gaps).toHaveLength(3);
  });
});

describe('generateImprovementGoals 改进目标', () => {
  it('无缺口时返回空数组', async () => {
    const { db } = makeDb([row({ success: 1, user_satisfaction: 0.95, execution_time: 500 })]);

    expect(await new SkillEvolution(db).generateImprovementGoals()).toEqual([]);
  });

  it('最多返回 3 个目标', async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      Array.from({ length: 10 }, () => row({ skill_name: `skill-${i}`, success: 0, user_satisfaction: 0.1 }))
    ).flat();
    const { db } = makeDb(many);

    const goals = await new SkillEvolution(db).generateImprovementGoals();

    expect(goals.length).toBeLessThanOrEqual(3);
  });

  it('目标类型为 skill-enhancement 并携带诊断元数据', async () => {
    const { db } = makeDb(Array.from({ length: 10 }, () => row({ success: 0, user_satisfaction: 0.9 })));

    const [goal] = await new SkillEvolution(db).generateImprovementGoals();

    expect(goal.type).toBe('skill-enhancement');
    expect(goal.relatedSkill).toBe('search');
    expect(goal.metadata.issue).toBe('low-success-rate');
    expect(goal.metadata.threshold).toBe(SKILL_SUCCESS_RATE_THRESHOLD);
  });

  it('目标描述包含技能名和问题说明', async () => {
    const { db } = makeDb(Array.from({ length: 10 }, () => row({ success: 0, user_satisfaction: 0.9 })));

    const [goal] = await new SkillEvolution(db).generateImprovementGoals();

    expect(goal.description).toContain('search');
    expect(goal.description).toContain('成功率');
  });
});

describe('getReport 报告', () => {
  it('汇总技能数、使用次数与平均指标', async () => {
    const { db } = makeDb([
      row({ skill_name: 'a', success: 1, user_satisfaction: 1.0 }),
      row({ skill_name: 'b', success: 0, user_satisfaction: 0.0 }),
    ]);

    const report = await new SkillEvolution(db).getReport();

    expect(report.totalSkills).toBe(2);
    expect(report.totalUsages).toBe(2);
    expect(report.avgSuccessRate).toBeCloseTo(0.5);
    expect(report.avgSatisfaction).toBeCloseTo(0.5);
  });

  it('查询失败时返回零值报告而非抛错', async () => {
    const db: DatabaseClient = {
      execute: vi.fn(),
      query: vi.fn(async () => {
        throw new Error('boom');
      }),
    };

    const report = await new SkillEvolution(db).getReport();

    expect(report.totalSkills).toBe(0);
    expect(report.gapCount).toBe(0);
    expect(report.topGaps).toEqual([]);
  });
});
