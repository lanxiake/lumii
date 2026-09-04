/**
 * P2: 帕累托前沿测试
 */

import { describe, it, expect } from 'vitest';
import { ParetoFrontier, dominates, computeConfigHash, OBJECTIVE_DIRECTIONS } from '../pareto-frontier';
import type { LayerConfigs, OptimizationObjectives } from '../types';

function makeConfig(overrides: Partial<LayerConfigs> = {}): LayerConfigs {
  return {
    promptVariantId: 'p1',
    memoryWeightsVersion: 'v1',
    skillStrategy: 's1',
    toolStrategy: 't1',
    ...overrides,
  };
}

function makeObjectives(overrides: Partial<OptimizationObjectives> = {}): OptimizationObjectives {
  return {
    userSatisfaction: 0.7,
    responseTime: 5000,
    tokenCost: 3000,
    consistencyScore: 0.8,
    ...overrides,
  };
}

describe('OBJECTIVE_DIRECTIONS 目标方向', () => {
  it('满意度和一致性越大越好，时间和成本越小越好', () => {
    expect(OBJECTIVE_DIRECTIONS.userSatisfaction).toBe('max');
    expect(OBJECTIVE_DIRECTIONS.consistencyScore).toBe('max');
    expect(OBJECTIVE_DIRECTIONS.responseTime).toBe('min');
    expect(OBJECTIVE_DIRECTIONS.tokenCost).toBe('min');
  });
});

describe('dominates 支配关系', () => {
  it('全面更优构成支配', () => {
    const better = makeObjectives({ userSatisfaction: 0.9, responseTime: 1000, tokenCost: 1000, consistencyScore: 0.9 });
    const worse = makeObjectives({ userSatisfaction: 0.5, responseTime: 9000, tokenCost: 9000, consistencyScore: 0.5 });

    expect(dominates(better, worse)).toBe(true);
    expect(dominates(worse, better)).toBe(false);
  });

  it('完全相同的指标互不支配', () => {
    const a = makeObjectives();
    expect(dominates(a, { ...a })).toBe(false);
  });

  it('互有优劣时互不支配（真正的权衡）', () => {
    const fast = makeObjectives({ userSatisfaction: 0.6, responseTime: 1000 });
    const accurate = makeObjectives({ userSatisfaction: 0.9, responseTime: 20000 });

    expect(dominates(fast, accurate)).toBe(false);
    expect(dominates(accurate, fast)).toBe(false);
  });

  it('其余持平且单项更优构成支配', () => {
    const base = makeObjectives();
    const slightlyBetter = makeObjectives({ tokenCost: base.tokenCost - 1 });

    expect(dominates(slightlyBetter, base)).toBe(true);
  });

  it('min 方向的目标数值更小才更优', () => {
    const cheap = makeObjectives({ tokenCost: 100 });
    const expensive = makeObjectives({ tokenCost: 10000 });

    expect(dominates(cheap, expensive)).toBe(true);
    expect(dominates(expensive, cheap)).toBe(false);
  });

  it('指标异常（NaN/Infinity）时保守判定为不支配', () => {
    const good = makeObjectives({ userSatisfaction: 0.99 });
    const broken = makeObjectives({ userSatisfaction: NaN });

    expect(dominates(good, broken)).toBe(false);
    expect(dominates(broken, good)).toBe(false);
  });
});

describe('computeConfigHash', () => {
  it('相同配置产生相同哈希', () => {
    expect(computeConfigHash(makeConfig())).toBe(computeConfigHash(makeConfig()));
  });

  it('不同配置产生不同哈希', () => {
    expect(computeConfigHash(makeConfig())).not.toBe(computeConfigHash(makeConfig({ promptVariantId: 'p2' })));
  });

  it('哈希与字段顺序无关（只取决于值）', () => {
    const a: LayerConfigs = { promptVariantId: 'p', memoryWeightsVersion: 'm', skillStrategy: 's', toolStrategy: 't' };
    const b: LayerConfigs = { toolStrategy: 't', skillStrategy: 's', memoryWeightsVersion: 'm', promptVariantId: 'p' };

    expect(computeConfigHash(a)).toBe(computeConfigHash(b));
  });
});

describe('add 前沿更新', () => {
  it('空前沿接受第一个配置', () => {
    const frontier = new ParetoFrontier();
    expect(frontier.add(makeConfig(), makeObjectives())).toBe(true);
    expect(frontier.size()).toBe(1);
  });

  it('被支配的配置不进入前沿', () => {
    const frontier = new ParetoFrontier();
    frontier.add(makeConfig({ promptVariantId: 'good' }), makeObjectives({ userSatisfaction: 0.9, responseTime: 1000, tokenCost: 1000, consistencyScore: 0.9 }));

    const accepted = frontier.add(
      makeConfig({ promptVariantId: 'bad' }),
      makeObjectives({ userSatisfaction: 0.4, responseTime: 9000, tokenCost: 9000, consistencyScore: 0.4 })
    );

    expect(accepted).toBe(false);
    expect(frontier.size()).toBe(1);
  });

  it('新配置支配旧配置时旧配置被移除', () => {
    const frontier = new ParetoFrontier();
    frontier.add(makeConfig({ promptVariantId: 'old' }), makeObjectives({ userSatisfaction: 0.5, responseTime: 9000, tokenCost: 9000, consistencyScore: 0.5 }));
    frontier.add(makeConfig({ promptVariantId: 'new' }), makeObjectives({ userSatisfaction: 0.9, responseTime: 1000, tokenCost: 1000, consistencyScore: 0.9 }));

    expect(frontier.size()).toBe(1);
    expect(frontier.getAll()[0].config.promptVariantId).toBe('new');
  });

  it('互不支配的配置共存于前沿', () => {
    const frontier = new ParetoFrontier();
    frontier.add(makeConfig({ promptVariantId: 'fast' }), makeObjectives({ userSatisfaction: 0.6, responseTime: 500 }));
    frontier.add(makeConfig({ promptVariantId: 'accurate' }), makeObjectives({ userSatisfaction: 0.95, responseTime: 25000 }));

    expect(frontier.size()).toBe(2);
  });

  it('前沿不含被支配的配置', () => {
    const frontier = new ParetoFrontier();
    frontier.add(makeConfig({ promptVariantId: 'a' }), makeObjectives({ userSatisfaction: 0.9, responseTime: 1000 }));
    frontier.add(makeConfig({ promptVariantId: 'b' }), makeObjectives({ userSatisfaction: 0.5, responseTime: 8000 }));
    frontier.add(makeConfig({ promptVariantId: 'c' }), makeObjectives({ userSatisfaction: 0.7, responseTime: 400 }));

    const all = frontier.getAll();
    for (const x of all) {
      for (const y of all) {
        if (x.configHash === y.configHash) continue;
        expect(dominates(y.objectives, x.objectives)).toBe(false);
      }
    }
  });

  it('重复添加相同配置只累加使用次数', () => {
    const frontier = new ParetoFrontier();
    frontier.add(makeConfig(), makeObjectives());
    frontier.add(makeConfig(), makeObjectives());
    frontier.add(makeConfig(), makeObjectives());

    expect(frontier.size()).toBe(1);
    expect(frontier.getAll()[0].usageCount).toBe(3);
  });

  it('容量上限被强制执行', () => {
    const frontier = new ParetoFrontier(5);

    // 生成一组互不支配的配置（满意度与响应时间此消彼长）
    for (let i = 0; i < 30; i++) {
      frontier.add(
        makeConfig({ promptVariantId: `v${i}` }),
        makeObjectives({ userSatisfaction: i / 30, responseTime: 30000 - i * 900 })
      );
    }

    expect(frontier.size()).toBeLessThanOrEqual(5);
  });

  it('淘汰策略是确定性的', () => {
    const build = () => {
      const f = new ParetoFrontier(4);
      for (let i = 0; i < 20; i++) {
        f.add(
          makeConfig({ promptVariantId: `v${i}` }),
          makeObjectives({ userSatisfaction: i / 20, responseTime: 20000 - i * 800 })
        );
      }
      return f.getAll().map((c) => c.configHash).sort();
    };

    expect(build()).toEqual(build());
  });
});

describe('select 按偏好选择', () => {
  it('空前沿返回 null', () => {
    expect(new ParetoFrontier().select()).toBeNull();
  });

  it('satisfaction 偏好选择满意度最高的配置', () => {
    const frontier = new ParetoFrontier();
    frontier.add(makeConfig({ promptVariantId: 'fast' }), makeObjectives({ userSatisfaction: 0.5, responseTime: 300, tokenCost: 500 }));
    frontier.add(makeConfig({ promptVariantId: 'best' }), makeObjectives({ userSatisfaction: 0.98, responseTime: 25000, tokenCost: 15000 }));

    expect(frontier.select('satisfaction')!.config.promptVariantId).toBe('best');
  });

  it('speed 偏好选择响应最快的配置', () => {
    const frontier = new ParetoFrontier();
    frontier.add(makeConfig({ promptVariantId: 'fast' }), makeObjectives({ userSatisfaction: 0.5, responseTime: 300, tokenCost: 8000 }));
    frontier.add(makeConfig({ promptVariantId: 'slow' }), makeObjectives({ userSatisfaction: 0.95, responseTime: 40000, tokenCost: 8000 }));

    expect(frontier.select('speed')!.config.promptVariantId).toBe('fast');
  });

  it('cost 偏好选择成本最低的配置', () => {
    const frontier = new ParetoFrontier();
    frontier.add(makeConfig({ promptVariantId: 'cheap' }), makeObjectives({ userSatisfaction: 0.5, tokenCost: 200, responseTime: 6000 }));
    frontier.add(makeConfig({ promptVariantId: 'pricey' }), makeObjectives({ userSatisfaction: 0.95, tokenCost: 19000, responseTime: 6000 }));

    expect(frontier.select('cost')!.config.promptVariantId).toBe('cheap');
  });

  it('balanced 为默认偏好', () => {
    const frontier = new ParetoFrontier();
    frontier.add(makeConfig(), makeObjectives());

    expect(frontier.select()).toEqual(frontier.select('balanced'));
  });

  it('选择结果可复现', () => {
    const frontier = new ParetoFrontier();
    frontier.add(makeConfig({ promptVariantId: 'a' }), makeObjectives({ userSatisfaction: 0.8, responseTime: 2000 }));
    frontier.add(makeConfig({ promptVariantId: 'b' }), makeObjectives({ userSatisfaction: 0.6, responseTime: 800 }));

    expect(frontier.select('balanced')!.configHash).toBe(frontier.select('balanced')!.configHash);
  });

  it('异常指标不会导致选择抛错', () => {
    const frontier = new ParetoFrontier();
    frontier.add(makeConfig({ promptVariantId: 'weird' }), makeObjectives({ userSatisfaction: NaN, responseTime: Infinity }));

    expect(() => frontier.select('balanced')).not.toThrow();
  });
});

describe('持久化与恢复', () => {
  it('load 恢复前沿内容', () => {
    const original = new ParetoFrontier();
    original.add(makeConfig({ promptVariantId: 'a' }), makeObjectives({ userSatisfaction: 0.9, responseTime: 1000 }));
    original.add(makeConfig({ promptVariantId: 'b' }), makeObjectives({ userSatisfaction: 0.6, responseTime: 300 }));

    const restored = new ParetoFrontier();
    restored.load(original.getAll());

    expect(restored.size()).toBe(original.size());
  });

  it('load 会过滤掉被支配的历史记录', () => {
    const frontier = new ParetoFrontier();
    frontier.load([
      {
        id: 'h1',
        configHash: 'h1',
        config: makeConfig({ promptVariantId: 'good' }),
        objectives: makeObjectives({ userSatisfaction: 0.95, responseTime: 500, tokenCost: 500, consistencyScore: 0.95 }),
        usageCount: 1,
        addedAt: '2026-09-04T00:00:00.000Z',
      },
      {
        id: 'h2',
        configHash: 'h2',
        config: makeConfig({ promptVariantId: 'dominated' }),
        objectives: makeObjectives({ userSatisfaction: 0.3, responseTime: 20000, tokenCost: 15000, consistencyScore: 0.3 }),
        usageCount: 1,
        addedAt: '2026-09-04T00:00:00.000Z',
      },
    ]);

    expect(frontier.size()).toBe(1);
    expect(frontier.getAll()[0].config.promptVariantId).toBe('good');
  });

  it('getAll 返回深拷贝，外部修改不影响前沿', () => {
    const frontier = new ParetoFrontier();
    frontier.add(makeConfig(), makeObjectives());

    const snapshot = frontier.getAll();
    snapshot[0].config.promptVariantId = 'mutated';

    expect(frontier.getAll()[0].config.promptVariantId).not.toBe('mutated');
  });

  it('clear 清空前沿', () => {
    const frontier = new ParetoFrontier();
    frontier.add(makeConfig(), makeObjectives());
    frontier.clear();

    expect(frontier.size()).toBe(0);
    expect(frontier.select()).toBeNull();
  });
});
