/**
 * SegmentRepo 单测（S2）—— 真实内存 SQLite
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SegmentRepo } from "../storage/segment-repo.js";
import type { DatabaseAdapter } from "../storage/local-database.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";

const baseCreate = {
  id: "seg-1",
  conversationId: "conv-1",
  userId: "u1",
  agentId: "a1",
  startMessageId: "m1",
  topicTokens: ["旅行", "计划"],
};

describe("SegmentRepo", () => {
  let db: DatabaseAdapter;
  let repo: SegmentRepo;

  beforeEach(async () => {
    db = createMigratedTestDb();
    repo = new SegmentRepo(db);
  });

  it("create 建 open 段并可查回（topic_tokens 往返）", () => {
    const seg = repo.create(baseCreate);
    expect(seg.status).toBe("open");
    expect(seg.startMessageId).toBe("m1");
    expect(seg.turnCount).toBe(1);
    expect(seg.topicTokens).toEqual(["旅行", "计划"]);
    expect(repo.findOpenByConversation("conv-1")?.id).toBe("seg-1");
  });

  it("append 更新 end/计数/topic", () => {
    repo.create(baseCreate);
    repo.append("seg-1", {
      endMessageId: "m3",
      turnCount: 2,
      charCount: 120,
      topicTokens: ["旅行", "计划", "日本"],
    });
    const seg = repo.findById("seg-1")!;
    expect(seg.endMessageId).toBe("m3");
    expect(seg.turnCount).toBe(2);
    expect(seg.charCount).toBe(120);
    expect(seg.topicTokens).toContain("日本");
  });

  it("close 后进入 findClosed，open 查询不再命中", () => {
    repo.create(baseCreate);
    repo.close("seg-1", "m5", "topic_shift");
    expect(repo.findOpenByConversation("conv-1")).toBeNull();
    const closed = repo.findClosed();
    expect(closed.map((s) => s.id)).toContain("seg-1");
    expect(closed[0].closeReason).toBe("topic_shift");
    expect(closed[0].endMessageId).toBe("m5");
  });

  it("markSummarised 后退出 findClosed（重启恢复不会重复处理）", () => {
    repo.create(baseCreate);
    repo.close("seg-1", "m5", "capacity");
    repo.markSummarised("seg-1");
    expect(repo.findClosed().map((s) => s.id)).not.toContain("seg-1");
    expect(repo.findById("seg-1")?.status).toBe("summarised");
  });

  it("findClosed 按创建时间升序（先进先总结）", () => {
    repo.create({ ...baseCreate, id: "seg-a", startMessageId: "ma" });
    repo.create({ ...baseCreate, id: "seg-b", conversationId: "conv-2", startMessageId: "mb" });
    repo.close("seg-a", "ma2", "capacity");
    repo.close("seg-b", "mb2", "capacity");
    const ids = repo.findClosed().map((s) => s.id);
    expect(ids.indexOf("seg-a")).toBeLessThan(ids.indexOf("seg-b"));
  });

  it("incrementRetry 累加", () => {
    repo.create(baseCreate);
    repo.close("seg-1", "m5", "capacity");
    expect(repo.incrementRetry("seg-1")).toBe(1);
    expect(repo.incrementRetry("seg-1")).toBe(2);
  });

  it("deleteByConversation 清理该会话所有段", () => {
    repo.create({ ...baseCreate, id: "seg-1" });
    repo.create({ ...baseCreate, id: "seg-2", conversationId: "conv-1", startMessageId: "m9" });
    repo.create({ ...baseCreate, id: "seg-keep", conversationId: "conv-X", startMessageId: "mx" });
    repo.deleteByConversation("conv-1");
    expect(repo.findById("seg-1")).toBeNull();
    expect(repo.findById("seg-2")).toBeNull();
    expect(repo.findById("seg-keep")).not.toBeNull();
  });

  it("段记录隔离字段（user_id/agent_id）正确持久化", () => {
    const seg = repo.create({ ...baseCreate, userId: "u-zhang", agentId: "a-coder" });
    expect(seg.userId).toBe("u-zhang");
    expect(seg.agentId).toBe("a-coder");
  });

  it("findAllOpen 返回跨会话所有 open 段，排除 closed/summarised", () => {
    repo.create({ ...baseCreate, id: "open-1", conversationId: "c1", startMessageId: "m1" });
    repo.create({ ...baseCreate, id: "open-2", conversationId: "c2", startMessageId: "m2" });
    repo.create({ ...baseCreate, id: "to-close", conversationId: "c3", startMessageId: "m3" });
    repo.close("to-close", "m3", "capacity");

    const open = repo.findAllOpen();
    const ids = open.map((s) => s.id);
    expect(ids).toContain("open-1");
    expect(ids).toContain("open-2");
    expect(ids).not.toContain("to-close"); // 已 closed
  });
});
