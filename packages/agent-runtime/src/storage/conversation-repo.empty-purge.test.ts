/**
 * 空会话清理判据（ConversationRepo.listEmptyConversationIds）。
 *
 * 用户点了「新建对话」却没发消息的本地会话要能被识别出来清理，同时不能误伤：
 * - 渠道会话 / 系统会话（weixin / cron / …）—— 由各自模块管理；
 * - 置顶会话 —— 用户显式标记过；
 * - 已经有消息的会话 —— 那是正常会话。
 */
import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { ConversationRepo } from "./conversation-repo.js";

const USER = "local-user";

/** 直接插会话行，覆盖 createConversation 不设置的 channel_type / is_pinned */
function insertRawConversation(
  db: ReturnType<typeof createMigratedTestDb>,
  id: string,
  opts: { channelType: string | null; pinned?: boolean },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO conversations (id, user_id, type, title, is_active, is_pinned, created_at, channel_type)
     VALUES (?, ?, 'direct', '新对话', 1, ?, ?, ?)`,
  ).run(id, USER, opts.pinned ? 1 : 0, now, opts.channelType);
}

describe("ConversationRepo.listEmptyConversationIds", () => {
  it("只返回本地、未置顶、无消息的会话", () => {
    const db = createMigratedTestDb();
    const repo = new ConversationRepo(db);

    // 本地会话（createConversation 不带 channel_type → 落库为 NULL）
    const emptyLocal = repo.createConversation({ userId: USER, title: "新对话", participants: [] });
    // 有消息的本地会话：不是空会话
    const withMessage = repo.createConversation({ userId: USER, title: "写了内容", participants: [] });
    repo.saveMessage({
      conversationId: withMessage.id,
      role: "user",
      contentJson: { type: "text", text: "你好" },
    });
    // 旧库回填出来的本地会话（channel_type='ipc'）
    insertRawConversation(db, "old-local-1", { channelType: "ipc" });
    // 渠道 / 系统会话即使为空也不该被清
    insertRawConversation(db, "weixin:u1", { channelType: "weixin" });
    insertRawConversation(db, "cron:job1", { channelType: "cron" });
    // 置顶的空本地会话保留
    const pinned = repo.createConversation({ userId: USER, title: "新对话", participants: [] });
    repo.togglePinned(pinned.id);

    const ids = [...repo.listEmptyConversationIds(USER)].sort();
    expect(ids).toEqual([emptyLocal.id, "old-local-1"].sort());
    db.close();
  });

  it("已关闭（is_active=0）的会话不在清理范围内", () => {
    const db = createMigratedTestDb();
    const repo = new ConversationRepo(db);
    const open = repo.createConversation({ userId: USER, title: "新对话", participants: [] });
    const closed = repo.createConversation({ userId: USER, title: "新对话", participants: [] });
    repo.closeConversation(closed.id);

    expect(repo.listEmptyConversationIds(USER)).toEqual([open.id]);
    db.close();
  });
});

describe("ConversationRepo.listTruncatedTitleFirstMessages", () => {
  it("只挑出标题以字面「...」结尾、且带首条用户消息的会话", () => {
    const db = createMigratedTestDb();
    const repo = new ConversationRepo(db);

    // 旧版截断留下的标题 + 首条用户消息（可据以重算）
    const truncated = repo.createConversation({ userId: USER, title: "新对话", participants: [] });
    repo.updateTitle(truncated.id, "MCP Server mcp-tre...");
    repo.saveMessage({
      conversationId: truncated.id,
      role: "user",
      contentJson: { type: "text", text: "MCP Server mcp-trends-hub 怎么配置" },
    });

    // 正常标题：不该被选中
    const normal = repo.createConversation({ userId: USER, title: "写周报", participants: [] });
    repo.saveMessage({
      conversationId: normal.id,
      role: "user",
      contentJson: { type: "text", text: "帮我写周报" },
    });

    // 标题带「...」但没有用户消息：无从重算，跳过
    const noUserMsg = repo.createConversation({ userId: USER, title: "新对话", participants: [] });
    repo.updateTitle(noUserMsg.id, "只剩省略号...");

    const rows = repo.listTruncatedTitleFirstMessages(USER);
    expect(rows.map((r) => r.id)).toEqual([truncated.id]);
    expect(JSON.parse(rows[0]!.contentJson)).toMatchObject({ text: "MCP Server mcp-trends-hub 怎么配置" });
    db.close();
  });
});

describe("ConversationRepo.listRecentUserMessageContentJsons", () => {
  it("按时间倒序取最近 N 条用户消息，忽略助手消息", () => {
    const db = createMigratedTestDb();
    const repo = new ConversationRepo(db);
    const conv = repo.createConversation({ userId: USER, title: "新对话", participants: [] });

    // 显式时间戳：同毫秒插入会让 ORDER BY timestamp 的顺序不稳定，测试会偶发失败
    const insert = db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content_json, is_proactive, timestamp)
       VALUES (?, ?, ?, ?, 0, ?)`,
    );
    const put = (text: string, ts: string, role: "user" | "assistant" = "user") =>
      insert.run(`m-${ts}`, conv.id, role, JSON.stringify({ type: "text", text }), ts);

    put("第一句", "2026-01-01T00:00:01.000Z");
    put("第二句", "2026-01-01T00:00:02.000Z");
    put("助手的回复", "2026-01-01T00:00:03.000Z", "assistant");
    put("第三句", "2026-01-01T00:00:04.000Z");
    put("第四句", "2026-01-01T00:00:05.000Z");

    const rows = repo.listRecentUserMessageContentJsons(conv.id, 2);
    expect(rows.map((r) => JSON.parse(r).text)).toEqual(["第四句", "第三句"]);
    db.close();
  });
});

