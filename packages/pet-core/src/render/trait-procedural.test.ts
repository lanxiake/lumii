import { describe, it, expect } from "vitest";
import {
  BASELINE_ENERGY,
  BASE_BLINK_JITTER,
  IDENTITY_PROCEDURAL_SCALES,
  SCALE_MAX,
  SCALE_MIN,
  amplifyExpressiveDeviation,
  composeScales,
  isIdentityScales,
  scaleProceduralParams,
  traitsToProceduralScales,
  type ProceduralScales,
} from "./trait-procedural.js";
import { NO_EXPRESSION_LAYER_GAIN } from "../model/expression-capability.js";
import type { ProceduralParams } from "./procedural-motion.js";

/** 五维取同一组值，只覆盖关心的那一维 */
const traits = (over: Partial<Record<
  "openness" | "extraversion" | "agreeableness" | "neuroticism",
  number
>>) => ({ openness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5, ...over });

const NEUTRAL = traits({});

describe("traitsToProceduralScales — 性格 → 倍率", () => {
  it("五维中性 + 基线精力 → 恒等元（引用相等，不是「数值差不多」）", () => {
    const s = traitsToProceduralScales(NEUTRAL, { energy: BASELINE_ENERGY });
    expect(isIdentityScales(s)).toBe(true);
    expect(s).toBe(IDENTITY_PROCEDURAL_SCALES);
  });

  it("省略精力时按基线算 —— 宠物还没有自己的 mood 时本层仍可用", () => {
    expect(traitsToProceduralScales(NEUTRAL)).toBe(IDENTITY_PROCEDURAL_SCALES);
  });

  it("单调性：每一维各自驱动它该驱动的那个原语", () => {
    const lowOpen = traitsToProceduralScales(traits({ openness: 0.2 }));
    const highOpen = traitsToProceduralScales(traits({ openness: 0.8 }));
    expect(highOpen.sway).toBeGreaterThan(lowOpen.sway);
    // 只动 openness 不该顺带改别的原语
    expect(highOpen.bob).toBe(lowOpen.bob);
    expect(highOpen.breathe).toBe(lowOpen.breathe);

    const lowExtra = traitsToProceduralScales(traits({ extraversion: 0.2 }));
    const highExtra = traitsToProceduralScales(traits({ extraversion: 0.8 }));
    expect(highExtra.bob).toBeGreaterThan(lowExtra.bob);

    const lowAgree = traitsToProceduralScales(traits({ agreeableness: 0.2 }));
    const highAgree = traitsToProceduralScales(traits({ agreeableness: 0.8 }));
    expect(highAgree.nod).toBeGreaterThan(lowAgree.nod);
  });

  it("精力高 → 呼吸幅度大、眨眼更慢（间隔更长）", () => {
    const tired = traitsToProceduralScales(NEUTRAL, { energy: 0.2 });
    const fresh = traitsToProceduralScales(NEUTRAL, { energy: 0.9 });
    expect(fresh.breathe).toBeGreaterThan(tired.breathe);
    expect(fresh.blink).toBeGreaterThan(tired.blink);
  });

  it("神经质高 → 眨眼更快（间隔更短）且更乱（抖动增量为正）", () => {
    const calm = traitsToProceduralScales(traits({ neuroticism: 0.2 }));
    const nervous = traitsToProceduralScales(traits({ neuroticism: 0.8 }));
    expect(nervous.blink).toBeLessThan(calm.blink);
    expect(nervous.blinkJitterBonus).toBeGreaterThan(0);
    // 低神经质反而是**负**增量（比默认更规律），不是 0——否则「稳」没有表达
    expect(calm.blinkJitterBonus).toBeLessThan(0);
  });

  it("中性神经质的抖动增量为 0 —— 恒等元不能悄悄改掉默认眨眼节奏", () => {
    const s = traitsToProceduralScales(traits({ neuroticism: 0.5, openness: 0.8 }));
    expect(s.blinkJitterBonus).toBe(0);
  });

  it("抖动增量不会把 jitter 推出 [0,1)（越过 1 会让间隔变负）", () => {
    const extreme = traitsToProceduralScales(traits({ neuroticism: 1 }));
    expect(BASE_BLINK_JITTER + extreme.blinkJitterBonus).toBeLessThan(1);
  });

  it("低位不取 0：内向的宠物也该会浮动，只是浮得小", () => {
    const s = traitsToProceduralScales(
      traits({ extraversion: 0, openness: 0, agreeableness: 0 }),
      { energy: 0 },
    );
    for (const k of ["bob", "breathe", "sway", "nod", "blink"] as const) {
      expect(s[k]).toBeGreaterThan(0);
    }
  });

  it("极端输入被夹在 [SCALE_MIN, SCALE_MAX]，且非有限数落回中性", () => {
    const wild = traitsToProceduralScales(
      traits({ openness: 99, extraversion: -99, agreeableness: NaN, neuroticism: Infinity }),
      { energy: 1e9 },
    );
    for (const k of ["bob", "breathe", "sway", "nod", "blink"] as const) {
      expect(Number.isFinite(wild[k])).toBe(true);
      expect(wild[k]).toBeGreaterThanOrEqual(SCALE_MIN);
      expect(wild[k]).toBeLessThanOrEqual(SCALE_MAX);
    }
  });
});

describe("scaleProceduralParams — 叠到清单声明的参数上", () => {
  const base: ProceduralParams = { bob: 9, breathe: 1.01, blink: 3200 };
  /** 一个非恒等的倍率组：只为验证「不凭空造字段」「不改入参」这类与补偿无关的性质。
   *  **不碰 blink**——下面「不凭空填字段」那条用 `{blink:1000}` 当入参，blink 倍率必须留 1。 */
  const NON_IDENTITY = { ...IDENTITY_PROCEDURAL_SCALES, bob: 1.5, sway: 1.2 }

  it("没声明原语的组保持没声明 —— 不凭空造动作", () => {
    expect(scaleProceduralParams(undefined, NON_IDENTITY)).toBeUndefined();
  });

  it("恒等倍率原样返回入参（引用相等）", () => {
    const out = scaleProceduralParams(base, IDENTITY_PROCEDURAL_SCALES);
    expect(out).toBe(base);
  });

  it("呼吸乘的是**偏离量**而不是总量（写错会让宠物整体胀一圈）", () => {
    const out = scaleProceduralParams(base, { ...IDENTITY_PROCEDURAL_SCALES, breathe: 1.5 })!;
    // 1 + (1.01-1)×1.5 = 1.015，而不是 1.01×1.5 = 1.515
    expect(out.breathe).toBeCloseTo(1.015, 10);
  });

  it("bob / blink 是幅度与间隔，直接乘", () => {
    const out = scaleProceduralParams(base, {
      ...IDENTITY_PROCEDURAL_SCALES,
      bob: 1.5,
      blink: 0.5,
    })!;
    expect(out.bob).toBeCloseTo(13.5, 10);
    expect(out.blink).toBeCloseTo(1600, 10);
  });

  it("清单没声明的字段不会被凭空填上", () => {
    const out = scaleProceduralParams({ blink: 1000 }, NON_IDENTITY)!;
    expect(out).toEqual({ blink: 1000 });
  });

  it("不修改入参对象", () => {
    const copy = { ...base };
    scaleProceduralParams(base, NON_IDENTITY);
    expect(base).toEqual(copy);
  });
});

describe("composeScales — 性格 × 无表情层补偿", () => {
  it("a 恒等 → 返回 b；b 恒等 → 返回 a（保持引用，供快路径判定）", () => {
    const s: ProceduralScales = { ...IDENTITY_PROCEDURAL_SCALES, bob: 1.2 };
    expect(composeScales(IDENTITY_PROCEDURAL_SCALES, s)).toBe(s);
    expect(composeScales(s, IDENTITY_PROCEDURAL_SCALES)).toBe(s);
  });

  it("倍率相乘，抖动增量相加（增量乘增量没有物理意义）", () => {
    const a: ProceduralScales = { ...IDENTITY_PROCEDURAL_SCALES, bob: 1.2, blinkJitterBonus: 0.3 };
    const b: ProceduralScales = { ...IDENTITY_PROCEDURAL_SCALES, bob: 1.5, blinkJitterBonus: 0.1 };
    const c = composeScales(a, b);
    expect(c.bob).toBeCloseTo(1.8, 10);
    expect(c.blinkJitterBonus).toBeCloseTo(0.4, 10);
  });

  it("合成结果也被夹取", () => {
    const big = (k: number): ProceduralScales => ({ ...IDENTITY_PROCEDURAL_SCALES, bob: k });
    expect(composeScales(big(1.8), big(1.8)).bob).toBeLessThanOrEqual(SCALE_MAX);
  });
});

describe("amplifyExpressiveDeviation — 无表情层模型的表达补偿", () => {
  const neutral = traitsToProceduralScales(traits({}))

  it("恒等 / gain=1 原样返回（引用相等，供快路径判定）", () => {
    expect(amplifyExpressiveDeviation(IDENTITY_PROCEDURAL_SCALES, 1)).toBe(IDENTITY_PROCEDURAL_SCALES)
    const s = traitsToProceduralScales(traits({ neuroticism: 0.8 }))
    expect(amplifyExpressiveDeviation(s, 1)).toBe(s)
    expect(amplifyExpressiveDeviation(s, Number.NaN)).toBe(s)
  })

  it("只放大偏离量，不做整体平移 —— 平移改的是性格不是表现力", () => {
    const nervous = traitsToProceduralScales(traits({ neuroticism: 0.85 }))
    const boosted = amplifyExpressiveDeviation(nervous, NO_EXPRESSION_LAYER_GAIN)
    const expected = 1 + (nervous.blink - 1) * NO_EXPRESSION_LAYER_GAIN
    expect(boosted.blink).toBeCloseTo(expected, 10)
    // 神经质的眨眼比基准快（<1），放大后应当**更快**，而不是被推过 1
    expect(nervous.blink).toBeLessThan(1)
    expect(boosted.blink).toBeLessThan(nervous.blink)
  })

  it("反向也放大：低神经质（眨眼更慢）在补偿后更慢", () => {
    const calm = traitsToProceduralScales(traits({ neuroticism: 0.15 }))
    const boosted = amplifyExpressiveDeviation(calm, NO_EXPRESSION_LAYER_GAIN)
    expect(calm.blink).toBeGreaterThan(1)
    expect(boosted.blink).toBeGreaterThan(calm.blink)
  })

  it("抖动增量同倍放大（「快而乱」里的「乱」也在补偿范围内）", () => {
    const nervous = traitsToProceduralScales(traits({ neuroticism: 0.85 }))
    const boosted = amplifyExpressiveDeviation(nervous, NO_EXPRESSION_LAYER_GAIN)
    expect(boosted.blinkJitterBonus).toBeCloseTo(nervous.blinkJitterBonus * NO_EXPRESSION_LAYER_GAIN, 10)
    // 不能越过 1：越过时 `mean×(1−jitter)` 为负，眨眼序列会错乱
    expect(BASE_BLINK_JITTER + boosted.blinkJitterBonus).toBeLessThan(1)
  })

  it("★ 幅度类原样透传 —— 转投后不再在它们上面做补偿", () => {
    const nervous = traitsToProceduralScales(traits({ extraversion: 0.8, openness: 0.8, neuroticism: 0.8 }))
    const boosted = amplifyExpressiveDeviation(nervous, NO_EXPRESSION_LAYER_GAIN)
    for (const k of ["bob", "breathe", "sway", "nod"] as const) {
      // 引用相等不可能（对象是新的），但**数值必须一字不差**
      expect(boosted[k]).toBe(nervous[k])
    }
  })

  it("中性性格放大后仍是中性（偏离为 0，乘什么都还是 0）", () => {
    const boosted = amplifyExpressiveDeviation(neutral, NO_EXPRESSION_LAYER_GAIN)
    expect(boosted.blink).toBe(1)
    expect(boosted.blinkJitterBonus).toBe(0)
  })

  it("增益被夹取，不会把 blink 推出 [SCALE_MIN, SCALE_MAX]", () => {
    const extreme = amplifyExpressiveDeviation(traitsToProceduralScales(traits({ neuroticism: 0 })), 100)
    expect(extreme.blink).toBeGreaterThanOrEqual(SCALE_MIN)
    expect(extreme.blink).toBeLessThanOrEqual(SCALE_MAX)
  })
});
