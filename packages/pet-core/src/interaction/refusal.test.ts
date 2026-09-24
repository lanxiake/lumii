import { describe, it, expect } from "vitest";
import {
  REFUSAL_PROBABILITY,
  refusalProbability,
  shouldRefuse,
} from "./refusal.js";

/** 会拒绝的输入：低亲和 + 心情差 */
const GRUMPY = { a: 0.2, v: -0.5 };

describe("refusalProbability — 触发条件", () => {
  it("低亲和 + 心情差 → 拒绝概率 0.3", () => {
    expect(refusalProbability(GRUMPY.a, GRUMPY.v, "interaction")).toBe(REFUSAL_PROBABILITY);
  });

  it("亲和性不够低就不拒绝（边界取开区间：正好 0.35 不触发）", () => {
    expect(refusalProbability(0.35, -0.5, "interaction")).toBe(0);
    expect(refusalProbability(0.9, -0.9, "interaction")).toBe(0);
  });

  it("心情不够差就不拒绝（边界同上：正好 -0.2 不触发）", () => {
    expect(refusalProbability(0.2, -0.2, "interaction")).toBe(0);
    expect(refusalProbability(0.2, 0.8, "interaction")).toBe(0);
  });

  it("非有限数按「不拒绝」处理（读不到性格时宁可温顺，不要突然闹脾气）", () => {
    expect(refusalProbability(Number.NaN, -1, "interaction")).toBe(0);
    expect(refusalProbability(0.1, Number.NaN, "interaction")).toBe(0);
  });
});

describe("★ 硬规则：任务请求一律不拒绝", () => {
  it("最容易拒绝的输入下，任务请求的概率仍是 0", () => {
    expect(refusalProbability(0, -1, "task")).toBe(0);
  });

  it("任务请求即使随机数落在最左端也不拒绝", () => {
    for (const r of [0, 0.0001, 0.29, 0.5, 1]) {
      expect(shouldRefuse(0, -1, "task", () => r)).toBe(false);
    }
  });

  it("同样的输入换成互动请求就会拒绝 —— 说明差别确实只在 kind 上", () => {
    const rand = () => 0.1; // < 0.3，必拒
    expect(shouldRefuse(0, -1, "interaction", rand)).toBe(true);
    expect(shouldRefuse(0, -1, "task", rand)).toBe(false);
  });
});

describe("shouldRefuse — 概率语义", () => {
  it("概率为 0 时不消费随机数（否则 rand 序列会与真实行为错位）", () => {
    let calls = 0;
    const rand = () => {
      calls++;
      return 0;
    };
    shouldRefuse(0.9, 0, "interaction", rand); // 心情不差 → 概率 0
    shouldRefuse(0, -1, "task", rand); // 任务请求 → 概率 0
    expect(calls).toBe(0);
  });

  it("拒绝概率约等于 0.3 —— 扫一遍随机源看落点比例", () => {
    let refused = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) {
      if (shouldRefuse(GRUMPY.a, GRUMPY.v, "interaction", () => (i + 0.5) / N)) refused++;
    }
    expect(refused / N).toBeCloseTo(REFUSAL_PROBABILITY, 2);
  });

  it("随机源返回非有限数时不拒绝（不把 NaN 当「小于阈值」）", () => {
    expect(shouldRefuse(GRUMPY.a, GRUMPY.v, "interaction", () => Number.NaN)).toBe(false);
  });
});
