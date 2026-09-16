/**
 * 实例销毁时的流式行收尾
 *
 * destroy 可能早于 agent:end 的落库收尾（收尾要等工作区快照等异步步骤），
 * 此时若无条件删除占位行，会把这一轮已经流式落库的正文连同工具轨迹整条抹掉 ——
 * 定时任务会话里「Agent 回复凭空消失」即由此而来。
 * 取舍：空壳删除，有内容（正文或工具调用）转已完成保留。
 */

import { describe, it, expect } from "vitest";
import { ConversationRepo } from "../storage/conversation-repo.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";

type TestDb = ReturnType<typeof createMigratedTestDb>;

/** 建一个带会话记录的库，返回 repo 与会话 id */
function seedConversation(): { db: TestDb; convId: string; repo: ConversationRepo } {
  const db = createMigratedTestDb();
  const convId = "cron:seed-morning-briefing";
  db.prepare(
    `INSERT INTO conversations (id, user_id, type, title, is_active, created_at, channel_type)
     VALUES (?, 'local-user', 'direct', '定时任务 · 早间简报', 1, ?, 'cron')`,
  ).run(convId, new Date().toISOString());
  return { db, convId, repo: new ConversationRepo(db) };
}

/** 写入一条流式中的 assistant 消息，返回其 id */
function insertStreaming(
  db: TestDb,
  convId: string,
  id: string,
  parts: readonly Record<string, unknown>[],
): string {
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content_json, timestamp, is_streaming)
     VALUES (?, ?, 'assistant', ?, ?, 1)`,
  ).run(id, convId, JSON.stringify({ type: "assistant_parts", parts }), new Date().toISOString());
  return id;
}

/** 直接读库，绕开仓库缓存 */
function readMessage(db: TestDb, id: string): { is_streaming: number; content_json: string } | undefined {
  return db
    .prepare<{ is_streaming: number; content_json: string }>(
      "SELECT is_streaming, content_json FROM messages WHERE id = ?",
    )
    .get(id);
}

describe("finalizeOrDeleteStreamingMessage", () => {
  it("空壳占位（无正文无工具）删除，不留无主行", () => {
    const { db, convId, repo } = seedConversation();
    insertStreaming(db, convId, "msg-empty", []);

    expect(repo.finalizeOrDeleteStreamingMessage("msg-empty", convId)).toBe("deleted");
    expect(readMessage(db, "msg-empty")).toBeUndefined();
  });

  it("已写入正文的流式行保留并置为已完成，回复不因 destroy 消失", () => {
    const { db, convId, repo } = seedConversation();
    insertStreaming(db, convId, "msg-text", [
      { type: "text", id: "t1", text: "早间简报 · 今天最该动手的三件事", status: "done" },
    ]);

    expect(repo.finalizeOrDeleteStreamingMessage("msg-text", convId)).toBe("finalized");
    const row = readMessage(db, "msg-text");
    expect(row?.is_streaming).toBe(0);
    expect(row?.content_json).toContain("早间简报");
  });

  it("只有工具调用轨迹的流式行同样保留（内容判据与孤儿清扫一致）", () => {
    const { db, convId, repo } = seedConversation();
    insertStreaming(db, convId, "msg-tool", [
      { type: "tool", id: "tool-1", name: "work_report_read", args: {}, status: "completed" },
    ]);

    expect(repo.finalizeOrDeleteStreamingMessage("msg-tool", convId)).toBe("finalized");
    expect(readMessage(db, "msg-tool")?.is_streaming).toBe(0);
  });

  it("已收尾的行不动（agent:end 正常落库后 destroy 是空操作）", () => {
    const { db, convId, repo } = seedConversation();
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content_json, timestamp, is_streaming)
       VALUES ('msg-done', ?, 'assistant', ?, ?, 0)`,
    ).run(
      convId,
      JSON.stringify({ type: "assistant_parts", parts: [{ type: "text", id: "t1", text: "已完成", status: "done" }] }),
      new Date().toISOString(),
    );

    expect(repo.finalizeOrDeleteStreamingMessage("msg-done", convId)).toBe("missing");
    expect(readMessage(db, "msg-done")?.content_json).toContain("已完成");
  });

  it("行不存在时返回 missing，不抛错", () => {
    const { convId, repo } = seedConversation();
    expect(repo.finalizeOrDeleteStreamingMessage("msg-unknown", convId)).toBe("missing");
  });
});
