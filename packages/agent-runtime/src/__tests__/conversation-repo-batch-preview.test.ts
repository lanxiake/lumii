/**
 * loadLastMessagesForConversations 批量预览查询
 *
 * 背景：会话列表原先对每条会话各查一次最后消息（50 会话 = 50 次 SQL，N+1）。
 * 这里用 ROW_NUMBER() 窗口函数一次取回所有会话的最近 N 条，
 * 本测试同时验证分组正确性与 node:sqlite 对窗口函数的支持。
 */

import { describe, it, expect } from "vitest";
import { ConversationRepo } from "../storage/conversation-repo.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";

function insertConversation(
  db: ReturnType<typeof createMigratedTestDb>,
  id: string,
): void {
  db.prepare(
    `INSERT INTO conversations (id, user_id, type, title, is_active, created_at, last_msg_at)
     VALUES (?, 'local-user', 'direct', ?, 1, '2026-06-30T10:00:00.000Z', '2026-06-30T10:00:00.000Z')`,
  ).run(id, id);
}

function insertMessage(
  db: ReturnType<typeof createMigratedTestDb>,
  params: {
    id: string;
    conversationId: string;
    role: string;
    text: string;
    timestamp: string;
    isStreaming?: number;
  },
): void {
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content_json, timestamp, is_streaming)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    params.id,
    params.conversationId,
    params.role,
    JSON.stringify({ type: "text", text: params.text }),
    params.timestamp,
    params.isStreaming ?? 0,
  );
}

describe("loadLastMessagesForConversations", () => {
  it("一次查询返回多个会话的最近消息，按会话分组且时间正序", () => {
    const db = createMigratedTestDb();
    insertConversation(db, "conv-a");
    insertConversation(db, "conv-b");

    insertMessage(db, {
      id: "a1",
      conversationId: "conv-a",
      role: "user",
      text: "问题 A",
      timestamp: "2026-06-30T10:00:00.000Z",
    });
    insertMessage(db, {
      id: "a2",
      conversationId: "conv-a",
      role: "assistant",
      text: "回答 A",
      timestamp: "2026-06-30T10:00:01.000Z",
    });
    insertMessage(db, {
      id: "b1",
      conversationId: "conv-b",
      role: "assistant",
      text: "回答 B",
      timestamp: "2026-06-30T10:00:02.000Z",
    });

    const repo = new ConversationRepo(db);
    const map = repo.loadLastMessagesForConversations(["conv-a", "conv-b"]);

    expect(map.size).toBe(2);
    const a = map.get("conv-a")!;
    expect(a.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(JSON.parse(a[1]!.content_json).text).toBe("回答 A");
    expect(map.get("conv-b")).toHaveLength(1);
  });

  it("每个会话最多返回 limit 条，保留最近的", () => {
    const db = createMigratedTestDb();
    insertConversation(db, "conv-a");
    for (let i = 0; i < 10; i++) {
      insertMessage(db, {
        id: `m${i}`,
        conversationId: "conv-a",
        role: "assistant",
        text: `消息 ${i}`,
        timestamp: `2026-06-30T10:00:0${i}.000Z`,
      });
    }

    const repo = new ConversationRepo(db);
    const rows = repo.loadLastMessagesForConversations(["conv-a"], 3).get("conv-a")!;

    expect(rows).toHaveLength(3);
    // 取最近 3 条（7、8、9），且按时间正序返回
    expect(rows.map((m) => JSON.parse(m.content_json).text)).toEqual([
      "消息 7",
      "消息 8",
      "消息 9",
    ]);
  });

  it("跳过流式中的消息", () => {
    const db = createMigratedTestDb();
    insertConversation(db, "conv-a");
    insertMessage(db, {
      id: "done",
      conversationId: "conv-a",
      role: "assistant",
      text: "已完成",
      timestamp: "2026-06-30T10:00:00.000Z",
    });
    insertMessage(db, {
      id: "streaming",
      conversationId: "conv-a",
      role: "assistant",
      text: "正在输出",
      timestamp: "2026-06-30T10:00:01.000Z",
      isStreaming: 1,
    });

    const repo = new ConversationRepo(db);
    const rows = repo.loadLastMessagesForConversations(["conv-a"]).get("conv-a")!;

    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.content_json).text).toBe("已完成");
  });

  it("空输入返回空 Map，不发查询", () => {
    const db = createMigratedTestDb();
    const repo = new ConversationRepo(db);
    expect(repo.loadLastMessagesForConversations([]).size).toBe(0);
  });

  it("没有消息的会话不出现在结果中", () => {
    const db = createMigratedTestDb();
    insertConversation(db, "empty-conv");
    const repo = new ConversationRepo(db);
    const map = repo.loadLastMessagesForConversations(["empty-conv"]);
    expect(map.get("empty-conv")).toBeUndefined();
  });
});
