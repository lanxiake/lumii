/**
 * S7 相关性召回单测：loadTopMemories 的 query 相关性加分
 */

import { describe, it, expect, beforeEach } from "vitest";
import { AgentMemoryRepo } from "../memory/memory-repo.js";
import { DEFAULT_HOT_MEMORY_CONFIG } from "../memory/types.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";

describe("loadTopMemories 相关性召回", () => {
  let repo: AgentMemoryRepo;

  beforeEach(() => {
    repo = new AgentMemoryRepo(createMigratedTestDb());
    // 三条同重要度、同类别的记忆，仅内容主题不同
    repo.saveCandidate({ agentId: "a1", userId: "u1", category: "project", content: "用户计划七月去日本旅行预算两万", importance: 0.5, tags: [] });
    repo.saveCandidate({ agentId: "a1", userId: "u1", category: "project", content: "用户在准备 CPA 注册会计师考试", importance: 0.5, tags: [] });
    repo.saveCandidate({ agentId: "a1", userId: "u1", category: "project", content: "用户在学习吉他每周练习两次", importance: 0.5, tags: [] });
  });

  it("含 query 时相关记忆排序靠前", () => {
    const r = repo.loadTopMemories("a1", "u1", DEFAULT_HOT_MEMORY_CONFIG, "我之前说的去日本旅行的计划");
    expect(r[0].content).toContain("日本旅行");
  });

  it("不同 query → 不同相关记忆靠前", () => {
    const r = repo.loadTopMemories("a1", "u1", DEFAULT_HOT_MEMORY_CONFIG, "我的注册会计师考试复习进度");
    expect(r[0].content).toContain("CPA");
  });

  it("无 query 时退化为标量评分（不报错，返回全部）", () => {
    const r = repo.loadTopMemories("a1", "u1");
    expect(r).toHaveLength(3);
  });

  it("query 过短（< minQueryTokens）跳过相关性，退化标量", () => {
    // "嗯" 只有 1 个 token，不足门槛 2
    const r = repo.loadTopMemories("a1", "u1", DEFAULT_HOT_MEMORY_CONFIG, "嗯");
    expect(r).toHaveLength(3); // 不因相关性为 0 而排除任何项
  });

  it("上下文类无关记忆被相关性门控排除（只留相关的）", () => {
    // 三条都是 project（上下文类），query 只与"日本旅行"相关
    const r = repo.loadTopMemories("a1", "u1", DEFAULT_HOT_MEMORY_CONFIG, "我之前说的去日本旅行计划");
    expect(r).toHaveLength(1);
    expect(r[0].content).toContain("日本旅行");
  });

  it("画像类（user/feedback）不受相关性门控，始终保留", () => {
    repo.saveCandidate({ agentId: "a1", userId: "u1", category: "user", content: "用户是后端工程师", importance: 0.5, tags: [] });
    // query 与"日本旅行"相关，但 user 画像记忆即使无关也应保留
    const r = repo.loadTopMemories("a1", "u1", DEFAULT_HOT_MEMORY_CONFIG, "我之前说的去日本旅行计划");
    expect(r.some((m) => m.category === "user")).toBe(true);
  });

  it("关闭门控（gateContextualByRelevance=false）→ 退回加分非过滤", () => {
    const cfg = { ...DEFAULT_HOT_MEMORY_CONFIG, gateContextualByRelevance: false };
    const r = repo.loadTopMemories("a1", "u1", cfg, "去日本旅行");
    expect(r).toHaveLength(3); // 不门控，全保留
  });

  it("多用户隔离：u2 查不到 u1 的记忆", () => {
    const r = repo.loadTopMemories("a1", "u2", DEFAULT_HOT_MEMORY_CONFIG, "日本旅行");
    expect(r).toHaveLength(0);
  });
});

describe("MemoryManager.injectIntoSystemPrompt query 透传（S9）", () => {
  it("query 透传到召回：相关记忆被注入提示词", async () => {
    const { MemoryManager } = await import("../memory/manager.js");
    const repo = new AgentMemoryRepo(createMigratedTestDb());
    repo.saveCandidate({ agentId: "a1", userId: "u1", category: "project", content: "用户计划七月去日本旅行", importance: 0.5, tags: [] });
    repo.saveCandidate({ agentId: "a1", userId: "u1", category: "project", content: "用户在准备注册会计师考试", importance: 0.5, tags: [] });
    const mgr = new MemoryManager(repo);
    const { updatedPrompt, injected } = mgr.injectIntoSystemPrompt(
      "SYS",
      "a1",
      "u1",
      DEFAULT_HOT_MEMORY_CONFIG,
      "我之前说的去日本旅行计划",
    );
    expect(injected.length).toBeGreaterThan(0);
    expect(updatedPrompt).toContain("日本旅行");
  });
});
