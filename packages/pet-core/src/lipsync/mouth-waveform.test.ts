import { describe, it, expect } from "vitest";
import {
  computeMouthOpen,
  smoothMouthValue,
  MOUTH_SMOOTHING,
} from "./mouth-waveform.js";

describe("computeMouthOpen — 纯波形", () => {
  it("输出恒在 [0,1]", () => {
    for (let t = 0; t < 5; t += 0.013) {
      const v = computeMouthOpen(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("纯函数：同 t 恒等", () => {
    expect(computeMouthOpen(1.234)).toBe(computeMouthOpen(1.234));
  });

  it("随时间变化（不是常量，嘴会动）", () => {
    const samples = new Set<number>();
    for (let t = 0; t < 1; t += 0.05) samples.add(Math.round(computeMouthOpen(t) * 100));
    expect(samples.size).toBeGreaterThan(3);
  });
});

describe("smoothMouthValue — 指数平滑", () => {
  it("向目标逼近但不越过", () => {
    const next = smoothMouthValue(0, 1);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(1);
    expect(next).toBeCloseTo(1 - MOUTH_SMOOTHING, 5);
  });

  it("prev==target 时保持不变", () => {
    expect(smoothMouthValue(0.5, 0.5)).toBeCloseTo(0.5, 5);
  });

  it("smoothing 越大越接近旧值", () => {
    const low = smoothMouthValue(0, 1, 0.1);
    const high = smoothMouthValue(0, 1, 0.9);
    expect(high).toBeLessThan(low);
  });
});
