/**
 * 会话分支（ConversationRepo.forkConversation）。
 *
 * 分支 = 把「锚点及其之前」的历史原样复刻到一个新会话；锚点之后的不复制。
 * 这里守的是四条容易静默出错的边界：
 * - 不传 newUserContent 时是纯复制（不凭空多出一条消息）；
 * - 同毫秒的多条消息要按插入顺序切，不能按 timestamp 单键排序；
 * - 锚点在流式中时拒绝（复制半截回复等于把残缺内容带进新分支）；
 * - 新会话不带父会话的 session_config（配置继承走全局默认）。
 */
import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { ConversationRepo } from "./conversation-repo.js";

const USER = "local-user";

function seed(
  repo: ConversationRepo,
  conversationId: string,
  texts: { id: string; text: string; timestamp: string; role?: "user" | "assistant" }[],
): void {
  for (const t of texts) {
    repo.saveMessage({
      id: t.id,
      conversationId,
      role: t.role ?? "user",
      contentJson: { type: "text", text: t.text },
      timestamp: t.timestamp,
    });
  }
}

/** 分支里实际复制过来的消息（排除末尾追加的那条 user 消息） */
function branchTexts(repo: ConversationRepo, conversationId: string): string[] {
  const page = repo.loadMessagesForUI(conversationId, 1, 100);
  return page.items.map((row: { content_json: string }) => JSON.parse(row.content_json).text);
}

describe("ConversationRepo.forkConversation", () => {
  it("不传 newUserContent 时纯复制到锚点为止", () => {
    const db = createMigratedTestDb();
    const repo = new ConversationRepo(db);
    const src = repo.createConversation({ userId: USER, title: "父会话", participants: [] });
    seed(repo, src.id, [
      { id: "m1", text: "第一句", timestamp: "2026-01-01T00:00:01.000Z" },
      { id: "m2", text: "第二句", timestamp: "2026-01-01T00:00:02.000Z" },
      { id: "m3", text: "第三句", timestamp: "2026-01-01T00:00:03.000Z" },
    ]);

    const forkId = repo.forkConversation({
      sourceConversationId: src.id,
      uptoMessageId: "m2",
      userId: USER,
    });

    expect(branchTexts(repo, forkId)).toEqual(["第一句", "第二句"]);
    // 父会话不受影响
    expect(branchTexts(repo, src.id)).toEqual(["第一句", "第二句", "第三句"]);
    db.close();
  });

  it("同毫秒的消息按插入顺序切，不按 timestamp 截断", () => {
    const db = createMigratedTestDb();
    const repo = new ConversationRepo(db);
    const src = repo.createConversation({ userId: USER, title: "父会话", participants: [] });
    const sameTs = "2026-01-01T00:00:01.000Z";
    seed(repo, src.id, [
      { id: "a1", text: "同刻一", timestamp: sameTs },
      { id: "a2", text: "同刻二", timestamp: sameTs },
      { id: "a3", text: "同刻三", timestamp: sameTs },
    ]);

    const forkId = repo.forkConversation({
      sourceConversationId: src.id,
      uptoMessageId: "a2",
      userId: USER,
    });

    // 只复制 a1、a2 —— 按 timestamp 单键排序时三条并列，边界会漂
    expect(branchTexts(repo, forkId)).toEqual(["同刻一", "同刻二"]);
    db.close();
  });

  it("锚点正在流式中时拒绝分支", () => {
    const db = createMigratedTestDb();
    const repo = new ConversationRepo(db);
    const src = repo.createConversation({ userId: USER, title: "父会话", participants: [] });
    repo.saveMessage({
      id: "streaming",
      conversationId: src.id,
      role: "assistant",
      contentJson: { type: "text", text: "还在写" },
      isStreaming: true,
    });

    expect(() =>
      repo.forkConversation({
        sourceConversationId: src.id,
        uptoMessageId: "streaming",
        userId: USER,
      }),
    ).toThrow(/streaming/);
    db.close();
  });

  it("继承压缩标记，但不继承父会话的 session_config", () => {
    const db = createMigratedTestDb();
    const repo = new ConversationRepo(db);
    const src = repo.createConversation({ userId: USER, title: "父会话", participants: [] });
    db.prepare("UPDATE conversations SET session_config = ? WHERE id = ?").run(
      JSON.stringify({ model: "forked-from" }),
      src.id,
    );
    seed(repo, src.id, [{ id: "c1", text: "旧消息", timestamp: "2026-01-01T00:00:01.000Z" }]);
    db.prepare("UPDATE messages SET compacted_at = ? WHERE id = ?").run(
      "2026-01-01T00:00:02.000Z",
      "c1",
    );

    const forkId = repo.forkConversation({
      sourceConversationId: src.id,
      uptoMessageId: "c1",
      userId: USER,
    });

    const compacted = db
      .prepare<{ compacted_at: string | null }>("SELECT compacted_at FROM messages WHERE conversation_id = ?")
      .get(forkId);
    expect(compacted?.compacted_at).toBe("2026-01-01T00:00:02.000Z");

    const cfg = db
      .prepare<{ session_config: string | null }>("SELECT session_config FROM conversations WHERE id = ?")
      .get(forkId);
    expect(cfg?.session_config).toBeNull();
    db.close();
  });

  it("传 newUserContent 时追加一条新的 user 消息", () => {
    const db = createMigratedTestDb();
    const repo = new ConversationRepo(db);
    const src = repo.createConversation({ userId: USER, title: "父会话", participants: [] });
    seed(repo, src.id, [{ id: "d1", text: "原标题", timestamp: "2026-01-01T00:00:01.000Z" }]);

    const forkId = repo.forkConversation({
      sourceConversationId: src.id,
      uptoMessageId: "d1",
      newUserContent: "换个问法",
      userId: USER,
    });

    expect(branchTexts(repo, forkId)).toEqual(["原标题", "换个问法"]);
    db.close();
  });
});
