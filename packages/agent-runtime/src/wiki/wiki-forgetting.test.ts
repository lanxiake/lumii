/**
 * 遗忘曲线排序单测
 */
import { describe, expect, it } from "vitest";
import { computeForgettingScore, rankByForgettingScore } from "./wiki-forgetting.js";

describe("computeForgettingScore", () => {
  it("近期高频高于久未使用", () => {
    const now = Date.parse("2026-08-26T00:00:00.000Z");
    const hot = computeForgettingScore({
      lastUsedAt: "2026-08-25T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      useCount: 20,
      nowMs: now,
    });
    const cold = computeForgettingScore({
      lastUsedAt: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      useCount: 0,
      nowMs: now,
    });
    expect(hot).toBeGreaterThan(cold);
  });

  it("同等年龄下 use_count 更高衰减更慢（分数更高）", () => {
    const now = Date.parse("2026-08-26T00:00:00.000Z");
    const used = "2026-07-01T00:00:00.000Z";
    const high = computeForgettingScore({
      lastUsedAt: used,
      createdAt: used,
      useCount: 50,
      nowMs: now,
    });
    const low = computeForgettingScore({
      lastUsedAt: used,
      createdAt: used,
      useCount: 1,
      nowMs: now,
    });
    expect(high).toBeGreaterThan(low);
  });
});

describe("rankByForgettingScore", () => {
  it("按分数降序排列", () => {
    const now = Date.parse("2026-08-26T00:00:00.000Z");
    const ranked = rankByForgettingScore([
      { id: "cold", lastUsedAt: null, createdAt: "2024-01-01T00:00:00.000Z", useCount: 0, nowMs: now },
      { id: "hot", lastUsedAt: "2026-08-25T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", useCount: 10, nowMs: now },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["hot", "cold"]);
  });
});
