/**
 * SummarizationQueue 单测（S4）—— 真实 SegmentRepo + mock summarize/LLM
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
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
      listPending: (limit) => repo.findClosed(limit),
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
      listPending: (limit) => repo.findClosed(limit),
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
      listPending: (limit) => repo.findClosed(limit),
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
      listPending: (limit) => repo.findClosed(limit),
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
      listPending: (limit) => repo.findClosed(limit),
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
      listPending: (limit) => repo.findClosed(limit),
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
      listPending: (limit) => repo.findClosed(limit),
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
      listPending: (limit) => repo.findClosed(limit),
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

  it("start() 只恢复本作用域的段，不跨 agent（listPending 注入）", async () => {
    seedClosed(repo, "mine"); // agentId=a1
    // 另一 agent 的 closed 段：本 pipeline 的恢复扫描不应捞走它
    repo.create({
      id: "other-agent",
      conversationId: "c9",
      userId: "u1",
      agentId: "a2",
      startMessageId: "other-start",
    });
    repo.close("other-agent", "other-end", "topic_shift");

    const processed: string[] = [];
    const q = new SummarizationQueue({
      repo,
      listPending: (limit) => repo.findClosedByScope("a1", "u1", limit),
      loadSegmentText: async () => "内容",
      summarize: async (_t, seg) => {
        processed.push(seg.id);
        return sampleCandidates;
      },
      onCandidates: () => {},
    });
    q.start();
    await q.settle();

    expect(processed).toEqual(["mine"]);
    expect(repo.findById("other-agent")?.status).toBe("closed"); // 仍待其归属 pipeline 处理
  });
});

/**
 * 可观测性（P1-3）。
 *
 * 段落管线是工作记忆的**唯一产出源**——它静默停摆时表现为「记忆不再增长」，
 * 没有报错、没有崩溃，只有计数能把它暴露出来（评审 §6 R3）。
 */
describe("SummarizationQueue 运行统计", () => {
  let repo: SegmentRepo;

  beforeEach(() => {
    repo = new SegmentRepo(createMigratedTestDb());
  });

  function makeQueue(summarize: () => Promise<readonly ExtractedCandidate[]>, text = "内容") {
    return new SummarizationQueue({
      repo,
      listPending: (limit) => repo.findClosed(limit),
      loadSegmentText: async () => text,
      summarize: async () => summarize(),
      onCandidates: () => {},
    });
  }

  it("成功产出计入 summarised，不计入 emptyCandidates", async () => {
    seedClosed(repo, "s1");
    const q = makeQueue(async () => sampleCandidates);
    q.enqueue("s1");
    await q.settle();

    const s = q.getStats();
    expect(s.summarised).toBe(1);
    expect(s.emptyCandidates).toBe(0);
    expect(s.failed).toBe(0);
  });

  it("LLM 返回空候选计入 emptyCandidates（与失败可区分）", async () => {
    seedClosed(repo, "s1");
    const q = makeQueue(async () => []);
    q.enqueue("s1");
    await q.settle();

    const s = q.getStats();
    expect(s.summarised).toBe(1);
    expect(s.emptyCandidates).toBe(1);
    expect(s.failed).toBe(0); // 空产出不是错误，但要看得出「一直在空转」
  });

  it("异常计入 failed 并记录 lastError", async () => {
    seedClosed(repo, "s1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = makeQueue(async () => {
      throw new Error("LLM 连接超时");
    });
    q.enqueue("s1");
    await q.settle();

    const s = q.getStats();
    expect(s.failed).toBe(1);
    expect(s.lastError?.message).toBe("LLM 连接超时");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("总结失败"))).toBe(true);
    warn.mockRestore();
  });

  it("超过重试上限计入 abandoned 并给出累计数（关键故障信号）", async () => {
    seedClosed(repo, "s1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = new SummarizationQueue({
      repo,
      listPending: (limit) => repo.findClosed(limit),
      loadSegmentText: async () => "内容",
      summarize: async () => {
        throw new Error("持续失败");
      },
      onCandidates: () => {},
      maxRetry: 1,
    });

    // 第一次失败：留 closed 等重启恢复；手动重入队模拟恢复
    q.enqueue("s1");
    await q.settle();
    expect(q.getStats().abandoned).toBe(0);

    q.enqueue("s1");
    await q.settle();

    const s = q.getStats();
    expect(s.abandoned).toBe(1);
    expect(s.failed).toBe(2);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("累计放弃 1 段")),
    ).toBe(true);
    warn.mockRestore();
  });

  it("无原文可总结计入 noText，且不调 summarize", async () => {
    seedClosed(repo, "s1");
    let called = false;
    const q = new SummarizationQueue({
      repo,
      listPending: (limit) => repo.findClosed(limit),
      loadSegmentText: async () => "   ",
      summarize: async () => {
        called = true;
        return [];
      },
      onCandidates: () => {},
    });
    q.enqueue("s1");
    await q.settle();

    expect(called).toBe(false);
    expect(q.getStats().noText).toBe(1);
  });

  it("getStats 返回快照副本（外部改动不回写内部状态）", async () => {
    seedClosed(repo, "s1");
    const q = makeQueue(async () => sampleCandidates);
    q.enqueue("s1");
    await q.settle();

    const snap = q.getStats() as { summarised: number };
    snap.summarised = 999;
    expect(q.getStats().summarised).toBe(1);
  });
});
