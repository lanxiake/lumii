/**
 * Phase 3 Task 4：Idle 压缩冷却保护
 *
 * 两类冷却互斥且失败优先：
 *  - 失败冷却 10min：事务 ROLLBACK / 抛异常 / 无可压缩内容
 *  - 收益冷却 30min：压成功但回收 tokens 太少（等于没压）
 */
import { describe, it, expect } from "vitest";
import {
  decideIdleCooldownMs,
  shouldIdleCompact,
  IDLE_COOLDOWN_FAILURE_MS,
  IDLE_COOLDOWN_LOW_YIELD_MS,
} from "./idle-trigger.js";

describe("decideIdleCooldownMs", () => {
  it("success=false（事务回滚）→ 失败冷却 10min，不被误判成收益过低", () => {
    // 回滚后 before === after，收益为 0，若不优先判失败就会落到 30min 收益冷却
    const r = decideIdleCooldownMs({ success: false, tokensBefore: 100_000, tokensAfter: 100_000 });
    expect(r.cooldownMs).toBe(IDLE_COOLDOWN_FAILURE_MS);
    expect(r.reason).toContain("事务回滚");
  });

  it("收益足够（回收 50%、远超 4096 tokens）→ 不冷却", () => {
    const r = decideIdleCooldownMs({ success: true, tokensBefore: 100_000, tokensAfter: 50_000 });
    expect(r.cooldownMs).toBe(0);
  });

  it("比例够但绝对量不足（回收 1000 tokens）→ 收益冷却 30min", () => {
    const r = decideIdleCooldownMs({ success: true, tokensBefore: 2_000, tokensAfter: 1_000 });
    expect(r.cooldownMs).toBe(IDLE_COOLDOWN_LOW_YIELD_MS);
  });

  it("绝对量够但比例不足（100 万里回收 5 万 = 5%）→ 收益冷却 30min", () => {
    const r = decideIdleCooldownMs({
      success: true,
      tokensBefore: 1_000_000,
      tokensAfter: 950_000,
    });
    expect(r.cooldownMs).toBe(IDLE_COOLDOWN_LOW_YIELD_MS);
    expect(r.reason).toContain("5.0%");
  });

  it("tokensBefore=0 不产生 NaN 比例，按收益过低处理", () => {
    const r = decideIdleCooldownMs({ success: true, tokensBefore: 0, tokensAfter: 0 });
    expect(r.cooldownMs).toBe(IDLE_COOLDOWN_LOW_YIELD_MS);
  });
});

describe("冷却与 shouldIdleCompact 联动", () => {
  const base = {
    enabled: true,
    idleAfterSeconds: 300,
    idleGapSeconds: 600,
    tokens: 900_000,
    floorTokens: 780_000,
  };

  it("冷却期内 Idle 一律拒绝；冷却过期后恢复触发", () => {
    const now = Date.now();
    const until = now + IDLE_COOLDOWN_FAILURE_MS;
    expect(shouldIdleCompact({ ...base, cooldownActive: now < until })).toBe(false);
    // 11min 后
    const later = now + 11 * 60_000;
    expect(shouldIdleCompact({ ...base, cooldownActive: later < until })).toBe(true);
  });

  it("连续 3 次低收益压缩累计冷却 30min，期间不重试", () => {
    let cooldownUntil = 0;
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) {
      const { cooldownMs } = decideIdleCooldownMs({
        success: true,
        tokensBefore: 1_000_000,
        tokensAfter: 950_000,
      });
      cooldownUntil = t0 + cooldownMs;
    }
    expect(cooldownUntil - t0).toBe(IDLE_COOLDOWN_LOW_YIELD_MS);
    expect(shouldIdleCompact({ ...base, cooldownActive: t0 + 29 * 60_000 < cooldownUntil })).toBe(
      false,
    );
  });

  it("一次高收益压缩后冷却清零，下次 Idle 可正常触发", () => {
    const { cooldownMs } = decideIdleCooldownMs({
      success: true,
      tokensBefore: 1_000_000,
      tokensAfter: 400_000,
    });
    expect(cooldownMs).toBe(0);
    expect(shouldIdleCompact({ ...base, cooldownActive: false })).toBe(true);
  });
});
