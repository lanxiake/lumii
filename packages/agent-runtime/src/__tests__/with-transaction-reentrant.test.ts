/**
 * withTransaction 可重入
 *
 * 压缩流程外层开 BEGIN IMMEDIATE，内层 repo.saveMessage 又要开事务；
 * 不可重入会抛 "cannot start a transaction within a transaction" 导致压缩整体回滚。
 */

import { describe, it, expect } from "vitest";
import { withTransaction } from "../storage/local-database.js";
import { ConversationRepo } from "../storage/conversation-repo.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";

function seed(): { db: ReturnType<typeof createMigratedTestDb>; repo: ConversationRepo } {
  const db = createMigratedTestDb();
  db.prepare(
    `INSERT INTO conversations (id, user_id, type, title, is_active, created_at)
     VALUES ('c1', 'local-user', 'direct', 't', 1, ?)`,
  ).run(new Date().toISOString());
  return { db, repo: new ConversationRepo(db) };
}

describe("withTransaction 可重入", () => {
  it("外层 BEGIN IMMEDIATE 内嵌 saveMessage 不报错且一起提交", () => {
    const { db, repo } = seed();

    withTransaction(
      db,
      () => {
        repo.saveMessage({
          conversationId: "c1",
          role: "assistant",
          contentJson: { type: "text", text: "摘要" },
        });
      },
      "BEGIN IMMEDIATE",
    );

    expect(repo.getMessageCount("c1")).toBe(1);
  });

  it("外层抛错时内层写入一并回滚", () => {
    const { db, repo } = seed();

    expect(() =>
      withTransaction(db, () => {
        repo.saveMessage({
          conversationId: "c1",
          role: "assistant",
          contentJson: { type: "text", text: "摘要" },
        });
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(repo.getMessageCount("c1")).toBe(0);
  });
});
