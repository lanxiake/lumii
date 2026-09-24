import { describe, it, expect, vi } from "vitest";
import { StuckGuard, digestArgs, type StuckGuardDeps } from "../stuck-guard.js";
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

// ---- digestArgs：参数指纹 ----
//
// 守着一个实测踩到的 bug：指纹曾是 `JSON.stringify(args).slice(0, 80)`（**取前缀**）。
// 对「长公共前缀」的调用会整体碰撞 —— bash 的 `cd "<很长的绝对路径>" && node xxx`，
// 前 80 字符全被路径吃掉，换哪个脚本指纹都一样。后果不是漏检而是**误杀**：
// 「反复在同一目录跑不同脚本」的正常多步工作被判成死循环、反复 steer、最后 abort。
// 2026-09-24 做月兔小仙时就因此把一轮跑得正好的任务中断了。
describe("digestArgs", () => {
  const PREFIX = String.raw`cd "C:\Users\me\.lumii\workspace\skills\设计与可视化\pet-sprite-h3\characters" && `;

  it("长公共前缀下的不同命令必须区分开（旧的前缀指纹在这里会碰撞）", () => {
    const a = digestArgs({ command: `${PREFIX}node stage-frame.mjs a.png b.png` });
    const b = digestArgs({ command: `${PREFIX}node h3-motion.mjs sheet --char moonrabbit` });
    expect(a).not.toBe(b);
  });

  it("完全相同的参数仍然得到相同指纹（真重复要抓得住）", () => {
    const args = { command: `${PREFIX}node install-pet.mjs --id demo` };
    expect(digestArgs(args)).toBe(digestArgs({ ...args }));
  });

  it("不能序列化的参数不抛异常", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => digestArgs(circular)).not.toThrow();
  });
});
