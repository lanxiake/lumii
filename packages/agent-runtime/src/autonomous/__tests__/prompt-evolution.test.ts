/**
 * Prompt 进化引擎测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  shouldExplore,
  computeUCB,
  selectVariant,
  updateVariantReward,
  PromptEvolutionEngine,
} from '../prompt-evolution';
import type { PromptVariant } from '../types';
import type { DatabaseClient } from '../meta-cognition-engine';
import { EPSILON, UCB_CONFIDENCE, MIN_TRIALS_BEFORE_EXPLOIT } from '../config';

describe('ε-greedy 策略', () => {
  it('探索概率应为 epsilon', () => {
    const trials = 1000;
    let exploreCount = 0;

    // 使用固定随机数序列
    for (let i = 0; i < trials; i++) {
      const rand = i / trials; // 0.000, 0.001, 0.002, ...
      if (shouldExplore(EPSILON, () => rand)) {
        exploreCount++;
      }
    }

    const actualRate = exploreCount / trials;
    expect(actualRate).toBeCloseTo(EPSILON, 1);
  });
});

describe('UCB 算法', () => {
  it('未试验变体应返回无穷大', () => {
    const variant: PromptVariant = {
      id: 'v1',
      baselinePromptId: 'baseline1',
      variantText: 'test',
      isBaseline: false,
      trialCount: 0,
      successCount: 0,
      totalReward: 0,
      ucbScore: 0,
      avgSatisfaction: 0,
      createdAt: new Date().toISOString(),
    };

    const ucb = computeUCB(variant, 100, UCB_CONFIDENCE);
    expect(ucb).toBe(Infinity);
  });

  it('应正确计算 UCB 分数', () => {
    const variant: PromptVariant = {
      id: 'v1',
      baselinePromptId: 'baseline1',
      variantText: 'test',
      isBaseline: false,
      trialCount: 10,
      successCount: 8,
      totalReward: 7.5,
      ucbScore: 0,
      avgSatisfaction: 0.75,
      createdAt: new Date().toISOString(),
    };

    const totalTrials = 100;
    const ucb = computeUCB(variant, totalTrials, UCB_CONFIDENCE);

    // UCB = 0.75 + 2.0 * sqrt(ln(100) / 10) ≈ 0.75 + 1.36 ≈ 2.11
    expect(ucb).toBeGreaterThan(0.75);
    expect(ucb).toBeLessThan(3);
  });
});

describe('变体选择', () => {
  const createVariant = (id: string, trialCount: number, avgSatisfaction: number): PromptVariant => ({
    id,
    baselinePromptId: 'baseline1',
    variantText: `variant ${id}`,
    isBaseline: false,
    trialCount,
    successCount: Math.floor(trialCount * avgSatisfaction),
    totalReward: trialCount * avgSatisfaction,
    ucbScore: 0,
    avgSatisfaction,
    createdAt: new Date().toISOString(),
  });

  it('探索模式应随机选择', () => {
    const variants = [createVariant('v1', 20, 0.8), createVariant('v2', 20, 0.6), createVariant('v3', 20, 0.7)];

    // 强制探索
    let selected = selectVariant(variants, 1.0, UCB_CONFIDENCE, MIN_TRIALS_BEFORE_EXPLOIT, () => 0.0);
    expect(selected.id).toBe('v1'); // 随机数 0.0 -> 索引 0

    selected = selectVariant(variants, 1.0, UCB_CONFIDENCE, MIN_TRIALS_BEFORE_EXPLOIT, () => 0.99);
    expect(selected.id).toBe('v3'); // 随机数 0.99 -> 索引 2
  });

  it('利用模式应选择最高 UCB 的变体', () => {
    const variants = [createVariant('v1', 20, 0.8), createVariant('v2', 20, 0.6), createVariant('v3', 20, 0.95)];

    // 强制利用（epsilon=0）
    const selected = selectVariant(variants, 0.0, UCB_CONFIDENCE, 5, () => 0.5);

    // v3 有最高平均满意度，应被选中
    expect(selected.id).toBe('v3');
  });

  it('未达最小试验次数应强制探索', () => {
    const variants = [createVariant('v1', 5, 0.8), createVariant('v2', 3, 0.6), createVariant('v3', 2, 0.7)];

    // 即使 epsilon=0，也应探索（因为未达到最小试验次数 10）
    const selected = selectVariant(variants, 0.0, UCB_CONFIDENCE, 10, () => 0.5);

    // 应选择中间的变体
    expect(variants).toContain(selected);
  });

  it('未试验的变体应优先选择', () => {
    const variants = [createVariant('v1', 20, 0.8), createVariant('v2', 0, 0), createVariant('v3', 20, 0.7)];

    // 利用模式，但 v2 未试验过
    const selected = selectVariant(variants, 0.0, UCB_CONFIDENCE, 5, () => 0.5);

    // v2 的 UCB 为无穷大，应被选中
    expect(selected.id).toBe('v2');
  });
});

describe('变体奖励更新', () => {
  it('应正确更新统计数据', () => {
    const variant: PromptVariant = {
      id: 'v1',
      baselinePromptId: 'baseline1',
      variantText: 'test',
      isBaseline: false,
      trialCount: 10,
      successCount: 7,
      totalReward: 7.2,
      ucbScore: 0,
      avgSatisfaction: 0.72,
      createdAt: new Date().toISOString(),
    };

    const updated = updateVariantReward(variant, 0.8);

    expect(updated.trialCount).toBe(11);
    expect(updated.successCount).toBe(8); // 0.8 > 0.6
    expect(updated.totalReward).toBeCloseTo(8.0, 1);
    expect(updated.avgSatisfaction).toBeCloseTo(8.0 / 11, 2);
  });

  it('满意度低于阈值不应增加成功次数', () => {
    const variant: PromptVariant = {
      id: 'v1',
      baselinePromptId: 'baseline1',
      variantText: 'test',
      isBaseline: false,
      trialCount: 10,
      successCount: 7,
      totalReward: 7.2,
      ucbScore: 0,
      avgSatisfaction: 0.72,
      createdAt: new Date().toISOString(),
    };

    const updated = updateVariantReward(variant, 0.5); // < 0.6

    expect(updated.successCount).toBe(7); // 不变
  });

  it('应保持不可变更新', () => {
    const variant: PromptVariant = {
      id: 'v1',
      baselinePromptId: 'baseline1',
      variantText: 'test',
      isBaseline: false,
      trialCount: 10,
      successCount: 7,
      totalReward: 7.2,
      ucbScore: 0,
      avgSatisfaction: 0.72,
      createdAt: new Date().toISOString(),
    };

    const updated = updateVariantReward(variant, 0.8);

    // 原对象不变
    expect(variant.trialCount).toBe(10);
    expect(updated).not.toBe(variant);
  });
});

describe('PromptEvolutionEngine', () => {
  let mockDb: DatabaseClient;
  let engine: PromptEvolutionEngine;

  beforeEach(() => {
    mockDb = {
      execute: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
    };

    engine = new PromptEvolutionEngine(
      {
        epsilon: EPSILON,
        maxVariantsPerPrompt: 5,
        minTrialsBeforeExploit: MIN_TRIALS_BEFORE_EXPLOIT,
        ucbConfidence: UCB_CONFIDENCE,
      },
      mockDb,
    );
  });

  it('无变体时应返回基线版本', async () => {
    mockDb.query = vi.fn().mockResolvedValue([]);

    const variant = await engine.selectPrompt('baseline1');

    expect(variant.isBaseline).toBe(true);
    expect(mockDb.execute).toHaveBeenCalled(); // 创建基线
  });

  it('应正确选择变体并记录历史', async () => {
    const mockVariants = [
      {
        id: 'v1',
        baseline_prompt_id: 'baseline1',
        variant_text: 'test',
        is_baseline: 0,
        trial_count: 20,
        success_count: 16,
        total_reward: 16.5,
        ucb_score: 0,
        avg_satisfaction: 0.825,
        created_at: new Date().toISOString(),
      },
    ];
    mockDb.query = vi.fn().mockResolvedValue(mockVariants);

    const variant = await engine.selectPrompt('baseline1');

    expect(variant.id).toBe('v1');
    expect(mockDb.execute).toHaveBeenCalled(); // 记录选择事件
  });

  it('应正确记录反馈并更新变体', async () => {
    const mockVariant = {
      id: 'v1',
      baseline_prompt_id: 'baseline1',
      variant_text: 'test',
      is_baseline: 0,
      trial_count: 10,
      success_count: 7,
      total_reward: 7.2,
      ucb_score: 0,
      avg_satisfaction: 0.72,
      created_at: new Date().toISOString(),
    };
    mockDb.query = vi.fn().mockResolvedValue([mockVariant]);

    await engine.recordFeedback('v1', 0.8);

    expect(mockDb.execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE prompt_variants'), expect.arrayContaining([11, 8]));
  });

  it('达到变体上限应拒绝创建', async () => {
    const mockVariants = Array.from({ length: 5 }, (_, i) => ({
      id: `v${i}`,
      baseline_prompt_id: 'baseline1',
      variant_text: `test${i}`,
      is_baseline: 0,
      trial_count: 10,
      success_count: 7,
      total_reward: 7.2,
      ucb_score: 0,
      avg_satisfaction: 0.72,
      created_at: new Date().toISOString(),
    }));
    mockDb.query = vi.fn().mockResolvedValue(mockVariants);

    await expect(engine.createVariant('baseline1', 'new variant')).rejects.toThrow('已达到最大变体数量');
  });

  it('应正确创建新变体', async () => {
    mockDb.query = vi.fn().mockResolvedValue([]); // 无现有变体

    const variant = await engine.createVariant('baseline1', 'new variant');

    expect(variant.trialCount).toBe(0);
    expect(variant.ucbScore).toBe(Infinity);
    expect(mockDb.execute).toHaveBeenCalled();
  });
});
