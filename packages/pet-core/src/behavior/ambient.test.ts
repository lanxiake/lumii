import { describe, it, expect } from "vitest";
import {
  AMBIENT_DEFAULTS,
  activityDuration,
  initialPlan,
  pickActivity,
  planNextActivity,
  adjustAmbientConfig,
  adjustDurationsByTraits,
  adjustWeightsByMood,
  AMBIENT_GAIN_IDENTITY,
  WEIGHT_MAX,
  WEIGHT_MIN,
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

// ---------------------------------------------------------------------------
// 性格 / 情绪 → 活动参数（第二期 T2.2）
// ---------------------------------------------------------------------------

describe("adjustWeightsByMood — 性格与情绪调权重", () => {
  const base = AMBIENT_DEFAULTS.weights;
  const ALL_KEYS: AmbientActivity[] = ["stand", "walk", "sit"];

  it("中性输入原样返回（引用相等）—— 未接线必须与上线前一致", () => {
    expect(adjustWeightsByMood(base)).toBe(base);
    expect(
      adjustWeightsByMood(base, { energy: 0.6, valence: 0 }, { extraversion: 0.5, openness: 0.5 }),
    ).toBe(base);
  });

  it("外向 → 走动权重高、坐下权重低；内向反过来", () => {
    const out = adjustWeightsByMood(base, null, { extraversion: 0.85 });
    const inn = adjustWeightsByMood(base, null, { extraversion: 0.15 });
    expect(out.walk).toBeGreaterThan(inn.walk);
    expect(out.sit).toBeLessThan(inn.sit);
  });

  it("精力高 → 走动更多；心情差 → 坐着更多", () => {
    const fresh = adjustWeightsByMood(base, { energy: 0.9 });
    const tired = adjustWeightsByMood(base, { energy: 0.2 });
    expect(fresh.walk).toBeGreaterThan(tired.walk);

    const glum = adjustWeightsByMood(base, { valence: -1 });
    expect(glum.sit).toBeGreaterThan(adjustWeightsByMood(base, { valence: 0 }).sit);
  });

  it("★ 极端输入下不越界、不为 0、不溢出", () => {
    // 两个极端个体 + 两个极端情绪，全组合都过一遍
    const extremes = [
      { extraversion: 0.15, openness: 0.15 },
      { extraversion: 0.85, openness: 0.85 },
      { extraversion: 0, openness: 0 },
      { extraversion: 1, openness: 1 },
    ];
    const moods = [
      { energy: 0, valence: -1 },
      { energy: 1, valence: 1 },
      { energy: Number.NaN, valence: Number.POSITIVE_INFINITY },
      { energy: -5, valence: 99 },
    ];
    for (const t of extremes) {
      for (const m of moods) {
        const w = adjustWeightsByMood(base, m, t);
        for (const k of ALL_KEYS) {
          expect(Number.isFinite(w[k])).toBe(true);
          expect(w[k]).toBeGreaterThanOrEqual(WEIGHT_MIN);
          expect(w[k]).toBeLessThanOrEqual(WEIGHT_MAX);
        }
      }
    }
  });

  it("★ 极端个体仍能走到三种活动（不会退化成「永不动」）", () => {
    // 逐个活动看它是否还抽得到：权重为 0 的那个活动永远抽不到，
    // 而"永不动"正是无夹取时最容易出现的形态
    const w = adjustWeightsByMood(base, { energy: 0, valence: -1 }, { extraversion: 0 });
    for (const k of ALL_KEYS) expect(w[k]).toBeGreaterThan(0);

    // 扫一遍累积抽样区间，确认三个活动各自都有非空区间
    const total = ALL_KEYS.reduce((s, k) => s + w[k], 0);
    const hits = new Set<AmbientActivity>();
    for (let i = 0; i <= 100; i++) hits.add(pickActivity(fixed(i / 100), w));
    expect(hits.size).toBe(3);
    expect(total).toBeGreaterThan(0);
  });
});

describe("adjustDurationsByTraits — 好奇外向的宠物闲不住", () => {
  const base = AMBIENT_DEFAULTS.durations;

  it("中性输入原样返回（引用相等）", () => {
    expect(adjustDurationsByTraits(base)).toBe(base);
    expect(adjustDurationsByTraits(base, { openness: 0.5, extraversion: 0.5 })).toBe(base);
  });

  it("高 openness + 高 extraversion → 每一项都更短", () => {
    const lively = adjustDurationsByTraits(base, { openness: 0.85, extraversion: 0.85 });
    for (const k of ["stand", "walk", "sit"] as const) {
      expect(lively[k].min).toBeLessThan(base[k].min);
      expect(lively[k].max).toBeLessThan(base[k].max);
    }
  });

  it("只动其中一个维度效果更弱（两维各贡献一半）", () => {
    const both = adjustDurationsByTraits(base, { openness: 0.85, extraversion: 0.85 });
    const onlyOpen = adjustDurationsByTraits(base, { openness: 0.85, extraversion: 0.5 });
    expect(both.stand.min).toBeLessThan(onlyOpen.stand.min);
    expect(onlyOpen.stand.min).toBeLessThan(base.stand.min);
  });

  it("极端输入不把区间推成 0 或负数", () => {
    const d = adjustDurationsByTraits(base, { openness: 1, extraversion: 1 });
    for (const k of ["stand", "walk", "sit"] as const) {
      expect(d[k].min).toBeGreaterThan(0);
      expect(d[k].min).toBeLessThanOrEqual(d[k].max);
    }
  });
});

describe("adjustAmbientConfig — 驱动侧唯一入口", () => {
  it("中性输入原样返回整份配置（引用相等）", () => {
    expect(adjustAmbientConfig(AMBIENT_DEFAULTS)).toBe(AMBIENT_DEFAULTS);
  });

  it("非中性输入返回新配置，且 walkSpeed 不被改动", () => {
    const out = adjustAmbientConfig(AMBIENT_DEFAULTS, { energy: 0.9 }, { extraversion: 0.8 });
    expect(out).not.toBe(AMBIENT_DEFAULTS);
    expect(out.walkSpeed).toBe(AMBIENT_DEFAULTS.walkSpeed);
    expect(out.weights.walk).toBeGreaterThan(AMBIENT_DEFAULTS.weights.walk);
  });
});

// ---------------------------------------------------------------------------
// 表达增益（U7 2026-09-24 转投到活动参数）
// ---------------------------------------------------------------------------

describe("adjustAmbientConfig — 无表情层模型的表达增益", () => {
  const LOUD = 1.6
  const traits = { openness: 0.85, extraversion: 0.85 }

  it("增益为 1 与不传完全一致（引用相等），保证接线前后逐字节一致", () => {
    expect(adjustAmbientConfig(AMBIENT_DEFAULTS, null, traits, 1)).toEqual(
      adjustAmbientConfig(AMBIENT_DEFAULTS, null, traits),
    )
    expect(adjustAmbientConfig(AMBIENT_DEFAULTS, null, null, 1)).toBe(AMBIENT_DEFAULTS)
  })

  it("★ 放大的是**偏离基准的量**，不是总量", () => {
    const plain = adjustAmbientConfig(AMBIENT_DEFAULTS, null, traits)
    const loud = adjustAmbientConfig(AMBIENT_DEFAULTS, null, traits, LOUD)
    const base = AMBIENT_DEFAULTS.weights.walk
    // walk 的偏离被乘了 1.6 倍，且方向不变
    const dev = plain.weights.walk - base
    expect(dev).not.toBe(0)
    expect(loud.weights.walk - base).toBeCloseTo(dev * LOUD, 2)
    expect(loud.weights.walk).toBeGreaterThan(plain.weights.walk)
  })

  it("时长同向放大：活泼的宠物在补偿后更闲不住", () => {
    const plain = adjustAmbientConfig(AMBIENT_DEFAULTS, null, traits)
    const loud = adjustAmbientConfig(AMBIENT_DEFAULTS, null, traits, LOUD)
    expect(loud.durations.stand.min).toBeLessThan(plain.durations.stand.min)
    expect(loud.durations.walk.min).toBeLessThan(plain.durations.walk.min)
  })

  it("中性性格 + 增益：数值与基准一致（偏离为 0，放大还是 0）", () => {
    const loud = adjustAmbientConfig(AMBIENT_DEFAULTS, null, null, LOUD)
    expect(loud.weights).toEqual(AMBIENT_DEFAULTS.weights)
    expect(loud.durations).toEqual(AMBIENT_DEFAULTS.durations)
  })

  it("极端性格 + 增益仍被夹取，且时长不为 0", () => {
    const loud = adjustAmbientConfig(
      AMBIENT_DEFAULTS,
      { energy: 1, valence: -1 },
      { openness: 1, extraversion: 0 },
      LOUD,
    )
    for (const k of ["stand", "walk", "sit"] as const) {
      expect(loud.weights[k]).toBeGreaterThanOrEqual(WEIGHT_MIN)
      expect(loud.weights[k]).toBeLessThanOrEqual(WEIGHT_MAX)
      expect(loud.durations[k].min).toBeGreaterThan(0)
      expect(loud.durations[k].min).toBeLessThanOrEqual(loud.durations[k].max)
    }
  })

  it("非法增益落回 1（不抛错、不把配置算成 NaN）", () => {
    for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const cfg = adjustAmbientConfig(AMBIENT_DEFAULTS, null, traits, bad)
      expect(Number.isFinite(cfg.weights.walk)).toBe(true)
      expect(cfg.weights.walk).toBeGreaterThan(0)
    }
  })
})
