/**
 * D-07：摘要生成的 progress touch 续命。
 *
 * summary-compact.ts 把 ProgressFence(idle=120s, ceiling=600s) 套在 generateSummary 外面，
 * 并把 f.touchProgress 作为 onProgress 回调交给它。这条接线是「慢但有输出的摘要不该被误杀」
 * 的唯一保障：只要模型还在吐 token 就续命，真卡死（无 delta）才在 idle 窗口后放弃。
 *
 * 用假定时器压缩时间轴 —— 真等 120s 没有意义。
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSummaryStage } from "../strategies/summary-compact.js";
import type { CompactConfig } from "../types.js";

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}
function assistant(text: string): AgentMessage {
  return { role: "assistant", content: text } as AgentMessage;
}

const OLD_MESSAGES: AgentMessage[] = [user("u0"), assistant("a0"), user("u1"), assistant("a1")];

function baseConfig(overrides: Partial<CompactConfig> = {}): CompactConfig {
  return {
    contextWindow: 10_000,
    triggerRatio: 0.9,
    keepRecentTurns: 4,
    outputReserveTokens: 500,
    summaryReserveTokens: 500,
    ...overrides,
  };
}

const IDLE_MS = 120_000;
const CEILING_MS = 600_000;

describe("摘要阶段 ProgressFence 续命（D-07）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("持续 touchProgress 时，总耗时远超 idle 窗口仍能拿到摘要", async () => {
    let touches = 0;
    let finishSummary!: (text: string) => void;
    const summaryText = new Promise<string>((r) => {
      finishSummary = r;
    });

    const config = baseConfig({
      // 摘要挂在外部 promise 上，由测试推进时钟并按节奏报进度（模拟流式 delta）
      generateSummary: async (_msgs, _prompt, _signal, hooks) => {
        const timer = setInterval(() => {
          touches++;
          hooks?.onProgress?.();
        }, IDLE_MS / 2);
        try {
          return await summaryText;
        } finally {
          clearInterval(timer);
        }
      },
    });

    const pending = runSummaryStage(OLD_MESSAGES, config);

    // 推进 3×idle（360s，仍在 600s ceiling 内）：期间每 0.5×idle 报一次进度，
    // idle 窗口应被不断续命。注意别推到 ceiling，那是另一条正确的放弃路径。
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(touches).toBeGreaterThanOrEqual(5);

    finishSummary("慢但一直有输出的摘要");
    const result = await pending;

    expect(result.summaryMessage).not.toBeNull();
    expect(result.failed).toBe(false);
  });

  it("完全无进度上报时，idle 窗口过后放弃并标记 failed", async () => {
    const config = baseConfig({
      // 一次 onProgress 都不调：模拟连接挂死、无 delta 回流
      generateSummary: () => new Promise<string>(() => {}),
    });

    const pending = runSummaryStage(OLD_MESSAGES, config);
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    const result = await pending;

    expect(result.summaryMessage).toBeNull();
    expect(result.failed).toBe(true);
  });

  it("touchProgress 不能突破 ceiling：一直报进度也在绝对封顶处放弃", async () => {
    // 双预算的第二条腿。只测 idle 续命会漏掉「永远报进度就永远不结束」这种活锁。
    let touches = 0;
    const config = baseConfig({
      generateSummary: (_msgs, _prompt, _signal, hooks) =>
        new Promise<string>(() => {
          setInterval(() => {
            touches++;
            hooks?.onProgress?.();
          }, IDLE_MS / 4);
        }),
    });

    const pending = runSummaryStage(OLD_MESSAGES, config);
    await vi.advanceTimersByTimeAsync(CEILING_MS + IDLE_MS);
    const result = await pending;

    expect(touches).toBeGreaterThan(10); // 确实一直在报进度
    expect(result.summaryMessage).toBeNull(); // 但 ceiling 到了照样放弃
    expect(result.failed).toBe(true);
  });

  it("onProgress 是传给 generateSummary 的、可被 fence 感知的真回调", async () => {
    // 防回归：曾经有过「hooks 参数漏传」的写法，摘要照样成功但续命静默失效。
    // 这里断言回调确实被交到下游，且调用它不抛错。
    let receivedHooks: unknown;

    const config = baseConfig({
      generateSummary: async (_msgs, _prompt, _signal, hooks) => {
        receivedHooks = hooks;
        hooks?.onProgress?.();
        return "摘要";
      },
    });

    const result = await runSummaryStage(OLD_MESSAGES, config);

    expect(receivedHooks).toBeDefined();
    expect(typeof (receivedHooks as { onProgress?: unknown }).onProgress).toBe("function");
    expect(result.summaryMessage).not.toBeNull();
  });
});
