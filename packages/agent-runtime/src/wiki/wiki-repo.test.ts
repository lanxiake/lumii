/**
 * WikiRepo 单测：路径校验、收件箱去重、修订写入事务性、检索。
 */
import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiRepo } from "./wiki-repo.js";
import { validateWikiPath } from "./types.js";

describe("validateWikiPath", () => {
  it("接受合法的固定顶层分类路径", () => {
    expect(validateWikiPath("sources/foo")).toEqual({ valid: true, category: "sources" });
    expect(validateWikiPath("media/bar/baz")).toEqual({ valid: true, category: "media" });
  });

  it("拒绝越权顶层、绝对路径、.. 与空段", () => {
    expect(validateWikiPath("notallowed/x").valid).toBe(false);
    expect(validateWikiPath("/sources/x").valid).toBe(false);
    expect(validateWikiPath("sources/../x").valid).toBe(false);
    expect(validateWikiPath("sources//x").valid).toBe(false);
    expect(validateWikiPath("sources\\x").valid).toBe(false);
  });
});

describe("WikiRepo 收件箱", () => {
  it("相同路径+内容哈希重复摄入时跳过，返回已有记录", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const a = repo.ingestToInbox({
      agentId: "ag",
      userId: "u",
      itemType: "upload",
      sourcePath: "/tmp/a.txt",
      title: "a.txt",
      contentHash: "hash1",
    });
    const b = repo.ingestToInbox({
      agentId: "ag",
      userId: "u",
      itemType: "upload",
      sourcePath: "/tmp/a.txt",
      title: "a.txt",
      contentHash: "hash1",
    });
    expect(b.id).toBe(a.id);
  });

  it("相同路径内容变化时作为新条目摄入", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const a = repo.ingestToInbox({
      agentId: "ag",
      userId: "u",
      itemType: "upload",
      sourcePath: "/tmp/a.txt",
      title: "a.txt",
      contentHash: "hash1",
    });
    const b = repo.ingestToInbox({
      agentId: "ag",
      userId: "u",
      itemType: "upload",
      sourcePath: "/tmp/a.txt",
      title: "a.txt",
      contentHash: "hash2",
    });
    expect(b.id).not.toBe(a.id);
    expect(repo.listInbox("ag", "u")).toHaveLength(2);
  });

  it("批量取件只取 pending 且未超重试上限的同类型条目", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const item = repo.ingestToInbox({ agentId: "ag", userId: "u", itemType: "upload", title: "a" });
    repo.markInboxAttemptFailed(item.id, "err");
    repo.markInboxAttemptFailed(item.id, "err");
    repo.markInboxAttemptFailed(item.id, "err");
    repo.markInboxAttemptFailed(item.id, "err");
    const batch = repo.takeInboxBatch("ag", "u", "upload", 10, 4);
    expect(batch).toHaveLength(0);
  });

  it("listPendingAgentUserPairs 只返回有 pending 条目的归属组合，去重", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.ingestToInbox({ agentId: "ag1", userId: "u", itemType: "upload", title: "a" });
    repo.ingestToInbox({ agentId: "ag1", userId: "u", itemType: "output", title: "b" });
    const organized = repo.ingestToInbox({ agentId: "ag2", userId: "u", itemType: "upload", title: "c" });
    repo.markInboxOrganized(organized.id, "src1");

    const pairs = repo.listPendingAgentUserPairs();
    expect(pairs).toEqual([{ agentId: "ag1", userId: "u" }]);
  });
});

describe("WikiRepo 页面与修订", () => {
  it("首次保存 version=1，再次保存同路径递增 version 并写修订", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const p1 = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/doc1",
      title: "doc1",
      contentMd: "v1",
      editor: "ai",
    });
    expect(p1.version).toBe(1);

    const p2 = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/doc1",
      title: "doc1",
      contentMd: "v2",
      editor: "user",
    });
    expect(p2.version).toBe(2);
    expect(p2.id).toBe(p1.id);
  });

  it("非法路径抛错，调用方应捕获后降级到 inbox/", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    expect(() =>
      repo.savePage({ agentId: "ag", userId: "u", path: "notallowed/x", title: "x", contentMd: "c", editor: "ai" }),
    ).toThrow();
  });

  it("同归属同路径唯一，跨归属隔离不冲突", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.savePage({ agentId: "ag1", userId: "u", path: "sources/x", title: "x", contentMd: "c", editor: "ai" });
    const other = repo.savePage({ agentId: "ag2", userId: "u", path: "sources/x", title: "x", contentMd: "c2", editor: "ai" });
    expect(other.content_md).toBe("c2");
    expect(repo.listPages("ag1", "u")).toHaveLength(1);
    expect(repo.listPages("ag2", "u")).toHaveLength(1);
  });
});

describe("WikiRepo 检索", () => {
  it("中文关键词检索命中且更新 use_count", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/arch",
      title: "架构设计文档",
      contentMd: "本文介绍系统的整体架构设计",
      editor: "ai",
    });
    const hits = repo.search("ag", "u", "架构设计");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.page.title).toBe("架构设计文档");

    const page = repo.findPageByPath("ag", "u", "sources/arch")!;
    expect(page.use_count).toBe(1);
  });

  it("特殊字符查询不抛异常", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    expect(() => repo.search("ag", "u", '"引号"*星号')).not.toThrow();
  });

  it("重建索引后检索结果与重建前一致", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.savePage({ agentId: "ag", userId: "u", path: "sources/x", title: "记忆重构", contentMd: "内容", editor: "ai" });
    const before = repo.search("ag", "u", "记忆重构").map((h) => h.page.id);
    repo.rebuildIndex();
    const after = repo.search("ag", "u", "记忆重构").map((h) => h.page.id);
    expect(after).toEqual(before);
  });
});

describe("WikiRepo 运行日志", () => {
  it("创建并结束运行，inbox_ids 往返一致", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const run = repo.createRun("ag", "u", ["i1", "i2"]);
    expect(run.status).toBe("running");
    repo.finishRun(run.id, "succeeded", "2 项已归档");
    const runs = repo.listRuns("ag", "u");
    expect(runs[0]!.inbox_ids).toEqual(["i1", "i2"]);
    expect(runs[0]!.status).toBe("succeeded");
  });
});
