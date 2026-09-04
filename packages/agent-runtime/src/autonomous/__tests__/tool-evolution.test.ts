/**
 * P2: 工具选择进化器测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolEvolution } from '../tool-evolution';
import type { DatabaseClient } from '../meta-cognition-engine';
import type { ToolUsageFeedback } from '../types';

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

function makeFeedback(overrides: Partial<ToolUsageFeedback> = {}): ToolUsageFeedback {
  return {
    toolName: 'grep',
    sessionId: 'session-1',
    context: { taskType: 'search', difficulty: 0.5 },
    result: 'success',
    executionTime: 800,
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

describe('selectTool 工具选择', () => {
  it('空工具列表抛错', async () => {
    const { db } = makeDb();
    await expect(new ToolEvolution(db).selectTool([], { taskType: 'x', difficulty: 0.5 })).rejects.toThrow();
  });

  it('单个工具直接返回', async () => {
    const { db } = makeDb();
    const selected = await new ToolEvolution(db).selectTool(['only'], { taskType: 'x', difficulty: 0.5 });
    expect(selected).toBe('only');
  });

  it('只返回候选列表中的工具（不越过白名单）', async () => {
    const { db } = makeDb();
    const evolution = new ToolEvolution(db);

    // 让一个列表外的工具积累大量成功
    for (let i = 0; i < 30; i++) {
      await evolution.recordFeedback(makeFeedback({ toolName: 'forbidden' }));
    }

    for (let i = 0; i < 20; i++) {
      const selected = await evolution.selectTool(['allowed-a', 'allowed-b'], { taskType: 'search', difficulty: 0.5 });
      expect(['allowed-a', 'allowed-b']).toContain(selected);
    }
  });

  it('高成功率工具在同上下文中占多数', async () => {
    const { db } = makeDb();
    const evolution = new ToolEvolution(db);
    const context = { taskType: 'search', difficulty: 0.5 };

    for (let i = 0; i < 60; i++) {
      await evolution.recordFeedback(makeFeedback({ toolName: 'good', result: 'success', context }));
      await evolution.recordFeedback(makeFeedback({ toolName: 'bad', result: 'failure', context }));
    }

    let goodCount = 0;
    for (let i = 0; i < 100; i++) {
      if ((await evolution.selectTool(['good', 'bad'], context)) === 'good') goodCount++;
    }

    expect(goodCount).toBeGreaterThan(85);
  });

  it('不同任务类型的统计相互隔离', async () => {
    const { db } = makeDb();
    const evolution = new ToolEvolution(db);

    // 在 search 场景中 toolA 表现极好
    for (let i = 0; i < 60; i++) {
      await evolution.recordFeedback(
        makeFeedback({ toolName: 'toolA', result: 'success', context: { taskType: 'search', difficulty: 0.5 } })
      );
      await evolution.recordFeedback(
        makeFeedback({ toolName: 'toolB', result: 'failure', context: { taskType: 'search', difficulty: 0.5 } })
      );
    }

    const report = await evolution.getReport();
    const toolA = report.toolStats.find((s) => s.tool === 'toolA')!;

    // 统计只归属于 search 上下文
    expect(toolA.contexts).toEqual(['search:medium']);
  });

  it('难度被离散化为 low/medium/high 三档上下文', async () => {
    const { db } = makeDb();
    const evolution = new ToolEvolution(db);

    for (const difficulty of [0.1, 0.5, 0.9]) {
      await evolution.recordFeedback(makeFeedback({ toolName: 't', context: { taskType: 'task', difficulty } }));
    }

    const report = await evolution.getReport();
    expect(report.toolStats[0].contexts.sort()).toEqual(['task:high', 'task:low', 'task:medium']);
  });
});

describe('recordFeedback 反馈记录', () => {
  it('合法反馈被持久化', async () => {
    const { db, executed } = makeDb();

    await new ToolEvolution(db).recordFeedback(makeFeedback());

    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(executed[0].params).toContain('grep');
    expect(executed[0].params).toContain('success');
  });

  it('难度越界时不写库', async () => {
    const { db } = makeDb();

    await new ToolEvolution(db).recordFeedback(makeFeedback({ context: { taskType: 'x', difficulty: 1.5 } }));

    expect(db.execute).not.toHaveBeenCalled();
  });

  it('负执行时间时不写库', async () => {
    const { db } = makeDb();

    await new ToolEvolution(db).recordFeedback(makeFeedback({ executionTime: -1 }));

    expect(db.execute).not.toHaveBeenCalled();
  });

  it('非法结果值时不写库', async () => {
    const { db } = makeDb();

    await new ToolEvolution(db).recordFeedback(makeFeedback({ result: 'timeout' as any }));

    expect(db.execute).not.toHaveBeenCalled();
  });

  it('写库失败不抛出，避免阻断主流程', async () => {
    const db: DatabaseClient = {
      execute: vi.fn(async () => {
        throw new Error('db down');
      }),
      query: vi.fn(async () => [] as any),
    };

    await expect(new ToolEvolution(db).recordFeedback(makeFeedback())).resolves.toBeUndefined();
  });

  it('失败结果增加 beta，降低成功率估计', async () => {
    const { db } = makeDb();
    const evolution = new ToolEvolution(db);
    const context = { taskType: 'search', difficulty: 0.5 };

    for (let i = 0; i < 20; i++) {
      await evolution.recordFeedback(makeFeedback({ toolName: 'flaky', result: 'failure', context }));
    }

    const report = await evolution.getReport();
    expect(report.toolStats.find((s) => s.tool === 'flaky')!.successRate).toBeLessThan(0.2);
  });
});

describe('getReport 报告', () => {
  it('无数据时返回空统计', async () => {
    const { db } = makeDb();
    expect((await new ToolEvolution(db).getReport()).toolStats).toEqual([]);
  });

  it('成功率与可信区间落在 [0, 1]', async () => {
    const { db } = makeDb();
    const evolution = new ToolEvolution(db);

    for (let i = 0; i < 25; i++) {
      await evolution.recordFeedback(makeFeedback({ result: i % 3 === 0 ? 'failure' : 'success' }));
    }

    const [stats] = (await evolution.getReport()).toolStats;
    expect(stats.successRate).toBeGreaterThanOrEqual(0);
    expect(stats.successRate).toBeLessThanOrEqual(1);
    expect(stats.confidence[0]).toBeGreaterThanOrEqual(0);
    expect(stats.confidence[1]).toBeLessThanOrEqual(1);
    expect(stats.confidence[0]).toBeLessThanOrEqual(stats.confidence[1]);
  });

  it('累计使用次数正确', async () => {
    const { db } = makeDb();
    const evolution = new ToolEvolution(db);

    for (let i = 0; i < 7; i++) {
      await evolution.recordFeedback(makeFeedback());
    }

    expect((await evolution.getReport()).toolStats[0].totalUsage).toBe(7);
  });
});

describe('loadFromDatabase 启动恢复', () => {
  it('从历史反馈重建后验', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      tool_name: 'restored',
      task_type: 'search',
      difficulty: 0.5,
      result: i % 5 === 0 ? 'failure' : 'success',
    }));
    const { db } = makeDb(() => rows);
    const evolution = new ToolEvolution(db);

    await evolution.loadFromDatabase(30);

    const [stats] = (await evolution.getReport()).toolStats;
    expect(stats.tool).toBe('restored');
    expect(stats.totalUsage).toBe(40);
    expect(stats.successRate).toBeGreaterThan(0.7);
  });

  it('重复加载不会重复计数（幂等）', async () => {
    const rows = Array.from({ length: 10 }, () => ({
      tool_name: 't',
      task_type: 'search',
      difficulty: 0.5,
      result: 'success',
    }));
    const { db } = makeDb(() => rows);
    const evolution = new ToolEvolution(db);

    await evolution.loadFromDatabase(30);
    await evolution.loadFromDatabase(30);
    await evolution.loadFromDatabase(30);

    expect((await evolution.getReport()).toolStats[0].totalUsage).toBe(10);
  });

  it('查询失败时不抛错', async () => {
    const db: DatabaseClient = {
      execute: vi.fn(),
      query: vi.fn(async () => {
        throw new Error('boom');
      }),
    };

    await expect(new ToolEvolution(db).loadFromDatabase(30)).resolves.toBeUndefined();
  });

  it('恢复后的成功率与写入历史一致', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      tool_name: 't',
      task_type: 'search',
      difficulty: 0.5,
      result: i < 80 ? 'success' : 'failure',
    }));
    const { db } = makeDb(() => rows);
    const evolution = new ToolEvolution(db);

    await evolution.loadFromDatabase(30);

    const rate = (await evolution.getReport()).toolStats[0].successRate;
    expect(rate).toBeGreaterThan(0.75);
    expect(rate).toBeLessThan(0.85);
  });
});
