/**
 * P2: 记忆排序模型测试
 */

import { describe, it, expect } from 'vitest';
import { MemoryRankingModel, computeMeanSquaredError } from '../memory-ranking-model';
import type { MemoryRankingFeatures } from '../types';

/** 构造特征，默认值为"中性"记忆 */
function makeFeatures(overrides: Partial<MemoryRankingFeatures> = {}): MemoryRankingFeatures {
  return {
    semanticSimilarity: 0.5,
    keywordMatch: 2,
    queryLength: 20,
    memoryAge: 30,
    accessCount: 5,
    lastAccessRecency: 24,
    memoryLength: 200,
    topicRelevance: 0.5,
    userFeedbackScore: 0.5,
    taskTypeMatch: false,
    avgUtilityScore: 0.5,
    retrievalSuccessRate: 0.5,
    ...overrides,
  };
}

describe('MemoryRankingModel 构造与校验', () => {
  it('学习率越界应抛错', () => {
    expect(() => new MemoryRankingModel(0)).toThrow();
    expect(() => new MemoryRankingModel(-0.1)).toThrow();
    expect(() => new MemoryRankingModel(1.5)).toThrow();
  });

  it('合法学习率可正常构造', () => {
    expect(() => new MemoryRankingModel(0.01)).not.toThrow();
    expect(() => new MemoryRankingModel(1)).not.toThrow();
  });
});

describe('predict 预测', () => {
  it('预测值始终落在 [0, 1]', () => {
    const model = new MemoryRankingModel();
    const cases = [
      makeFeatures(),
      makeFeatures({ semanticSimilarity: 1, topicRelevance: 1, avgUtilityScore: 1 }),
      makeFeatures({ semanticSimilarity: 0, topicRelevance: 0, avgUtilityScore: 0 }),
    ];

    for (const features of cases) {
      const score = model.predict(features);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('语义相似度更高的记忆得分更高', () => {
    const model = new MemoryRankingModel();
    const low = model.predict(makeFeatures({ semanticSimilarity: 0.1 }));
    const high = model.predict(makeFeatures({ semanticSimilarity: 0.9 }));
    expect(high).toBeGreaterThan(low);
  });

  it('异常特征（越界、超大值）不会产生 NaN 或越界结果', () => {
    const model = new MemoryRankingModel();
    const weird = makeFeatures({
      semanticSimilarity: 5, // 越界
      topicRelevance: -3, // 负值
      accessCount: 1e9, // 超大
      memoryAge: 1e6,
      keywordMatch: 10000,
      lastAccessRecency: 1e7,
    });

    const score = model.predict(weird);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('特征归一化让大数值特征不主导预测', () => {
    const model = new MemoryRankingModel();
    // accessCount 差异极大，但因归一化，得分差异应保持温和
    const a = model.predict(makeFeatures({ accessCount: 1 }));
    const b = model.predict(makeFeatures({ accessCount: 1_000_000 }));
    expect(Math.abs(b - a)).toBeLessThan(0.5);
  });
});

describe('learn 在线学习', () => {
  it('实际效用越界应抛错', () => {
    const model = new MemoryRankingModel();
    expect(() => model.learn(makeFeatures(), -0.1)).toThrow();
    expect(() => model.learn(makeFeatures(), 1.1)).toThrow();
  });

  it('学习后预测朝目标值移动', () => {
    const model = new MemoryRankingModel(0.5);
    const features = makeFeatures({ semanticSimilarity: 0.9 });

    const before = model.predict(features);
    for (let i = 0; i < 50; i++) {
      model.learn(features, 1.0);
    }
    const after = model.predict(features);

    expect(after).toBeGreaterThan(before);
  });

  it('学习会推进模型版本号', () => {
    const model = new MemoryRankingModel();
    const v0 = model.getVersion();
    model.learn(makeFeatures(), 0.8);
    expect(model.getVersion()).toBe(v0 + 1);
  });
});

describe('batchLearn 批量训练', () => {
  it('空样本集不报错且不改变版本', () => {
    const model = new MemoryRankingModel();
    const v0 = model.getVersion();
    expect(() => model.batchLearn([], 10)).not.toThrow();
    expect(model.getVersion()).toBe(v0);
  });

  it('训练后均方误差下降', () => {
    const model = new MemoryRankingModel(0.3);

    // 构造有明确规律的样本：相似度高 → 效用高
    const samples = [
      { features: makeFeatures({ semanticSimilarity: 0.95, topicRelevance: 0.95 }), actualUtility: 1.0 },
      { features: makeFeatures({ semanticSimilarity: 0.9, topicRelevance: 0.85 }), actualUtility: 0.95 },
      { features: makeFeatures({ semanticSimilarity: 0.05, topicRelevance: 0.05 }), actualUtility: 0.0 },
      { features: makeFeatures({ semanticSimilarity: 0.1, topicRelevance: 0.1 }), actualUtility: 0.05 },
    ];

    const errorBefore = computeMeanSquaredError(model, samples);
    model.batchLearn(samples, 100);
    const errorAfter = computeMeanSquaredError(model, samples);

    expect(errorAfter).toBeLessThan(errorBefore);
  });
});

describe('排序行为', () => {
  it('训练后相关记忆排序靠前', () => {
    const model = new MemoryRankingModel(0.3);

    // 训练：高相似度 → 高效用
    const samples = [
      { features: makeFeatures({ semanticSimilarity: 0.95, topicRelevance: 0.9 }), actualUtility: 1.0 },
      { features: makeFeatures({ semanticSimilarity: 0.05, topicRelevance: 0.1 }), actualUtility: 0.0 },
    ];
    model.batchLearn(samples, 200);

    const candidates = [
      { id: 'irrelevant', features: makeFeatures({ semanticSimilarity: 0.1, topicRelevance: 0.1 }) },
      { id: 'relevant', features: makeFeatures({ semanticSimilarity: 0.95, topicRelevance: 0.9 }) },
      { id: 'medium', features: makeFeatures({ semanticSimilarity: 0.5, topicRelevance: 0.5 }) },
    ];

    const ranked = candidates
      .map((c) => ({ id: c.id, score: model.predict(c.features) }))
      .sort((a, b) => b.score - a.score);

    expect(ranked[0].id).toBe('relevant');
    expect(ranked[ranked.length - 1].id).toBe('irrelevant');
  });

  it('相同输入产生可复现的结果', () => {
    const model = new MemoryRankingModel();
    const features = makeFeatures({ semanticSimilarity: 0.7 });
    expect(model.predict(features)).toBe(model.predict(features));
  });
});

describe('权重快照与恢复', () => {
  it('快照可以恢复训练前的权重', () => {
    const model = new MemoryRankingModel(0.5);
    const features = makeFeatures({ semanticSimilarity: 0.8 });

    const snapshot = model.createSnapshot();
    const predictionBefore = model.predict(features);

    for (let i = 0; i < 30; i++) {
      model.learn(features, 1.0);
    }
    expect(model.predict(features)).not.toBe(predictionBefore);

    model.restoreSnapshot(snapshot);
    expect(model.predict(features)).toBe(predictionBefore);
    expect(model.getVersion()).toBe(snapshot.version);
  });

  it('getWeights 返回副本，外部修改不影响模型', () => {
    const model = new MemoryRankingModel();
    const weights = model.getWeights();
    const original = weights.semanticSimilarity;

    weights.semanticSimilarity = 999;

    expect(model.getWeights().semanticSimilarity).toBe(original);
  });

  it('setWeights 可直接注入权重和版本', () => {
    const model = new MemoryRankingModel();
    const weights = model.getWeights();
    weights.semanticSimilarity = 2.0;

    model.setWeights(weights, 42);

    expect(model.getWeights().semanticSimilarity).toBe(2.0);
    expect(model.getVersion()).toBe(42);
  });
});

describe('computeMeanSquaredError', () => {
  it('空样本返回 0', () => {
    const model = new MemoryRankingModel();
    expect(computeMeanSquaredError(model, [])).toBe(0);
  });

  it('误差非负', () => {
    const model = new MemoryRankingModel();
    const samples = [
      { features: makeFeatures(), actualUtility: 1.0 },
      { features: makeFeatures(), actualUtility: 0.0 },
    ];
    expect(computeMeanSquaredError(model, samples)).toBeGreaterThanOrEqual(0);
  });
});
