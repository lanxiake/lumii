/**
 * SummarizationQueue 单测（S4）—— 真实 SegmentRepo + mock summarize/LLM
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SegmentRepo, type MemorySegment } from "../storage/segment-repo.js";
import { SummarizationQueue } from "../memory/summarization-queue.js";
import type { ExtractedCandidate } from "../memory/types.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";

function seedClosed(repo: SegmentRepo, id: string, conv = "c1"): void {
  repo.create({ id, conversationId: conv, userId: "u1", agentId: "a1", startMessageId: `${id}-start` });
  repo.close(id, `${id}-end`, "topic_shift");
}

const sampleCandidates: ExtractedCandidate[] = [
  { content: "用户计划去日本旅行", category: "project", importance: 0.7, tags: ["travel"] },
];

describe("SummarizationQueue", () => {
  let repo: SegmentRepo;

  beforeEach(() => {
    repo = new SegmentRepo(createMigratedTestDb());
  });

  it("处理 closed 段：调 summarize → onCandidates → markSummarised", async () => {
    seedClosed(repo, "s1");
    const onCalls: Array<{ seg: MemorySegment; cands: readonly ExtractedCandidate[] }> = [];
    const q = new SummarizationQueue({
      repo,
      loadSegmentText: async () => "我打算去日本旅行",
      summarize: async () => sampleCandidates,
      onCandidates: (seg, cands) => { onCalls.push({ seg, cands }); },
    });
    q.enqueue("s1");
    await q.settle();

    expect(onCalls).toHaveLength(1);
    expect(onCalls[0].cands).toEqual(sampleCandidates);
    expect(repo.findById("s1")?.status).toBe("summarised");
  });

  it("空原文 → 直接 summarised，不调 summarize", async () => {
    seedClosed(repo, "s1");
    let summarizeCalled = false;
    const q = new SummarizationQueue({
      repo,
      loadSegmentText: async () => "   ",
      summarize: async () => { summarizeCalled = true; return []; },
      onCandidates: () => {},
    });
    q.enqueue("s1");
    await q.settle();
    expect(summarizeCalled).toBe(false);
    expect(repo.findById("s1")?.status).toBe("summarised");
  });

  it("候选为空时不调 onCandidates，但仍 summarised", async () => {
    seedClosed(repo, "s1");
    let onCalled = false;
    const q = new SummarizationQueue({
      repo,
      loadSegmentText: async () => "闲聊一句",
      summarize: async () => [],
      onCandidates: () => { onCalled = true; },
    });
    q.enqueue("s1");
    await q.settle();
    expect(onCalled).toBe(false);
    expect(repo.findById("s1")?.status).toBe("summarised");
  });

  it("失败 < maxRetry：留 closed + retry 累加", async () => {
    seedClosed(repo, "s1");
    const q = new SummarizationQueue({
      repo,
      loadSegmentText: async () => "内容",
      summarize: async () => { throw new Error("LLM 限流"); },
      onCandidates: () => {},
      maxRetry: 2,
    });
    q.enqueue("s1");
    await q.settle();
    const seg = repo.findById("s1")!;
    expect(seg.status).toBe("closed");
    expect(seg.retryCount).toBe(1);
  });

  it("失败 > maxRetry：放弃并标 summarised", async () => {
    seedClosed(repo, "s1");
    repo.incrementRetry("s1");
    repo.incrementRetry("s1"); // 已 2 次
    const q = new SummarizationQueue({
      repo,
      loadSegmentText: async () => "内容",
      summarize: async () => { throw new Error("again"); },
      onCandidates: () => {},
      maxRetry: 2,
    });
    q.enqueue("s1"); // 第 3 次 → 超上限
    await q.settle();
    expect(repo.findById("s1")?.status).toBe("summarised");
  });

  it("start() 扫描遗留 closed 段续处理（重启恢复）", async () => {
    seedClosed(repo, "s1");
    seedClosed(repo, "s2", "c2");
    const processed: string[] = [];
    const q = new SummarizationQueue({
      repo,
      loadSegmentText: async () => "内容",
      summarize: async (_t, seg) => { processed.push(seg.id); return sampleCandidates; },
      onCandidates: () => {},
    });
    q.start(); // 不手动 enqueue，靠扫描
    await q.settle();
    expect(processed.sort()).toEqual(["s1", "s2"]);
    expect(repo.findById("s1")?.status).toBe("summarised");
    expect(repo.findById("s2")?.status).toBe("summarised");
  });

  it("非 closed 段（已 summarised）跳过", async () => {
    seedClosed(repo, "s1");
    repo.markSummarised("s1");
    let summarizeCalled = false;
    const q = new SummarizationQueue({
      repo,
      loadSegmentText: async () => "内容",
      summarize: async () => { summarizeCalled = true; return []; },
      onCandidates: () => {},
    });
    q.enqueue("s1");
    await q.settle();
    expect(summarizeCalled).toBe(false);
  });

  it("串行处理多段不并发", async () => {
    seedClosed(repo, "s1");
    seedClosed(repo, "s2", "c2");
    let active = 0;
    let maxActive = 0;
    const q = new SummarizationQueue({
      repo,
      loadSegmentText: async () => "内容",
      summarize: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return sampleCandidates;
      },
      onCandidates: () => {},
    });
    q.enqueue("s1");
    q.enqueue("s2");
    await q.settle();
    expect(maxActive).toBe(1); // 串行：任意时刻至多 1 个在处理
  });
});
