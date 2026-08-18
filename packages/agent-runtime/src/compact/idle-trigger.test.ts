import { describe, it, expect } from "vitest";
import { shouldIdleCompact } from "./idle-trigger.js";

describe("shouldIdleCompact - Phase 2: Idle 纯谓词 4 条件 AND", () => {
  it("关闭 enabled=false", () => {
    const result = shouldIdleCompact({
      enabled: false,
      idleAfterSeconds: 300,
      idleGapSeconds: 301,
      tokens: 100_000,
      floorTokens: 20_000,
      cooldownActive: false,
    });
    expect(result).toBe(false);
  });

  it("关闭 idleAfter=0", () => {
    const result = shouldIdleCompact({
      enabled: true,
      idleAfterSeconds: 0,
      idleGapSeconds: 301,
      tokens: 100_000,
      floorTokens: 20_000,
      cooldownActive: false,
    });
    expect(result).toBe(false);
  });

  it("时间不够 299s < 300s", () => {
    const result = shouldIdleCompact({
      enabled: true,
      idleAfterSeconds: 300,
      idleGapSeconds: 299,
      tokens: 100_000,
      floorTokens: 20_000,
      cooldownActive: false,
    });
    expect(result).toBe(false);
  });

  it("时间刚到 301s ✓", () => {
    const result = shouldIdleCompact({
      enabled: true,
      idleAfterSeconds: 300,
      idleGapSeconds: 301,
      tokens: 100_000,
      floorTokens: 20_000,
      cooldownActive: false,
    });
    expect(result).toBe(true);
  });

  it("cooldown 激活（上次失败在冷却内）", () => {
    const result = shouldIdleCompact({
      enabled: true,
      idleAfterSeconds: 300,
      idleGapSeconds: 301,
      tokens: 100_000,
      floorTokens: 20_000,
      cooldownActive: true,
    });
    expect(result).toBe(false);
  });

  it("tokens=5K < floor=20K 压了也白压", () => {
    const result = shouldIdleCompact({
      enabled: true,
      idleAfterSeconds: 300,
      idleGapSeconds: 301,
      tokens: 5_000,
      floorTokens: 20_000,
      cooldownActive: false,
    });
    expect(result).toBe(false);
  });

  it("tokens=21K > floor=20K ✓", () => {
    const result = shouldIdleCompact({
      enabled: true,
      idleAfterSeconds: 300,
      idleGapSeconds: 301,
      tokens: 21_000,
      floorTokens: 20_000,
      cooldownActive: false,
    });
    expect(result).toBe(true);
  });
});
