import { describe, it, expect } from "vitest";
import { pinIdleFrames, checkIdlePin } from "./idle-pin.js";
import type { SpriteFrameRef } from "./sprite-manifest.js";

const idle: SpriteFrameRef = { base: "body_00", face: { eyes: "eye_open" }, durationMs: 420 };

const wave: SpriteFrameRef[] = [
  { base: "wave_00", durationMs: 300 },
  { base: "wave_01", durationMs: 200 },
  { base: "wave_02", durationMs: 460 },
  { base: "wave_03", durationMs: 240 },
];

describe("pinIdleFrames — 装配", () => {
  it("前后各插一格待机，原帧一帧不少、顺序不变", () => {
    const out = pinIdleFrames(wave, idle);
    expect(out.map((f) => f.base)).toEqual([
      "body_00",
      "wave_00",
      "wave_01",
      "wave_02",
      "wave_03",
      "body_00",
    ]);
  });

  it("首末格带上待机的槽位声明（否则渲染时面部层会缺档）", () => {
    const out = pinIdleFrames(wave, idle);
    expect(out[0]!.face).toEqual({ eyes: "eye_open" });
    expect(out[out.length - 1]!.face).toEqual({ eyes: "eye_open" });
  });

  it("不改入参", () => {
    const before = JSON.stringify(wave);
    pinIdleFrames(wave, idle);
    expect(JSON.stringify(wave)).toBe(before);
  });

  it("首末两格是彼此独立的副本", () => {
    const out = pinIdleFrames(wave, idle);
    expect(out[0]).not.toBe(out[out.length - 1]);
    expect(out[0]!.face).not.toBe(out[out.length - 1]!.face);
  });

  it("空动作原样返回，不会凭空造出两格", () => {
    expect(pinIdleFrames([], idle)).toEqual([]);
  });
});

describe("pinIdleFrames — 时长", () => {
  /**
   * 待机帧自己的 `durationMs` 是**待机循环的节奏**（420ms 是因为它在一个四帧呼吸
   * 循环里），搬进一次性动作没有意义。首末格该沿用的是**被锚定动作**的节奏。
   */
  it("默认沿用被锚定动作首末格的时长，而不是待机帧自己的", () => {
    const out = pinIdleFrames(wave, idle);
    expect(out[0]!.durationMs).toBe(300); // wave 首格，不是 idle 的 420
    expect(out[out.length - 1]!.durationMs).toBe(240); // wave 末格
  });

  it("可显式指定首末格时长", () => {
    const out = pinIdleFrames(wave, idle, { headMs: 500, tailMs: 600 });
    expect(out[0]!.durationMs).toBe(500);
    expect(out[out.length - 1]!.durationMs).toBe(600);
  });

  it("被锚定动作没声明时长时，首末格也不声明（交给 fps 均分，不塞 0）", () => {
    const bare: SpriteFrameRef[] = [{ base: "w0" }, { base: "w1" }];
    const out = pinIdleFrames(bare, idle);
    expect(out[0]!.durationMs).toBeUndefined();
    expect(out[out.length - 1]!.durationMs).toBeUndefined();
  });

  it("时长非法（0 / 负数）时同样不声明", () => {
    const out = pinIdleFrames(wave, idle, { headMs: 0, tailMs: -5 });
    expect(out[0]!.durationMs).toBeUndefined();
    expect(out[out.length - 1]!.durationMs).toBeUndefined();
  });
});

describe("checkIdlePin — 验收", () => {
  it("钉好的动作通过", () => {
    const frames = pinIdleFrames(wave, idle);
    expect(checkIdlePin({ kind: "once", group: "Wave", next: "Idle", frames }, idle)).toEqual({
      ok: true,
    });
  });

  it("循环动作不判（钉它等于把循环掐断，语义相反）", () => {
    expect(checkIdlePin({ kind: "loop", group: "Idle", frames: wave }, idle)).toEqual({ ok: true });
  });

  it("首格不是待机姿态 → 报出会跳", () => {
    const r = checkIdlePin({ kind: "once", group: "Wave", next: "Idle", frames: wave }, idle);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("首格");
  });

  it("只钉了一头也要报出来", () => {
    const frames = pinIdleFrames(wave, idle);
    frames[frames.length - 1] = { base: "wave_03" };
    const r = checkIdlePin({ kind: "once", group: "Wave", next: "Idle", frames }, idle);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("末格");
  });

  it("只差一个槽位部件也算没钉住", () => {
    // 首格是待机那帧，但眼睛是闭着的——接上去仍然会突脸
    const frames = pinIdleFrames(wave, idle);
    frames[0] = { base: "body_00", face: { eyes: "eye_shut" } };
    const r = checkIdlePin({ kind: "once", group: "Wave", next: "Idle", frames }, idle);
    expect(r.ok).toBe(false);
  });

  /**
   * `JSON.stringify` 按键序输出，而清单是手也可以改的。不排序的话，
   * 同样两个键写反了顺序就会被判成「不是同一帧」——检查开始误报。
   */
  it("键序不同不算差异", () => {
    const frames = pinIdleFrames(wave, idle);
    frames[0] = { face: { eyes: "eye_open" }, base: "body_00", durationMs: 300 };
    expect(checkIdlePin({ kind: "once", group: "Wave", next: "Idle", frames }, idle)).toEqual({
      ok: true,
    });
  });

  it("帧数不足两帧时报出来", () => {
    const r = checkIdlePin({ kind: "once", group: "Wave", frames: [{ base: "body_00" }] }, idle);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("两端钉不住");
  });
});
