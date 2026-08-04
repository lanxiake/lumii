/**
 * 记忆功能验收测试 —— 贯穿"段落总结 + 相关召回"完整闭环。
 *
 * 与验证手册 `.qoder/report/2026-05-30-段落总结记忆-验证手册.md` 的场景一一对应，
 * 既是回归测试，也是手册的可执行镜像。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SegmentRepo } from "../storage/segment-repo.js";
import { ConversationRepo } from "../storage/conversation-repo.js";
import { AgentMemoryRepo } from "../memory/memory-repo.js";
import { MemoryManager } from "../memory/manager.js";
import { SegmentMemoryPipeline } from "../memory/segment-memory-pipeline.js";
import { DEFAULT_HOT_MEMORY_CONFIG } from "../memory/types.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";
import type { DatabaseAdapter } from "../storage/local-database.js";

const AGENT = "assistant";
const USER = "local-user";

describe("记忆验收：段落总结 → 写入 → 相关召回", () => {
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
    mgr = new MemoryManager(memRepo);
    idSeq = 0;
    db.prepare(
      `INSERT INTO conversations (id, user_id, type, title, is_active, created_at)
       VALUES ('conv-1', ?, 'direct', 't', 1, ?)`,
    ).run(USER, new Date().toISOString());
  });

  function pipelineReturning(candidatesJson: string): SegmentMemoryPipeline {
    return new SegmentMemoryPipeline({
      segmentRepo: segRepo,
      conversationRepo: convRepo,
      memoryManager: mgr,
      callLLM: async () => candidatesJson, // 模拟 LLM 总结输出
      agentId: AGENT,
      userId: USER,
      newId: () => `seg-${++idSeq}`,
      minSummaryChars: 5,
    });
  }

  function userSays(msgId: string, text: string, pipe: SegmentMemoryPipeline, ts: number): void {
    convRepo.saveMessage({ id: msgId, conversationId: "conv-1", role: "user", contentJson: { type: "text", text } });
    pipe.observe({ conversationId: "conv-1", userId: USER, agentId: AGENT, messageId: msgId, ts, text, role: "user" });
  }

  it("完整闭环：聊旅行→换话题触发总结→旅行记忆落库→相关召回排序靠前", async () => {
    // LLM 对"旅行段"的总结输出
    const pipe = pipelineReturning(
      JSON.stringify([
        { content: "用户计划七月去日本旅行，预算两万，偏好自由行", category: "project", importance: 0.8, tags: ["travel"] },
      ]),
    );

    // ── 写侧：聊旅行（多轮，同主题——共享"日本旅行"词汇——并入一段）──
    userSays("m1", "我想规划一下七月去日本旅行的行程安排", pipe, 1_000_000);
    userSays("m2", "日本旅行预算大概两万，想自由行不跟团", pipe, 1_000_100);
    userSays("m3", "日本旅行东京和大阪各待几天比较合适", pipe, 1_000_200);

    // 同主题应仍为一个 open 段，未总结
    expect(segRepo.findOpenByConversation("conv-1")?.turnCount).toBe(3);

    // ── 换话题：触发段关闭 + 后台总结 ──
    userSays("m4", "换个话题，帮我看看这段报错的代码", pipe, 1_000_300);
    await pipe.settle();

    // 旅行段应已 summarised，旅行记忆落库
    const memories = mgr.listActive(AGENT, USER);
    expect(memories.some((m) => m.content.includes("日本旅行"))).toBe(true);

    // ── 读侧：下一轮问相关话题，旅行记忆应被相关性召回排在前 ──
    const recalled = memRepo.loadTopMemories(AGENT, USER, DEFAULT_HOT_MEMORY_CONFIG, "我之前说的去日本旅行的计划呢");
    expect(recalled[0]?.content).toContain("日本旅行");
  });

  it("去重合并：相同信息再次总结不产生重复记忆", async () => {
    const json = JSON.stringify([{ content: "用户常用 Notion 记笔记", category: "reference", importance: 0.6, tags: ["tool"] }]);

    const pipe1 = pipelineReturning(json);
    userSays("a1", "我平时都用 Notion 来记笔记管理任务安排", pipe1, 1_000_000);
    pipe1.flush("conv-1", "session_end");
    await pipe1.settle();

    const pipe2 = pipelineReturning(json);
    userSays("b1", "继续聊聊用 Notion 整理资料的方法", pipe2, 2_000_000);
    pipe2.flush("conv-1", "session_end");
    await pipe2.settle();

    const memories = mgr.listActive(AGENT, USER).filter((m) => m.content.includes("Notion"));
    expect(memories).toHaveLength(1); // 合并，不重复
  });
});
