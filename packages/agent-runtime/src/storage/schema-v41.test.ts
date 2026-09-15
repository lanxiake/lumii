/**
 * V41 迁移验证：会话归属渠道落库（10-S2）。
 *
 * 迁移做两件事：加 `conversations.channel_type` 列 + 按 id 前缀回填存量行。
 * 回填规则 = 建会话时的归属规则：渠道前缀 → 该渠道；cron/evolution/onboarding → 系统会话；
 * 其余（裸 conversationId，含被 /link 绑定的客户端会话）→ ipc——**绑定是路由，不改归属**。
 */
import { describe, expect, it } from "vitest";
import {
  createMigratedTestDb,
  createPreV41TestDb,
  runMigration41,
} from "../__tests__/helpers/sqlite-test-db.js";
import { SCHEMA_VERSION } from "./schema.js";

interface Row {
  id: string;
  channel_type: string | null;
}

/** 往 pre-V41 库塞几条待回填的会话（老库没有 channel_type 列，故只写老字段） */
function seedLegacyConversations(db: ReturnType<typeof createPreV41TestDb>, ids: string[]): void {
  const now = new Date().toISOString();
  for (const id of ids) {
    db.prepare(
      `INSERT INTO conversations (id, user_id, type, title, is_active, created_at)
       VALUES (?, 'local-user', 'direct', ?, 1, ?)`,
    ).run(id, id, now);
  }
}

describe("schema V41 conversations.channel_type", () => {
  it("SCHEMA_VERSION 已递增到 41", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(41);
  });

  it("新建库直接带 channel_type 列", () => {
    const db = createMigratedTestDb();
    const cols = db
      .prepare<{ name: string }>(`PRAGMA table_info(conversations)`)
      .all()
      .map((c) => c.name);
    expect(cols).toContain("channel_type");
    db.close();
  });

  it("存量行按前缀回填（含带时间戳的 /new 键与系统会话）", () => {
    const db = createPreV41TestDb();
    seedLegacyConversations(db, [
      "weixin:o9cq801",
      "feishu:ou_ba9a",
      "wecom:wodXgu",
      "qbot:964A476991442C6FA18DC32EF18AFEFC",
      "qbot:964A476991442C6FA18DC32EF18AFEFC:1730000000000",
      "cron:local-cron-1",
      "evolution:main",
      "onboarding:guide",
      "1f3c9a2b7d", // 客户端本地会话（裸 id）
    ]);

    runMigration41(db);

    const byId = new Map(
      db
        .prepare<Row>(`SELECT id, channel_type FROM conversations`)
        .all()
        .map((r) => [r.id, r.channel_type]),
    );
    expect(byId.get("weixin:o9cq801")).toBe("weixin");
    expect(byId.get("feishu:ou_ba9a")).toBe("feishu");
    expect(byId.get("wecom:wodXgu")).toBe("wecom");
    expect(byId.get("qbot:964A476991442C6FA18DC32EF18AFEFC")).toBe("qbot");
    expect(byId.get("qbot:964A476991442C6FA18DC32EF18AFEFC:1730000000000")).toBe("qbot");
    expect(byId.get("cron:local-cron-1")).toBe("cron");
    expect(byId.get("evolution:main")).toBe("evolution");
    expect(byId.get("onboarding:guide")).toBe("onboarding");
    // 裸 id = 客户端会话：被 /link 绑定的也是它，绑定是路由不是归属
    expect(byId.get("1f3c9a2b7d")).toBe("ipc");
    db.close();
  });

  it("回填覆盖渠道键与裸 id，无遗漏分支", () => {
    const db = createPreV41TestDb();
    seedLegacyConversations(db, ["qbot:964A", "1f3c9a2b7d"]);
    runMigration41(db);

    const rows = db
      .prepare<Row>(`SELECT id, channel_type FROM conversations ORDER BY id`)
      .all();
    // 两个 id 形状都在回填规则覆盖范围内，且各自只出现一次（CASE 全匹配，无遗漏分支）
    expect(rows).toEqual([
      { id: "1f3c9a2b7d", channel_type: "ipc" },
      { id: "qbot:964A", channel_type: "qbot" },
    ]);
    db.close();
  });
});
