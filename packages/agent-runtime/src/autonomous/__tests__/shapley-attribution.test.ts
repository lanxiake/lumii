/**
 * P2: Shapley Value 贡献归因测试
 */

import { describe, it, expect } from 'vitest';
import {
  ATTRIBUTION_LAYERS,
  computeMarginalContribution,
  computeShapleyContribution,
  uniformContribution,
  isContributionNormalized,
} from '../shapley-attribution';
import { EvolutionLayer } from '../types';
import type { LayerObservation } from '../shapley-attribution';

function obs(layer: EvolutionLayer, score?: number, sampleCount = 10): LayerObservation {
  return { layer, score, sampleCount };
}

describe('ATTRIBUTION_LAYERS', () => {
  it('包含四层且顺序固定', () => {
    expect(ATTRIBUTION_LAYERS).toEqual([
      EvolutionLayer.PROMPT,
      EvolutionLayer.MEMORY,
      EvolutionLayer.SKILL,
      EvolutionLayer.TOOL,
    ]);
  });
});

describe('uniformContribution', () => {
  it('四层均分且总和为 1', () => {
    const c = uniformContribution();
    expect(c.prompt).toBeCloseTo(0.25);
    expect(c.memory).toBeCloseTo(0.25);
    expect(c.skill).toBeCloseTo(0.25);
    expect(c.tool).toBeCloseTo(0.25);
    expect(isContributionNormalized(c)).toBe(true);
  });
});

describe('computeMarginalContribution 边际贡献近似', () => {
  it('无有效观测时退化为均匀分配', () => {
    expect(computeMarginalContribution([])).toEqual(uniformContribution());
  });

  it('所有层得分相同时在参与层间均分', () => {
    const c = computeMarginalContribution([
      obs(EvolutionLayer.PROMPT, 0.7),
      obs(EvolutionLayer.MEMORY, 0.7),
      obs(EvolutionLayer.SKILL, 0.7),
      obs(EvolutionLayer.TOOL, 0.7),
    ]);

    expect(c.prompt).toBeCloseTo(0.25);
    expect(c.tool).toBeCloseTo(0.25);
    expect(isContributionNormalized(c)).toBe(true);
  });

  it('高于基线的层获得更高贡献', () => {
    const c = computeMarginalContribution([
      obs(EvolutionLayer.PROMPT, 0.9),
      obs(EvolutionLayer.MEMORY, 0.5),
      obs(EvolutionLayer.SKILL, 0.5),
      obs(EvolutionLayer.TOOL, 0.5),
    ]);

    expect(c.prompt).toBeGreaterThan(c.memory);
    expect(isContributionNormalized(c)).toBe(true);
  });

  it('低于基线的层贡献被截断为 0（负贡献不参与正向归因）', () => {
    const c = computeMarginalContribution([
      obs(EvolutionLayer.PROMPT, 0.9),
      obs(EvolutionLayer.MEMORY, 0.1),
    ]);

    expect(c.memory).toBe(0);
    expect(c.prompt).toBeCloseTo(1);
  });

  it('缺失观测的层贡献为 0', () => {
    const c = computeMarginalContribution([
      obs(EvolutionLayer.PROMPT, 0.9),
      obs(EvolutionLayer.MEMORY, 0.3),
      obs(EvolutionLayer.SKILL, undefined),
    ]);

    expect(c.skill).toBe(0);
    expect(c.tool).toBe(0);
  });

  it('越界或非有限得分被忽略', () => {
    const c = computeMarginalContribution([
      obs(EvolutionLayer.PROMPT, 1.5),
      obs(EvolutionLayer.MEMORY, NaN),
      obs(EvolutionLayer.SKILL, -0.2),
    ]);

    // 全部无效 → 均匀分配
    expect(c).toEqual(uniformContribution());
  });

  it('贡献度总和始终归一化到 1', () => {
    const cases: LayerObservation[][] = [
      [obs(EvolutionLayer.PROMPT, 1), obs(EvolutionLayer.MEMORY, 0)],
      [obs(EvolutionLayer.PROMPT, 0.2), obs(EvolutionLayer.TOOL, 0.8)],
      [obs(EvolutionLayer.SKILL, 0.55), obs(EvolutionLayer.TOOL, 0.45)],
    ];

    for (const observations of cases) {
      expect(isContributionNormalized(computeMarginalContribution(observations))).toBe(true);
    }
  });
});

describe('computeShapleyContribution 完整 Shapley 估计', () => {
  const observations = ATTRIBUTION_LAYERS.map((l) => obs(l, 0.5));

  it('只有一层有贡献时该层获得全部归因', () => {
    // 特征函数：只有包含 PROMPT 的组合才有价值
    const valueFn = (subset: EvolutionLayer[]) => (subset.includes(EvolutionLayer.PROMPT) ? 1 : 0);

    const c = computeShapleyContribution(valueFn, observations);

    expect(c.prompt).toBeCloseTo(1);
    expect(c.memory).toBeCloseTo(0);
    expect(c.skill).toBeCloseTo(0);
    expect(c.tool).toBeCloseTo(0);
  });

  it('各层等价时贡献均分', () => {
    // 价值只取决于子集大小
    const valueFn = (subset: EvolutionLayer[]) => subset.length / 4;

    const c = computeShapleyContribution(valueFn, observations);

    expect(c.prompt).toBeCloseTo(0.25);
    expect(c.memory).toBeCloseTo(0.25);
    expect(c.skill).toBeCloseTo(0.25);
    expect(c.tool).toBeCloseTo(0.25);
  });

  it('零贡献特征函数退化为均匀分配', () => {
    const c = computeShapleyContribution(() => 0, observations);
    expect(isContributionNormalized(c)).toBe(true);
    expect(c.prompt).toBeCloseTo(0.25);
  });

  it('组合预算不足时回退到边际近似', () => {
    const marginalObservations = [obs(EvolutionLayer.PROMPT, 0.9), obs(EvolutionLayer.MEMORY, 0.1)];

    // maxCombinations = 4 < 2^4，触发回退
    const c = computeShapleyContribution(() => 1, marginalObservations, 4);

    expect(c).toEqual(computeMarginalContribution(marginalObservations));
  });

  it('特征函数抛错时按 0 处理，不影响归一化', () => {
    const valueFn = (subset: EvolutionLayer[]) => {
      if (subset.length === 2) throw new Error('boom');
      return subset.includes(EvolutionLayer.TOOL) ? 1 : 0;
    };

    const c = computeShapleyContribution(valueFn, observations);
    expect(isContributionNormalized(c)).toBe(true);
  });

  it('特征函数返回越界值时被截断到 [0, 1]', () => {
    const valueFn = (subset: EvolutionLayer[]) => (subset.includes(EvolutionLayer.SKILL) ? 100 : -100);

    const c = computeShapleyContribution(valueFn, observations);
    expect(c.skill).toBeCloseTo(1);
    expect(isContributionNormalized(c)).toBe(true);
  });

  it('结果可复现（相同特征函数产生相同归因）', () => {
    const valueFn = (subset: EvolutionLayer[]) => subset.length * 0.2;
    const a = computeShapleyContribution(valueFn, observations);
    const b = computeShapleyContribution(valueFn, observations);
    expect(a).toEqual(b);
  });
});

describe('isContributionNormalized', () => {
  it('总和偏离 1 时返回 false', () => {
    expect(isContributionNormalized({ prompt: 0.5, memory: 0.1, skill: 0.1, tool: 0.1 })).toBe(false);
  });

  it('总和为 1 时返回 true', () => {
    expect(isContributionNormalized({ prompt: 0.4, memory: 0.3, skill: 0.2, tool: 0.1 })).toBe(true);
  });
});
