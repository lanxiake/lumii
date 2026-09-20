import { describe, it, expect } from "vitest";
import { GAZE_DEFAULTS, gazeOffset, type GazeInput } from "./gaze.js";

const H = 100; // 宠物高 100px，比例好算
const g = (dx: number, dy: number, petHeight = H) => gazeOffset({ dx, dy, petHeight });

describe("gazeOffset — 死区", () => {
  it("死区内输出恒为零", () => {
    // 默认死区 0.25 → 25px
    expect(g(0, 0)).toEqual({ tiltDeg: 0, shiftX: 0, shiftY: 0 });
    expect(g(10, 0)).toEqual({ tiltDeg: 0, shiftX: 0, shiftY: 0 });
    expect(g(0, 20)).toEqual({ tiltDeg: 0, shiftX: 0, shiftY: 0 });
    // 斜着刚好在死区内（3-4-5 三角形，距离 25）
    expect(g(15, 20)).toEqual({ tiltDeg: 0, shiftX: 0, shiftY: 0 });
  });

  it("死区边界上仍是零（不跳变）", () => {
    expect(g(25, 0)).toEqual({ tiltDeg: 0, shiftX: 0, shiftY: 0 });
  });

  it("刚出死区时变化很小（smoothstep 起步平缓）", () => {
    const justOutside = g(26, 0);
    expect(Math.abs(justOutside.tiltDeg)).toBeLessThan(0.05);
  });
});

describe("gazeOffset — 方向", () => {
  it("光标在右 → 正倾斜（顺时针），位移向右", () => {
    const r = g(200, 0);
    expect(r.tiltDeg).toBeGreaterThan(0);
    expect(r.shiftX).toBeGreaterThan(0);
    expect(r.shiftY).toBeCloseTo(0, 6);
  });

  it("光标在左 → 负倾斜，位移向左", () => {
    const r = g(-200, 0);
    expect(r.tiltDeg).toBeLessThan(0);
    expect(r.shiftX).toBeLessThan(0);
  });

  it("光标在下 → 位移向下，不产生倾斜（纯上下不倾斜）", () => {
    const r = g(0, 200);
    expect(r.tiltDeg).toBeCloseTo(0, 6);
    expect(r.shiftY).toBeGreaterThan(0);
    expect(r.shiftX).toBeCloseTo(0, 6);
  });

  it("左右对称：镜像输入得到镜像输出", () => {
    const r = g(150, 40);
    const l = g(-150, 40);
    expect(l.tiltDeg).toBeCloseTo(-r.tiltDeg, 6);
    expect(l.shiftX).toBeCloseTo(-r.shiftX, 6);
    expect(l.shiftY).toBeCloseTo(r.shiftY, 6);
  });
});

describe("gazeOffset — 上限", () => {
  it("超过满量程后不再增大", () => {
    const at = g(1000, 0);
    const far = g(100000, 0);
    expect(far.tiltDeg).toBeCloseTo(at.tiltDeg, 6);
    expect(far.shiftX).toBeCloseTo(at.shiftX, 6);
  });

  it("倾斜不超过声明上限", () => {
    for (const dx of [30, 100, 500, 5000]) {
      expect(Math.abs(g(dx, 0).tiltDeg)).toBeLessThanOrEqual(GAZE_DEFAULTS.maxTiltDeg + 1e-9);
    }
  });

  it("位移不超过声明上限（按宠物高度的比例）", () => {
    const max = H * GAZE_DEFAULTS.maxShiftRatio;
    for (const d of [30, 200, 5000]) {
      expect(Math.abs(g(d, 0).shiftX)).toBeLessThanOrEqual(max + 1e-9);
      expect(Math.abs(g(0, d).shiftY)).toBeLessThanOrEqual(max + 1e-9);
    }
  });
});

describe("gazeOffset — 单调性", () => {
  it("离得越远倾斜越大（到上限为止）", () => {
    // 采样点从默认死区/满量程推出来，不写死距离：满量程改小过（2.5 → 0.8），
    // 写死的 [30,60,120,240] 会整组落到满量程之外，报一句看不懂的「6 不大于 6」
    const span = GAZE_DEFAULTS.fullRangeRatio - GAZE_DEFAULTS.deadZoneRatio;
    const xs = [0.1, 0.3, 0.5, 0.9].map((f) => (GAZE_DEFAULTS.deadZoneRatio + span * f) * H);
    const tilts = xs.map((x) => g(x, 0).tiltDeg);
    for (let i = 1; i < tilts.length; i++) {
      expect(
        tilts[i],
        `x=${xs[i].toFixed(1)} 应比 x=${xs[i - 1].toFixed(1)} 更倾斜`,
      ).toBeGreaterThan(tilts[i - 1]);
    }
  });

  it("常见距离上响应可见（满量程定太远的回归）", () => {
    // 实测输入：光标离宠物中心 88px、宠高 136px → 归一化 (-0.182, 0.620)，距离 0.646。
    // 满量程 2.5 时这里 t≈0.08 → 倾斜 0.14°、眼睛几乎不动，肉眼看就是「完全没反应」。
    // 这才是这条测试的意义：满量程再被调远，它会先红。
    const r = gazeOffset({ dx: -0.182, dy: 0.620, petHeight: 1 });
    expect(Math.hypot(0.182, 0.62)).toBeCloseTo(0.646, 3);
    expect(Math.abs(r.tiltDeg)).toBeGreaterThan(0.5);
    // 位移是宠高的比例：0.01 宠高 ≈ 像素猫（56px 画布）眼睛挪 0.8px
    expect(Math.hypot(r.shiftX, r.shiftY)).toBeGreaterThan(0.01);
  });
});

describe("gazeOffset — 尺寸无关", () => {
  it("同一相对位置下，大小不同的宠物表现一致", () => {
    // 大宠物（200px 高）在 2 倍距离处，输出应与小宠物相同
    const small = gazeOffset({ dx: 100, dy: 0, petHeight: 100 });
    const big = gazeOffset({ dx: 200, dy: 0, petHeight: 200 });
    expect(big.tiltDeg).toBeCloseTo(small.tiltDeg, 6);
    // 位移是绝对像素，所以大宠物的位移按比例更大
    expect(big.shiftX).toBeCloseTo(small.shiftX * 2, 6);
  });
});

describe("gazeOffset — 非法输入", () => {
  it("非有限的 dx/dy 一律零输出（NaN 旋转会让角色消失）", () => {
    const nasty: GazeInput[] = [
      { dx: NaN, dy: 0, petHeight: H },
      { dx: Infinity, dy: 0, petHeight: H },
      { dx: 0, dy: NaN, petHeight: H },
      { dx: 0, dy: -Infinity, petHeight: H },
    ];
    for (const input of nasty) {
      expect(gazeOffset(input)).toEqual({ tiltDeg: 0, shiftX: 0, shiftY: 0 });
    }
  });

  it("宠物高度未知（0 / 负 / NaN）时不动", () => {
    // 没有归一化基准，任何偏移都是瞎猜
    expect(gazeOffset({ dx: 100, dy: 100, petHeight: 0 })).toEqual({ tiltDeg: 0, shiftX: 0, shiftY: 0 });
    expect(gazeOffset({ dx: 100, dy: 100, petHeight: -5 })).toEqual({ tiltDeg: 0, shiftX: 0, shiftY: 0 });
    expect(gazeOffset({ dx: 100, dy: 100, petHeight: NaN })).toEqual({ tiltDeg: 0, shiftX: 0, shiftY: 0 });
  });

  it("**不变量**：任何输入下输出都是有限数", () => {
    const nasty = [
      { dx: 1e308, dy: 1e308, petHeight: 1e-308 },
      { dx: NaN, dy: Infinity, petHeight: Infinity },
      { dx: -1e308, dy: 1e308, petHeight: 1 },
    ];
    for (const input of nasty) {
      const r = gazeOffset(input);
      expect(Number.isFinite(r.tiltDeg)).toBe(true);
      expect(Number.isFinite(r.shiftX)).toBe(true);
      expect(Number.isFinite(r.shiftY)).toBe(true);
    }
  });

  it("选项非法时不崩（负数/NaN 退化为默认）", () => {
    const r = gazeOffset({ dx: 500, dy: 0, petHeight: H }, { maxTiltDeg: NaN, deadZoneRatio: -1 });
    expect(Number.isFinite(r.tiltDeg)).toBe(true);
    expect(Math.abs(r.tiltDeg)).toBeLessThanOrEqual(GAZE_DEFAULTS.maxTiltDeg + 1e-9);
  });

  it("选项传 NaN 时退化为 GAZE_DEFAULTS，不是某个遗留字面量", () => {
    // 兜底值曾经和默认值各写一份，默认值改了、兜底那份没跟着改（2.5 vs 0.8）。
    // 这条钉住「默认值只有一个来源」：非法输入等价于不传。
    expect(gazeOffset({ dx: 65, dy: 0, petHeight: H }, { fullRangeRatio: NaN })).toEqual(g(65, 0));
    expect(gazeOffset({ dx: 65, dy: 0, petHeight: H }, { deadZoneRatio: NaN })).toEqual(g(65, 0));
  });
});
