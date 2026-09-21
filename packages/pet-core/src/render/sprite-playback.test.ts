import { describe, it, expect } from "vitest";
import { advanceSpriteFrame, type PlaybackState } from "./sprite-playback.js";
import type { SlotState } from "./sprite-runtime.js";

const frames = (n: number): SlotState[] =>
  Array.from({ length: n }, (_, i) => ({ base: `f${i}`, layered: {} }));

/** 只填本函数关心的字段，其余按默认给 */
function anim(over: Partial<Parameters<typeof advanceSpriteFrame>[0]> = {}) {
  return {
    frames: frames(4),
    fps: 8,
    kind: "loop" as const,
    durationsMs: undefined as number[] | undefined,
    ...over,
  };
}

const at = (frame: number, elapsedMs = 0): PlaybackState => ({ frame, elapsedMs });

describe("advanceSpriteFrame — 均速（未声明逐帧时长）", () => {
  it("按 1000/fps 切帧，余量带到下一帧", () => {
    // fps=8 → 125ms 一帧
    const r = advanceSpriteFrame(anim(), at(0), 130);
    expect(r).toEqual({ frame: 1, elapsedMs: 5, advanced: true });
  });

  it("不够一帧就不动，时间攒着", () => {
    const r = advanceSpriteFrame(anim(), at(0), 100);
    expect(r).toEqual({ frame: 0, elapsedMs: 100, advanced: false });
  });

  it("一次 tick 跨多帧", () => {
    // 350ms ≈ 2.8 帧
    const r = advanceSpriteFrame(anim(), at(0), 350);
    expect(r).toEqual({ frame: 2, elapsedMs: 100, advanced: true });
  });

  it("fps 非法（0/负）时按 1fps 兜底，而不是除零", () => {
    const r = advanceSpriteFrame(anim({ fps: 0 }), at(0), 1000);
    expect(r.frame).toBe(1);
  });
});

describe("advanceSpriteFrame — 逐帧时长", () => {
  // 首尾停得久、中间走得快，抄 hatch-pet 的 idle
  const idle = anim({ frames: frames(4), fps: 4, durationsMs: [420, 200, 420, 200] });

  it("长帧要等更久才切", () => {
    // 300ms 在 420ms 的第一帧里还没走完——按均速（250ms）早就切了
    expect(advanceSpriteFrame(idle, at(0), 300)).toEqual({
      frame: 0,
      elapsedMs: 300,
      advanced: false,
    });
  });

  it("超过当前帧时长就切，并扣掉的是**当前帧**的时长", () => {
    expect(advanceSpriteFrame(idle, at(0), 500)).toEqual({
      frame: 1,
      elapsedMs: 80, // 500 - 420，而不是 500 - 250
      advanced: true,
    });
  });

  it("跨到一个短帧时，余量足够就继续切", () => {
    // 420 + 200 = 620 走完两帧，630 落在第三帧 10ms 处
    expect(advanceSpriteFrame(idle, at(0), 630)).toEqual({
      frame: 2,
      elapsedMs: 10,
      advanced: true,
    });
  });

  /**
   * `0` 是「这一帧没声明」，不是「停 0 毫秒」。
   * 后者会让这一帧被瞬间跳过——四帧动作播起来像少了一帧。
   */
  it("某帧时长是 0 时回落到均速，不当成瞬跳", () => {
    const a = anim({ fps: 8, durationsMs: [0, 500, 0, 0] });
    // 第一帧走均速 125ms
    expect(advanceSpriteFrame(a, at(0), 120).frame).toBe(0);
    expect(advanceSpriteFrame(a, at(0), 130)).toMatchObject({ frame: 1, elapsedMs: 5 });
  });
});

describe("advanceSpriteFrame — 循环与单次", () => {
  it("loop 走到末帧后回到第 0 帧", () => {
    const r = advanceSpriteFrame(anim(), at(3), 125);
    expect(r.frame).toBe(0);
  });

  it("once 在末帧停住，不再前进", () => {
    const r = advanceSpriteFrame(anim({ kind: "once" }), at(3), 1000);
    expect(r).toMatchObject({ frame: 3, advanced: false });
  });

  it("once 的中间帧照常前进", () => {
    const r = advanceSpriteFrame(anim({ kind: "once" }), at(1), 125);
    expect(r.frame).toBe(2);
  });
});

describe("advanceSpriteFrame — 边界", () => {
  it("只有一帧时完全不推进", () => {
    const r = advanceSpriteFrame(anim({ frames: frames(1) }), at(0), 100_000);
    expect(r).toEqual({ frame: 0, elapsedMs: 0, advanced: false });
  });

  it("一帧都没有时不崩", () => {
    const r = advanceSpriteFrame(anim({ frames: [] }), at(0), 1000);
    expect(r).toEqual({ frame: 0, elapsedMs: 0, advanced: false });
  });

  /**
   * 防挂死。`durationMs` 合法值可以小到 1ms，而长掉帧（窗口失焦回来、断点停留）
   * 能让 `deltaMS` 到几十万——没有上限的话这个 while 会转几十万次，把主线程钉住。
   */
  it("极小时长 + 巨大 deltaMS 时不会空转，且有推进上限", () => {
    const a = anim({ frames: frames(4), durationsMs: [1, 1, 1, 1] });
    const t0 = Date.now();
    const r = advanceSpriteFrame(a, at(0), 10_000_000);
    expect(Date.now() - t0).toBeLessThan(50);
    expect(r.advanced).toBe(true);
    expect(Number.isFinite(r.elapsedMs)).toBe(true);
  });
});
