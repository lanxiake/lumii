import { describe, it, expect } from "vitest";
import { IDLE_STAGE_DEFAULTS, idleStage } from "./idle-stage.js";

// 阈值从默认值推出来，不写死 60/300：阈值一改，下面这批断言自动跟着走
const D = IDLE_STAGE_DEFAULTS.drowsySec;
const A = IDLE_STAGE_DEFAULTS.asleepSec;

describe("idleStage — 阈值边界", () => {
  it("打盹阈值：前一秒还醒着，到点进打盹", () => {
    expect(idleStage(D - 1)).toBe("awake");
    expect(idleStage(D)).toBe("drowsy");
  });

  it("睡着阈值：前一秒还在打盹，到点睡着", () => {
    expect(idleStage(A - 1)).toBe("drowsy");
    expect(idleStage(A)).toBe("asleep");
  });

  it("刚回到电脑前（秒数归零/个位数）就是醒着", () => {
    expect(idleStage(0)).toBe("awake");
    expect(idleStage(2)).toBe("awake");
  });
});

describe("idleStage — 单调", () => {
  it("秒数增大时阶段只进不退", () => {
    const rank = { awake: 0, drowsy: 1, asleep: 2 } as const;
    let prev = -1;
    // 边界两侧都要采到，所以步长取阈值差的 1/7
    const step = Math.max(1, Math.floor(A / 7));
    for (let s = 0; s <= A + step; s += step) {
      const r = rank[idleStage(s)];
      expect(r, `idleSec=${s} 的阶段倒挂了`).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });

  it("不存在「睡够了自动醒」——秒数只增不减时阶段不会回落", () => {
    // 闲置秒数是系统给的累计值，不会自己减少；宠物醒来靠的是用户输入把它清零。
    // 如果哪天有人往里塞了「睡满 N 秒就醒」的逻辑，这条会红。
    expect(idleStage(A * 10)).toBe("asleep");
  });
});

describe("idleStage — 非法输入", () => {
  it("负数 / NaN / Infinity 一律当作醒着", () => {
    // Infinity 尤其要紧：它数学上 >= asleepSec，判成睡着就是「叫不醒的宠物」
    expect(idleStage(NaN)).toBe("awake");
    expect(idleStage(Infinity)).toBe("awake");
    expect(idleStage(-Infinity)).toBe("awake");
    expect(idleStage(-1)).toBe("awake");
  });

  it("阈值选项非法时退化为默认值", () => {
    expect(idleStage(D, { drowsySec: NaN })).toBe("drowsy");
    expect(idleStage(A, { asleepSec: NaN })).toBe("asleep");
    expect(idleStage(D, { drowsySec: -100 })).toBe("drowsy");
  });

  it("阈值配反时打盹档消失，而不是让阶段倒挂", () => {
    // 睡着（10）配得比打盹（100）还早：睡着阈值被抬到打盹那一档，
    // 于是中间没有打盹区——到 100s 直接睡着，而不是「先睡着再打盹」。
    const inverted = { drowsySec: 100, asleepSec: 10 };
    expect(idleStage(99, inverted)).toBe("awake");
    expect(idleStage(100, inverted)).toBe("asleep");
    expect(idleStage(10_000, inverted)).toBe("asleep");
  });

  it("自定义阈值生效（手测要把阈值调小，这条保证那条路是通的）", () => {
    expect(idleStage(3, { drowsySec: 2, asleepSec: 5 })).toBe("drowsy");
    expect(idleStage(5, { drowsySec: 2, asleepSec: 5 })).toBe("asleep");
  });
});
