/**
 * V47 迁移验证：记忆的「曝光 / 效用」分离。
 *
 * 动因（评审 2026-09-17 §2.4.2）：`use_count` 记的是**被展示**而非**被使用**——它在注入时 +1，
 * 而 `last_used` 也在注入时刷新，两者都是打分输入，构成自激：被注入 → 分数变高 → 更容易
 * 再被注入。实测 9 条记忆吃掉全部注入席位的 54%，单条最高 251 次。
 *
 * 本用例守住三件事：
 * 1. 三个新列建出来，且**旧行被回填**——不回填会让 `passesInjectionGates` 把 155 条
 *    「其实用过」的记忆误判成「从未用过」而集体跳过（229 条中 155 条 use_count > 0）
 * 2. `use_count` / `last_used` 保留（云同步与历史统计仍读得到）
 * 3. 迁移在含数据的旧库上可执行，不丢行
 */
import { describe, expect, it } from "vitest";
import {
  createPreV47TestDb,
  runMigration47,
} from "../__tests__/helpers/sqlite-test-db.js";
import type { DatabaseAdapter } from "./local-database.js";
import { SCHEMA_VERSION } from "./schema.js";

function columns(db: DatabaseAdapter, table: string): string[] {
  return db
    .prepare<{ name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

function seedMemory(
  db: DatabaseAdapter,
  id: string,
  opts: { use_count: number; last_used: string },
): void {
  db.prepare(
    `INSERT INTO agent_memories
       (id, agent_id, user_id, category, content, importance, tags,
        created_at, last_used, use_count, is_archived)
     VALUES (?, 'assistant', 'local-user', 'project', ?, 0.6, NULL, ?, ?, ?, 0)`,
  ).run(id, `记忆 ${id}`, "2026-08-01T00:00:00.000Z", opts.last_used, opts.use_count);
}

describe("V47 迁移", () => {
  it("SCHEMA_VERSION 已推进到 47 或更高（V48 起为 48）", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(47);
  });

  it("建出 last_injected_at / exposure_count / utility_count 三列，保留旧列", () => {
    const db = createPreV47TestDb();
    const before = columns(db, "agent_memories");
    expect(before).not.toContain("last_injected_at");

    runMigration47(db);

    const after = columns(db, "agent_memories");
    expect(after).toEqual(
      expect.arrayContaining(["last_injected_at", "exposure_count", "utility_count"]),
    );
    // 旧列保留：云同步与历史统计仍要读
    expect(after).toEqual(expect.arrayContaining(["last_used", "use_count"]));
  });

  it("回填：exposure_count = use_count、last_injected_at = last_used", () => {
    const db = createPreV47TestDb();
    seedMemory(db, "m1", { use_count: 0, last_used: "2026-08-01T00:00:00.000Z" });
    seedMemory(db, "m2", { use_count: 42, last_used: "2026-09-10T12:00:00.000Z" });

    runMigration47(db);

    const rows = db
      .prepare<{
        id: string;
        use_count: number;
        exposure_count: number;
        utility_count: number;
        last_used: string;
        last_injected_at: string;
      }>(
        "SELECT id, use_count, exposure_count, utility_count, last_used, last_injected_at FROM agent_memories ORDER BY id",
      )
      .all();

    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.exposure_count).toBe(r.use_count);
      expect(r.last_injected_at).toBe(r.last_used);
      // 效用必须从 0 起——回填不了的东西不假装有
      expect(r.utility_count).toBe(0);
    }
  });

  it("不丢行（含数据的旧库上执行后条数不变）", () => {
    const db = createPreV47TestDb();
    for (let i = 0; i < 20; i++) {
      seedMemory(db, `m${i}`, { use_count: i, last_used: "2026-09-01T00:00:00.000Z" });
    }
    const beforeCount = db
      .prepare<{ c: number }>("SELECT COUNT(*) AS c FROM agent_memories")
      .get()!.c;

    runMigration47(db);

    const afterCount = db
      .prepare<{ c: number }>("SELECT COUNT(*) AS c FROM agent_memories")
      .get()!.c;
    expect(afterCount).toBe(beforeCount);
  });
});
