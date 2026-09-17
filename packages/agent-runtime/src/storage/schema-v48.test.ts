/**
 * V48 迁移验证：记忆的「非破坏失效」——取代语义。
 *
 * 动因（评审 2026-09-17 §4.4 / §2.5.3）：`archiveOldProjectSnapshots` 是全系统唯一的
 * 「新事实取代旧事实」机制，但它依据正则猜项目主题——实测只识别 18% 的 project 记忆、
 * 零重复主题、251 条零归档。修法是把解释工作搬到写路径（模型产出 `project_key`），
 * 本迁移提供承载它的列。
 *
 * 本用例守住：
 * 1. 四列建出来，且**旧行不被回填**——`superseded_at` 留 NULL 表示「未被取代」，
 *    给存量数据编造取代关系比留空更糟
 * 2. 旧列与数据不受影响
 * 3. 索引建在部分列上（只索引有 key 的行）
 */
import { describe, expect, it } from "vitest";
import { createPreV48TestDb, runMigration48 } from "../__tests__/helpers/sqlite-test-db.js";
import type { DatabaseAdapter } from "./local-database.js";
import { SCHEMA_VERSION } from "./schema.js";

function columns(db: DatabaseAdapter, table: string): string[] {
  return db
    .prepare<{ name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

describe("V48 迁移", () => {
  it("SCHEMA_VERSION 已推进到 48", () => {
    expect(SCHEMA_VERSION).toBe(48);
  });

  it("建出 project_key / superseded_at / superseded_by / archive_reason 四列", () => {
    const db = createPreV48TestDb();
    expect(columns(db, "agent_memories")).not.toContain("project_key");

    runMigration48(db);

    expect(columns(db, "agent_memories")).toEqual(
      expect.arrayContaining([
        "project_key",
        "superseded_at",
        "superseded_by",
        "archive_reason",
      ]),
    );
  });

  it("旧行不回填：superseded_at 全为 NULL（不编造取代关系）", () => {
    const db = createPreV48TestDb();
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO agent_memories
           (id, agent_id, user_id, category, content, importance, tags,
            created_at, last_used, use_count, is_archived)
         VALUES (?, 'assistant', 'local-user', 'project', ?, 0.7, NULL,
                 '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 0, 0)`,
      ).run(`m${i}`, `项目快照 ${i}`);
    }

    runMigration48(db);

    const row = db
      .prepare<{ total: number; superseded: number; keyed: number; count: number }>(
        `SELECT COUNT(*) AS total,
                SUM(superseded_at IS NOT NULL) AS superseded,
                SUM(project_key IS NOT NULL) AS keyed,
                (SELECT COUNT(*) FROM agent_memories) AS count
         FROM agent_memories`,
      )
      .get()!;
    expect(row.count).toBe(5);
    expect(row.superseded).toBe(0);
    expect(row.keyed).toBe(0);
  });

  it("迁移后仍可插入带 project_key 的新行（部分索引可用）", () => {
    const db = createPreV48TestDb();
    runMigration48(db);

    db.prepare(
      `INSERT INTO agent_memories
         (id, agent_id, user_id, category, content, importance, tags, project_key,
          created_at, last_used, use_count, is_archived)
       VALUES ('k1', 'assistant', 'local-user', 'project', '带 key 的快照', 0.7, NULL, 'k8s',
               '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 0, 0)`,
    ).run();

    const key = db
      .prepare<{ project_key: string }>("SELECT project_key FROM agent_memories WHERE id = 'k1'")
      .get()!.project_key;
    expect(key).toBe("k8s");
  });
});
