/**
 * 上下文压缩标记 + UI 历史分页
 *
 * 压缩只应把消息移出 LLM 请求（compacted_at），不得物理删除；
 * UI 分页读取必须仍能看到被标记的消息。
 */

import { describe, it, expect } from "vitest";
import { ConversationRepo } from "../storage/conversation-repo.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";

/** 按角色写入当前消息存储格式的测试数据。 */
function insertMessage(
  db: ReturnType<typeof createMigratedTestDb>,
  id: string,
  conversationId: string,
  role: "user" | "assistant",
  text: string,
  timestamp: string,
): void {
  const content =
    role === "assistant"
      ? {
          type: "assistant_parts",
          parts: [{ type: "text", id: `${id}-text`, text, status: "done" }],
        }
      : { type: "text", text };
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content_json, timestamp, is_streaming)
     VALUES (?, ?, ?, ?, ?, 0)`,
  ).run(id, conversationId, role, JSON.stringify(content), timestamp);
}

/** 创建带 5 条交替消息的测试会话。 */
function seedConversation(): { db: ReturnType<typeof createMigratedTestDb>; convId: string; repo: ConversationRepo } {
  const db = createMigratedTestDb();
  const convId = "conv-compact";
  db.prepare(
    `INSERT INTO conversations (id, user_id, type, title, is_active, created_at)
     VALUES (?, 'local-user', 'direct', 'test', 1, ?)`,
  ).run(convId, new Date().toISOString());
  const base = Date.parse("2026-08-15T10:00:00.000Z");
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
  return { db, convId, repo: new ConversationRepo(db) };
}

describe("ConversationRepo 压缩标记与历史分页", () => {
  it("markMessagesCompacted 后消息仍在表中，但不再进入 pi 历史", () => {
    const { db, convId, repo } = seedConversation();

    const marked = repo.markMessagesCompacted(convId, ["m1", "m2"]);
    expect(marked).toBe(2);

    const rows = db
      .prepare<{ id: string; compacted_at: string | null }>(
        "SELECT id, compacted_at FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC",
      )
      .all(convId);
    expect(rows).toHaveLength(5);
    expect(rows[0]?.compacted_at).toBeTruthy();
    expect(rows[1]?.compacted_at).toBeTruthy();
    expect(rows[2]?.compacted_at).toBeNull();

    const pi = repo.loadMessagesAsPiFormat(convId, { limit: 20 });
    const texts = pi.map((m) => {
      const blocks = m.content as Array<{ type: string; text?: string }>;
      return blocks.find((b) => b.type === "text")?.text ?? "";
    });
    expect(texts).toEqual(["msg-3", "msg-4", "msg-5"]);
    expect(repo.countActiveMessages(convId)).toBe(3);
  });

  it("重复标记已压缩消息不重复计入 changes", () => {
    const { convId, repo } = seedConversation();
    expect(repo.markMessagesCompacted(convId, ["m1"])).toBe(1);
    expect(repo.markMessagesCompacted(convId, ["m1"])).toBe(0);
  });

  it("loadMessagesPage 仍返回被压缩的消息，并支持游标分页", () => {
    const { convId, repo } = seedConversation();
    repo.markMessagesCompacted(convId, ["m1", "m2"]);

    const page1 = repo.loadMessagesPage(convId, { limit: 2 });
    expect(page1.items.map((r) => r.id)).toEqual(["m4", "m5"]);
    expect(page1.hasMore).toBe(true);

    const oldest = page1.items[0]!;
    const page2 = repo.loadMessagesPage(convId, {
      limit: 2,
      before: { timestamp: oldest.timestamp, id: oldest.id },
    });
    expect(page2.items.map((r) => r.id)).toEqual(["m2", "m3"]);
    expect(page2.hasMore).toBe(true);

    const oldest2 = page2.items[0]!;
    const page3 = repo.loadMessagesPage(convId, {
      limit: 2,
      before: { timestamp: oldest2.timestamp, id: oldest2.id },
    });
    expect(page3.items.map((r) => r.id)).toEqual(["m1"]);
    expect(page3.hasMore).toBe(false);
  });

  it("schema 迁移后 messages 表应有 compacted_at 列", () => {
    const db = createMigratedTestDb();
    const cols = db.prepare<{ name: string }>("PRAGMA table_info(messages)").all();
    expect(cols.some((c) => c.name === "compacted_at")).toBe(true);
  });
});
