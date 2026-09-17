/**
 * 墓碑链路（P0-2）：删除写 `deleted_at`，读路径全部过滤。
 *
 * 背景（评审 2026-09-17 §2.4.5）：`deleted_at` 是 V38 为云同步软删除加的墓碑列，
 * 同步器会传播它（`sync-importer.ts` 的「优先传播删除」分支）、`asset-checkup` 也认它——
 * **唯独没有任何生产者**：本地删除走的是 `removeById` 硬删。于是删除无法跨设备传播，
 * 对端记录仍是活的，下一轮合并会把行带回来。
 *
 * 这批用例守住两件事：
 * 1. 删除后行仍在库中（带 `deleted_at`），但**任何读路径都看不见它**
 * 2. 已删内容可以重新写入（墓碑不该把同名新记忆也挡在门外）
 *
 * 顺序约束（实施计划约束 #4）：先补生产者，再加读过滤。反过来做没有任何可观测效果。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AgentMemoryRepo } from "../memory-repo.js";
import { MemoryIndexRepo } from "../memory-index.js";
import { DEFAULT_HOT_MEMORY_CONFIG } from "../types.js";
import { createMigratedTestDb } from "../../__tests__/helpers/sqlite-test-db.js";
import type { DatabaseAdapter } from "../../storage/local-database.js";

const A = "assistant";
const U = "local-user";
const QUERY = "关西旅行 计划 版本"; // 有效 token ≥ 2，能通过相关性门控

describe("P0-2 墓碑链路", () => {
  let repo: AgentMemoryRepo;
  let db: DatabaseAdapter;

  beforeEach(() => {
    db = createMigratedTestDb();
    repo = new AgentMemoryRepo(db);
  });

  function save(content: string, importance = 0.7): string {
    return repo.saveCandidate({
      agentId: A,
      userId: U,
      category: "project",
      content,
      importance,
      tags: [],
    }).id;
  }

  function deletedAtOf(id: string): string | null {
    return db
      .prepare<{ deleted_at: string | null }>("SELECT deleted_at FROM agent_memories WHERE id = ?")
      .get(id)!.deleted_at;
  }

  it("删除写墓碑：行仍在库中且 deleted_at 非空", () => {
    const id = save("关西旅行计划：旧版本已过期");
    expect(deletedAtOf(id)).toBeNull();

    repo.removeById(id);

    expect(deletedAtOf(id)).not.toBeNull();
    expect(repo.findById(id)).not.toBeNull(); // 行还在（findById 是管理/溯源用，不做过滤）
  });

  it("已删条目不出现在注入 / 搜索 / 列表 / 温度统计中", () => {
    const kept = save("关西旅行计划：保留的版本");
    const removed = save("关西旅行计划：要删掉的版本");
    repo.removeById(removed);

    expect(repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, QUERY).map((e) => e.id)).toEqual([
      kept,
    ]);
    expect(repo.search(A, U, "关西旅行").map((e) => e.id)).toEqual([kept]);
    expect(repo.listActive(A, U).map((e) => e.id)).toEqual([kept]);
    expect(repo.listActiveAllAgents(U).map((e) => e.id)).toEqual([kept]);
    const stats = repo.countByTemperature(A, U, Date.now());
    expect(stats.hot + stats.warm + stats.cold).toBe(1);
    const win = repo.listByWindow({ userId: U, agentId: A, since: "2000-01-01T00:00:00.000Z" });
    expect(win.entries.map((e) => e.id)).toEqual([kept]);
  });

  it("删除同时清理 FTS 索引（搜索回落 LIKE 也搜不到）", () => {
    const id = save("关西旅行计划：这条要被搜不到");
    repo.removeById(id);

    // FTS 命中路径
    expect(repo.search(A, U, "关西旅行")).toHaveLength(0);
    // LIKE 回落路径（分词为空时走它）
    expect(repo.search(A, U, "!!!")).toHaveLength(0);
    // 索引与主表条数一致性检查不因墓碑而报错
    expect(db.prepare<{ c: number }>("SELECT COUNT(*) AS c FROM agent_memories_fts").get()!.c).toBe(
      0,
    );
  });

  it("同内容的历史重复行一并写墓碑", () => {
    const first = save("关西旅行计划：重复内容");
    // 绕过 saveCandidate 的幂等去重，直接插一条同内容的历史重复
    db.prepare(
      `INSERT INTO agent_memories
         (id, agent_id, user_id, category, content, importance, tags,
          created_at, last_used, use_count, is_archived)
       VALUES ('dup-1', ?, ?, 'project', '关西旅行计划：重复内容', 0.7, NULL,
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0, 0)`,
    ).run(A, U);

    repo.removeById(first);

    const live = db
      .prepare<{ c: number }>(
        "SELECT COUNT(*) AS c FROM agent_memories WHERE content = '关西旅行计划：重复内容' AND deleted_at IS NULL",
      )
      .get()!.c;
    expect(live).toBe(0);
    expect(repo.search(A, U, "关西旅行")).toHaveLength(0);
  });

  it("已删内容可以重新写入（墓碑不该挡住同名新记忆）", () => {
    const old = save("关西旅行计划：写错了要重来");
    repo.removeById(old);

    const fresh = save("关西旅行计划：写错了要重来");

    expect(fresh).not.toBe(old);
    expect(repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, QUERY).map((e) => e.id)).toEqual([
      fresh,
    ]);
  });

  it("索引重建不会让已删条目复活（墓碑语义不被 rebuild 抹掉）", () => {
    const kept = save("关西旅行计划：保留的版本");
    const removed = save("关西旅行计划：要删掉的版本");
    repo.removeById(removed);

    repo.rebuildIndex();

    expect(repo.search(A, U, "关西旅行").map((e) => e.id)).toEqual([kept]);
    expect(db.prepare<{ c: number }>("SELECT COUNT(*) AS c FROM agent_memories_fts").get()!.c).toBe(
      1,
    );
  });

  it("FTS 健康检查按活跃行比对（墓碑不造成假性不一致）", () => {
    save("关西旅行计划：一条");
    const removed = save("关西旅行计划：另一条");
    repo.removeById(removed);

    // 与应用内一致：健康检查由 MemoryIndexRepo 提供（bridge 的启动自愈读它决定是否重建）
    const indexRepo = new MemoryIndexRepo(db);
    const health = indexRepo.checkFtsHealth();
    expect(health.isHealthy).toBe(true);
  });

  it("用户主动清空仍是硬删（墓碑语义只给单条删除）", () => {
    save("关西旅行计划：一条");
    save("关西旅行计划：另一条");

    const n = repo.clearAllForAgent(A, U);

    expect(n).toBe(2);
    expect(
      db.prepare<{ c: number }>("SELECT COUNT(*) AS c FROM agent_memories").get()!.c,
    ).toBe(0);
  });

  it("标签整批轮换仍是硬删", () => {
    repo.saveCandidate({
      agentId: A,
      userId: U,
      category: "general",
      content: "planner-todo 待办条目",
      tags: ["planner-todo"],
    });

    const n = repo.removeByTag(A, U, "planner-todo");

    expect(n).toBe(1);
    expect(
      db.prepare<{ c: number }>("SELECT COUNT(*) AS c FROM agent_memories").get()!.c,
    ).toBe(0);
  });
});
