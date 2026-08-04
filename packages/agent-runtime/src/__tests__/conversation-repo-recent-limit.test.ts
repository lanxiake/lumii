/**
 * loadMessagesAsPiFormat 应加载「最近 N 条」而非「最早 N 条」
 *
 * 回归保护：ORDER BY timestamp ASC LIMIT N 会导致长会话丢失最新上下文。
 */

import { describe, it, expect } from "vitest";
import { ConversationRepo } from "../storage/conversation-repo.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";

function insertMessage(
  db: ReturnType<typeof createMigratedTestDb>,
  id: string,
  conversationId: string,
  role: "user" | "assistant",
  text: string,
  timestamp: string,
): void {
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content_json, timestamp, is_streaming)
     VALUES (?, ?, ?, ?, ?, 0)`,
  ).run(id, conversationId, role, JSON.stringify({ type: "text", text }), timestamp);
}

describe("loadMessagesAsPiFormat 最近消息限制", () => {
  it("limit 小于总数时返回最近的 N 条（时间升序）", () => {
    const db = createMigratedTestDb();
    const convId = "conv-recent";
    db.prepare(
      `INSERT INTO conversations (id, user_id, type, title, is_active, created_at)
       VALUES (?, 'local-user', 'direct', 'test', 1, ?)`,
    ).run(convId, new Date().toISOString());
    const base = Date.parse("2026-06-30T10:00:00.000Z");

    for (let i = 1; i <= 5; i++) {
      insertMessage(
        db,
        `m${i}`,
        convId,
        i % 2 === 1 ? "user" : "assistant",
        `msg-${i}`,
        new Date(base + i * 1000).toISOString(),
      );
    }

    const repo = new ConversationRepo(db);
    const msgs = repo.loadMessagesAsPiFormat(convId, { limit: 3 });

    expect(msgs).toHaveLength(3);
    const texts = msgs.map((m) => {
      const blocks = m.content as Array<{ type: string; text?: string }>;
      return blocks.find((b) => b.type === "text")?.text ?? "";
    });
    expect(texts).toEqual(["msg-3", "msg-4", "msg-5"]);
  });
});
