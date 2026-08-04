/**
 * 记忆来源关联 + 内容寻址测试（记忆系统升级阶段一 · 诉求 A + P2）
 *
 * 覆盖：
 * 1. contentAddressId / deterministicDrawerId 确定性 + NUL 分隔防碰撞
 * 2. saveSummarizedCandidates 带来源 → 回填 source_segment_id / source_message_id
 * 3. updateMergedFields 命中已有记忆时保留最早来源（不覆盖非空）
 * 4. getMemoryProvenance 注入 repos 后回读段 + 原文区间
 * 5. SegmentMemoryPipeline.archiveToPalace 重复归档 → 同一 drawerId（幂等）
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SegmentRepo } from "../storage/segment-repo.js";
import { ConversationRepo } from "../storage/conversation-repo.js";
import { AgentMemoryRepo } from "../memory/memory-repo.js";
import { MemoryManager } from "../memory/manager.js";
import { SegmentMemoryPipeline } from "../memory/segment-memory-pipeline.js";
import { contentAddressId, deterministicDrawerId, DRAWER_ID_HEX_LEN } from "../memory/content-address.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";
import type { DatabaseAdapter } from "../storage/local-database.js";

function insertConversation(db: DatabaseAdapter, id: string): void {
  db.prepare(
    `INSERT INTO conversations (id, user_id, type, title, is_active, created_at)
     VALUES (?, 'u1', 'direct', 't', 1, ?)`,
  ).run(id, new Date().toISOString());
}

describe("content-address", () => {
  it("contentAddressId 确定性：同输入 → 同输出，长度为截断值", () => {
    const a = contentAddressId(["wing", "room", "hello"]);
    const b = contentAddressId(["wing", "room", "hello"]);
    expect(a).toBe(b);
    expect(a).toHaveLength(DRAWER_ID_HEX_LEN);
    expect(a).toMatch(/^[0-9a-f]+$/);
  });

  it("NUL 分隔防碰撞：('ab','c') 与 ('a','bc') 不同", () => {
    expect(contentAddressId(["ab", "c"])).not.toBe(contentAddressId(["a", "bc"]));
  });

  it("deterministicDrawerId 随 wing/room/content 任一变化而变化", () => {
    const base = deterministicDrawerId("w", "r", "c");
    expect(deterministicDrawerId("w2", "r", "c")).not.toBe(base);
    expect(deterministicDrawerId("w", "r2", "c")).not.toBe(base);
    expect(deterministicDrawerId("w", "r", "c2")).not.toBe(base);
  });

  it("自定义截断长度生效（阶段二 chunk 用 32）", () => {
    expect(contentAddressId(["x"], 32)).toHaveLength(32);
  });
});

describe("memory provenance (诉求 A)", () => {
  let db: DatabaseAdapter;
  let convRepo: ConversationRepo;
  let segRepo: SegmentRepo;
  let memRepo: AgentMemoryRepo;
  let mgr: MemoryManager;

  beforeEach(() => {
    db = createMigratedTestDb();
    convRepo = new ConversationRepo(db);
    segRepo = new SegmentRepo(db);
    memRepo = new AgentMemoryRepo(db);
    mgr = new MemoryManager(memRepo, { segmentRepo: segRepo, conversationRepo: convRepo });
    insertConversation(db, "c1");
  });

  it("saveSummarizedCandidates 带来源 → 回填 source_segment_id / source_message_id", () => {
    convRepo.saveMessage({ id: "m1", conversationId: "c1", role: "user", contentJson: { type: "text", text: "我想去日本旅行" } });
    segRepo.create({ id: "seg-1", conversationId: "c1", userId: "u1", agentId: "a1", startMessageId: "m1" });
    mgr.saveSummarizedCandidates(
      [{ content: "用户计划去日本旅行", category: "project", importance: 0.7, tags: ["travel"] }],
      "a1",
      "u1",
      { segmentId: "seg-1", conversationId: "c1", representativeMessageId: "m1" },
    );

    const [entry] = mgr.listActive("a1", "u1");
    expect(entry.content).toBe("用户计划去日本旅行");
    expect(entry.source_segment_id).toBe("seg-1");
    expect(entry.source_message_id).toBe("m1");
  });

  it("命中已有记忆合并时保留最早来源（不覆盖非空）", () => {
    convRepo.saveMessage({ id: "m1", conversationId: "c1", role: "user", contentJson: { type: "text", text: "我用 Notion" } });
    convRepo.saveMessage({ id: "m2", conversationId: "c1", role: "user", contentJson: { type: "text", text: "Notion 真好用" } });
    segRepo.create({ id: "seg-1", conversationId: "c1", userId: "u1", agentId: "a1", startMessageId: "m1" });
    segRepo.create({ id: "seg-2", conversationId: "c1", userId: "u1", agentId: "a1", startMessageId: "m2" });
    // 首次写入带来源 seg-1
    mgr.saveSummarizedCandidates(
      [{ content: "用户常用 Notion", category: "reference", importance: 0.6, tags: ["a"] }],
      "a1",
      "u1",
      { segmentId: "seg-1", conversationId: "c1", representativeMessageId: "m1" },
    );
    // 相同内容再次写入带来源 seg-2 → 走 toUpdate 合并路径
    mgr.saveSummarizedCandidates(
      [{ content: "用户常用 Notion", category: "reference", importance: 0.9, tags: ["b"] }],
      "a1",
      "u1",
      { segmentId: "seg-2", conversationId: "c1", representativeMessageId: "m2" },
    );

    const active = mgr.listActive("a1", "u1");
    expect(active).toHaveLength(1);
    const entry = active[0];
    // 来源保留最早 seg-1，不被 seg-2 覆盖
    expect(entry.source_segment_id).toBe("seg-1");
    expect(entry.source_message_id).toBe("m1");
    // importance 取高、tags 并集
    expect(entry.importance).toBeCloseTo(0.9);
    expect([...entry.tags].sort()).toEqual(["a", "b"]);
  });

  it("getMemoryProvenance 注入 repos → 回读段 + 原文区间", () => {
    // 造一段真实对话 + 段记录
    convRepo.saveMessage({ id: "m1", conversationId: "c1", role: "user", contentJson: { type: "text", text: "我想去日本旅行" } });
    convRepo.saveMessage({ id: "m2", conversationId: "c1", role: "assistant", contentJson: { type: "text", text: "好的，帮你规划行程" } });
    segRepo.create({ id: "seg-1", conversationId: "c1", userId: "u1", agentId: "a1", startMessageId: "m1" });
    segRepo.close("seg-1", "m2", "topic_shift");

    mgr.saveSummarizedCandidates(
      [{ content: "用户计划去日本旅行", category: "project", importance: 0.7, tags: [] }],
      "a1",
      "u1",
      { segmentId: "seg-1", conversationId: "c1", representativeMessageId: "m1" },
    );
    const [entry] = mgr.listActive("a1", "u1");

    const prov = mgr.getMemoryProvenance(entry.id);
    expect(prov).not.toBeNull();
    expect(prov?.sourceSegmentId).toBe("seg-1");
    expect(prov?.segment?.id).toBe("seg-1");
    expect(prov?.originalText).toContain("我想去日本旅行");
    expect(prov?.originalText).toContain("好的，帮你规划行程");
  });

  it("getMemoryProvenance 未知记忆返回 null", () => {
    expect(mgr.getMemoryProvenance("nope")).toBeNull();
  });

  it("无来源段的记忆：provenance 段/原文为 null", () => {
    mgr.saveSummarizedCandidates(
      [{ content: "无来源记忆", category: "general", importance: 0.5, tags: [] }],
      "a1",
      "u1",
    );
    const [entry] = mgr.listActive("a1", "u1");
    const prov = mgr.getMemoryProvenance(entry.id);
    expect(prov?.sourceSegmentId).toBeNull();
    expect(prov?.segment).toBeNull();
    expect(prov?.originalText).toBeNull();
  });
});

describe("SegmentMemoryPipeline 宫殿归档幂等 (P2)", () => {
  let db: DatabaseAdapter;
  let convRepo: ConversationRepo;
  let segRepo: SegmentRepo;
  let memRepo: AgentMemoryRepo;
  let mgr: MemoryManager;
  let idSeq: number;

  beforeEach(() => {
    db = createMigratedTestDb();
    convRepo = new ConversationRepo(db);
    segRepo = new SegmentRepo(db);
    memRepo = new AgentMemoryRepo(db);
    mgr = new MemoryManager(memRepo, { segmentRepo: segRepo, conversationRepo: convRepo });
    idSeq = 0;
    insertConversation(db, "c1");
  });

  it("段原文归档 → 段与记忆回填同一确定性 drawerId；重复归档 ID 不变", async () => {
    const archiveCalls: { text: string; drawerId: string; wing: string; room: string }[] = [];
    const pipe = new SegmentMemoryPipeline({
      segmentRepo: segRepo,
      conversationRepo: convRepo,
      memoryManager: mgr,
      callLLM: async () =>
        JSON.stringify([{ content: "用户计划去日本旅行", category: "project", importance: 0.7, tags: [] }]),
      agentId: "a1",
      userId: "u1",
      newId: () => `seg-${++idSeq}`,
      minSummaryChars: 5,
      archivePalace: async (text, meta) => {
        archiveCalls.push({ text, drawerId: meta.drawerId, wing: meta.wing, room: meta.room });
        return { drawerId: meta.drawerId }; // 宿主回相同 ID（幂等）
      },
    });

    convRepo.saveMessage({ id: "m1", conversationId: "c1", role: "user", contentJson: { type: "text", text: "我们聊聊去日本旅行的详细计划和行程安排" } });
    pipe.observe({ conversationId: "c1", userId: "u1", agentId: "a1", messageId: "m1", ts: 1_000_000, text: "我们聊聊去日本旅行的详细计划和行程安排", role: "user" });
    convRepo.saveMessage({ id: "m2", conversationId: "c1", role: "user", contentJson: { type: "text", text: "换个话题，帮我调试这段报错代码" } });
    pipe.observe({ conversationId: "c1", userId: "u1", agentId: "a1", messageId: "m2", ts: 1_000_100, text: "换个话题，帮我调试这段报错代码", role: "user" });

    await pipe.settle();

    expect(archiveCalls).toHaveLength(1);
    const seg = segRepo.findById("seg-1");
    expect(seg?.palaceDrawerId).toBe(archiveCalls[0].drawerId);

    // 该段产出的记忆也回填了同一 drawerId
    const [entry] = mgr.listActive("a1", "u1");
    expect(entry.palace_drawer_id).toBe(archiveCalls[0].drawerId);

    // drawerId 即 (wing, room, 原文) 的确定性内容寻址
    const text = convRepo.loadSegmentText("c1", "m1", "m1");
    expect(archiveCalls[0].drawerId).toBe(
      deterministicDrawerId(archiveCalls[0].wing, archiveCalls[0].room, text),
    );
  });

  it("宿主返回不同 drawerId → 以宿主为准回填段与记忆", async () => {
    const pipe = new SegmentMemoryPipeline({
      segmentRepo: segRepo,
      conversationRepo: convRepo,
      memoryManager: mgr,
      callLLM: async () =>
        JSON.stringify([{ content: "用户常用 Notion 管理任务", category: "reference", importance: 0.6, tags: [] }]),
      agentId: "a1",
      userId: "u1",
      newId: () => `seg-${++idSeq}`,
      minSummaryChars: 5,
      archivePalace: async () => ({ drawerId: "host-assigned-id" }),
    });

    convRepo.saveMessage({ id: "m1", conversationId: "c1", role: "user", contentJson: { type: "text", text: "我平时用 Notion 记笔记和管理任务安排" } });
    pipe.observe({ conversationId: "c1", userId: "u1", agentId: "a1", messageId: "m1", ts: 1_000_000, text: "我平时用 Notion 记笔记和管理任务安排", role: "user" });
    pipe.flush("c1", "session_end");
    await pipe.settle();

    expect(segRepo.findById("seg-1")?.palaceDrawerId).toBe("host-assigned-id");
    expect(mgr.listActive("a1", "u1")[0].palace_drawer_id).toBe("host-assigned-id");
  });
});
