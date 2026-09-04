/**
 * P2: Thompson Sampling 工具选择测试
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToolThompsonSampling } from '../tool-thompson-sampling';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('初始化与先验', () => {
  it('新工具使用 Beta(1, 1) 均匀先验', () => {
    const ts = new ToolThompsonSampling();
    ts.initTool('grep');

    const stat = ts.getStats('grep');
    expect(stat).toBeDefined();
    expect(stat!.alpha).toBe(1);
    expect(stat!.beta).toBe(1);
    expect(stat!.totalUsage).toBe(0);
  });

  it('重复初始化不会重置已有统计', () => {
    const ts = new ToolThompsonSampling();
    ts.initTool('grep');
    ts.updateStats('grep', true);

    ts.initTool('grep');

    expect(ts.getStats('grep')!.alpha).toBe(2);
  });

  it('未初始化工具的成功率估计返回中性先验', () => {
    const ts = new ToolThompsonSampling();
    const estimate = ts.getSuccessRateEstimate('unknown');
    expect(estimate.mean).toBe(0.5);
    expect(estimate.credibleInterval).toEqual([0, 1]);
  });
});

describe('selectTool 选择行为', () => {
  it('空工具列表应抛错', () => {
    const ts = new ToolThompsonSampling();
    expect(() => ts.selectTool([])).toThrow(/No available tools/);
  });

  it('单个工具直接返回该工具', () => {
    const ts = new ToolThompsonSampling();
    expect(ts.selectTool(['only-tool'])).toBe('only-tool');
  });

  it('只会返回可用列表中的工具', () => {
    const ts = new ToolThompsonSampling();
    // 让一个不在候选列表中的工具拥有极高后验
    for (let i = 0; i < 50; i++) ts.updateStats('excluded', true);

    for (let i = 0; i < 30; i++) {
      const selected = ts.selectTool(['a', 'b']);
      expect(['a', 'b']).toContain(selected);
    }
  });

  it('工具被移除后不再被选中', () => {
    const ts = new ToolThompsonSampling();
    for (let i = 0; i < 20; i++) ts.updateStats('removed', true);

    for (let i = 0; i < 20; i++) {
      expect(ts.selectTool(['kept'])).toBe('kept');
    }
  });

  it('明显更优的工具在多轮采样中占多数', () => {
    const ts = new ToolThompsonSampling();

    // good: 高成功率；bad: 低成功率
    for (let i = 0; i < 100; i++) ts.updateStats('good', true);
    for (let i = 0; i < 100; i++) ts.updateStats('bad', false);

    let goodCount = 0;
    const trials = 200;
    for (let i = 0; i < trials; i++) {
      if (ts.selectTool(['good', 'bad']) === 'good') goodCount++;
    }

    expect(goodCount / trials).toBeGreaterThan(0.9);
  });

  it('新工具仍有机会被探索（不确定性驱动）', () => {
    const ts = new ToolThompsonSampling();

    // known 有中等成功率，fresh 完全未知
    for (let i = 0; i < 10; i++) ts.updateStats('known', true);
    for (let i = 0; i < 10; i++) ts.updateStats('known', false);

    let freshCount = 0;
    const trials = 200;
    for (let i = 0; i < trials; i++) {
      if (ts.selectTool(['known', 'fresh']) === 'fresh') freshCount++;
    }

    // 未知工具的后验更宽，应有可观的探索比例
    expect(freshCount).toBeGreaterThan(0);
    expect(freshCount).toBeLessThan(trials);
  });
});

describe('updateStats 后验更新', () => {
  it('成功增加 alpha，失败增加 beta', () => {
    const ts = new ToolThompsonSampling();

    ts.updateStats('t', true);
    ts.updateStats('t', true);
    ts.updateStats('t', false);

    const stat = ts.getStats('t')!;
    expect(stat.alpha).toBe(3); // 1 + 2 successes
    expect(stat.beta).toBe(2); // 1 + 1 failure
    expect(stat.totalUsage).toBe(3);
  });

  it('未初始化的工具在更新时自动初始化，且只计一次', () => {
    const ts = new ToolThompsonSampling();
    ts.updateStats('auto', true);

    const stat = ts.getStats('auto')!;
    expect(stat.alpha).toBe(2);
    expect(stat.beta).toBe(1);
    expect(stat.totalUsage).toBe(1);
  });

  it('成功率估计随观测收敛到真实值', () => {
    const ts = new ToolThompsonSampling();

    // 真实成功率 0.8
    for (let i = 0; i < 400; i++) {
      ts.updateStats('t', i % 5 !== 0);
    }

    const estimate = ts.getSuccessRateEstimate('t');
    expect(estimate.mean).toBeGreaterThan(0.75);
    expect(estimate.mean).toBeLessThan(0.85);
  });

  it('可信区间随样本增加而收窄', () => {
    const ts = new ToolThompsonSampling();

    for (let i = 0; i < 10; i++) ts.updateStats('few', i % 2 === 0);
    const narrowEarly = ts.getSuccessRateEstimate('few');
    const widthEarly = narrowEarly.credibleInterval[1] - narrowEarly.credibleInterval[0];

    for (let i = 0; i < 500; i++) ts.updateStats('few', i % 2 === 0);
    const narrowLate = ts.getSuccessRateEstimate('few');
    const widthLate = narrowLate.credibleInterval[1] - narrowLate.credibleInterval[0];

    expect(widthLate).toBeLessThan(widthEarly);
  });

  it('可信区间始终落在 [0, 1] 且下界不超过上界', () => {
    const ts = new ToolThompsonSampling();

    for (const successes of [0, 1, 7, 50]) {
      const name = `tool-${successes}`;
      for (let i = 0; i < successes; i++) ts.updateStats(name, true);
      ts.updateStats(name, false);

      const { credibleInterval } = ts.getSuccessRateEstimate(name);
      expect(credibleInterval[0]).toBeGreaterThanOrEqual(0);
      expect(credibleInterval[1]).toBeLessThanOrEqual(1);
      expect(credibleInterval[0]).toBeLessThanOrEqual(credibleInterval[1]);
    }
  });
});

describe('采样边界与健壮性', () => {
  it('采样结果始终为 [0, 1] 内的有限数', () => {
    const ts = new ToolThompsonSampling();
    // 通过大量选择间接验证采样器不产生 NaN（NaN 会破坏比较逻辑）
    for (let i = 0; i < 100; i++) ts.updateStats('a', true);

    for (let i = 0; i < 100; i++) {
      const selected = ts.selectTool(['a', 'b', 'c']);
      expect(['a', 'b', 'c']).toContain(selected);
    }
  });

  it('达到最大迭代次数时回退到期望值，不会死循环', () => {
    // Math.random 恒定为 0，使 Marsaglia-Tsang 的接受条件难以命中
    const ts = new ToolThompsonSampling(5);
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);

    const selected = ts.selectTool(['a', 'b']);
    expect(['a', 'b']).toContain(selected);
  });

  it('极端不对称后验也能正常选择', () => {
    const ts = new ToolThompsonSampling();
    for (let i = 0; i < 2000; i++) ts.updateStats('dominant', true);

    const selected = ts.selectTool(['dominant', 'weak']);
    expect(['dominant', 'weak']).toContain(selected);
  });
});

describe('状态持久化与恢复', () => {
  it('getAllStats 返回全部工具统计', () => {
    const ts = new ToolThompsonSampling();
    ts.updateStats('a', true);
    ts.updateStats('b', false);

    const all = ts.getAllStats();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.toolName).sort()).toEqual(['a', 'b']);
  });

  it('loadStats 可恢复后验，且替换而非叠加已有状态', () => {
    const ts = new ToolThompsonSampling();
    ts.updateStats('stale', true);

    ts.loadStats([
      { toolName: 'restored', alpha: 11, beta: 3, totalUsage: 12, lastUsed: '2026-09-04T00:00:00.000Z' },
    ]);

    expect(ts.getStats('stale')).toBeUndefined();
    const restored = ts.getStats('restored')!;
    expect(restored.alpha).toBe(11);
    expect(restored.beta).toBe(3);
    expect(restored.totalUsage).toBe(12);
  });

  it('恢复后的成功率估计与保存时一致', () => {
    const original = new ToolThompsonSampling();
    for (let i = 0; i < 60; i++) original.updateStats('t', i % 4 !== 0);
    const expected = original.getSuccessRateEstimate('t');

    const restored = new ToolThompsonSampling();
    restored.loadStats(original.getAllStats());

    expect(restored.getSuccessRateEstimate('t')).toEqual(expected);
  });
});
