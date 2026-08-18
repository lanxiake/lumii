import { describe, it, expect, vi } from "vitest";
import { createTransformContext } from "../transform-context.js";
import type { CompactConfig } from "../types.js";
import type { AgentMessage } from "../../types.js";

describe("transform-context Phase 1 集成：Proactive Prune 接入", () => {
  const createToolResult = (content: string): AgentMessage => ({
    id: Math.random().toString(),
    role: "toolResult",
    toolName: "bash",
    content,
    createdAt: Date.now(),
  });

  it("0.48≤tokens<0.60 区间触发 Proactive，不触发 Micro", () => {
    const config: CompactConfig = {
      contextWindow: 100_000,
      triggerRatio: 0.78, // 78K 才触发 Summary
      microCompactRatio: 0.60, // 60K 才触发 Micro
      proactivePruneRatio: 0.48, // 48K 触发 Proactive
    };
    // 构造 tokens ≈ 54K（在 [48K, 60K) 区间）
    const messages: AgentMessage[] = Array.from({ length: 30 }, () =>
      createToolResult("x".repeat(7200)), // 30*7200*0.25≈54K
    );
    const onCompaction = vi.fn();
    const transform = createTransformContext(config, { onCompaction });
    const result = transform(messages);
    // 预期：触发了 Proactive（静默，不调 onCompaction）
    expect(result.length).toBeLessThan(messages.length); // 某些消息被去重/摘要
    expect(onCompaction).not.toHaveBeenCalled(); // Proactive 不触发回调
  });

  it("tokens<0.48 什么都不做", () => {
    const config: CompactConfig = {
      contextWindow: 100_000,
      proactivePruneRatio: 0.48,
    };
    const messages: AgentMessage[] = [createToolResult("x".repeat(10_000))]; // ~2.5K tokens
    const transform = createTransformContext(config, {});
    const result = transform(messages);
    // 预期：原样返回
    expect(result).toBe(messages); // 引用相等
  });

  it("连转两轮 48K→40K→42K：第二轮 Rearm 挡下不触发", () => {
    const config: CompactConfig = {
      contextWindow: 100_000,
      proactivePruneRatio: 0.48,
    };
    const transform = createTransformContext(config, {});
    // 第一轮：48K+，触发
    const messages1 = Array.from({ length: 30 }, () =>
      createToolResult("x".repeat(7200)),
    );
    const result1 = transform(messages1);
    expect(result1.length).toBeLessThan(messages1.length);

    // 第二轮：42K（<48K rearm 跑道）
    const messages2 = Array.from({ length: 25 }, () =>
      createToolResult("y".repeat(7200)),
    );
    const result2 = transform(messages2);
    // 预期：被 Rearm Gate 挡下，原样返回
    expect(result2).toBe(messages2);
  });

  it("0.60≤tokens<0.78：Proactive（先跑）→ MicroCompact（再跑）级联", () => {
    const config: CompactConfig = {
      contextWindow: 100_000,
      triggerRatio: 0.78,
      microCompactRatio: 0.60,
      proactivePruneRatio: 0.48,
    };
    const onCompaction = vi.fn();
    const transform = createTransformContext(config, { onCompaction });
    // 构造 tokens ≈ 70K（在 [60K, 78K) 区间）
    const messages = Array.from({ length: 40 }, () =>
      createToolResult("z".repeat(7200)),
    );
    const result = transform(messages);
    // 预期：先 Proactive（静默），再 MicroCompact（触发回调 strategy='micro'）
    expect(onCompaction).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "micro" }),
    );
  });
});
