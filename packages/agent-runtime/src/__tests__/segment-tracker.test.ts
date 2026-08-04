/**
 * SegmentTracker 单测（S3）—— 真实 SegmentRepo + 捕获 enqueue
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SegmentRepo } from "../storage/segment-repo.js";
import { SegmentTracker, type ObserveParams } from "../memory/segment-tracker.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";

describe("SegmentTracker", () => {
  let repo: SegmentRepo;
  let enqueued: string[];
  let tracker: SegmentTracker;
  let idSeq: number;

  beforeEach(() => {
    repo = new SegmentRepo(createMigratedTestDb());
    enqueued = [];
    idSeq = 0;
    tracker = new SegmentTracker({
      repo,
      enqueue: (id) => enqueued.push(id),
      newId: () => `seg-${++idSeq}`,
      minSummaryChars: 10,
    });
  });

  const turn = (over: Partial<ObserveParams> & { text: string; messageId: string }): ObserveParams => ({
    conversationId: "c1",
    userId: "u1",
    agentId: "a1",
    ts: 1_000_000,
    role: "user",
    ...over,
  });

  it("首轮创建 open 段", () => {
    tracker.observe(turn({ messageId: "m1", text: "我们来聊聊去日本旅行的计划安排" }));
    const open = repo.findOpenByConversation("c1");
    expect(open?.startMessageId).toBe("m1");
    expect(open?.turnCount).toBe(1);
    expect(enqueued).toEqual([]);
  });

  it("同主题继续并入同一段，turnCount 增长", () => {
    tracker.observe(turn({ messageId: "m1", text: "我们来聊聊去日本旅行的计划安排" }));
    tracker.observe(turn({ messageId: "m2", role: "assistant", text: "好的，日本旅行计划想去哪些城市" }));
    tracker.observe(turn({ messageId: "m3", text: "旅行计划里东京和大阪的行程怎么排" }));
    const open = repo.findOpenByConversation("c1");
    expect(open?.turnCount).toBe(3);
    expect(open?.endMessageId).toBe("m3");
    expect(enqueued).toEqual([]);
  });

  it("主题切换 → 关闭前段并入队，新建段（段累积 ≥3 轮后才允许）", () => {
    // 3 轮同主题旅行（共享"日本旅行"词汇，留在一段，累积到 3 轮）
    tracker.observe(turn({ messageId: "m1", text: "我们来聊聊去日本旅行的计划安排行程" }));
    tracker.observe(turn({ messageId: "m2", text: "日本旅行的预算大概多少比较合适" }));
    tracker.observe(turn({ messageId: "m3", text: "日本旅行东京和大阪怎么安排行程" }));
    expect(repo.findOpenByConversation("c1")?.turnCount).toBe(3);
    expect(enqueued).toEqual([]); // 同主题未切

    // 第 4 轮切到代码 → topic_shift（段已达 minTurnsBeforeTopicShift=3）
    tracker.observe(turn({ messageId: "m4", text: "帮我调试这段报错的 python 代码函数" }));
    expect(enqueued).toEqual(["seg-1"]);
    expect(repo.findById("seg-1")?.status).toBe("closed");
    expect(repo.findById("seg-1")?.closeReason).toBe("topic_shift");
    const open = repo.findOpenByConversation("c1");
    expect(open?.id).toBe("seg-2");
    expect(open?.startMessageId).toBe("m4");
  });

  it("单轮段不会因主题切换被切碎（防 over-segmentation）", () => {
    tracker.observe(turn({ messageId: "m1", text: "我们来聊聊去日本旅行的计划安排行程" }));
    // 第 2 轮即使主题不同，段只有 1 轮（< minTurnsBeforeTopicShift），不切
    tracker.observe(turn({ messageId: "m2", text: "帮我调试这段报错的 python 代码函数" }));
    expect(enqueued).toEqual([]);
    expect(repo.findOpenByConversation("c1")?.turnCount).toBe(2); // 并入同一段
  });

  it("显式线索 → 切段", () => {
    tracker.observe(turn({ messageId: "m1", text: "我们来聊聊去日本旅行的计划安排行程" }));
    tracker.observe(turn({ messageId: "m2", text: "换个话题，帮我看看代码" }));
    expect(repo.findById("seg-1")?.closeReason).toBe("explicit_cue");
    expect(enqueued).toEqual(["seg-1"]);
  });

  it("时间间隔超阈值 → 切段", () => {
    tracker.observe(turn({ messageId: "m1", text: "我们来聊聊去日本旅行的计划安排行程" }));
    tracker.observe(turn({ messageId: "m2", ts: 1_000_000 + 21 * 60_000, text: "继续刚才旅行计划日本东京" }));
    expect(repo.findById("seg-1")?.closeReason).toBe("time_gap");
    expect(enqueued).toEqual(["seg-1"]);
  });

  it("容量超轮数 → 切段", () => {
    const t = new SegmentTracker({
      repo,
      enqueue: (id) => enqueued.push(id),
      newId: () => `seg-${++idSeq}`,
      config: { maxTurns: 3 },
      minSummaryChars: 1,
    });
    t.observe(turn({ messageId: "m1", text: "旅行计划日本东京" }));
    t.observe(turn({ messageId: "m2", text: "旅行计划日本大阪" }));
    t.observe(turn({ messageId: "m3", text: "旅行计划日本京都" }));
    // 第 4 轮触发容量边界（已有 3 轮）
    t.observe(turn({ messageId: "m4", text: "旅行计划日本奈良" }));
    expect(repo.findById("seg-1")?.closeReason).toBe("capacity");
    expect(enqueued).toEqual(["seg-1"]);
  });

  it("flushOpenSegments 关闭 open 段并入队", () => {
    tracker.observe(turn({ messageId: "m1", text: "我们来聊聊去日本旅行的计划安排行程" }));
    tracker.flushOpenSegments("c1", "session_end");
    expect(repo.findOpenByConversation("c1")).toBeNull();
    expect(repo.findById("seg-1")?.closeReason).toBe("session_end");
    expect(enqueued).toEqual(["seg-1"]);
  });

  it("过短段不入队总结（直接标记 summarised）", () => {
    tracker.observe(turn({ messageId: "m1", text: "嗯好" }));
    tracker.flushOpenSegments("c1", "session_end");
    expect(enqueued).toEqual([]); // < minSummaryChars(10)
    expect(repo.findById("seg-1")?.status).toBe("summarised");
  });

  it("flush 无 open 段时安全无操作", () => {
    expect(() => tracker.flushOpenSegments("nonexistent", "idle")).not.toThrow();
    expect(enqueued).toEqual([]);
  });
});
