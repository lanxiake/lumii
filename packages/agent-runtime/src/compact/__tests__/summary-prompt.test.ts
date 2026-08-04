import { describe, expect, it } from "vitest";

import { buildLlmSummaryMessage } from "../summary-message.js";
import { buildPartialSummaryPrompt } from "../summary-prompt.js";

describe("buildLlmSummaryMessage — 续聊强度与原文追溯（B3）", () => {
  it("resume-task（默认）含强反寒暄措辞", () => {
    const msg = buildLlmSummaryMessage("1. Summary");
    const c = (msg as { content?: string }).content ?? "";
    expect(c).toContain("Resume directly");
    expect(c).toContain("as if the break never happened");
  });

  it("resume-soft 不含强反寒暄，含自然继续", () => {
    const msg = buildLlmSummaryMessage("1. Summary", { resumeMode: "resume-soft" });
    const c = (msg as { content?: string }).content ?? "";
    expect(c).not.toContain("Resume directly");
    expect(c).toContain("naturally");
  });

  it("recentMessagesPreserved=true 含逐字保留提示", () => {
    const msg = buildLlmSummaryMessage("1. Summary", { recentMessagesPreserved: true });
    const c = (msg as { content?: string }).content ?? "";
    expect(c).toContain("逐字保留");
  });

  it("historyRecallHint=true 含 memory 回查指针", () => {
    const msg = buildLlmSummaryMessage("1. Summary", { historyRecallHint: true });
    const c = (msg as { content?: string }).content ?? "";
    expect(c).toContain("memory_search");
    expect(c).toContain("memory_read");
    expect(c).toContain("检索相关历史");
  });

  it("historyRecallHint=true 且 sessionKey 含会话过滤提示", () => {
    const msg = buildLlmSummaryMessage("1. Summary", {
      historyRecallHint: true,
      sessionKey: "conv-abc-123",
    });
    const c = (msg as { content?: string }).content ?? "";
    expect(c).toContain("sessionKey=conv-abc-123");
    expect(c).toContain("优先在当前会话");
    expect(c).not.toContain("检索相关历史");
  });

  it("始终包含完成态真实性约束", () => {
    const msg = buildLlmSummaryMessage("1. Summary");
    const c = (msg as { content?: string }).content ?? "";
    expect(c).toContain("may be unverified");
  });

  it("兼容旧 boolean 第二参数（等价 historyRecallHint）", () => {
    const msg = buildLlmSummaryMessage("1. Summary", true);
    const c = (msg as { content?: string }).content ?? "";
    expect(c).toContain("memory_read");
  });
});

describe("buildPartialSummaryPrompt — from / up_to 模板（B3 预留）", () => {
  it("from 方向第 9 节为 Optional Next Step", () => {
    const p = buildPartialSummaryPrompt({ direction: "from" });
    expect(p).toContain("9. Optional Next Step");
    expect(p).not.toContain("Context for Continuing Work");
    // NO_TOOLS 约束前后包裹
    expect(p).toContain("Do NOT call any tools");
  });

  it("up_to 方向第 9 节为 Context for Continuing Work（不猜下一步）", () => {
    const p = buildPartialSummaryPrompt({ direction: "up_to" });
    expect(p).toContain("9. Context for Continuing Work");
    expect(p).not.toContain("9. Optional Next Step");
  });

  it("customInstructions 追加", () => {
    const p = buildPartialSummaryPrompt({ direction: "from", customInstructions: "保留测试输出" });
    expect(p).toContain("Additional Instructions:");
    expect(p).toContain("保留测试输出");
  });
});
