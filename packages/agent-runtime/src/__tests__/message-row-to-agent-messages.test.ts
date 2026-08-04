/**
 * messageRowToAgentMessages：DB 行 → pi-agent 消息序列（含 toolCalls 展开）
 */
import { describe, expect, it } from "vitest";

import { ConversationRepo, messageRowToAgentMessages } from "../storage/conversation-repo.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";

function seedConversation(db: ReturnType<typeof createMigratedTestDb>, convId = "conv-1") {
  db.prepare(
    `INSERT INTO conversations (id, user_id, type, title, is_active, created_at)
     VALUES (?, 'u1', 'direct', 'test', 1, datetime('now'))`,
  ).run(convId);
}

describe("messageRowToAgentMessages", () => {
  it("assistant 消息的 toolCalls 应展开为 toolCall block + toolResult", () => {
    const row = {
      id: "m1",
      conversation_id: "c1",
      agent_id: null,
      role: "assistant",
      content_json: JSON.stringify({
        type: "text",
        text: "已完成第17篇",
        toolCalls: [
          {
            id: "tc1",
            name: "bash",
            args: { command: "ls" },
            result: "ok",
            isError: false,
          },
        ],
      }),
      is_proactive: 0,
      timestamp: "2026-07-05T10:00:00.000Z",
      is_streaming: 0,
    };

    const msgs = messageRowToAgentMessages(row);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("assistant");
    const content = msgs[0]!.content as Array<{ type: string; id?: string }>;
    expect(content.some((b) => b.type === "toolCall" && b.id === "tc1")).toBe(true);
    expect(msgs[1]!.role).toBe("toolResult");
    expect((msgs[1] as { toolCallId?: string }).toolCallId).toBe("tc1");
  });
});

describe("finalizeAllStreamingMessages", () => {
  it("应将 is_streaming=1 的消息标记为已完成并保留 content_json", () => {
    const db = createMigratedTestDb();
    seedConversation(db);
    const repo = new ConversationRepo(db);

    repo.saveMessage({
      id: "stream-1",
      conversationId: "conv-1",
      role: "assistant",
      contentJson: { type: "text", text: "第18篇生图中…" },
      isStreaming: true,
    });

    const count = repo.finalizeAllStreamingMessages();
    expect(count).toBe(1);

    const msgs = repo.loadMessagesAsPiFormat("conv-1");
    expect(msgs.length).toBeGreaterThan(0);
    const textBlock = (msgs[0]!.content as Array<{ type: string; text?: string }>).find(
      (b) => b.type === "text",
    );
    expect(textBlock?.text).toContain("第18篇");
  });
});
