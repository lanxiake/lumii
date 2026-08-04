import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";

import { createTransformContext } from "../transform-context.js";
import { RecompactionTracker } from "../post-compact.js";
import type { CompactionInfo } from "../types.js";

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}
function assistant(text: string): AgentMessage {
  return { role: "assistant", content: text } as AgentMessage;
}

function buildOverThreshold(): AgentMessage[] {
  const msgs: AgentMessage[] = [];
  for (let i = 0; i < 40; i++) {
    msgs.push(user("x".repeat(500)));
    msgs.push(assistant("y".repeat(500)));
  }
  return msgs;
}

function baseConfig(overrides = {}) {
  return {
    contextWindow: 10_000,
    triggerRatio: 0.9,
    keepRecentTurns: 4,
    outputReserveTokens: 500,
    summaryReserveTokens: 500,
    generateSummary: async () => "<summary>ok</summary>",
    ...overrides,
  };
}

describe("RecompactionTracker — 再压缩诊断", () => {
  it("首次 record：isRecompaction=false, turnsSince=-1", () => {
    const t = new RecompactionTracker();
    const r = t.record(5);
    expect(r.isRecompaction).toBe(false);
    expect(r.turnsSincePreviousCompact).toBe(-1);
  });

  it("二次 record：isRecompaction=true, turnsSince=轮次差", () => {
    const t = new RecompactionTracker();
    t.record(5);
    const r = t.record(8);
    expect(r.isRecompaction).toBe(true);
    expect(r.turnsSincePreviousCompact).toBe(3);
  });
});

describe("CompactionInfo — B4 诊断字段流向 onCompaction", () => {
  it("summary 策略上报 isRecompaction/turnsSince/consecutiveFailures/ptlRetries", async () => {
    const infos: CompactionInfo[] = [];
    const transform = createTransformContext(
      baseConfig({ onCompaction: (i: CompactionInfo) => infos.push(i) }),
    );
    await transform(buildOverThreshold(), undefined);
    await transform(buildOverThreshold(), undefined);

    expect(infos.length).toBe(2);
    expect(infos[0]!.strategy).toBe("summary");
    expect(infos[0]!.isRecompaction).toBe(false);
    expect(infos[0]!.turnsSincePreviousCompact).toBe(-1);
    expect(infos[0]!.ptlRetries).toBe(0);
    expect(typeof infos[0]!.consecutiveFailures).toBe("number");
    // 第二次为再压缩
    expect(infos[1]!.isRecompaction).toBe(true);
    expect(infos[1]!.turnsSincePreviousCompact).toBeGreaterThan(0);
  });
});

describe("PostCompactRebuild — 重建钩子（B4 骨架）", () => {
  it("未注入时压缩正常（零回归）", async () => {
    const transform = createTransformContext(baseConfig());
    const out = await transform(buildOverThreshold(), undefined);
    expect(out.length).toBeGreaterThan(0);
    expect((out[0] as { role?: string }).role).toBe("user"); // 摘要消息
  });

  it("注入钩子时附件并入摘要之后", async () => {
    const marker = "REBUILT_ATTACHMENT_MARKER";
    const transform = createTransformContext(
      baseConfig({
        postCompactRebuild: {
          buildAttachments: async () => [user(marker)],
        },
      }),
    );
    const out = await transform(buildOverThreshold(), undefined);
    const hasMarker = out.some((m) => {
      const c = (m as { content?: unknown }).content;
      return typeof c === "string" && c.includes(marker);
    });
    expect(hasMarker).toBe(true);
  });

  it("钩子抛错时被吞掉，压缩仍成功（不影响主流程）", async () => {
    const transform = createTransformContext(
      baseConfig({
        postCompactRebuild: {
          buildAttachments: async () => {
            throw new Error("rebuild boom");
          },
        },
      }),
    );
    const out = await transform(buildOverThreshold(), undefined);
    expect(out.length).toBeGreaterThan(0);
  });
});
