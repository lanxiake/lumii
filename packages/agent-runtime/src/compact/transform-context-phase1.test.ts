import { describe, it, expect, vi } from "vitest";
import { createTransformContext } from "./transform-context.js";
import { estimateTokenCount } from "./token-estimate.js";
import type { CompactConfig } from "./types.js";
import type { AgentMessage } from "../types.js";

/**
 * Phase 1 分档触发的集成断言。
 *
 * 两个易踩的前提，写死在这里避免后人再改错：
 * - transform 返回值恒为新数组（finalizeHistoryMessages 内部 copy），
 *   因此「未触发」只能断言 token 不变，不能断言引用相等。
 * - 序列必须以非 toolResult 开头，否则 stripLeadingOrphanToolResults 会把整串削空。
 * - token 估算约 0.30/字符：20 条≈43K、25 条≈54K、30 条≈65K。
 */
describe("transform-context Phase 1 集成：Proactive Prune 接入", () => {
  let seq = 0;
  const toolResult = (content: string): AgentMessage =>
    ({
      id: `t${(seq += 1)}`,
      role: "toolResult",
      toolName: "bash",
      content,
      createdAt: 0,
    }) as unknown as AgentMessage;

  const assistant = (): AgentMessage =>
    ({
      id: `a${(seq += 1)}`,
      role: "assistant",
      content: "hi",
      createdAt: 0,
    }) as unknown as AgentMessage;

  /** 首条 assistant 打底，其后 count 条各 7200 字符的 toolResult */
  const makeMessages = (count: number): AgentMessage[] => [
    assistant(),
    ...Array.from({ length: count }, () => toolResult("x".repeat(7200))),
  ];

  const baseConfig = {
    contextWindow: 100_000,
    triggerRatio: 0.78, // 78K 才触发 Summary
    microCompactRatio: 0.6, // 60K 才触发 Micro
    proactivePruneRatio: 0.48, // 48K 触发 Proactive
    outputReserveTokens: 1_000,
    summaryReserveTokens: 500,
  } satisfies Partial<CompactConfig>;

  it("0.48≤tokens<0.60 区间触发 Proactive，静默不发 onCompaction", async () => {
    const onCompaction = vi.fn();
    const transform = createTransformContext({
      ...baseConfig,
      onCompaction,
    } as CompactConfig);

    const messages = makeMessages(25); // ≈54K，落在 [48K, 60K)
    const before = estimateTokenCount(messages);
    expect(before).toBeGreaterThanOrEqual(48_000);
    expect(before).toBeLessThan(60_000);

    const result = await transform(messages);

    // 三阶段确定性剪枝真的回收了 token
    expect(estimateTokenCount(result)).toBeLessThan(before);
    // Proactive 是后台静默清理，不暴露 UI 事件
    expect(onCompaction).not.toHaveBeenCalled();
  });

  it("tokens<0.48 什么都不做", async () => {
    const transform = createTransformContext({
      ...baseConfig,
      onCompaction: undefined,
    } as CompactConfig);

    const messages = [assistant(), toolResult("x".repeat(10_000))]; // ≈3K
    const before = estimateTokenCount(messages);
    const result = await transform(messages);

    // 未触发任何策略：条数与 token 均不变
    expect(result).toHaveLength(messages.length);
    expect(estimateTokenCount(result)).toBe(before);
  });

  it("连转两轮 54K→43K：第二轮 Rearm 挡下不再剪枝", async () => {
    const transform = createTransformContext({
      ...baseConfig,
    } as CompactConfig);

    await transform(makeMessages(25)); // 第一轮 ≈54K，触发并武装 rearm 跑道

    const second = makeMessages(20); // 第二轮 ≈43K，低于 48K 跑道
    const before = estimateTokenCount(second);
    const result = await transform(second);

    // 被 Rearm Gate 挡下：token 原样返回
    expect(estimateTokenCount(result)).toBe(before);
    expect(result).toHaveLength(second.length);
  });

  it("Proactive 未通过 Reclaim Gate 时，MicroCompact 接手并发 strategy='micro'", async () => {
    const onCompaction = vi.fn();
    const transform = createTransformContext({
      ...baseConfig,
      // 把回收门槛拉到不可达，让 Proactive 必定被 Reclaim Gate 拒绝，
      // 才能观察到下一级 MicroCompact——Proactive 一旦提交就 return，两级不会同轮级联。
      proactivePruneMinReclaimTokens: 10_000_000,
      onCompaction,
    } as CompactConfig);

    const messages = makeMessages(30); // ≈65K，落在 [60K, 78K)
    const before = estimateTokenCount(messages);
    expect(before).toBeGreaterThanOrEqual(60_000);
    expect(before).toBeLessThan(78_000);

    await transform(messages);

    expect(onCompaction).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "micro" }),
    );
  });
});
