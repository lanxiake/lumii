/**
 * messageRowToAgentMessages：DB 行 → pi-agent 消息序列（含 toolCalls 展开）
 */
import { describe, expect, it } from "vitest";

import {
  ConversationRepo,
  messageRowToAgentMessages,
  parseMessageContentJson,
} from "../storage/conversation-repo.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";

/** 为存储层测试写入最小会话数据。 */
function seedConversation(db: ReturnType<typeof createMigratedTestDb>, convId = "conv-1") {
  db.prepare(
    `INSERT INTO conversations (id, user_id, type, title, is_active, created_at)
     VALUES (?, 'u1', 'direct', 'test', 1, datetime('now'))`,
  ).run(convId);
}

describe("messageRowToAgentMessages", () => {
  it("assistant_parts 按 parts 顺序投影 thinking/text/toolCall，并展开 toolResult", () => {
    const row = {
      id: "m1",
      conversation_id: "c1",
      agent_id: null,
      role: "assistant",
      content_json: JSON.stringify({
        type: "assistant_parts",
        parts: [
          { type: "thinking", id: "th1", text: "分析", status: "done" },
          { type: "text", id: "tx1", text: "开始", status: "done" },
          {
            type: "tool",
            id: "tc1",
            name: "bash",
            args: { command: "ls" },
            result: "ok",
            isError: false,
            status: "done",
          },
          { type: "text", id: "tx2", text: "完成", status: "done" },
        ],
      }),
      timestamp: "2026-07-05T10:00:00.000Z",
      is_streaming: 0,
    };

    const msgs = messageRowToAgentMessages(row);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("assistant");
    const blocks = msgs[0]!.content as Array<{
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
    }>;
    expect(blocks.map((block) => block.type)).toEqual(["thinking", "text", "toolCall", "text"]);
    expect(blocks[0]?.thinking).toBe("分析");
    expect(blocks[1]?.text).toBe("开始");
    expect(blocks[2]?.id).toBe("tc1");
    expect(blocks[3]?.text).toBe("完成");
    expect(msgs[1]!.role).toBe("toolResult");
    expect((msgs[1] as { toolCallId?: string }).toolCallId).toBe("tc1");
  });

  it("assistant 的旧 text 格式不再投影，user text 仍可投影", () => {
    const baseRow = {
      id: "m2",
      conversation_id: "c1",
      agent_id: null,
      content_json: JSON.stringify({ type: "text", text: "旧消息" }),
      timestamp: "2026-07-05T10:00:00.000Z",
      is_streaming: 0,
    };

    expect(messageRowToAgentMessages({ ...baseRow, role: "assistant" })).toEqual([]);
    expect(messageRowToAgentMessages({ ...baseRow, role: "user" })).toHaveLength(1);
  });
});

describe("parseMessageContentJson", () => {
  it("仅在 parts 为数组时识别 assistant_parts", () => {
    expect(
      parseMessageContentJson(
        JSON.stringify({
          type: "assistant_parts",
          parts: [{ type: "text", id: "tx1", text: "你好", status: "done" }],
        }),
      ),
    ).toMatchObject({ type: "assistant_parts" });
    expect(
      parseMessageContentJson(JSON.stringify({ type: "assistant_parts", parts: null })),
    ).toBeUndefined();
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
      contentJson: {
        type: "assistant_parts",
        parts: [{ type: "text", id: "tx1", text: "第18篇生图中…", status: "streaming" }],
      },
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
