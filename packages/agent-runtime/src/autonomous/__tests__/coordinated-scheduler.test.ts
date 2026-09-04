/**
 * P2: 协同探索调度器测试
 */

import { describe, it, expect } from 'vitest';
import {
  CoordinatedScheduler,
  computeExplorationBudget,
  createInitialSchedulerState,
} from '../coordinated-scheduler';
import { EvolutionLayer, ExplorationMode } from '../types';
import {
  EXPLORATION_BUDGET_BASE,
  EXPLORATION_BUDGET_MAX,
  SATISFACTION_THRESHOLD,
} from '../config';

/** 固定随机源 */
const fixed = (value: number) => () => value;

/** 按序列返回的随机源 */
function sequence(values: number[]) {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('computeExplorationBudget 探索预算', () => {
  it('满意度达到阈值时使用基准预算', () => {
    expect(computeExplorationBudget(SATISFACTION_THRESHOLD)).toBe(EXPLORATION_BUDGET_BASE);
    expect(computeExplorationBudget(0.95)).toBe(EXPLORATION_BUDGET_BASE);
    expect(computeExplorationBudget(1)).toBe(EXPLORATION_BUDGET_BASE);
  });

  it('满意度为 0 时达到最大预算', () => {
    expect(computeExplorationBudget(0)).toBeCloseTo(EXPLORATION_BUDGET_MAX);
  });

  it('满意度越低预算越高（单调）', () => {
    const high = computeExplorationBudget(0.55);
    const mid = computeExplorationBudget(0.3);
    const low = computeExplorationBudget(0.1);

    expect(mid).toBeGreaterThan(high);
    expect(low).toBeGreaterThan(mid);
  });

  it('预算始终落在 [BASE, MAX]', () => {
    for (const s of [-1, 0, 0.2, 0.5, 0.8, 1, 2, NaN]) {
      const budget = computeExplorationBudget(s);
      expect(budget).toBeGreaterThanOrEqual(EXPLORATION_BUDGET_BASE);
      expect(budget).toBeLessThanOrEqual(EXPLORATION_BUDGET_MAX);
    }
  });
});

describe('createInitialSchedulerState', () => {
  it('四层优先级均分且无探索历史', () => {
    const state = createInitialSchedulerState();

    expect(state.recentExplorations).toHaveLength(0);
    expect(state.layerPriorities[EvolutionLayer.PROMPT]).toBeCloseTo(0.25);
    expect(state.layerPriorities[EvolutionLayer.TOOL]).toBeCloseTo(0.25);
  });
});

describe('decide 探索决策', () => {
  it('随机值大于预算时选择利用模式', () => {
    const scheduler = new CoordinatedScheduler({ random: fixed(0.99) });
    const decision = scheduler.decide();

    expect(decision.mode).toBe(ExplorationMode.EXPLOIT);
    expect(decision.layer).toBeNull();
    expect(decision.reason).toContain('exploiting');
  });

  it('随机值小于预算时选择探索模式，且只探索一层', () => {
    const scheduler = new CoordinatedScheduler({ random: fixed(0.0) });
    const decision = scheduler.decide();

    expect(decision.mode).not.toBe(ExplorationMode.EXPLOIT);
    expect(decision.layer).not.toBeNull();
  });

  it('探索模式与被选层严格对应', () => {
    const modeByLayer: Record<EvolutionLayer, ExplorationMode> = {
      [EvolutionLayer.PROMPT]: ExplorationMode.EXPLORE_PROMPT,
      [EvolutionLayer.MEMORY]: ExplorationMode.EXPLORE_MEMORY,
      [EvolutionLayer.SKILL]: ExplorationMode.EXPLORE_SKILL,
      [EvolutionLayer.TOOL]: ExplorationMode.EXPLORE_TOOL,
    };

    for (const layer of Object.keys(modeByLayer) as EvolutionLayer[]) {
      const scheduler = new CoordinatedScheduler({ random: fixed(0.0), enabledLayers: [layer] });
      const decision = scheduler.decide();

      expect(decision.layer).toBe(layer);
      expect(decision.mode).toBe(modeByLayer[layer]);
    }
  });

  it('决策包含可解释的原因和当次预算', () => {
    const scheduler = new CoordinatedScheduler({ random: fixed(0.0) });
    const decision = scheduler.decide();

    expect(decision.reason.length).toBeGreaterThan(0);
    expect(decision.explorationBudget).toBeGreaterThan(0);
  });

  it('全部层被禁用时回退到利用模式', () => {
    const scheduler = new CoordinatedScheduler({ random: fixed(0.0), enabledLayers: [] });
    const decision = scheduler.decide();

    expect(decision.mode).toBe(ExplorationMode.EXPLOIT);
    expect(decision.layer).toBeNull();
    expect(decision.reason).toContain('disabled');
  });

  it('被禁用的层不会被探索', () => {
    const scheduler = new CoordinatedScheduler({
      random: fixed(0.0),
      enabledLayers: [EvolutionLayer.PROMPT, EvolutionLayer.MEMORY],
    });
    scheduler.setLayerEnabled(EvolutionLayer.MEMORY, false);

    for (let i = 0; i < 10; i++) {
      const decision = scheduler.decide();
      expect(decision.layer).not.toBe(EvolutionLayer.MEMORY);
      if (decision.layer) scheduler.recordExploration(decision.layer, 0.5);
    }
  });

  it('探索比例大致符合预算（注入的随机序列）', () => {
    // 序列在 [0,1) 上均匀铺开，探索次数应接近 budget * trials
    const trials = 1000;
    const values = Array.from({ length: trials }, (_, i) => i / trials);
    const scheduler = new CoordinatedScheduler({ random: sequence(values) });

    let exploreCount = 0;
    for (let i = 0; i < trials; i++) {
      if (scheduler.decide().mode !== ExplorationMode.EXPLOIT) exploreCount++;
    }

    const expected = computeExplorationBudget(createInitialSchedulerState().globalSatisfaction);
    expect(exploreCount / trials).toBeCloseTo(expected, 1);
  });
});

describe('轮流探索', () => {
  it('优先探索从未探索过的层', () => {
    const scheduler = new CoordinatedScheduler({ random: fixed(0.0) });

    const explored = new Set<EvolutionLayer>();
    for (let i = 0; i < 4; i++) {
      const decision = scheduler.decide();
      expect(decision.layer).not.toBeNull();
      expect(explored.has(decision.layer!)).toBe(false);

      explored.add(decision.layer!);
      scheduler.recordExploration(decision.layer!, 0.5);
    }

    expect(explored.size).toBe(4);
  });

  it('所有层都探索过后继续轮流，不长期锁定单层', () => {
    const scheduler = new CoordinatedScheduler({ random: fixed(0.0) });

    const counts = new Map<EvolutionLayer, number>();
    for (let i = 0; i < 40; i++) {
      const decision = scheduler.decide();
      const layer = decision.layer!;
      counts.set(layer, (counts.get(layer) ?? 0) + 1);
      scheduler.recordExploration(layer, 0.6);
    }

    // 每层都应获得过探索机会
    expect(counts.size).toBe(4);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(0);
    }
  });
});

describe('recordExploration 与优先级更新', () => {
  it('探索历史被记录', () => {
    const scheduler = new CoordinatedScheduler();
    scheduler.recordExploration(EvolutionLayer.PROMPT, 0.8, '2026-09-04T00:00:00.000Z');

    const state = scheduler.getState();
    expect(state.recentExplorations).toHaveLength(1);
    expect(state.recentExplorations[0].layer).toBe(EvolutionLayer.PROMPT);
    expect(state.recentExplorations[0].satisfactionAfter).toBe(0.8);
  });

  it('探索历史长度受限，只保留最近记录', () => {
    const scheduler = new CoordinatedScheduler();
    for (let i = 0; i < 50; i++) {
      scheduler.recordExploration(EvolutionLayer.PROMPT, 0.5);
    }

    expect(scheduler.getState().recentExplorations.length).toBeLessThanOrEqual(20);
  });

  it('满意度越界值被裁剪到 [0, 1]', () => {
    const scheduler = new CoordinatedScheduler();
    scheduler.recordExploration(EvolutionLayer.TOOL, 5);
    scheduler.recordExploration(EvolutionLayer.TOOL, -3);

    const history = scheduler.getState().recentExplorations;
    expect(history[0].satisfactionAfter).toBe(1);
    expect(history[1].satisfactionAfter).toBe(0);
  });

  it('高满意度探索提升该层优先级', () => {
    const scheduler = new CoordinatedScheduler();
    const before = scheduler.getState().layerPriorities[EvolutionLayer.SKILL];

    for (let i = 0; i < 20; i++) {
      scheduler.recordExploration(EvolutionLayer.SKILL, 1.0);
    }

    expect(scheduler.getState().layerPriorities[EvolutionLayer.SKILL]).toBeGreaterThan(before);
  });

  it('低满意度探索降低该层优先级', () => {
    const scheduler = new CoordinatedScheduler();
    const before = scheduler.getState().layerPriorities[EvolutionLayer.SKILL];

    for (let i = 0; i < 20; i++) {
      scheduler.recordExploration(EvolutionLayer.SKILL, 0.0);
    }

    expect(scheduler.getState().layerPriorities[EvolutionLayer.SKILL]).toBeLessThan(before);
  });
});

describe('updatePrioritiesFromContribution', () => {
  it('高贡献层的优先级上升', () => {
    const scheduler = new CoordinatedScheduler();
    const before = scheduler.getState().layerPriorities[EvolutionLayer.MEMORY];

    for (let i = 0; i < 20; i++) {
      scheduler.updatePrioritiesFromContribution({ prompt: 0.1, memory: 0.7, skill: 0.1, tool: 0.1 });
    }

    const after = scheduler.getState().layerPriorities;
    expect(after[EvolutionLayer.MEMORY]).toBeGreaterThan(before);
    expect(after[EvolutionLayer.MEMORY]).toBeGreaterThan(after[EvolutionLayer.PROMPT]);
  });

  it('非有限贡献值被忽略，不污染优先级', () => {
    const scheduler = new CoordinatedScheduler();
    const before = scheduler.getState().layerPriorities[EvolutionLayer.PROMPT];

    scheduler.updatePrioritiesFromContribution({ prompt: NaN, memory: 0.5, skill: 0.3, tool: 0.2 });

    expect(scheduler.getState().layerPriorities[EvolutionLayer.PROMPT]).toBe(before);
  });

  it('优先级始终保持在 [0, 1]', () => {
    const scheduler = new CoordinatedScheduler();
    for (let i = 0; i < 50; i++) {
      scheduler.updatePrioritiesFromContribution({ prompt: 10, memory: -5, skill: 0.5, tool: 0.5 });
    }

    for (const value of Object.values(scheduler.getState().layerPriorities)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('全局满意度更新', () => {
  it('EMA 向新观测靠近', () => {
    const scheduler = new CoordinatedScheduler();
    const before = scheduler.getState().globalSatisfaction;

    for (let i = 0; i < 50; i++) scheduler.updateGlobalSatisfaction(1.0);

    expect(scheduler.getState().globalSatisfaction).toBeGreaterThan(before);
  });

  it('非有限值被忽略', () => {
    const scheduler = new CoordinatedScheduler();
    const before = scheduler.getState().globalSatisfaction;

    scheduler.updateGlobalSatisfaction(NaN);

    expect(scheduler.getState().globalSatisfaction).toBe(before);
  });

  it('满意度下降后探索预算上升', () => {
    const scheduler = new CoordinatedScheduler({ random: fixed(0.99) });
    const initialBudget = scheduler.decide().explorationBudget;

    for (let i = 0; i < 100; i++) scheduler.updateGlobalSatisfaction(0.0);

    expect(scheduler.decide().explorationBudget).toBeGreaterThan(initialBudget);
  });
});

describe('状态快照与恢复', () => {
  it('getState 返回深拷贝，外部修改不影响调度器', () => {
    const scheduler = new CoordinatedScheduler();
    scheduler.recordExploration(EvolutionLayer.PROMPT, 0.7);

    const snapshot = scheduler.getState();
    snapshot.recentExplorations.push({
      layer: EvolutionLayer.TOOL,
      timestamp: 'x',
      satisfactionAfter: 0,
    });
    snapshot.layerPriorities[EvolutionLayer.PROMPT] = 999;

    expect(scheduler.getState().recentExplorations).toHaveLength(1);
    expect(scheduler.getState().layerPriorities[EvolutionLayer.PROMPT]).not.toBe(999);
  });

  it('restoreState 完整恢复调度状态', () => {
    const original = new CoordinatedScheduler();
    original.recordExploration(EvolutionLayer.MEMORY, 0.9);
    original.recordExploration(EvolutionLayer.SKILL, 0.4);
    original.updateGlobalSatisfaction(0.35);

    const saved = original.getState();

    const restored = new CoordinatedScheduler();
    restored.restoreState(saved);

    expect(restored.getState()).toEqual(saved);
  });

  it('恢复后的决策与原调度器一致（相同随机源）', () => {
    const original = new CoordinatedScheduler({ random: fixed(0.0) });
    original.recordExploration(EvolutionLayer.PROMPT, 0.8);
    original.recordExploration(EvolutionLayer.MEMORY, 0.2);

    const restored = new CoordinatedScheduler({ random: fixed(0.0), state: original.getState() });

    expect(restored.decide().layer).toBe(original.decide().layer);
  });
});
