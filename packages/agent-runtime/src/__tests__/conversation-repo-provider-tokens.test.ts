/**
 * 重启 / 切会话后恢复上下文用量读数。
 *
 * 助手消息落库为 `assistant_parts`，而这里早先只认扁平 `text`，于是「最近一次真实回执」
 * 永远查不到 —— 上下文用量静默退化成按消息估算，重启后占用条读数直接不对
 * （2026-09-20 实测：一个真实 26.4K 的会话，切回去显示成 424）。
 */

import { describe, it, expect } from "vitest";
import { ConversationRepo } from "../storage/conversation-repo.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";

type TestDb = ReturnType<typeof createMigratedTestDb>;

function seed(): { db: TestDb; convId: string; repo: ConversationRepo } {
  const db = createMigratedTestDb();
  const convId = "session-under-test";
  db.prepare(
    `INSERT INTO conversations (id, user_id, type, title, is_active, created_at, channel_type)
     VALUES (?, 'local-user', 'direct', '测试会话', 1, ?, 'local')`,
  ).run(convId, new Date().toISOString());
  return { db, convId, repo: new ConversationRepo(db) };
}

let seq = 0;
function insertAssistant(db: TestDb, convId: string, content: unknown, timestamp?: string): void {
  seq += 1;
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content_json, timestamp, is_streaming)
     VALUES (?, ?, 'assistant', ?, ?, 0)`,
  ).run(`msg-${seq}`, convId, JSON.stringify(content), timestamp ?? new Date(Date.now() + seq * 1000).toISOString());
}

describe("getLastAssistantProviderInputTokens", () => {
  it("assistant_parts 形态的助手消息也能取到真实回执", () => {
    const { db, convId, repo } = seed();
    insertAssistant(db, convId, {
      type: "assistant_parts",
      parts: [{ type: "text", id: "t1", text: "好的", status: "done" }],
      usage: { inputTokens: 26_402, outputTokens: 56 },
    });

    expect(repo.getLastAssistantProviderInputTokens(convId)).toBe(26_402);
  });

  it("扁平 text 形态（旧数据）仍然认", () => {
    const { db, convId, repo } = seed();
    insertAssistant(db, convId, {
      type: "text",
      text: "旧格式消息",
      usage: { inputTokens: 1234, outputTokens: 5 },
    });

    expect(repo.getLastAssistantProviderInputTokens(convId)).toBe(1234);
  });

  it("缓存命中计入读数（只取 inputTokens 会虚低一个量级）", () => {
    const { db, convId, repo } = seed();
    insertAssistant(db, convId, {
      type: "assistant_parts",
      parts: [],
      usage: { inputTokens: 152, outputTokens: 20, cacheRead: 11_800, cacheWrite: 500 },
    });

    expect(repo.getLastAssistantProviderInputTokens(convId)).toBe(152 + 11_800 + 500);
  });

  it("没有 usage 的消息跳过，继续往前找", () => {
    const { db, convId, repo } = seed();
    insertAssistant(db, convId, { type: "assistant_parts", parts: [] }, "2026-09-20T01:00:00.000Z");
    insertAssistant(
      db,
      convId,
      { type: "assistant_parts", parts: [], usage: { inputTokens: 777, outputTokens: 1 } },
      "2026-09-20T02:00:00.000Z",
    );

    expect(repo.getLastAssistantProviderInputTokens(convId)).toBe(777);
  });

  it("流式中的行不参与（收尾前是中间值，会误导读数）", () => {
    const { db, convId, repo } = seed();
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content_json, timestamp, is_streaming)
       VALUES ('msg-streaming', ?, 'assistant', ?, ?, 1)`,
    ).run(
      convId,
      JSON.stringify({
        type: "assistant_parts",
        parts: [],
        usage: { inputTokens: 99_999, outputTokens: 1 },
      }),
      "2026-09-20T03:00:00.000Z",
    );

    expect(repo.getLastAssistantProviderInputTokens(convId)).toBeUndefined();
  });

  it("没有任何带 usage 的助手消息时返回 undefined（交由调用方估算）", () => {
    const { db, convId, repo } = seed();
    insertAssistant(db, convId, { type: "assistant_parts", parts: [] });

    expect(repo.getLastAssistantProviderInputTokens(convId)).toBeUndefined();
  });
});
