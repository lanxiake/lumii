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

  it("残留里仍停在 running 的工具 part 收尾为 interrupted（否则永久显示「执行中」）", () => {
    const db = createMigratedTestDb();
    seedConversation(db);
    const repo = new ConversationRepo(db);

    repo.saveMessage({
      id: "stream-2",
      conversationId: "conv-1",
      role: "assistant",
      contentJson: {
        type: "assistant_parts",
        parts: [
          { type: "thinking", id: "th1", text: "想", status: "streaming" },
          {
            type: "tool",
            id: "t1",
            name: "spawn_agent",
            args: { name: "24shi-b12-fix" },
            status: "running",
          } as never,
          {
            type: "tool",
            id: "t2",
            name: "bash",
            args: {},
            result: "ok",
            isError: false,
            status: "done",
          } as never,
        ],
      },
      isStreaming: true,
    });

    repo.finalizeAllStreamingMessages();

    const row = db
      .prepare("SELECT content_json FROM messages WHERE id = ?")
      .get("stream-2") as { content_json: string };
    const parts = (
      JSON.parse(row.content_json) as { parts: Array<{ id: string; status: string; result?: unknown }> }
    ).parts;

    expect(parts.find((p) => p.id === "th1")?.status).toBe("done");
    expect(parts.find((p) => p.id === "t1")?.status).toBe("interrupted");
    // 已完成的工具不受影响
    expect(parts.find((p) => p.id === "t2")?.status).toBe("done");
    // 不补 result：渲染层靠「无结果 + 消息已结束」判定中断
    expect(parts.find((p) => p.id === "t1")).not.toHaveProperty("result");
  });

  it("无 running 工具时不重写 content_json（不做无谓写入）", () => {
    const db = createMigratedTestDb();
    seedConversation(db);
    const repo = new ConversationRepo(db);

    const original = JSON.stringify({
      type: "assistant_parts",
      parts: [{ type: "text", id: "tx1", text: "半句", status: "streaming" }],
    });
    repo.saveMessage({
      id: "stream-3",
      conversationId: "conv-1",
      role: "assistant",
      contentJson: JSON.parse(original),
      isStreaming: true,
    });

    repo.finalizeAllStreamingMessages();

    const row = db
      .prepare("SELECT content_json FROM messages WHERE id = ?")
      .get("stream-3") as { content_json: string };
    // thinking/text 的收尾由渲染层做；这里只负责工具 part，故内容保持原样
    expect(row.content_json).toBe(original);
  });
});
