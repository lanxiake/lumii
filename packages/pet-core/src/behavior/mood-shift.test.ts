/**
 * 「雀跃 / 蔫」的跨越判定。
 *
 * 这是一条**只该偶尔为真**的判据，所以两侧都要钉：太松会让宠物抽搐（两个 1.6~2.0 秒的
 * 动作被几十毫秒一次的更新反复打断），太紧则这两个动作一年也播不出一次。
 */
import { describe, expect, it } from "vitest";
import {
  detectMoodShift,
  MOOD_CHEER_THRESHOLD,
  MOOD_DROOP_THRESHOLD,
} from "./mood-shift.js";

const at = (valence: number) => ({ valence });

describe("detectMoodShift", () => {
  it("升过阈值 → 雀跃", () => {
    expect(detectMoodShift(at(0), at(0.3))).toBe("cheer");
  });

  it("跌破阈值 → 蔫", () => {
    expect(detectMoodShift(at(0), at(-0.3))).toBe("droop");
  });

  it("**在阈值上方来回动不算跨越**——这正是「按事件播会抽搐」的那个坑", () => {
    // 心情一直不错，每次事件都改 valence，但一次都没跨过线
    expect(detectMoodShift(at(0.5), at(0.25))).toBeNull();
    expect(detectMoodShift(at(0.25), at(0.5))).toBeNull();
  });

  it("刚好落在阈值上算跨过（与 moodToDecisionParams 的严格小于互补，不留缝）", () => {
    expect(detectMoodShift(at(0.1), at(MOOD_CHEER_THRESHOLD))).toBe("cheer");
    expect(detectMoodShift(at(-0.1), at(MOOD_DROOP_THRESHOLD))).toBe("droop");
  });

  it("**第一次读到不算跨越**：那是初始状态，不是「变蔫了」", () => {
    // 上线第一帧就演一遍沮丧是凭空多出来的戏
    expect(detectMoodShift(null, at(-0.9))).toBeNull();
    expect(detectMoodShift(null, at(0.9))).toBeNull();
  });

  it("方向搞反不触发：跌下去不会雀跃，升上来不会蔫", () => {
    expect(detectMoodShift(at(0.5), at(-0.5))).toBe("droop");
    expect(detectMoodShift(at(-0.5), at(0.5))).toBe("cheer");
  });

  it("一路走低但每一步都不过线 → 一次都不播", () => {
    let prev = at(0.9);
    const shifts: Array<string | null> = [];
    for (const v of [0.7, 0.5, 0.3, 0.1, 0]) {
      shifts.push(detectMoodShift(prev, at(v)));
      prev = at(v);
    }
    expect(shifts.every((s) => s === null)).toBe(true);
  });

  it("非有限值不触发（读库坏了的防御，不给它一次假表演）", () => {
    expect(detectMoodShift(at(Number.NaN), at(0.5))).toBeNull();
    expect(detectMoodShift(at(0), at(Number.NaN))).toBeNull();
  });
});
