/**
 * P2 V30 迁移验证：多层进化协同的表结构、约束与数据保留。
 */
import { describe, expect, it } from "vitest";
import { createTestSqliteAdapter, createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";
import type { DatabaseAdapter } from "./types.js";

/** 建一个迁移到 V29（即将执行 V30 之前）的内存库 */
function createPreV30TestDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter();
  for (const [version, sql] of MIGRATIONS) {
    if (version >= 30) continue;
    db.exec(sql);
  }
  return db;
}

/** 对一个 pre-V30 库执行 V30 迁移 SQL */
function runMigration30(db: DatabaseAdapter): void {
  const entry = MIGRATIONS.find(([version]) => version === 30);
  if (!entry) throw new Error("V30 migration not found in MIGRATIONS");
  db.exec(entry[1]);
}

const P2_TABLES = [
  "memory_usage_feedback",
  "skill_usage_records",
  "tool_usage_feedback",
  "coordinated_evolution_history",
  "pareto_frontier",
  "memory_ranking_weights",
  "coordinated_scheduler_state",
];

describe("autonomous P2 schema V30", () => {
  it("SCHEMA_VERSION 已递增到至少 30", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(30);
  });

  it("新鲜数据库可完成全量迁移并建出全部 P2 表", () => {
    const db = createMigratedTestDb();

    for (const table of P2_TABLES) {
      const row = db
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table);
      expect(row?.name, `表 ${table} 应存在`).toBe(table);
    }

    db.close();
  });

  it("已有 P0/P1 数据的库可增量迁移，且目标数据不丢失", () => {
    const db = createPreV30TestDb();

    // 写入一条 P1 时代的目标
    db.prepare(
      `INSERT INTO autonomous_goals (id, agent_id, type, description, trigger_reason, status, priority, created_at)
       VALUES ('g1', 'a1', 'capability-improvement', '提升代码能力', 'low-satisfaction', 'pending', 0.7, '2026-09-01T00:00:00.000Z')`,
    ).run();

    runMigration30(db);

    const row = db
      .prepare<{ id: string; type: string; description: string }>("SELECT id, type, description FROM autonomous_goals WHERE id = 'g1'")
      .get();
    expect(row?.type).toBe("capability-improvement");
    expect(row?.description).toBe("提升代码能力");

    db.close();
  });

  it("迁移后 autonomous_goals 接受 P2 的两种新目标类型", () => {
    const db = createMigratedTestDb();

    for (const type of ["skill-enhancement", "memory-optimization"]) {
      expect(() =>
        db.prepare(
          `INSERT INTO autonomous_goals (id, agent_id, type, description, trigger_reason, status, priority, created_at)
           VALUES (?, 'a1', ?, 'desc', 'scheduled', 'pending', 0.5, '2026-09-04T00:00:00.000Z')`,
        ).run(`goal-${type}`, type),
      ).not.toThrow();
    }

    db.close();
  });

  it("autonomous_goals 仍拒绝未知目标类型", () => {
    const db = createMigratedTestDb();

    expect(() =>
      db.prepare(
        `INSERT INTO autonomous_goals (id, agent_id, type, description, trigger_reason, status, priority, created_at)
         VALUES ('bad', 'a1', 'self-replicate', 'desc', 'scheduled', 'pending', 0.5, '2026-09-04T00:00:00.000Z')`,
      ).run(),
    ).toThrow();

    db.close();
  });

  it("memory_usage_feedback 拒绝越界的贡献度", () => {
    const db = createMigratedTestDb();

    const insert = (score: number) =>
      db.prepare(
        `INSERT INTO memory_usage_feedback (memory_id, session_id, query_length, was_used_in_response, contribution_score, features, created_at)
         VALUES ('m1', 's1', 12, 1, ?, '{}', '2026-09-04T00:00:00.000Z')`,
      ).run(score);

    expect(() => insert(0.5)).not.toThrow();
    expect(() => insert(1.5)).toThrow();
    expect(() => insert(-0.1)).toThrow();

    db.close();
  });

  it("memory_usage_feedback 不含 query 原文列（隐私约束）", () => {
    const db = createMigratedTestDb();

    const columns = db
      .prepare<{ name: string }>("SELECT name FROM pragma_table_info('memory_usage_feedback')")
      .all()
      .map((c) => c.name);

    expect(columns).toContain("query_length");
    expect(columns).not.toContain("query");

    db.close();
  });

  it("skill_usage_records 约束复杂度枚举与非负耗时", () => {
    const db = createMigratedTestDb();

    const insert = (complexity: string, executionTime: number) =>
      db.prepare(
        `INSERT INTO skill_usage_records (skill_name, session_id, task_type, complexity, success, execution_time, user_satisfaction, created_at)
         VALUES ('s', 'sess', 'task', ?, 1, ?, 0.8, '2026-09-04T00:00:00.000Z')`,
      ).run(complexity, executionTime);

    expect(() => insert("medium", 1000)).not.toThrow();
    expect(() => insert("extreme", 1000)).toThrow();
    expect(() => insert("low", -1)).toThrow();

    db.close();
  });

  it("tool_usage_feedback 约束 result 枚举与难度范围", () => {
    const db = createMigratedTestDb();

    const insert = (result: string, difficulty: number) =>
      db.prepare(
        `INSERT INTO tool_usage_feedback (tool_name, session_id, task_type, difficulty, result, execution_time, created_at)
         VALUES ('t', 'sess', 'task', ?, ?, 100, '2026-09-04T00:00:00.000Z')`,
      ).run(difficulty, result);

    expect(() => insert("success", 0.5)).not.toThrow();
    expect(() => insert("failure", 0.5)).not.toThrow();
    expect(() => insert("timeout", 0.5)).toThrow();
    expect(() => insert("success", 2)).toThrow();

    db.close();
  });

  it("pareto_frontier 的 config_hash 唯一", () => {
    const db = createMigratedTestDb();

    const insert = () =>
      db.prepare(
        `INSERT INTO pareto_frontier (config_hash, agent_id, config_json, user_satisfaction, response_time, token_cost, added_at)
         VALUES ('hash-1', 'a1', '{}', 0.8, 1000, 500, '2026-09-04T00:00:00.000Z')`,
      ).run();

    expect(() => insert()).not.toThrow();
    expect(() => insert()).toThrow();

    db.close();
  });

  it("coordinated_evolution_history 记录四层贡献与探索模式", () => {
    const db = createMigratedTestDb();

    db.prepare(
      `INSERT INTO coordinated_evolution_history
        (agent_id, session_id, correlation_id, config_json, user_satisfaction, response_time, token_cost,
         prompt_contribution, memory_contribution, skill_contribution, tool_contribution, exploration_mode, explored_layer, created_at)
       VALUES ('a1', 's1', 'c1', '{}', 0.8, 3000, 1200, 0.4, 0.3, 0.2, 0.1, 'explore_memory', 'memory', '2026-09-04T00:00:00.000Z')`,
    ).run();

    const row = db
      .prepare<{ exploration_mode: string; memory_contribution: number }>(
        "SELECT exploration_mode, memory_contribution FROM coordinated_evolution_history WHERE agent_id = 'a1'",
      )
      .get();

    expect(row?.exploration_mode).toBe("explore_memory");
    expect(row?.memory_contribution).toBeCloseTo(0.3);

    db.close();
  });

  it("memory_ranking_weights 支持按 agent + version 存多份快照", () => {
    const db = createMigratedTestDb();

    const insert = (version: number) =>
      db.prepare(
        `INSERT INTO memory_ranking_weights (agent_id, version, weights_json, created_at)
         VALUES ('a1', ?, '{}', '2026-09-04T00:00:00.000Z')`,
      ).run(version);

    expect(() => insert(1)).not.toThrow();
    expect(() => insert(2)).not.toThrow();
    // 同一 agent 的同一版本重复写入应被主键拒绝
    expect(() => insert(2)).toThrow();

    db.close();
  });

  it("coordinated_scheduler_state 每个 agent 只保留一行状态", () => {
    const db = createMigratedTestDb();

    const insert = () =>
      db.prepare(
        `INSERT INTO coordinated_scheduler_state (agent_id, global_satisfaction, exploration_budget, state_json, last_updated)
         VALUES ('a1', 0.7, 0.15, '{}', '2026-09-04T00:00:00.000Z')`,
      ).run();

    expect(() => insert()).not.toThrow();
    expect(() => insert()).toThrow();

    db.close();
  });

  it("P0/P1 表在 V30 迁移后依然存在（回滚不误删既有数据）", () => {
    const db = createMigratedTestDb();

    const legacyTables = [
      "autonomous_satisfaction_scores",
      "autonomous_goals",
      "prompt_variants",
      "personality_state",
      "capability_dimensions",
      "capability_tests",
      "reflections",
    ];

    for (const table of legacyTables) {
      const row = db
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table);
      expect(row?.name, `P0/P1 表 ${table} 应保留`).toBe(table);
    }

    db.close();
  });
});
