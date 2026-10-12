/**
 * searchConversationsByContent 回归保护
 *
 * 背景：侧栏搜索此前只能匹配标题 + 每条会话的「最后一条消息预览」，更早的历史
 * 永远搜不到（表现就是「只搜得到会话名」）。这个查询是「按正文搜会话」的唯一落点，
 * 三件事要钉住：LIKE 转义（未转义时用户输入一个 `%` 会命中全部会话）、片段确实
 * 围绕关键词截取、以及命中落在不可见内容里时会话不能凭空消失。
 */

import { describe, it, expect } from "vitest";
import { ConversationRepo } from "../storage/conversation-repo.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";

type TestDb = ReturnType<typeof createMigratedTestDb>;

const TS = "2026-06-30T10:00:00.000Z";

function insertConversation(db: TestDb, id: string): void {
  db.prepare(
    `INSERT INTO conversations (id, user_id, type, title, is_active, created_at, last_msg_at)
     VALUES (?, 'local-user', 'direct', ?, 1, ?, ?)`,
  ).run(id, id, TS, TS);
}

function insertMessage(db: TestDb, id: string, conversationId: string, contentJson: string): void {
  db.prepare(
    `INSERT INTO messages (id, conversation_id, agent_id, role, content_json, timestamp)
     VALUES (?, ?, NULL, 'user', ?, ?)`,
  ).run(id, conversationId, contentJson, TS);
}

/** 普通文本消息的 content_json */
const textMessage = (text: string) => JSON.stringify({ type: "text", text });

describe("searchConversationsByContent", () => {
  it("命中正文的会话被返回，没命中的不返回", () => {
    const db = createMigratedTestDb();
    insertConversation(db, "conv-a");
    insertConversation(db, "conv-b");
    insertMessage(db, "m1", "conv-a", textMessage("帮我看看宠物精灵图的抠底算法"));
    insertMessage(db, "m2", "conv-b", textMessage("今天的天气不错"));

    const repo = new ConversationRepo(db);
    const ids = repo.searchConversationsByContent("精灵图").map((m) => m.conversationId);
    expect(ids).toEqual(["conv-a"]);
    expect(repo.searchConversationsByContent("不存在的东西")).toEqual([]);
  });

  it("同一会话命中多条只返回一次（每个会话取最近的一条）", () => {
    const db = createMigratedTestDb();
    insertConversation(db, "conv-a");
    insertMessage(db, "m1", "conv-a", textMessage("微信附件发不出去"));
    insertMessage(db, "m2", "conv-a", textMessage("微信还是不行"));
    insertMessage(db, "m3", "conv-a", textMessage("修好了"));

    const repo = new ConversationRepo(db);
    const ids = repo.searchConversationsByContent("微信").map((m) => m.conversationId);
    expect(ids).toEqual(["conv-a"]);
  });

  it("片段围绕关键词截取，两端各留前 24 / 后 48 字并加省略号", () => {
    const db = createMigratedTestDb();
    insertConversation(db, "conv-a");
    insertMessage(db, "m1", "conv-a", textMessage(`${"甲".repeat(30)}关键词${"乙".repeat(60)}`));

    const repo = new ConversationRepo(db);
    const [match] = repo.searchConversationsByContent("关键词");
    expect(match.snippet).toBe(`…${"甲".repeat(24)}关键词${"乙".repeat(48)}…`);
  });

  it("片段里的换行/连续空白被压成单个空格（侧栏是单行显示）", () => {
    const db = createMigratedTestDb();
    insertConversation(db, "conv-a");
    insertMessage(db, "m1", "conv-a", textMessage("第一行\n\n  第二行 关键词 后面"));

    const repo = new ConversationRepo(db);
    const [match] = repo.searchConversationsByContent("关键词");
    expect(match.snippet).toBe("第一行 第二行 关键词 后面");
    expect(match.snippet).not.toContain("\n");
  });

  it("命中落在 thinking 里时返回空片段，但会话仍要出现在结果里", () => {
    const db = createMigratedTestDb();
    insertConversation(db, "conv-a");
    insertMessage(
      db,
      "m1",
      "conv-a",
      JSON.stringify({
        type: "assistant_parts",
        parts: [{ type: "thinking", id: "th-1", text: "用户可能在找 jlvpsogs 那个节点" }],
      }),
    );

    const repo = new ConversationRepo(db);
    const matches = repo.searchConversationsByContent("jlvpsogs");
    // 会话不能消失——否则「搜得到」这件事就悄悄退化了，只是没有片段可展示
    expect(matches.map((m) => m.conversationId)).toEqual(["conv-a"]);
    expect(matches[0].snippet).toBe("");
  });

  it("LIKE 通配符按字面量处理：搜 '%' 不会命中全部会话", () => {
    const db = createMigratedTestDb();
    insertConversation(db, "conv-a");
    insertConversation(db, "conv-b");
    insertMessage(db, "m1", "conv-a", textMessage("覆盖率 99.8% 已达标"));
    insertMessage(db, "m2", "conv-b", textMessage("覆盖率和它没关系"));

    const repo = new ConversationRepo(db);
    expect(repo.searchConversationsByContent("%").map((m) => m.conversationId)).toEqual(["conv-a"]);
  });

  it("查询里的转义符按字面量处理，不会打穿 LIKE 语法", () => {
    const db = createMigratedTestDb();
    insertConversation(db, "conv-a");
    insertConversation(db, "conv-b");
    insertMessage(db, "m1", "conv-a", textMessage("路径是 C:\\myself\\projects"));
    insertMessage(db, "m2", "conv-b", textMessage("没有反斜杠"));

    const repo = new ConversationRepo(db);
    // 库里的 JSON 编码会把 `\` 写成 `\\`，所以按「单个反斜杠」能命中 —— 但那不是重点。
    // 重点是不转义时 pattern 会退化成 `%\%`，ESCAPE 语义下等于「转义掉结尾的 %」，
    // 匹配范围整个变样。这条钉住转义符本身被正确打平。
    expect(repo.searchConversationsByContent("\\").map((m) => m.conversationId)).toEqual(["conv-a"]);
  });

  it("limit 生效", () => {
    const db = createMigratedTestDb();
    for (let i = 0; i < 5; i++) {
      insertConversation(db, `conv-${i}`);
      insertMessage(db, `m-${i}`, `conv-${i}`, textMessage("共同关键词"));
    }

    const repo = new ConversationRepo(db);
    expect(repo.searchConversationsByContent("共同关键词", 2)).toHaveLength(2);
  });
});
