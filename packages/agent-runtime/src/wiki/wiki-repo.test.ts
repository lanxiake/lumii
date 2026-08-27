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

  it("countInbox 按 status 计数且不受 list LIMIT 影响", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    for (let i = 0; i < 5; i++) {
      repo.ingestToInbox({
        agentId: "ag",
        userId: "u",
        itemType: "upload",
        title: `t${i}`,
        mediaType: "document",
        sourcePath: `/tmp/f${i}`,
        contentHash: `h${i}`,
      });
    }
    const [first] = repo.listInbox("ag", "u", "pending");
    repo.markInboxOrganized(first!.id, "src-fake");
    expect(repo.countInbox("ag", "u", "pending")).toBe(4);
    expect(repo.countInbox("ag", "u")).toBe(5);
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

  it("含稀有拉丁串的混合查询不因中文 bigram OR 误召回", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/exists",
      title: "资料综述",
      contentMd: "本文讨论存在与不存在的边界，以及架构设计。",
      editor: "ai",
    });
    // 旧 OR 语义会因「存在/不存」等 bigram 命中；AND + 稀有拉丁 token 应为空
    expect(repo.search("ag", "u", "完全不存在的词xyzzywiki999")).toEqual([]);
    // 真实短语仍可召回
    expect(repo.search("ag", "u", "架构设计")).toHaveLength(1);
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

describe("WikiRepo 链接与反链", () => {
  it("保存页面时解析 [[标题]] 并写入链接索引，反链可查", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const target = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "concepts/微信语音",
      title: "微信语音",
      contentMd: "概念页正文",
      editor: "ai",
    });
    const source = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/笔记",
      title: "笔记",
      contentMd: "参见 [[微信语音]]",
      editor: "ai",
    });

    const backlinks = repo.listBacklinks("ag", "u", target.id);
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]).toMatchObject({
      sourcePageId: source.id,
      sourceTitle: "笔记",
      sourcePath: "sources/笔记",
      anchorText: "微信语音",
      isResolved: true,
    });

    const outbound = repo.listOutboundLinks("ag", "u", source.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.is_resolved).toBe(true);
    expect(outbound[0]!.target_page_id).toBe(target.id);
  });

  it("未匹配目标的链接落库为未解析，不抛异常", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/笔记",
      title: "笔记",
      contentMd: "参见 [[尚未建页]]",
      editor: "ai",
    });

    const outbound = repo.listOutboundLinks("ag", "u", source.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.is_resolved).toBe(false);
    expect(outbound[0]!.target_page_id).toBeNull();

    const unresolved = repo.listUnresolvedLinks("ag", "u");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.anchor_text).toBe("尚未建页");
  });

  it("先链接后建页：建页后重新保存源页触发解析", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/笔记",
      title: "笔记",
      contentMd: "参见 [[新概念]]",
      editor: "ai",
    });
    expect(repo.listUnresolvedLinks("ag", "u")).toHaveLength(1);

    const target = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "concepts/新概念",
      title: "新概念",
      contentMd: "内容",
      editor: "ai",
    });

    // 建页本身不会回填已有链接，需源页再保存一次才重算
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/笔记",
      title: "笔记",
      contentMd: "参见 [[新概念]]",
      editor: "ai",
    });

    expect(repo.listUnresolvedLinks("ag", "u")).toHaveLength(0);
    const backlinks = repo.listBacklinks("ag", "u", target.id);
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]!.sourcePageId).toBe(source.id);
  });

  it("删除目标页后反链变未解析，源页正文不受影响", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const target = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "concepts/微信语音",
      title: "微信语音",
      contentMd: "内容",
      editor: "ai",
    });
    const source = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/笔记",
      title: "笔记",
      contentMd: "参见 [[微信语音]]",
      editor: "ai",
    });

    repo.deletePage(target.id);

    const outbound = repo.listOutboundLinks("ag", "u", source.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.is_resolved).toBe(false);
    expect(outbound[0]!.target_page_id).toBeNull();
    expect(outbound[0]!.anchor_text).toBe("微信语音");

    const reloaded = repo.findPageById(source.id)!;
    expect(reloaded.content_md).toBe("参见 [[微信语音]]");
  });

  it("删除源页级联清理其出向链接行", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const target = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "concepts/微信语音",
      title: "微信语音",
      contentMd: "内容",
      editor: "ai",
    });
    const source = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/笔记",
      title: "笔记",
      contentMd: "参见 [[微信语音]]",
      editor: "ai",
    });

    repo.deletePage(source.id);

    expect(repo.listOutboundLinks("ag", "u", source.id)).toHaveLength(0);
    expect(repo.listBacklinks("ag", "u", target.id)).toHaveLength(0);
  });

  it("歧义候选不写边，两条候选均不作为解析目标", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.savePage({ agentId: "ag", userId: "u", path: "sources/同名A", title: "同名", contentMd: "a", editor: "ai" });
    repo.savePage({ agentId: "ag", userId: "u", path: "media/同名B", title: "同名", contentMd: "b", editor: "ai" });
    const source = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/笔记",
      title: "笔记",
      contentMd: "参见 [[同名]]",
      editor: "ai",
    });

    const outbound = repo.listOutboundLinks("ag", "u", source.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.is_resolved).toBe(false);
    expect(outbound[0]!.target_page_id).toBeNull();
  });

  it("rebuildLinkIndex 后条数与增量维护一致", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const target = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "concepts/微信语音",
      title: "微信语音",
      contentMd: "内容",
      editor: "ai",
    });
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/笔记",
      title: "笔记",
      contentMd: "参见 [[微信语音]] 和 [[未建页]]",
      editor: "ai",
    });

    const before = repo.listBacklinks("ag", "u", target.id).length;
    const rebuiltCount = repo.rebuildLinkIndex("ag", "u");
    const after = repo.listBacklinks("ag", "u", target.id).length;

    expect(rebuiltCount).toBe(2);
    expect(after).toBe(before);
  });
});

describe("WikiRepo 修订与回滚", () => {
  it("listRevisions 按 version 降序返回", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const page = repo.savePage({ agentId: "ag", userId: "u", path: "sources/doc", title: "doc", contentMd: "v1", editor: "ai" });
    repo.savePage({ agentId: "ag", userId: "u", path: "sources/doc", title: "doc", contentMd: "v2", editor: "user" });
    repo.savePage({ agentId: "ag", userId: "u", path: "sources/doc", title: "doc", contentMd: "v3", editor: "ai" });

    const revisions = repo.listRevisions(page.id);
    expect(revisions.map((r) => r.version)).toEqual([3, 2, 1]);
    expect(revisions.map((r) => r.content_md)).toEqual(["v3", "v2", "v1"]);
  });

  it("回滚后 version 递增，旧修订内容不变，回滚产生的修订 editor 为 user", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const page = repo.savePage({ agentId: "ag", userId: "u", path: "sources/doc", title: "doc", contentMd: "v1", editor: "ai" });
    repo.savePage({ agentId: "ag", userId: "u", path: "sources/doc", title: "doc", contentMd: "被改坏的内容", editor: "ai" });

    const rolledBack = repo.rollbackPage("ag", "u", page.id, 1);
    expect(rolledBack.version).toBe(3);
    expect(rolledBack.content_md).toBe("v1");

    const revisions = repo.listRevisions(page.id);
    expect(revisions).toHaveLength(3);
    expect(revisions.find((r) => r.version === 1)!.content_md).toBe("v1");
    expect(revisions.find((r) => r.version === 2)!.content_md).toBe("被改坏的内容");
    const latest = revisions.find((r) => r.version === 3)!;
    expect(latest.content_md).toBe("v1");
    expect(latest.editor).toBe("user");
    expect(latest.source_ref).toBe("rollback:v1");
  });

  it("回滚到不存在的版本抛错", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const page = repo.savePage({ agentId: "ag", userId: "u", path: "sources/doc", title: "doc", contentMd: "v1", editor: "ai" });
    expect(() => repo.rollbackPage("ag", "u", page.id, 99)).toThrow();
  });

  it("回滚不存在的页面抛错", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    expect(() => repo.rollbackPage("ag", "u", "no-such-id", 1)).toThrow();
  });
});

describe("WikiRepo 附件", () => {
  it("attach/detach 增删", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const page = repo.savePage({ agentId: "ag", userId: "u", path: "media/pic", title: "pic", contentMd: "c", editor: "ai" });

    const attachment = repo.attachFile({
      pageId: page.id,
      filePath: "/tmp/pic.png",
      mediaType: "image",
      displayName: "pic.png",
    });
    expect(repo.listAttachments(page.id)).toEqual([attachment]);

    const detached = repo.detachFile(attachment.id);
    expect(detached).toBe(true);
    expect(repo.listAttachments(page.id)).toHaveLength(0);
  });

  it("解绑不存在的附件返回 false", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    expect(repo.detachFile("no-such-id")).toBe(false);
  });

  it("附件行引用既有 source 不产生新文件——sourceId 原样落库", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = repo.createSource({ agentId: "ag", userId: "u", title: "src", sourcePath: "/tmp/pic.png", mediaType: "image" });
    const page = repo.savePage({ agentId: "ag", userId: "u", path: "media/pic", title: "pic", contentMd: "c", editor: "ai" });

    const attachment = repo.attachFile({
      pageId: page.id,
      sourceId: source.id,
      filePath: "/tmp/pic.png",
      mediaType: "image",
      displayName: "pic.png",
    });
    expect(attachment.source_id).toBe(source.id);
  });

  it("删除页面级联删除其附件（依赖 foreign_keys=ON，同生产环境）", () => {
    const db = createMigratedTestDb();
    db.exec("PRAGMA foreign_keys=ON");
    const repo = new WikiRepo(db);
    const page = repo.savePage({ agentId: "ag", userId: "u", path: "media/pic", title: "pic", contentMd: "c", editor: "ai" });
    repo.attachFile({ pageId: page.id, filePath: "/tmp/pic.png", mediaType: "image", displayName: "pic.png" });

    repo.deletePage(page.id);
    expect(repo.listAttachments(page.id)).toHaveLength(0);
  });
});

describe("WikiRepo 运行日志", () => {
  it("创建并结束运行，inbox_ids 往返一致", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const run = repo.createRun("ag", "u", ["i1", "i2"]);
    expect(run.status).toBe("running");
    expect(run.result_detail).toBeNull();
    repo.finishRun(run.id, "succeeded", "2 项已归档");
    const runs = repo.listRuns("ag", "u");
    expect(runs[0]!.inbox_ids).toEqual(["i1", "i2"]);
    expect(runs[0]!.status).toBe("succeeded");
  });

  it("finishRun 写入 result_detail 后 listRuns 能读回", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const run = repo.createRun("ag", "u", ["i1"]);
    const detail = JSON.stringify({
      items: [{ inboxId: "i1", title: "T", path: "sources/t", mediaType: "document", outcome: "archived", extract: "preview" }],
    });
    repo.finishRun(run.id, "succeeded", "1 项已归档", undefined, detail);
    const stored = repo.listRuns("ag", "u")[0]!;
    expect(stored.result_detail).toBe(detail);
    expect(JSON.parse(stored.result_detail!).items[0].path).toBe("sources/t");
  });
});
