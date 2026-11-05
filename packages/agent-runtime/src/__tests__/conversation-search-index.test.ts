/**
 * 会话搜索的内存索引（2026-11-05）。
 *
 * 动因：侧栏搜索框输入即卡。实测本机 10117 行 / 160M 字符，`content_json LIKE`
 * 170–430ms/次，且会话级与逐条各跑一次、全在主进程同步执行。
 * 改成内存检索后 0.2–5ms（对照数据见 verify/conversation-search/）。
 *
 * 这里钉住的是**两套实现必须给同样的答案**——索引与 SQL 兜底并存，最容易发生
 * 「索引里搜得到、SQL 里搜不到」，用户看到的就是「一会儿搜得到一会儿搜不到」。
 */
import { describe, it, expect } from "vitest";
import { ConversationRepo } from "../storage/conversation-repo.js";
import { ConversationSearchIndex } from "../storage/conversation-search-index.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";

type TestDb = ReturnType<typeof createMigratedTestDb>;

const TS = "2026-06-30T10:00:00.000Z";
const textMessage = (text: string) => JSON.stringify({ type: "text", text });

function seed(db: TestDb, rows: Array<{ id: string; conv: string; text: string; ts?: string }>) {
  for (const conv of [...new Set(rows.map((r) => r.conv))]) {
    db.prepare(
      `INSERT INTO conversations (id, user_id, type, title, is_active, created_at, last_msg_at)
       VALUES (?, 'local-user', 'direct', ?, 1, ?, ?)`,
    ).run(conv, conv, TS, TS);
  }
  for (const r of rows) {
    db.prepare(
      `INSERT INTO messages (id, conversation_id, agent_id, role, content_json, timestamp)
       VALUES (?, ?, NULL, 'user', ?, ?)`,
    ).run(r.id, r.conv, textMessage(r.text), r.ts ?? TS);
  }
}

/** 把整个库装进索引并标记就绪 */
function buildIndexed(repo: ConversationRepo): ConversationSearchIndex {
  const index = new ConversationSearchIndex();
  repo.attachSearchIndex(index);
  let cursor = 0;
  for (;;) {
    const { loaded, lastRowid } = repo.loadSearchIndexBatch(2, cursor);
    if (loaded === 0) break;
    cursor = lastRowid;
  }
  index.markReady();
  return index;
}

describe("ConversationSearchIndex · 与 SQL 兜底等价", () => {
  const rows = [
    { id: "m1", conv: "conv-a", text: "帮我看看宠物精灵图的抠底算法", ts: "2026-06-01T00:00:00.000Z" },
    { id: "m2", conv: "conv-a", text: "微信附件发不出去", ts: "2026-06-02T00:00:00.000Z" },
    { id: "m3", conv: "conv-b", text: "今天的天气不错", ts: "2026-06-03T00:00:00.000Z" },
    { id: "m4", conv: "conv-b", text: "微信还是不行", ts: "2026-06-04T00:00:00.000Z" },
    { id: "m5", conv: "conv-c", text: "覆盖率 99.8% 已达标", ts: "2026-06-05T00:00:00.000Z" },
  ];

  for (const keyword of ["微信", "精灵图", "一", "xzqw", "%"]) {
    it(`逐条命中一致：「${keyword}」`, () => {
      const sqlDb = createMigratedTestDb();
      seed(sqlDb, rows);
      const sqlRepo = new ConversationRepo(sqlDb);
      const expected = sqlRepo.searchConversationHits(keyword).map((h) => h.messageId);

      const idxDb = createMigratedTestDb();
      seed(idxDb, rows);
      const idxRepo = new ConversationRepo(idxDb);
      buildIndexed(idxRepo);
      const actual = idxRepo.searchConversationHits(keyword).map((h) => h.messageId);

      expect(actual).toEqual(expected);
    });

    it(`会话级命中一致：「${keyword}」`, () => {
      const sqlDb = createMigratedTestDb();
      seed(sqlDb, rows);
      const expected = new ConversationRepo(sqlDb)
        .searchConversationsByContent(keyword)
        .map((m) => m.conversationId)
        .sort();

      const idxDb = createMigratedTestDb();
      seed(idxDb, rows);
      const idxRepo = new ConversationRepo(idxDb);
      buildIndexed(idxRepo);
      const actual = idxRepo
        .searchConversationsByContent(keyword)
        .map((m) => m.conversationId)
        .sort();

      expect(actual).toEqual(expected);
    });
  }

  it("片段与 SQL 版逐字一致（含两端省略号）", () => {
    const db = createMigratedTestDb();
    seed(db, [
      { id: "m1", conv: "conv-a", text: `${"甲".repeat(30)}关键词${"乙".repeat(60)}` },
      { id: "m2", conv: "conv-b", text: "第一行\n\n  第二行 关键词 后面" },
    ]);
    const sqlRepo = new ConversationRepo(db);
    const expected = sqlRepo.searchConversationHits("关键词");

    const db2 = createMigratedTestDb();
    seed(db2, [
      { id: "m1", conv: "conv-a", text: `${"甲".repeat(30)}关键词${"乙".repeat(60)}` },
      { id: "m2", conv: "conv-b", text: "第一行\n\n  第二行 关键词 后面" },
    ]);
    const idxRepo = new ConversationRepo(db2);
    buildIndexed(idxRepo);

    expect(idxRepo.searchConversationHits("关键词")).toEqual(expected);
  });

  it("索引未就绪时退回 SQL（宁可慢，不能搜不到）", () => {
    const db = createMigratedTestDb();
    seed(db, rows);
    const repo = new ConversationRepo(db);
    // 注入但不 markReady
    repo.attachSearchIndex(new ConversationSearchIndex());
    expect(repo.searchConversationHits("微信").map((h) => h.messageId).sort()).toEqual(["m2", "m4"]);
  });
});

describe("ConversationSearchIndex · 增量维护", () => {
  function freshIndexed() {
    const db = createMigratedTestDb();
    seed(db, [{ id: "m1", conv: "conv-a", text: "初始内容" }]);
    const repo = new ConversationRepo(db);
    buildIndexed(repo);
    return { db, repo };
  }

  it("新存一条消息立刻能搜到（不用等重建）", () => {
    const { repo } = freshIndexed();
    repo.saveMessage({
      id: "m2",
      conversationId: "conv-a",
      role: "user",
      contentJson: { type: "text", text: "刚写进去的新词" },
    });
    expect(repo.searchConversationHits("新词").map((h) => h.messageId)).toEqual(["m2"]);
  });

  it("删一条后立刻搜不到", () => {
    const { repo } = freshIndexed();
    expect(repo.searchConversationHits("初始内容")).toHaveLength(1);
    repo.deleteMessage("m1", "conv-a");
    expect(repo.searchConversationHits("初始内容")).toHaveLength(0);
  });

  it("删会话后整批摘除", () => {
    const { repo } = freshIndexed();
    repo.deleteConversation("conv-a");
    expect(repo.searchConversationHits("初始内容")).toHaveLength(0);
  });

  it("流式覆盖同一条 id 不产生重复命中", () => {
    const { repo } = freshIndexed();
    for (const partial of ["流式", "流式输出", "流式输出中"]) {
      repo.updateMessageContent({
        messageId: "m1",
        conversationId: "conv-a",
        contentJson: { type: "text", text: partial },
        isStreaming: true,
      });
    }
    const hits = repo.searchConversationHits("流式");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toContain("流式输出中");
  });
});
