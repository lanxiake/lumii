/**
 * listActiveConversations 排序回归保护
 *
 * 背景：新建会话的 last_msg_at 为 NULL，若排序写成 `last_msg_at DESC NULLS LAST`，
 * 新会话会被排到列表末尾；当会话总数超过 limit 时新会话直接被截断，
 * 渲染侧「当前会话不在列表就刷新」的兜底逻辑会陷入无限刷新循环。
 */

import { describe, it, expect } from "vitest";
import { ConversationRepo } from "../storage/conversation-repo.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";

/** 直接落库一条带 last_msg_at 的历史会话，绕开 createConversation 以便精确控制时间。 */
function insertConversation(
  db: ReturnType<typeof createMigratedTestDb>,
  id: string,
  createdAt: string,
  lastMsgAt: string | null,
): void {
  db.prepare(
    `INSERT INTO conversations (id, user_id, type, title, is_active, created_at, last_msg_at)
     VALUES (?, 'local-user', 'direct', ?, 1, ?, ?)`,
  ).run(id, id, createdAt, lastMsgAt);
}

describe("listActiveConversations 排序", () => {
  it("新建的空会话（last_msg_at 为 NULL）排在最前，不会被 limit 截断", () => {
    const db = createMigratedTestDb();
    const base = Date.parse("2026-06-30T10:00:00.000Z");

    // 先塞满 limit 条有消息的历史会话
    for (let i = 0; i < 50; i++) {
      const ts = new Date(base + i * 1000).toISOString();
      insertConversation(db, `old-${i}`, ts, ts);
    }

    const repo = new ConversationRepo(db);
    const created = repo.createConversation({
      userId: "local-user",
      title: "新对话",
      participants: [
        { type: "user", id: "local-user" },
        { type: "agent", id: "default" },
      ],
    });

    const rows = repo.listActiveConversations("local-user", 50);

    expect(rows.map((r) => r.id)).toContain(created.id);
    expect(rows[0]?.id).toBe(created.id);
  });

  it("置顶会话优先，其次按最后活跃时间倒序", () => {
    const db = createMigratedTestDb();
    insertConversation(db, "older", "2026-06-30T10:00:00.000Z", "2026-06-30T10:00:00.000Z");
    insertConversation(db, "newer", "2026-06-30T11:00:00.000Z", "2026-06-30T11:00:00.000Z");
    insertConversation(db, "pinned", "2026-06-30T09:00:00.000Z", "2026-06-30T09:00:00.000Z");
    db.prepare("UPDATE conversations SET is_pinned = 1 WHERE id = 'pinned'").run();

    const repo = new ConversationRepo(db);
    const rows = repo.listActiveConversations("local-user", 50);

    expect(rows.map((r) => r.id)).toEqual(["pinned", "newer", "older"]);
  });

  it("省略 limit 时返回全部会话，不截断渠道/系统会话", () => {
    const db = createMigratedTestDb();
    const base = Date.parse("2026-06-30T10:00:00.000Z");

    // 55 条默认会话（超过旧的全局 limit 50），last_msg_at 都比渠道/系统会话更新
    for (let i = 0; i < 55; i++) {
      const ts = new Date(base + i * 1000).toISOString();
      insertConversation(db, `default-${i}`, ts, ts);
    }
    // 渠道/系统会话的 last_msg_at 更旧，全局 limit 50 会把它们挤出列表
    insertConversation(db, "feishu:ou_x", "2026-06-29T10:00:00.000Z", "2026-06-29T10:00:00.000Z");
    insertConversation(db, "cron:job-1", "2026-06-29T09:00:00.000Z", "2026-06-29T09:00:00.000Z");
    insertConversation(db, "evolution:main", "2026-06-29T08:00:00.000Z", "2026-06-29T08:00:00.000Z");

    const repo = new ConversationRepo(db);
    const rows = repo.listActiveConversations("local-user");

    expect(rows).toHaveLength(58);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("feishu:ou_x");
    expect(ids).toContain("cron:job-1");
    expect(ids).toContain("evolution:main");
  });
});
