import { describe, it, expect, beforeEach } from "vitest";
import { createMigratedTestDb } from "../../__tests__/helpers/sqlite-test-db.js";
import { AgentMemoryRepo } from "../memory-repo.js";
import { MemoryIndexRepo } from "../memory-index.js";
import type { DatabaseAdapter } from "../../storage/local-database.js";

describe("FTS5 派生索引", () => {
  let db: DatabaseAdapter;
  let repo: AgentMemoryRepo;
  let indexRepo: MemoryIndexRepo;

  beforeEach(() => {
    db = createMigratedTestDb();
    repo = new AgentMemoryRepo(db);
    indexRepo = new MemoryIndexRepo(db);
  });

  it("一致性：新增/更新/删除后索引恒健康", () => {
    const m1 = repo.saveCandidate({
      agentId: "a1",
      userId: "u1",
      category: "project",
      content: "用户喜欢周末去爬山",
    });
    expect(indexRepo.checkFtsHealth().isHealthy).toBe(true);

    repo.updateContentById(m1.id, "用户喜欢周末去爬山和露营");
    expect(indexRepo.checkFtsHealth().isHealthy).toBe(true);

    repo.removeById(m1.id);
    expect(indexRepo.checkFtsHealth().isHealthy).toBe(true);
  });

  it("rebuildFts 后条数不变（索引是派生物，重建不丢数据）", () => {
    repo.saveCandidate({ agentId: "a1", userId: "u1", category: "project", content: "项目部署到生产环境" });
    repo.saveCandidate({ agentId: "a1", userId: "u1", category: "general", content: "用户喜欢爬山" });

    const before = repo.listActive("a1", "u1").length;
    indexRepo.rebuildFts();
    const after = repo.listActive("a1", "u1").length;

    expect(after).toBe(before);
    expect(indexRepo.checkFtsHealth().isHealthy).toBe(true);
  });

  it("中文召回：BM25 排序命中目标记忆", () => {
    repo.saveCandidate({ agentId: "a1", userId: "u1", category: "general", content: "用户周末喜欢去爬山" });
    repo.saveCandidate({ agentId: "a1", userId: "u1", category: "general", content: "用户喜欢吃火锅" });
    repo.saveCandidate({ agentId: "a1", userId: "u1", category: "project", content: "项目计划下周部署到生产环境" });

    const hits = repo.search("a1", "u1", "爬山", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain("爬山");
  });

  it("特殊字符不崩：查询含引号时不抛异常", () => {
    repo.saveCandidate({ agentId: "a1", userId: "u1", category: "general", content: "普通内容" });
    expect(() => repo.search("a1", "u1", '"引号 AND 测试"', 5)).not.toThrow();
  });

  it("降级：FTS 表被手动 DROP 后 search 不崩溃，回落 LIKE", () => {
    repo.saveCandidate({ agentId: "a1", userId: "u1", category: "general", content: "用户喜欢爬山" });
    db.exec("DROP TABLE agent_memories_fts");

    const hits = repo.search("a1", "u1", "爬山", 5);
    expect(hits.length).toBe(1);
    expect(hits[0]!.content).toBe("用户喜欢爬山");
  });

  it("removeByTag：按标签整批删除并同步索引", () => {
    repo.saveCandidate({ agentId: "a1", userId: "u1", category: "reference", content: "先做小任务", tags: ["planner-todo"] });
    repo.saveCandidate({ agentId: "a1", userId: "u1", category: "reference", content: "再写复盘记录", tags: ["planner-todo"] });
    repo.saveCandidate({ agentId: "a1", userId: "u1", category: "project", content: "项目部署到生产环境" });

    expect(repo.removeByTag("a1", "u1", "planner-todo")).toBe(2);
    expect(repo.listActive("a1", "u1").map((m) => m.content)).toEqual(["项目部署到生产环境"]);
    expect(repo.search("a1", "u1", "小任务", 5)).toHaveLength(0);
    expect(indexRepo.checkFtsHealth().isHealthy).toBe(true);
  });

  it("removeByTag 只删带标签的行，不牵连同内容的无标签记忆", () => {
    repo.saveCandidate({ agentId: "a1", userId: "u1", category: "reference", content: "同一条内容", tags: ["planner-todo"] });
    // 裸插一条同内容、无标签的行（模拟其他来源；saveCandidate 会去重，故绕过它）
    const ts = new Date().toISOString();
    db.prepare(
      `INSERT INTO agent_memories (id, agent_id, user_id, category, content, importance, created_at, last_used, is_archived)
       VALUES ('other-src', 'a1', 'u1', 'reference', '同一条内容', 0.5, ?, ?, 0)`,
    ).run(ts, ts);

    expect(repo.removeByTag("a1", "u1", "planner-todo")).toBe(1);
    expect(repo.findById("other-src")).not.toBeNull();
  });
});
