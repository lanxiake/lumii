/**
 * V34 迁移验证：autonomous_goals 增加 scheduled_for / planned_by 两列，
 * 区分「被动触发」与「主动排期」的目标，支撑心跳按时间派发。
 */
import { describe, expect, it } from "vitest";
import { createMigratedTestDb, createTestSqliteAdapter } from "../__tests__/helpers/sqlite-test-db.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

describe("autonomous_goals schema V34", () => {
  it("SCHEMA_VERSION 已递增到 34 之后（V34 迁移仍在）", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(34);
  });

  it("autonomous_goals 含 scheduled_for / planned_by 两列", () => {
    const db = createMigratedTestDb();
    const cols = db
      .prepare<{ name: string }>("PRAGMA table_info(autonomous_goals)")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("scheduled_for");
    expect(cols).toContain("planned_by");
    db.close();
  });

  it("已有 V33 数据的库增量迁移到 V34，目标数据不丢失", () => {
    const db = createTestSqliteAdapter();
    for (const [version, sql] of MIGRATIONS) {
      if (version >= 34) continue;
      db.exec(sql);
    }
    // V33 时代的目标行（无新列）
    db.prepare(
      `INSERT INTO autonomous_goals
       (id, agent_id, type, description, trigger_reason, status, priority, created_at)
       VALUES ('g0','a1','learning','旧目标','low-satisfaction','completed',0.5,'2026-09-01T00:00:00.000Z')`,
    ).run();

    // 执行 V34 迁移
    const v34 = MIGRATIONS.find(([version]) => version === 34);
    expect(v34).toBeTruthy();
    db.exec(v34![1]);

    const cols = db
      .prepare<{ name: string }>("PRAGMA table_info(autonomous_goals)")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("scheduled_for");
    expect(cols).toContain("planned_by");

    // 旧目标仍在，新列默认 NULL
    const row = db
      .prepare<{ id: string; scheduled_for: string | null; planned_by: string | null }>(
        `SELECT id, scheduled_for, planned_by FROM autonomous_goals WHERE id = 'g0'`,
      )
      .get();
    expect(row?.id).toBe("g0");
    expect(row?.scheduled_for).toBeNull();
    expect(row?.planned_by).toBeNull();
    db.close();
  });

  it("被动目标（planned_by='trigger'、scheduled_for=NULL）可正常插入读取", () => {
    const db = createMigratedTestDb();
    db.prepare(
      `INSERT INTO autonomous_goals
       (id, agent_id, type, description, trigger_reason, status, priority, created_at, planned_by)
       VALUES ('g1','a1','learning','学点东西','low-satisfaction','executing',0.5,'2026-09-06T00:00:00.000Z','trigger')`,
    ).run();
    const row = db
      .prepare<{ scheduled_for: string | null; planned_by: string | null }>(
        `SELECT scheduled_for, planned_by FROM autonomous_goals WHERE id = 'g1'`,
      )
      .get();
    expect(row?.planned_by).toBe("trigger");
    expect(row?.scheduled_for).toBeNull();
    db.close();
  });
});
