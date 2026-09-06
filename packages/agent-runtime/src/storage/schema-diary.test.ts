/**
 * V32 迁移验证：autonomous_diaries 日记表（留存 + 按日期读历史保连续性）。
 */
import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { SCHEMA_VERSION } from "./schema.js";

describe("diary schema V32", () => {
  it("SCHEMA_VERSION 已递增到至少 32", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(32);
  });

  it("新鲜数据库建出 autonomous_diaries 表", () => {
    const db = createMigratedTestDb();
    const row = db
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = 'autonomous_diaries'",
      )
      .get();
    expect(row?.name).toBe("autonomous_diaries");
    db.close();
  });

  it("autonomous_diaries 支持按日期倒序读历史日记", () => {
    const db = createMigratedTestDb();
    db.prepare(
      `INSERT INTO autonomous_diaries (id, agent_id, diary_date, content, created_at)
       VALUES ('d1','a1','2026-09-04','旧','2026-09-04T00:00:00.000Z'),
              ('d2','a1','2026-09-05','新','2026-09-05T00:00:00.000Z')`,
    ).run();
    const rows = db
      .prepare<{ diary_date: string }>(
        `SELECT diary_date FROM autonomous_diaries WHERE agent_id='a1' ORDER BY diary_date DESC`,
      )
      .all();
    expect(rows.map((r) => r.diary_date)).toEqual(["2026-09-05", "2026-09-04"]);
    db.close();
  });
});
