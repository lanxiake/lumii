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
});
