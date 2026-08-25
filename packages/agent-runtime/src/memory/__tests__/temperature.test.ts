import { describe, it, expect } from "vitest";
import { computeTemperature, DEFAULT_TEMPERATURE_THRESHOLDS } from "../temperature.js";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

describe("computeTemperature — 5 类 x 3 档矩阵", () => {
  it("个人类（user）恒为 hot，即使久未使用且 importance 低", () => {
    const t = computeTemperature(
      { category: "user", lastUsedAt: NOW - 200 * DAY, importance: 0.1, now: NOW },
      DEFAULT_TEMPERATURE_THRESHOLDS,
    );
    expect(t).toBe("hot");
  });

  it("个人类（feedback）恒为 hot", () => {
    const t = computeTemperature(
      { category: "feedback", lastUsedAt: NOW - 200 * DAY, importance: 0.0, now: NOW },
      DEFAULT_TEMPERATURE_THRESHOLDS,
    );
    expect(t).toBe("hot");
  });

  it("边界日：第 7 天整仍算 hot（<=）", () => {
    const t = computeTemperature(
      { category: "project", lastUsedAt: NOW - 7 * DAY, importance: 0.1, now: NOW },
      DEFAULT_TEMPERATURE_THRESHOLDS,
    );
    expect(t).toBe("hot");
  });

  it("第 8 天且 importance 不达标 → 不再 hot，落入 warm（8<=30 且 importance>=0.4 需满足）", () => {
    const t = computeTemperature(
      { category: "project", lastUsedAt: NOW - 8 * DAY, importance: 0.5, now: NOW },
      DEFAULT_TEMPERATURE_THRESHOLDS,
    );
    expect(t).toBe("warm");
  });

  it("高 importance 但久未使用 → 仍 hot（或关系）", () => {
    const t = computeTemperature(
      { category: "reference", lastUsedAt: NOW - 100 * DAY, importance: 0.85, now: NOW },
      DEFAULT_TEMPERATURE_THRESHOLDS,
    );
    expect(t).toBe("hot");
  });

  it("低 importance 刚用过 → hot 不是 warm（7 天内用过即 hot）", () => {
    const t = computeTemperature(
      { category: "general", lastUsedAt: NOW - 1 * DAY, importance: 0.1, now: NOW },
      DEFAULT_TEMPERATURE_THRESHOLDS,
    );
    expect(t).toBe("hot");
  });

  it("边界日：第 30 天整、importance 达标 → warm", () => {
    const t = computeTemperature(
      { category: "general", lastUsedAt: NOW - 30 * DAY, importance: 0.4, now: NOW },
      DEFAULT_TEMPERATURE_THRESHOLDS,
    );
    expect(t).toBe("warm");
  });

  it("第 31 天 → cold（超出 warmRecentDays）", () => {
    const t = computeTemperature(
      { category: "general", lastUsedAt: NOW - 31 * DAY, importance: 0.5, now: NOW },
      DEFAULT_TEMPERATURE_THRESHOLDS,
    );
    expect(t).toBe("cold");
  });

  it("importance 低于 warmImportanceMin 且已过 hot 窗口 → cold", () => {
    const t = computeTemperature(
      { category: "project", lastUsedAt: NOW - 10 * DAY, importance: 0.2, now: NOW },
      DEFAULT_TEMPERATURE_THRESHOLDS,
    );
    expect(t).toBe("cold");
  });

  it("reference 类超期未用且低 importance → cold", () => {
    const t = computeTemperature(
      { category: "reference", lastUsedAt: NOW - 40 * DAY, importance: 0.3, now: NOW },
      DEFAULT_TEMPERATURE_THRESHOLDS,
    );
    expect(t).toBe("cold");
  });
});
