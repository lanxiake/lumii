import { describe, it, expect } from "vitest";
import {
  bobOffset,
  breatheScale,
  swayAngle,
  nodAngle,
  blinkStartTimes,
  BlinkScheduler,
  evaluateProcedural,
  validateProceduralParams,
  PROCEDURAL_DEFAULTS,
  PROCEDURAL_PERIODS,
} from "./procedural-motion.js";

// ---------------------------------------------------------------------------
// bob — 垂直浮动
// ---------------------------------------------------------------------------

describe("bobOffset — 垂直浮动", () => {
  const AMP = 3;
  const PERIOD = PROCEDURAL_PERIODS.bob;

  it("t=0 与 t=周期 归零（保证循环无缝）", () => {
    expect(bobOffset(AMP, 0)).toBeCloseTo(0, 6);
    expect(bobOffset(AMP, PERIOD)).toBeCloseTo(0, 6);
    expect(bobOffset(AMP, PERIOD * 3)).toBeCloseTo(0, 6);
  });

  it("峰值为振幅", () => {
    const peak = Math.max(
      ...Array.from({ length: 400 }, (_, i) => bobOffset(AMP, (i / 400) * PERIOD)),
    );
    expect(peak).toBeCloseTo(AMP, 3);
  });

  it("取值恒在 [-振幅, 振幅]", () => {
    for (let t = 0; t < PERIOD * 2; t += 0.017) {
      const v = bobOffset(AMP, t);
      expect(v).toBeGreaterThanOrEqual(-AMP - 1e-9);
      expect(v).toBeLessThanOrEqual(AMP + 1e-9);
    }
  });

  it("连续无跳变（相邻采样差远小于振幅）", () => {
    let maxJump = 0;
    let prev = bobOffset(AMP, 0);
    for (let t = 0.01; t < PERIOD * 2; t += 0.01) {
      const cur = bobOffset(AMP, t);
      maxJump = Math.max(maxJump, Math.abs(cur - prev));
      prev = cur;
    }
    expect(maxJump).toBeLessThan(AMP * 0.05);
  });

  it("振幅为 0 时恒为 0", () => {
    for (let t = 0; t < PERIOD; t += 0.11) expect(bobOffset(0, t)).toBe(0);
  });

  it("纯函数：同 t 恒等", () => {
    expect(bobOffset(AMP, 1.234)).toBe(bobOffset(AMP, 1.234));
  });
});

// ---------------------------------------------------------------------------
// breathe — 呼吸缩放
// ---------------------------------------------------------------------------

describe("breatheScale — 呼吸缩放", () => {
  const MAX = 1.02;
  const PERIOD = PROCEDURAL_PERIODS.breathe;

  it("t=0 为 1（从静止开始，不突变）", () => {
    expect(breatheScale(MAX, 0)).toBeCloseTo(1, 6);
  });

  it("取值恒在 [1, 倍率]", () => {
    for (let t = 0; t < PERIOD * 2; t += 0.017) {
      const v = breatheScale(MAX, t);
      expect(v).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(v).toBeLessThanOrEqual(MAX + 1e-9);
    }
  });

  it("峰值达到声明倍率", () => {
    const peak = Math.max(
      ...Array.from({ length: 400 }, (_, i) => breatheScale(MAX, (i / 400) * PERIOD)),
    );
    expect(peak).toBeCloseTo(MAX, 4);
  });

  it("倍率为 1 时恒为 1", () => {
    for (let t = 0; t < PERIOD; t += 0.13) expect(breatheScale(1, t)).toBeCloseTo(1, 9);
  });
});

// ---------------------------------------------------------------------------
// sway / nod — 摇摆与点头
// ---------------------------------------------------------------------------

describe("swayAngle — 左右摇摆", () => {
  const AMP = 1.5;
  const PERIOD = PROCEDURAL_PERIODS.sway;

  it("正负对称（t 与 t+半周期 反号）", () => {
    for (let t = 0; t < PERIOD; t += 0.23) {
      expect(swayAngle(AMP, t)).toBeCloseTo(-swayAngle(AMP, t + PERIOD / 2), 6);
    }
  });

  it("t=0 归零，峰值为振幅", () => {
    expect(swayAngle(AMP, 0)).toBeCloseTo(0, 6);
    const peak = Math.max(
      ...Array.from({ length: 400 }, (_, i) => swayAngle(AMP, (i / 400) * PERIOD)),
    );
    expect(peak).toBeCloseTo(AMP, 3);
  });

  it("角度为 0 时恒为 0", () => {
    for (let t = 0; t < PERIOD; t += 0.17) expect(swayAngle(0, t)).toBe(0);
  });
});

describe("nodAngle — 点头", () => {
  it("与 sway 同形状但周期更快", () => {
    expect(PROCEDURAL_PERIODS.nod).toBeLessThan(PROCEDURAL_PERIODS.sway);
    const AMP = 2;
    expect(nodAngle(AMP, 0)).toBeCloseTo(0, 6);
    const peak = Math.max(
      ...Array.from({ length: 400 }, (_, i) => nodAngle(AMP, (i / 400) * PROCEDURAL_PERIODS.nod)),
    );
    expect(peak).toBeCloseTo(AMP, 3);
  });

  it("正负对称", () => {
    const P = PROCEDURAL_PERIODS.nod;
    for (let t = 0; t < P; t += 0.19) {
      expect(nodAngle(2, t)).toBeCloseTo(-nodAngle(2, t + P / 2), 6);
    }
  });
});

// ---------------------------------------------------------------------------
// blink — 眨眼
// ---------------------------------------------------------------------------

describe("blinkStartTimes — 眨眼时刻序列", () => {
  const MEAN = 3200;
  const DURATION = 120;
  const JITTER = 0.4;

  it("确定性：同参数同结果", () => {
    expect(blinkStartTimes(MEAN, 10, DURATION, JITTER)).toEqual(
      blinkStartTimes(MEAN, 10, DURATION, JITTER),
    );
  });

  it("间隔落在期望区间内随机（不是固定值）", () => {
    const times = blinkStartTimes(MEAN, 30, DURATION, JITTER);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    const lo = MEAN * (1 - JITTER);
    const hi = MEAN * (1 + JITTER);
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(lo - 1e-6);
      expect(g).toBeLessThanOrEqual(hi + 1e-6);
    }
    // 不能是常量间隔，否则是机械眨眼
    expect(new Set(gaps.map((g) => Math.round(g))).size).toBeGreaterThan(3);
  });

  it("不连续两次眨眼（相邻间隔 ≥ 2×时长）", () => {
    const times = blinkStartTimes(MEAN, 50, DURATION, JITTER);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(2 * DURATION);
    }
  });

  it("单次眨眼时长为固定值", () => {
    const times = blinkStartTimes(MEAN, 5, DURATION, JITTER);
    // 序列只描述起始时刻，时长由 DURATION 常量决定 —— 用调度器验证闭合窗口
    const s = new BlinkScheduler(MEAN, DURATION, JITTER);
    const t0 = times[0]!;
    expect(s.update(t0 - 1)).toBe(false);
    expect(s.update(t0 + 1)).toBe(true);
    expect(s.update(t0 + DURATION - 1)).toBe(true);
    expect(s.update(t0 + DURATION + 1)).toBe(false);
  });

  it("时刻单调递增", () => {
    const times = blinkStartTimes(MEAN, 20, DURATION, JITTER);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
  });
});

describe("BlinkScheduler — 渲染循环用的眨眼状态", () => {
  const MEAN = 3200;
  const DURATION = 120;

  it("逐帧推进时闭合窗口与序列一致", () => {
    const s = new BlinkScheduler(MEAN, DURATION);
    const times = blinkStartTimes(MEAN, 4, DURATION, 0.4);
    for (let i = 0; i < 4; i++) {
      const t0 = times[i]!;
      expect(s.update(t0 + 10)).toBe(true);
      expect(s.update(t0 + DURATION + 10)).toBe(false);
    }
  });

  it("不眨眼时恒为 false", () => {
    const s = new BlinkScheduler(MEAN, DURATION);
    expect(s.update(0)).toBe(false);
    expect(s.update(50)).toBe(false);
    expect(s.update(100)).toBe(false);
  });

  it("单次眨眼内多次调用恒为 true（不重复触发）", () => {
    const s = new BlinkScheduler(MEAN, DURATION);
    const t0 = blinkStartTimes(MEAN, 1, DURATION, 0.4)[0]!;
    const seen = new Set<boolean>();
    for (let t = t0; t < t0 + DURATION; t += 10) seen.add(s.update(t));
    expect(seen).toEqual(new Set([true]));
  });
});

// ---------------------------------------------------------------------------
// evaluateProcedural — 合成
// ---------------------------------------------------------------------------

describe("evaluateProcedural — 原语合成", () => {
  it("空参数返回单位变换", () => {
    const tr = evaluateProcedural({}, 1.234);
    expect(tr.offsetX).toBe(0);
    expect(tr.offsetY).toBe(0);
    expect(tr.scale).toBe(1);
    expect(tr.rotation).toBe(0);
    expect(tr.blinkClosed).toBe(false);
  });

  it("bob 作用于 offsetY，不污染其他分量", () => {
    const tr = evaluateProcedural({ bob: 4 }, PROCEDURAL_PERIODS.bob / 4);
    expect(tr.offsetY).toBeCloseTo(4, 3);
    expect(tr.offsetX).toBe(0);
    expect(tr.scale).toBe(1);
    expect(tr.rotation).toBe(0);
  });

  it("nod 与 sway 叠加到同一 rotation", () => {
    const t = 0.7;
    const tr = evaluateProcedural({ sway: 1.5, nod: 2 }, t);
    expect(tr.rotation).toBeCloseTo(swayAngle(1.5, t) + nodAngle(2, t), 6);
  });

  it("breathe 作用于 scale", () => {
    const tr = evaluateProcedural({ breathe: 1.05 }, PROCEDURAL_PERIODS.breathe / 2);
    expect(tr.scale).toBeCloseTo(1.05, 4);
  });

  it("确定性：同 t 同参数恒等", () => {
    const p = { bob: 3, sway: 1, nod: 0.5, breathe: 1.02 };
    expect(evaluateProcedural(p, 2.5)).toEqual(evaluateProcedural(p, 2.5));
  });

  it("blink 需要调度器；未传时不眨眼", () => {
    const tr = evaluateProcedural({ blink: 3200 }, 5);
    expect(tr.blinkClosed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateProceduralParams — 安全约束（清单是数据不是代码）
// ---------------------------------------------------------------------------

describe("validateProceduralParams — 参数类型校验", () => {
  it("接受纯数值参数", () => {
    const r = validateProceduralParams({ bob: 3, sway: 1.5, breathe: 1.02, blink: 3200 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params).toEqual({ bob: 3, sway: 1.5, breathe: 1.02, blink: 3200 });
  });

  it("接受空对象", () => {
    const r = validateProceduralParams({});
    expect(r.ok).toBe(true);
  });

  it("拒绝字符串表达式 —— 这是任意代码执行的入口", () => {
    for (const bad of ["sin(t)", "3", "javascript:alert(1)", "${x}"]) {
      const r = validateProceduralParams({ bob: bad });
      expect(r.ok).toBe(false);
    }
  });

  it("拒绝函数与对象", () => {
    expect(validateProceduralParams({ bob: () => 1 }).ok).toBe(false);
    expect(validateProceduralParams({ bob: { toString: () => "1" } }).ok).toBe(false);
    expect(validateProceduralParams({ bob: [1] }).ok).toBe(false);
  });

  it("拒绝 NaN 与 Infinity", () => {
    expect(validateProceduralParams({ bob: NaN }).ok).toBe(false);
    expect(validateProceduralParams({ bob: Infinity }).ok).toBe(false);
    expect(validateProceduralParams({ bob: -Infinity }).ok).toBe(false);
  });

  it("拒绝未知字段（防止夹带）", () => {
    const r = validateProceduralParams({ bob: 1, __proto__evil: 1, script: "x" });
    expect(r.ok).toBe(false);
  });

  it("拒绝非对象输入", () => {
    for (const bad of [null, undefined, "bob:3", 42, [], true]) {
      expect(validateProceduralParams(bad as unknown).ok).toBe(false);
    }
  });

  it("允许负值（反向摇摆等语义合法）", () => {
    const r = validateProceduralParams({ sway: -1.5 });
    expect(r.ok).toBe(true);
  });

  it("失败时给出可定位的错误信息", () => {
    const r = validateProceduralParams({ bob: "sin(t)" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors.join(" ")).toContain("bob");
    }
  });
});

describe("PROCEDURAL_DEFAULTS — 缺省值", () => {
  it("所有原语缺省为 0 值，缺省即静止", () => {
    expect(PROCEDURAL_DEFAULTS.bob).toBe(0);
    expect(PROCEDURAL_DEFAULTS.sway).toBe(0);
    expect(PROCEDURAL_DEFAULTS.nod).toBe(0);
    expect(PROCEDURAL_DEFAULTS.breathe).toBe(1);
    expect(PROCEDURAL_DEFAULTS.blink).toBe(0);
  });

  it("缺省参数经校验后可用", () => {
    const r = validateProceduralParams(PROCEDURAL_DEFAULTS);
    expect(r.ok).toBe(true);
  });
});
