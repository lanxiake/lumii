import { describe, it, expect } from "vitest";
import { stepWalk, walkBoundsOf } from "./locomotion.js";

const bounds = { minX: 100, maxX: 900 };

describe("stepWalk — 匀速前进", () => {
  it("朝右走按速度乘时间前进", () => {
    const r = stepWalk({ x: 500, facing: 1 }, 0.025, 60, bounds); // 60px/s × 25ms
    expect(r.x).toBe(501.5);
    expect(r.facing).toBe(1);
    expect(r.hitBoundary).toBe(false);
  });

  it("朝左走是负方向", () => {
    const r = stepWalk({ x: 500, facing: -1 }, 0.025, 60, bounds);
    expect(r.x).toBe(498.5);
    expect(r.facing).toBe(-1);
  });

  it("速度为 0 时原地不动，但仍返回完整结构", () => {
    const r = stepWalk({ x: 500, facing: 1 }, 0.5, 0, bounds);
    expect(r).toEqual({ x: 500, facing: 1, hitBoundary: false });
  });

  it("dt 为 0 或负数时不动（不倒退）", () => {
    expect(stepWalk({ x: 500, facing: 1 }, 0, 60, bounds).x).toBe(500);
    expect(stepWalk({ x: 500, facing: 1 }, -1, 60, bounds).x).toBe(500);
  });
});

describe("stepWalk — 撞墙折返", () => {
  it("撞左墙：夹到 minX 并转向右", () => {
    const r = stepWalk({ x: 101, facing: -1 }, 0.05, 60, bounds); // 想走 3px，只剩 1px
    expect(r.x).toBe(100);
    expect(r.facing).toBe(1);
    expect(r.hitBoundary).toBe(true);
  });

  it("撞右墙：夹到 maxX 并转向左", () => {
    const r = stepWalk({ x: 899, facing: 1 }, 0.05, 60, bounds);
    expect(r.x).toBe(900);
    expect(r.facing).toBe(-1);
    expect(r.hitBoundary).toBe(true);
  });

  it("正好落在边界上算撞墙（否则贴边那一帧会朝墙内走）", () => {
    expect(stepWalk({ x: 900, facing: 1 }, 0.016, 60, bounds).hitBoundary).toBe(true);
    expect(stepWalk({ x: 100, facing: -1 }, 0.016, 60, bounds).hitBoundary).toBe(true);
  });

  it("折返后下一步朝反方向走（不会卡在墙上抖动）", () => {
    // 一步 50ms（单步上限）→ 3px
    const first = stepWalk({ x: 899, facing: 1 }, 0.05, 60, bounds);
    expect(first.x).toBe(900);
    const second = stepWalk(first, 0.05, 60, bounds);
    expect(second.x).toBe(897);
    expect(second.facing).toBe(-1);
    expect(second.hitBoundary).toBe(false);
  });

  it("初始就在界外时被拉回界内", () => {
    // 模型换尺寸/缩放变化后可能出现越界的存量位置
    expect(stepWalk({ x: 5000, facing: 1 }, 0.016, 60, bounds).x).toBe(900);
    expect(stepWalk({ x: -500, facing: -1 }, 0.016, 60, bounds).x).toBe(100);
  });

  it("minX > maxX 的非法区间不抛错、不返回 NaN", () => {
    const r = stepWalk({ x: 500, facing: 1 }, 0.016, 60, { minX: 900, maxX: 100 });
    expect(Number.isFinite(r.x)).toBe(true);
  });
});

describe("stepWalk — 单步上限", () => {
  it("超长 dt 被夹到 50ms，不会一步跨出屏幕", () => {
    // 标签页切回来时两帧可能隔几秒
    const r = stepWalk({ x: 500, facing: 1 }, 10, 60, bounds);
    expect(r.x).toBe(503); // 60 × 0.05
    expect(r.hitBoundary).toBe(false);
  });

  it("夹取发生在积分之前：高速也不会穿过边界再折返", () => {
    // 6000px/s × 10s 若不夹，会飞到 x=60500 之外
    const r = stepWalk({ x: 500, facing: 1 }, 10, 6000, bounds);
    expect(r.x).toBe(800); // 6000 × 0.05 = 300
  });
});

describe("walkBoundsOf — 画布边界换算成脚能到的地方", () => {
  it("按锚点（脚底中心）左右各留一份，不是半个宽度", () => {
    // 锚点 40、缩放 2 → 屏幕上半宽 80
    expect(walkBoundsOf(1000, 40, 2)).toEqual({ minX: 80, maxX: 920 });
  });

  it("margin 加在两侧", () => {
    expect(walkBoundsOf(1000, 40, 2, 10)).toEqual({ minX: 90, maxX: 910 });
  });

  it("锚点不居中时两侧留白相等（锚点即中心，与画布宽度无关）", () => {
    const b = walkBoundsOf(1000, 30, 1);
    expect(b.maxX - 1000).toBe(-30);
    expect(b.minX).toBe(30);
  });

  it("画布比模型还窄时退化为钉在中间，而不是给出反向区间", () => {
    const b = walkBoundsOf(100, 40, 4); // 半宽 160 > 画布 100
    expect(b.minX).toBe(50);
    expect(b.maxX).toBe(50);
    expect(b.minX).toBeLessThanOrEqual(b.maxX);
  });

  it("缩放为 0 时退化为整幅画布可用", () => {
    expect(walkBoundsOf(1000, 40, 0)).toEqual({ minX: 0, maxX: 1000 });
  });
});
