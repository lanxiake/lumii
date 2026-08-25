import { describe, it, expect } from "vitest";
import { scoreMemory } from "../scorer.js";
import { DEFAULT_HOT_MEMORY_CONFIG } from "../types.js";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

describe("scoreMemory", () => {
  it("刚用过 + 高 importance 打分最高", () => {
    const fresh = scoreMemory(
      { now: NOW, lastUsedAt: NOW, importance: 0.9, category: "project", relevance: 0 },
      DEFAULT_HOT_MEMORY_CONFIG,
    );
    const stale = scoreMemory(
      { now: NOW, lastUsedAt: NOW - 60 * DAY, importance: 0.9, category: "project", relevance: 0 },
      DEFAULT_HOT_MEMORY_CONFIG,
    );
    expect(fresh).toBeGreaterThan(stale);
  });

  it("超过 recencyHalfLifeDays 后 recency 加分为 0", () => {
    const atHalfLife = scoreMemory(
      { now: NOW, lastUsedAt: NOW - 30 * DAY, importance: 0.5, category: "general", relevance: 0 },
      DEFAULT_HOT_MEMORY_CONFIG,
    );
    const beyondHalfLife = scoreMemory(
      { now: NOW, lastUsedAt: NOW - 90 * DAY, importance: 0.5, category: "general", relevance: 0 },
      DEFAULT_HOT_MEMORY_CONFIG,
    );
    // 两者 recency 加分都应钳制为 0，故分数相等（不会变负）
    expect(atHalfLife).toBeCloseTo(beyondHalfLife, 6);
  });

  it("relevance 加分线性叠加", () => {
    const withRelevance = scoreMemory(
      { now: NOW, lastUsedAt: NOW, importance: 0.5, category: "general", relevance: 0.5 },
      DEFAULT_HOT_MEMORY_CONFIG,
    );
    const withoutRelevance = scoreMemory(
      { now: NOW, lastUsedAt: NOW, importance: 0.5, category: "general", relevance: 0 },
      DEFAULT_HOT_MEMORY_CONFIG,
    );
    expect(withRelevance - withoutRelevance).toBeCloseTo(
      (DEFAULT_HOT_MEMORY_CONFIG.relevanceBonus ?? 1.0) * 0.5,
      6,
    );
  });

  it("类别权重生效（feedback > general，同 importance）", () => {
    const feedback = scoreMemory(
      { now: NOW, lastUsedAt: NOW - 60 * DAY, importance: 0.5, category: "feedback", relevance: 0 },
      DEFAULT_HOT_MEMORY_CONFIG,
    );
    const general = scoreMemory(
      { now: NOW, lastUsedAt: NOW - 60 * DAY, importance: 0.5, category: "general", relevance: 0 },
      DEFAULT_HOT_MEMORY_CONFIG,
    );
    expect(feedback).toBeGreaterThan(general);
  });
});
