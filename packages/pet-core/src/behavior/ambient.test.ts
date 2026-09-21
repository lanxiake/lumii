import { describe, it, expect } from "vitest";
import {
  AMBIENT_DEFAULTS,
  activityDuration,
  initialPlan,
  pickActivity,
  planNextActivity,
  type AmbientActivity,
} from "./ambient.js";

/** 固定返回值的随机源 */
const fixed = (v: number) => () => v;

/** 顺序返回的随机源（用完后重复最后一个） */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

describe("pickActivity — 权重抽签", () => {
  const w = AMBIENT_DEFAULTS.weights; // stand .45 / sit .20 / walk .35，累积 0.45 / 0.65 / 1.0

  it("按累积区间落点", () => {
    expect(pickActivity(fixed(0.0), w)).toBe("stand");
    expect(pickActivity(fixed(0.44), w)).toBe("stand");
    expect(pickActivity(fixed(0.45), w)).toBe("sit"); // 区间右开
    expect(pickActivity(fixed(0.64), w)).toBe("sit");
    expect(pickActivity(fixed(0.65), w)).toBe("walk");
    expect(pickActivity(fixed(0.99), w)).toBe("walk");
  });

  it("rand 返回 1 时不越界（仍落在最后一个活动上）", () => {
    // 注入的随机源返回 1 是常见写法，累积法会正好走到边界外
    expect(pickActivity(fixed(1), w)).toBe("walk");
  });

  it("rand 返回 NaN / 负数时落到第一个活动，而不是返回 undefined", () => {
    expect(pickActivity(fixed(Number.NaN), w)).toBe("stand");
    expect(pickActivity(fixed(-5), w)).toBe("stand");
  });

  it("权重全 0 时退化为第一个活动（不抛错、不返回 undefined）", () => {
    const zero = { stand: 0, sit: 0, walk: 0 };
    expect(pickActivity(fixed(0.5), zero)).toBe("stand");
  });

  it("权重不必归一化：等比缩放不改变分布", () => {
    const scaled = { stand: 4.5, sit: 2, walk: 3.5 };
    expect(pickActivity(fixed(0.44), scaled)).toBe("stand");
    expect(pickActivity(fixed(0.45), scaled)).toBe("sit");
    expect(pickActivity(fixed(0.99), scaled)).toBe("walk");
  });

  it("权重表缺键时把缺失的当 0，不抛错", () => {
    const partial = { stand: 1, sit: 0, walk: 0 } as Record<AmbientActivity, number>;
    expect(pickActivity(fixed(0.5), partial)).toBe("stand");
  });

  it("大样本下分布贴近权重（不是均匀抽）", () => {
    // 用确定性序列覆盖 [0,1)，避免 flaky：这是分布的形状检查，不是统计检验
    const counts: Record<AmbientActivity, number> = { stand: 0, sit: 0, walk: 0 };
    const N = 10_000;
    for (let i = 0; i < N; i++) counts[pickActivity(fixed(i / N), w)]++;
    expect(counts.stand / N).toBeCloseTo(0.45, 2);
    expect(counts.sit / N).toBeCloseTo(0.2, 2);
    expect(counts.walk / N).toBeCloseTo(0.35, 2);
  });
});

describe("activityDuration — 时长取值", () => {
  const cfg = AMBIENT_DEFAULTS.durations;

  it("落在区间内，且两端可取到", () => {
    const r = cfg.walk; // 3~10s
    expect(activityDuration("walk", fixed(0), cfg)).toBe(r.min);
    expect(activityDuration("walk", fixed(0.5), cfg)).toBe((r.min + r.max) / 2);
    expect(activityDuration("walk", fixed(1), cfg)).toBe(r.max);
  });

  it("min > max 时按 min 处理，而不是悄悄交换", () => {
    // 配置写反了要能被看出来
    const bad = { ...cfg, sit: { min: 5000, max: 1000 } };
    expect(activityDuration("sit", fixed(0.9), bad)).toBe(5000);
  });

  it("负的 min 被夹到 0", () => {
    const bad = { ...cfg, stand: { min: -100, max: 200 } };
    expect(activityDuration("stand", fixed(0), bad)).toBe(0);
  });

  it("时长区间标称值就是默认节奏：平均 20~35 秒一次活动", () => {
    // 这条是**回归哨兵**：默认值被改到"5 秒一次"就说明回到了被否决的表演节奏
    const avg = (a: AmbientActivity) => {
      const d = cfg[a];
      return (d.min + d.max) / 2;
    };
    expect(avg("stand")).toBeGreaterThanOrEqual(15_000);
    expect(avg("walk")).toBeGreaterThanOrEqual(3_000);
    // 周期性活动（stand/sit）必须都是数十秒量级
    expect(avg("sit")).toBeGreaterThanOrEqual(20_000);
  });
});

describe("planNextActivity / initialPlan", () => {
  it("计划由同一次抽签的两个值组成（活动 + 时长）", () => {
    // 第一次调用抽活动，第二次抽时长
    const plan = planNextActivity(seq([0.9, 0.5]), AMBIENT_DEFAULTS);
    expect(plan.activity).toBe("walk");
    const r = AMBIENT_DEFAULTS.durations.walk;
    expect(plan.durationMs).toBe((r.min + r.max) / 2);
  });

  it("首次一定是站着——进宠物模式就先走起来很突兀", () => {
    // 无论抽到什么权重值，第一次都不该是 walk/sit
    for (const v of [0, 0.5, 0.99]) {
      expect(initialPlan(fixed(v), AMBIENT_DEFAULTS).activity).toBe("stand");
    }
  });

  it("首次的时长按 stand 区间取", () => {
    const plan = initialPlan(fixed(0), AMBIENT_DEFAULTS);
    expect(plan.durationMs).toBe(AMBIENT_DEFAULTS.durations.stand.min);
  });
});
