/**
 * SegmentMemoryPipeline 集成测试（S10）—— 真实 repos + mock LLM 端到端
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SegmentRepo } from "../storage/segment-repo.js";
import { ConversationRepo } from "../storage/conversation-repo.js";
import { AgentMemoryRepo } from "../memory/memory-repo.js";
import { MemoryManager } from "../memory/manager.js";
import { SegmentMemoryPipeline } from "../memory/segment-memory-pipeline.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";
import type { DatabaseAdapter } from "../storage/local-database.js";

function insertConversation(db: DatabaseAdapter, id: string): void {
  db.prepare(
    `INSERT INTO conversations (id, user_id, type, title, is_active, created_at)
     VALUES (?, 'u1', 'direct', 't', 1, ?)`,
  ).run(id, new Date().toISOString());
}

describe("SegmentMemoryPipeline", () => {
  let db: DatabaseAdapter;
  let convRepo: ConversationRepo;
  let segRepo: SegmentRepo;
  let memRepo: AgentMemoryRepo;
  let mgr: MemoryManager;
  let llmCalls: string[];
  let idSeq: number;

  function makePipeline(llmResponse: string) {
    return new SegmentMemoryPipeline({
      segmentRepo: segRepo,
      conversationRepo: convRepo,
      memoryManager: mgr,
      callLLM: async (prompt) => {
        llmCalls.push(prompt);
        return llmResponse;
      },
      agentId: "a1",
      userId: "u1",
      newId: () => `seg-${++idSeq}`,
      minSummaryChars: 5,
    });
  }

  beforeEach(() => {
    db = createMigratedTestDb();
    convRepo = new ConversationRepo(db);
    segRepo = new SegmentRepo(db);
    memRepo = new AgentMemoryRepo(db);
    mgr = new MemoryManager(memRepo);
    llmCalls = [];
    idSeq = 0;
    insertConversation(db, "c1");
  });

  function saveUserMsg(id: string, text: string): void {
    convRepo.saveMessage({ id, conversationId: "c1", role: "user", contentJson: { type: "text", text } });
  }

  it("主题切换关闭段 → 后台总结 → 候选写入记忆", async () => {
    const llmResponse = JSON.stringify([
      { content: "用户计划去日本旅行", category: "project", importance: 0.7, tags: ["travel"] },
    ]);
    const pipe = makePipeline(llmResponse);

    saveUserMsg("m1", "我们来聊聊去日本旅行的计划和行程安排");
    pipe.observe({ conversationId: "c1", userId: "u1", agentId: "a1", messageId: "m1", ts: 1_000_000, text: "我们来聊聊去日本旅行的计划和行程安排", role: "user" });

    saveUserMsg("m2", "换个话题，帮我调试这段报错代码");
    pipe.observe({ conversationId: "c1", userId: "u1", agentId: "a1", messageId: "m2", ts: 1_000_100, text: "换个话题，帮我调试这段报错代码", role: "user" });

    await pipe.settle();

    expect(llmCalls.length).toBeGreaterThan(0); // LLM 被调用
    const active = mgr.listActive("a1", "u1");
    expect(active.map((m) => m.content)).toContain("用户计划去日本旅行");
    expect(segRepo.findById("seg-1")?.status).toBe("summarised");
  });

  it("flush 关闭 open 段并总结", async () => {
    const pipe = makePipeline(JSON.stringify([{ content: "用户常用 Notion", category: "reference", importance: 0.6, tags: [] }]));
    saveUserMsg("m1", "我平时用 Notion 记笔记和管理任务");
    pipe.observe({ conversationId: "c1", userId: "u1", agentId: "a1", messageId: "m1", ts: 1_000_000, text: "我平时用 Notion 记笔记和管理任务", role: "user" });
    pipe.flush("c1", "session_end");
    await pipe.settle();
    expect(mgr.listActive("a1", "u1").map((m) => m.content)).toContain("用户常用 Notion");
  });

  it("无 callLLM 时仅分段不产出记忆", async () => {
    const pipe = new SegmentMemoryPipeline({
      segmentRepo: segRepo, conversationRepo: convRepo, memoryManager: mgr,
      agentId: "a1", userId: "u1", newId: () => `seg-${++idSeq}`, minSummaryChars: 5,
    });
    saveUserMsg("m1", "随便说点什么内容测试一下");
    pipe.observe({ conversationId: "c1", userId: "u1", agentId: "a1", messageId: "m1", ts: 1_000_000, text: "随便说点什么内容测试一下", role: "user" });
    pipe.flush("c1", "session_end");
    await pipe.settle();
    expect(mgr.listActive("a1", "u1")).toHaveLength(0);
    expect(segRepo.findById("seg-1")?.status).toBe("summarised"); // 仍标记完成，不卡队列
  });

  it("start() 重启恢复遗留 closed 段", async () => {
    // 先用一条管线制造 closed 段但不总结（无 callLLM）
    segRepo.create({ id: "seg-x", conversationId: "c1", userId: "u1", agentId: "a1", startMessageId: "m1" });
    saveUserMsg("m1", "用户在学习弹吉他每周练习两次以上");
    segRepo.close("seg-x", "m1", "capacity");

    const pipe = makePipeline(JSON.stringify([{ content: "用户在学吉他", category: "project", importance: 0.6, tags: [] }]));
    pipe.start(); // 扫描遗留 closed
    await pipe.settle();
    expect(segRepo.findById("seg-x")?.status).toBe("summarised");
    expect(mgr.listActive("a1", "u1").map((m) => m.content)).toContain("用户在学吉他");
  });

  it("flushAll 关闭跨会话所有 open 段（app 退出场景）", async () => {
    insertConversation(db, "c2");
    const pipe = makePipeline(JSON.stringify([]));
    saveUserMsg("m1", "在 c1 聊去日本旅行的计划安排");
    pipe.observe({ conversationId: "c1", userId: "u1", agentId: "a1", messageId: "m1", ts: 1_000_000, text: "在 c1 聊去日本旅行的计划安排", role: "user" });
    convRepo.saveMessage({ id: "m2", conversationId: "c2", role: "user", contentJson: { type: "text", text: "在 c2 聊学吉他的事情安排" } });
    pipe.observe({ conversationId: "c2", userId: "u1", agentId: "a1", messageId: "m2", ts: 1_000_000, text: "在 c2 聊学吉他的事情安排", role: "user" });

    expect(segRepo.findAllOpen()).toHaveLength(2); // 两会话各一 open 段
    pipe.flushAll("app_quit");
    expect(segRepo.findAllOpen()).toHaveLength(0); // 全部关闭
    await pipe.settle();
  });

  it("app 退出 flushAll → 下次启动 start() 重启恢复总结（端到端缺口修复）", async () => {
    // 会话 1：observe 后 open 段未达边界（模拟用户聊两句就退出）
    const pipe1 = makePipeline(JSON.stringify([]));
    saveUserMsg("m1", "我平时喜欢周末去爬山和摄影");
    pipe1.observe({ conversationId: "c1", userId: "u1", agentId: "a1", messageId: "m1", ts: 1_000_000, text: "我平时喜欢周末去爬山和摄影", role: "user" });
    // 退出前 flushAll（同步关闭，不总结）
    pipe1.flushAll("app_quit");
    pipe1.stop();
    expect(segRepo.findAllOpen()).toHaveLength(0);

    // 下次启动：全新管线 start() 应重启恢复并总结刚关闭的段
    const pipe2 = makePipeline(JSON.stringify([{ content: "用户周末爬山摄影", category: "project", importance: 0.6, tags: [] }]));
    pipe2.start();
    await pipe2.settle();
    expect(mgr.listActive("a1", "u1").map((m) => m.content)).toContain("用户周末爬山摄影");
  });

  it("archiveToPalace 将段原文传给宿主 archivePalace（Phase 4.5）", async () => {
    let archivedText = "";
    const pipe = new SegmentMemoryPipeline({
      segmentRepo: segRepo,
      conversationRepo: convRepo,
      memoryManager: mgr,
      callLLM: async () =>
        JSON.stringify([{ content: "用户要整理本周待办", category: "project", importance: 0.6, tags: [] }]),
      agentId: "a1",
      userId: "u1",
      newId: () => `seg-${++idSeq}`,
      minSummaryChars: 5,
      archivePalace: async (text) => {
        archivedText = text;
        return { drawerId: "drawer-1" };
      },
    });
    saveUserMsg("m1", "用户说：请帮我整理本周待办清单");
    pipe.observe({
      conversationId: "c1",
      userId: "u1",
      agentId: "a1",
      messageId: "m1",
      ts: 1_000_000,
      text: "用户说：请帮我整理本周待办清单",
      role: "user",
    });
    pipe.flush("c1", "session_end");
    await pipe.settle();
    expect(archivedText).toContain("请帮我整理本周待办清单");
  });
});
