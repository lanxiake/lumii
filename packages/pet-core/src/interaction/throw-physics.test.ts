import { describe, it, expect } from "vitest";
import {
  DEFAULT_VELOCITY_WINDOW_MS,
  estimateVelocity,
  isThrowable,
  stepThrow,
  type DragSample,
  type ThrowBody,
  type ThrowBounds,
} from "./throw-physics.js";

const BOUNDS: ThrowBounds = { minX: 0, maxX: 1000, groundY: 500 };
const at = (over: Partial<ThrowBody> = {}): ThrowBody => ({ x: 500, y: 100, vx: 0, vy: 0, ...over });

describe("stepThrow — 抛物线积分", () => {
  it("自由落体：位置符合解析解（半隐式欧拉）", () => {
    // vy 先加 g·dt，再走位置：y = vy0·dt + g·dt²
    const r = stepThrow(at({ vy: 0 }), 0.1, BOUNDS, { gravity: 1000 });
    expect(r.body.vy).toBeCloseTo(100, 6);
    expect(r.body.y).toBeCloseTo(100 + 1000 * 0.1 * 0.1, 6);
    expect(r.landed).toBe(false);
  });

  it("水平速度不衰减（空气阻力不建模）", () => {
    const r = stepThrow(at({ vx: 200 }), 0.05, BOUNDS);
    expect(r.body.vx).toBe(200);
    expect(r.body.x).toBeCloseTo(510, 6);
  });

  it("落地：y 停在 groundY，速度归零", () => {
    const r = stepThrow(at({ y: 490, vy: 3000 }), 0.1, BOUNDS);
    expect(r.landed).toBe(true);
    expect(r.body.y).toBe(500);
    expect(r.body.vx).toBe(0);
    expect(r.body.vy).toBe(0);
  });

  it("恰好落在地面线上也算落地", () => {
    const r = stepThrow(at({ y: 500 }), 0.016, BOUNDS);
    expect(r.landed).toBe(true);
  });

  it("撞左边界反弹：位置夹住、横向速度反向且衰减", () => {
    const r = stepThrow(at({ x: 5, vx: -400 }), 0.1, BOUNDS, { restitution: 0.5 });
    expect(r.bouncedX).toBe(true);
    expect(r.body.x).toBe(0);
    expect(r.body.vx).toBeCloseTo(200, 6);
  });

  it("撞右边界反弹", () => {
    const r = stepThrow(at({ x: 995, vx: 400 }), 0.1, BOUNDS, { restitution: 0.5 });
    expect(r.bouncedX).toBe(true)
    expect(r.body.x).toBe(1000)
    expect(r.body.vx).toBeCloseTo(-200, 6)
  })

  it("落地优先于反弹：同时满足时按落地处理（不该落地还在横着弹）", () => {
    const r = stepThrow(at({ x: 995, y: 499, vx: 400, vy: 4000 }), 0.1, BOUNDS)
    expect(r.landed).toBe(true)
    expect(r.body.vx).toBe(0)
  })

  it("dt 为 0 或负数时原样返回（换帧/切回页面时会出现）", () => {
    const body = at({ vx: 100, vy: 200 })
    expect(stepThrow(body, 0, BOUNDS).body).toEqual(body)
    expect(stepThrow(body, -0.5, BOUNDS).body).toEqual(body)
  })

  it("不修改传入的物体（纯函数）", () => {
    const body = at({ vx: 100, vy: 200 })
    const before = JSON.stringify(body)
    stepThrow(body, 0.1, BOUNDS)
    expect(JSON.stringify(body)).toBe(before)
  })

  it("**不变量**：任何输入下输出都是有限数", () => {
    // 物理量漏出 NaN 会让宠物直接消失在屏幕上，而且极难反查——
    // 这条不是"防御性编程"，是踩过同类问题后定的硬要求。
    const nasty: ThrowBody[] = [
      at({ x: NaN, y: NaN, vx: NaN, vy: NaN }),
      at({ x: Infinity, y: -Infinity, vx: Infinity, vy: -Infinity }),
      at({ x: 1e308, y: 1e308, vx: 1e308, vy: 1e308 }),
    ]
    for (const body of nasty) {
      for (const dt of [0.016, 1, 1000, NaN, Infinity]) {
        const r = stepThrow(body, dt, BOUNDS)
        expect(Number.isFinite(r.body.x), `x body=${JSON.stringify(body)} dt=${dt}`).toBe(true)
        expect(Number.isFinite(r.body.y)).toBe(true)
        expect(Number.isFinite(r.body.vx)).toBe(true)
        expect(Number.isFinite(r.body.vy)).toBe(true)
      }
    }
  })
})

describe("estimateVelocity — 释放速度估计", () => {
  const s = (x: number, y: number, t: number): DragSample => ({ x, y, t })

  it("匀速拖拽：速度 = 位移 / 时间", () => {
    // 100ms 内走了 50px → 500 px/s
    const v = estimateVelocity([s(0, 0, 0), s(25, 10, 50), s(50, 20, 100)], 100)
    expect(v.vx).toBeCloseTo(500, 6)
    expect(v.vy).toBeCloseTo(200, 6)
  })

  it("只取时间窗内的采样：窗口外的慢速段不拖后腿", () => {
    const samples = [
      s(0, 0, 0), // 窗口外（慢）
      s(1, 0, 500), // 窗口外（慢）
      s(100, 0, 950), // 窗口内起点
      s(200, 0, 1000), // 窗口内终点：50ms 走了 100px → 2000 px/s
    ]
    const v = estimateVelocity(samples, 100)
    expect(v.vx).toBeCloseTo(2000, 6)
  })

  it("采样不足两点 → 零速度（退化为原地落下，不猜）", () => {
    expect(estimateVelocity([], 100)).toEqual({ vx: 0, vy: 0 })
    expect(estimateVelocity([s(10, 10, 0)], 100)).toEqual({ vx: 0, vy: 0 })
  })

  it("时间差为 0 → 零速度（不产生 Infinity）", () => {
    const v = estimateVelocity([s(0, 0, 100), s(50, 50, 100)], 100)
    expect(v).toEqual({ vx: 0, vy: 0 })
  })

  it("**不变量**：任何输入下都返回有限数", () => {
    const nasty: DragSample[][] = [
      [s(NaN, NaN, NaN), s(NaN, NaN, NaN)],
      [s(Infinity, 0, 0), s(0, 0, 100)],
      [s(0, 0, -1e9), s(1, 1, 1e9)],
    ]
    for (const samples of nasty) {
      const v = estimateVelocity(samples)
      expect(Number.isFinite(v.vx)).toBe(true)
      expect(Number.isFinite(v.vy)).toBe(true)
    }
  })

  it("窗口参数非法时不崩", () => {
    const v = estimateVelocity([s(0, 0, 0), s(10, 0, 10)], NaN)
    expect(Number.isFinite(v.vx)).toBe(true)
  })

  it("默认窗口是 100ms 左右（改了要有意识）", () => {
    expect(DEFAULT_VELOCITY_WINDOW_MS).toBe(100)
  })
})

describe("isThrowable — 够不够得上「抛出」", () => {
  it("超过阈值算抛出", () => {
    expect(isThrowable({ vx: 400, vy: 0 }, 320)).toBe(true)
    expect(isThrowable({ vx: 0, vy: -400 }, 320)).toBe(true)
    expect(isThrowable({ vx: 300, vy: 300 }, 320)).toBe(true) // 合速度 424
  })

  it("低于阈值算原地落下（慢拖松手不该被抖出去）", () => {
    expect(isThrowable({ vx: 100, vy: 0 }, 320)).toBe(false)
    expect(isThrowable({ vx: 0, vy: 0 }, 320)).toBe(false)
  })

  it("非有限速度视为不可抛", () => {
    expect(isThrowable({ vx: NaN, vy: NaN })).toBe(false)
  })
})

describe("stepThrow — 顶部边界（不能飞出屏幕）", () => {
  const B = { minX: 0, maxX: 1000, groundY: 800, minY: 0 }

  it("撞顶边带着**反向**速度弹回来，不是糊在天花板上", () => {
    const r = stepThrow({ x: 500, y: 2, vx: 0, vy: -600 }, 1 / 60, B)
    expect(r.body.y).toBe(0)
    expect(r.body.vy).toBeGreaterThan(0)
    expect(r.landed).toBe(false)
    expect(r.bouncedY).toBe(true)
  })

  it("反弹按 restitution 折损能量", () => {
    // 一帧（1/60s）内 vy 从 -600 变到 -600 + 2400/60 = -560，位移约 -9.3，够撞上 y=0。
    // 反射后 |vy| = 560 × 0.55 ≈ 308。**别用更小的 dt**——位移不足时就撞不上，
    // 测出来的是"还在飞"而不是"反弹"（这个用例第一版就栽在这）。
    const r = stepThrow({ x: 500, y: 2, vx: 0, vy: -600 }, 1 / 60, B)
    expect(r.body.vy).toBeGreaterThan(280)
    expect(r.body.vy).toBeLessThan(340)
  })

  it("没给 minY 时不受限——老行为一字不变", () => {
    const r = stepThrow({ x: 500, y: 5, vx: 0, vy: -600 }, 1 / 60, {
      minX: 0,
      maxX: 1000,
      groundY: 800,
    })
    expect(r.body.y).toBeLessThan(0)
    expect(r.bouncedY).toBe(false)
  })

  it("没撞顶边时 bouncedY 是 false（别把正常飞行报成碰撞）", () => {
    const r = stepThrow({ x: 500, y: 300, vx: 0, vy: -100 }, 1 / 60, B)
    expect(r.bouncedY).toBe(false)
  })
})
