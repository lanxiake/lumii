import { describe, it, expect, vi } from "vitest";
import { StuckGuard, type StuckGuardDeps } from "../stuck-guard.js";
import { detectToolLoop } from "../../agent/stuck-detection.js";

// ---- detectToolLoop 纯函数 ----

describe("detectToolLoop", () => {
  it("样本不足（<14）时不判定", () => {
    const names = Array.from({ length: 13 }, () => "a:1");
    expect(detectToolLoop(names)).toBeNull();
  });

  it("单工具高频（>=18/20）判定循环", () => {
    const names = Array.from({ length: 20 }, () => "search:{}");
    const result = detectToolLoop(names);
    expect(result).toContain("search:{}");
    expect(result).toContain("/20");
  });

  it("短序列交替（长度2出现6+次）判定循环", () => {
    // [a,b] 交替重复 8 次 = 16 条
    const names: string[] = [];
    for (let i = 0; i < 8; i++) {
      names.push("a:1", "b:2");
    }
    const result = detectToolLoop(names);
    expect(result).toContain("sequence");
  });

  it("多样化工具调用不判定循环", () => {
    const names = Array.from({ length: 20 }, (_, i) => `tool${i}:${i}`);
    expect(detectToolLoop(names)).toBeNull();
  });
});

// ---- StuckGuard 状态机 ----

function makeDeps(overrides: Partial<StuckGuardDeps> = {}): {
  deps: StuckGuardDeps;
  steer: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  turnRef: { value: number };
} {
  const steer = vi.fn();
  const followUp = vi.fn();
  const abort = vi.fn();
  const turnRef = { value: 0 };
  const deps: StuckGuardDeps = {
    instanceId: "test",
    duplicateContentThreshold: 2,
    getMessages: () => [],
    getTurnCount: () => turnRef.value,
    steer,
    followUp,
    abort,
    ...overrides,
  };
  return { deps, steer, followUp, abort, turnRef };
}

/** 注入 20 条相同工具指纹，触发单工具高频循环 */
function fillLoop(guard: StuckGuard): void {
  for (let i = 0; i < 20; i++) guard.recordToolCall("search", {});
}

describe("StuckGuard", () => {
  it("未检测到循环时不注入 steer/followUp", () => {
    const { deps, steer, followUp } = makeDeps();
    const guard = new StuckGuard(deps);
    guard.recordToolCall("a", {});
    guard.checkAndHandle();
    expect(steer).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
  });

  it("首次检测到循环：注入 steer，不打断", () => {
    const { deps, steer, followUp, abort } = makeDeps();
    const guard = new StuckGuard(deps);
    fillLoop(guard);
    guard.checkAndHandle();
    expect(steer).toHaveBeenCalledTimes(1);
    expect(followUp).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it("冷却期（3轮）后仍循环：followUp + abort + 置打断标志", () => {
    const { deps, steer, followUp, abort, turnRef } = makeDeps();
    const guard = new StuckGuard(deps);
    // 首次检测在 turn=0 注入 steer
    fillLoop(guard);
    turnRef.value = 0;
    guard.checkAndHandle();
    expect(steer).toHaveBeenCalledTimes(1);
    // 冷却 3 轮后再次检测：硬打断
    fillLoop(guard);
    turnRef.value = 3;
    guard.checkAndHandle();
    expect(followUp).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(guard.consumeLoopInterrupt()).toBe(true);
    // 消费一次后清零
    expect(guard.consumeLoopInterrupt()).toBe(false);
  });

  it("reset() 清空指纹队列，循环检测重新计数", () => {
    const { deps, steer } = makeDeps();
    const guard = new StuckGuard(deps);
    fillLoop(guard);
    guard.reset();
    guard.checkAndHandle();
    expect(steer).not.toHaveBeenCalled();
  });

  it("consumeLoopInterrupt 默认 false", () => {
    const { deps } = makeDeps();
    const guard = new StuckGuard(deps);
    expect(guard.consumeLoopInterrupt()).toBe(false);
  });
});
