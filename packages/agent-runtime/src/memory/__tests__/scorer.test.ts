import { describe, it, expect } from "vitest";
import { scoreMemory } from "../scorer.js";
import { DEFAULT_HOT_MEMORY_CONFIG } from "../types.js";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

describe("scoreMemory", () => {
  it("新建 + 高 importance 打分高于同 importance 的旧条目", () => {
    const fresh = scoreMemory(
      { now: NOW, createdAt: NOW, importance: 0.9, category: "project", relevance: 0 },
      DEFAULT_HOT_MEMORY_CONFIG,
    );
    const stale = scoreMemory(
      { now: NOW, createdAt: NOW - 60 * DAY, importance: 0.9, category: "project", relevance: 0 },
      DEFAULT_HOT_MEMORY_CONFIG,
    );
    expect(fresh).toBeGreaterThan(stale);
  });

  it("超过 recencyHalfLifeDays 后 recency 加分为 0", () => {
    const atHalfLife = scoreMemory(
      { now: NOW, createdAt: NOW - 30 * DAY, importance: 0.5, category: "general", relevance: 0 },
      DEFAULT_HOT_MEMORY_CONFIG,
    );
    const beyondHalfLife = scoreMemory(
      { now: NOW, createdAt: NOW - 90 * DAY, importance: 0.5, category: "general", relevance: 0 },
      DEFAULT_HOT_MEMORY_CONFIG,
    );
    // 两者 recency 加分都应钳制为 0，故分数相等（不会变负）
    expect(atHalfLife).toBeCloseTo(beyondHalfLife, 6);
  });

  it("relevance 加分线性叠加", () => {
    const withRelevance = scoreMemory(
      { now: NOW, createdAt: NOW, importance: 0.5, category: "general", relevance: 0.5 },
      DEFAULT_HOT_MEMORY_CONFIG,
    );
    const withoutRelevance = scoreMemory(
      { now: NOW, createdAt: NOW, importance: 0.5, category: "general", relevance: 0 },
      DEFAULT_HOT_MEMORY_CONFIG,
    );
    expect(withRelevance - withoutRelevance).toBeCloseTo(
      (DEFAULT_HOT_MEMORY_CONFIG.relevanceBonus ?? 1.0) * 0.5,
      6,
    );
  });

  it("类别权重生效（feedback > general，同 importance）", () => {
    const feedback = scoreMemory(
      { now: NOW, createdAt: NOW - 60 * DAY, importance: 0.5, category: "feedback", relevance: 0 },
      DEFAULT_HOT_MEMORY_CONFIG,
    );
    const general = scoreMemory(
      { now: NOW, createdAt: NOW - 60 * DAY, importance: 0.5, category: "general", relevance: 0 },
      DEFAULT_HOT_MEMORY_CONFIG,
    );
    expect(feedback).toBeGreaterThan(general);
  });

  it("计数加成封顶 0.15（高频条目不霸榜）", () => {
    const base = { now: NOW, createdAt: NOW - 60 * DAY, importance: 0.5, category: "general" as const, relevance: 0 };
    const huge = scoreMemory({ ...base, useCount: 100_000 }, DEFAULT_HOT_MEMORY_CONFIG);
    const alsoHuge = scoreMemory({ ...base, useCount: 1_000_000 }, DEFAULT_HOT_MEMORY_CONFIG);
    expect(huge - scoreMemory(base, DEFAULT_HOT_MEMORY_CONFIG)).toBeCloseTo(0.15, 9);
    // 足够大之后增量趋于 0（对数级）
    expect(alsoHuge - huge).toBeLessThan(0.01);
  });

  /**
   * 乘法模式（B2 的实验分支，默认关闭）。
   *
   * 与加法模式的**结构性差别**：加法下「高 importance 但零相关」总能靠基础分压过
   * 「低 importance 但高相关」；乘法下后者的缩放因子足以反超。这正是「陈旧条目
   * 压过真正相关的那条」这个实测问题的候选解法——是否真的更好由
   * `injection-eval-params.real.test.ts` 在真实语料上回答，这里只锁住行为差异。
   */
  describe("relevanceMode: multiplicative", () => {
    const mult = { ...DEFAULT_HOT_MEMORY_CONFIG, relevanceMode: "multiplicative" as const };

    it("乘法对相关性的奖励**弱于**加法（实测据此判定乘法更差）", () => {
      const staleImportant = { now: NOW, createdAt: NOW - 3 * DAY, importance: 0.9, category: "project" as const, relevance: 0 };
      const relevantLight = { now: NOW, createdAt: NOW - 3 * DAY, importance: 0.3, category: "project" as const, relevance: 0.9 };

      const addGain =
        scoreMemory(relevantLight, DEFAULT_HOT_MEMORY_CONFIG) /
        scoreMemory(staleImportant, DEFAULT_HOT_MEMORY_CONFIG);
      const multGain = scoreMemory(relevantLight, mult) / scoreMemory(staleImportant, mult);

      // 两者都能让相关项反超，但乘法的反超幅度更小——
      // 加法是固定加项（低 base 下相对增益极大），乘法是比例缩放
      expect(addGain).toBeGreaterThan(1);
      expect(multGain).toBeGreaterThan(1);
      expect(addGain).toBeGreaterThan(multGain);
    });

    it("relevance 的相对增益：加法是 1+r/k 型（base 越小越猛），乘法恒定 1+2r", () => {
      const small = { now: NOW, createdAt: NOW, importance: 0.3, category: "general" as const, relevance: 0 };
      // 乘法：增益倍数与 base 无关，恒为 1 + relevanceBonus × 0.5 = 2.0
      const multRatio =
        scoreMemory({ ...small, relevance: 0.5 }, mult) / scoreMemory(small, mult);
      expect(multRatio).toBeCloseTo(2.0, 6);
      // 加法：base 越小相对增益越大
      const addRatio =
        scoreMemory({ ...small, relevance: 0.5 }, DEFAULT_HOT_MEMORY_CONFIG) /
        scoreMemory(small, DEFAULT_HOT_MEMORY_CONFIG);
      expect(addRatio).toBeGreaterThan(multRatio);
    });
  });
});
