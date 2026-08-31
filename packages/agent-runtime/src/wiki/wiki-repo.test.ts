/**
 * WikiRepo 单测：路径校验、收件箱去重、修订写入事务性、检索。
 */
import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiRepo } from "./wiki-repo.js";
import { validateWikiPath } from "./types.js";
import { DEFAULT_TOPIC_TREE, PARKING_CATEGORY } from "./wiki-topic-tree.js";
import { topicCountKey } from "./wiki-topic-mutate.js";
import { GRAPH_EXTRACT_CURSOR_META_KEY } from "./wiki-graph-types.js";

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

describe("WikiRepo 主题树", () => {
  it("空库 getOrCreateTopicTree 写入并返回默认树", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    expect(repo.getOrCreateTopicTree()).toEqual(DEFAULT_TOPIC_TREE);
    expect(repo.getIndexMeta("topic_categories")).toBeTruthy();
  });

  it("setTopicTree 在已有文件占用的小类被删除时应 throw", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = repo.createSource({ agentId: "ag", userId: "u", title: "会议纪要" });
    repo.updateSourceTopic("ag", "u", source.id, "工作", "例行");

    const nextTree = {
      version: 2 as const,
      categories: DEFAULT_TOPIC_TREE.categories.map((c) =>
        c.name === "工作"
          ? { name: c.name, subtopics: c.subtopics.filter((s) => s !== "例行") }
          : c,
      ),
    };
    expect(() => repo.setTopicTree(nextTree)).toThrow();
  });

  it("setTopicTree 接受合法新树", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const nextTree = { version: 1 as const, categories: [{ name: "自定义大类", subtopics: ["自定义小类"] }] };
    repo.setTopicTree(nextTree);
    expect(repo.getOrCreateTopicTree()).toEqual(nextTree);
  });
});

describe("WikiRepo 资料主题读写", () => {
  it("updateSourceTopic 写入合法归属并可被 listSourcesByTopic 按大类/小类过滤", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = repo.createSource({ agentId: "ag", userId: "u", title: "合同" });
    repo.updateSourceTopic("ag", "u", source.id, "生活", "凭据");

    const bySubtopic = repo.listSourcesByTopic("ag", "u", { category: "生活", subtopic: "凭据" });
    expect(bySubtopic).toHaveLength(1);
    expect(bySubtopic[0]!.id).toBe(source.id);

    const byCategory = repo.listSourcesByTopic("ag", "u", { category: "生活" });
    expect(byCategory).toHaveLength(1);

    const otherCategory = repo.listSourcesByTopic("ag", "u", { category: "学习" });
    expect(otherCategory).toHaveLength(0);
  });

  it("updateSourceTopic 拒绝越权归属（大类/小类不存在于树中）", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = repo.createSource({ agentId: "ag", userId: "u", title: "x" });
    expect(() => repo.updateSourceTopic("ag", "u", source.id, "不存在的大类", "x")).toThrow();
  });

  it("updateSourceTopic 允许移到临时存放（subtopic 必须为 null）", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = repo.createSource({ agentId: "ag", userId: "u", title: "x" });
    const updated = repo.updateSourceTopic("ag", "u", source.id, PARKING_CATEGORY, null);
    expect(updated.topic_category).toBe(PARKING_CATEGORY);
    expect(updated.topic_subtopic).toBeNull();

    const parking = repo.listSourcesByTopic("ag", "u", { parking: true });
    expect(parking).toHaveLength(1);
  });

  it("listSourcesByTopic unfiled 只返回两列皆为 NULL 的资料", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const filed = repo.createSource({ agentId: "ag", userId: "u", title: "已归档" });
    repo.updateSourceTopic("ag", "u", filed.id, "工作", "例行");
    repo.createSource({ agentId: "ag", userId: "u", title: "待整理" });

    const unfiled = repo.listSourcesByTopic("ag", "u", { unfiled: true });
    expect(unfiled).toHaveLength(1);
    expect(unfiled[0]!.title).toBe("待整理");
  });

  it("listSourcesByTopic archived 只返回已归档，且不受 category 影响", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const archived = repo.createSource({ agentId: "ag", userId: "u", title: "旧项目.docx" });
    repo.updateSourceTopic("ag", "u", archived.id, "工作", "项目");
    const active = repo.createSource({ agentId: "ag", userId: "u", title: "在用.docx" });
    repo.archiveSources("ag", "u", [archived.id]);

    expect(repo.listSourcesByTopic("ag", "u", { archived: true }).map((x) => x.id)).toEqual([archived.id]);
    expect(repo.listSourcesByTopic("ag", "u", {}).map((x) => x.id)).toEqual([active.id]);
    expect(
      repo.listSourcesByTopic("ag", "u", { archived: true, category: "工作" }).map((x) => x.id),
    ).toEqual([archived.id]);
  });

  it("clearSourceTopic 把资料回到未分类（topic_category/subtopic 变 NULL）", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = repo.createSource({ agentId: "ag", userId: "u", title: "归档过的" });
    repo.updateSourceTopic("ag", "u", source.id, "工作", "例行");
    expect(repo.findSourceById(source.id)?.topic_category).toBe("工作");

    repo.clearSourceTopic("ag", "u", source.id);
    const after = repo.findSourceById(source.id)!;
    expect(after.topic_category).toBeNull();
    expect(after.topic_subtopic).toBeNull();
  });

  it("clearSourceTopic 对不存在的资料抛错", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    expect(() => repo.clearSourceTopic("ag", "u", "不存在")).toThrow(/资料不存在/);
  });

  it("setSourceStorage 写 origin_url 与 storage_mode", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = repo.createSource({ agentId: "ag", userId: "u", title: "资料" });
    repo.setSourceStorage("ag", "u", source.id, { originUrl: "https://example.com", storageMode: "ref" });
    const after = repo.findSourceById(source.id)!;
    expect(after.origin_url).toBe("https://example.com");
    expect(after.storage_mode).toBe("ref");
  });

  it("setSourceStorage 支持只更新部分字段", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = repo.createSource({ agentId: "ag", userId: "u", title: "资料" });
    repo.setSourceStorage("ag", "u", source.id, { storageMode: "materialized" });
    expect(repo.findSourceById(source.id)!.storage_mode).toBe("materialized");
    expect(repo.findSourceById(source.id)!.origin_url).toBeNull();
  });

  it("createSource 支持传入 originUrl 与 storageMode", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = repo.createSource({
      agentId: "ag",
      userId: "u",
      title: "剪藏",
      originUrl: "https://news.com/article",
      storageMode: "ref",
    });
    expect(source.origin_url).toBe("https://news.com/article");
    expect(source.storage_mode).toBe("ref");
  });

  it("createSource 默认 storage_mode 为 ref", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = repo.createSource({ agentId: "ag", userId: "u", title: "默认" });
    expect(source.storage_mode).toBe("ref");
  });

  it("touchSource 更新 last_used 与 use_count", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = repo.createSource({ agentId: "ag", userId: "u", title: "x" });
    expect(source.use_count).toBe(0);
    repo.touchSource("ag", "u", source.id);
    const after = repo.findSourceById(source.id)!;
    expect(after.use_count).toBe(1);
    expect(after.last_used).toBeTruthy();
  });
});

describe("WikiRepo 自动分类开关", () => {
  it("默认关闭——没显式打开时 AI 不该擅自分类", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    expect(repo.getAutoClassifyEnabled("ag", "u")).toBe(false);
  });

  it("开关可读回，且按 agent+user 隔离", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.setAutoClassifyEnabled("ag", "u", true);
    expect(repo.getAutoClassifyEnabled("ag", "u")).toBe(true);
    expect(repo.getAutoClassifyEnabled("ag2", "u")).toBe(false);

    repo.setAutoClassifyEnabled("ag", "u", false);
    expect(repo.getAutoClassifyEnabled("ag", "u")).toBe(false);
  });
});

describe("WikiRepo 主题树 mutation 事务", () => {
  it("countSourcesByTopic 按两列分组，跳过待补分与临时存放", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const a = repo.createSource({ agentId: "ag", userId: "u", title: "a" });
    const b = repo.createSource({ agentId: "ag", userId: "u", title: "b" });
    repo.createSource({ agentId: "ag", userId: "u", title: "待补分" });
    const parked = repo.createSource({ agentId: "ag", userId: "u", title: "搁置" });
    repo.updateSourceTopic("ag", "u", a.id, "工作", "例行");
    repo.updateSourceTopic("ag", "u", b.id, "工作", "例行");
    repo.updateSourceTopic("ag", "u", parked.id, PARKING_CATEGORY, null);

    const counts = repo.countSourcesByTopic();
    expect(counts.get(topicCountKey("工作", "例行"))).toBe(2);
    expect(counts.get(topicCountKey(PARKING_CATEGORY))).toBeUndefined();
    expect([...counts.keys()]).toHaveLength(1);
  });

  it("applyTopicMutation 改名后文件跟着走，树也更新", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "周报.docx" });
    repo.updateSourceTopic("ag", "u", s.id, "工作", "项目");

    const r = repo.applyTopicMutation({ op: "renameCategory", from: "工作", to: "工作产出" });
    expect(r.tree.categories.map((c) => c.name)).toContain("工作产出");
    expect(r.movedCount).toBe(1);
    expect(repo.findSourceById(s.id)!.topic_category).toBe("工作产出");
    expect(repo.findSourceById(s.id)!.topic_subtopic).toBe("项目");
    expect(repo.getOrCreateTopicTree().categories.map((c) => c.name)).toContain("工作产出");
  });

  it("删有文件的小类未给去向时抛错且树与文件都不变", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "纪要.md" });
    repo.updateSourceTopic("ag", "u", s.id, "工作", "例行");

    expect(() =>
      repo.applyTopicMutation({
        op: "deleteSubtopic",
        category: "工作",
        name: "例行",
      }),
    ).toThrow(/1 个文件|去向/);
    expect(repo.getOrCreateTopicTree().categories[0]!.subtopics).toContain("例行");
    expect(repo.findSourceById(s.id)!.topic_subtopic).toBe("例行");
  });

  it("带 parking 去向删除小类时文件进临时存放", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "纪要.md" });
    repo.updateSourceTopic("ag", "u", s.id, "工作", "例行");

    const r = repo.applyTopicMutation({
      op: "deleteSubtopic",
      category: "工作",
      name: "例行",
      disposition: { type: "parking" },
    });
    expect(r.movedCount).toBe(1);
    const after = repo.findSourceById(s.id)!;
    expect(after.topic_category).toBe(PARKING_CATEGORY);
    expect(after.topic_subtopic).toBeNull();
  });

  it("merge 后 from 的文件全部落到 to", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const a = repo.createSource({ agentId: "ag", userId: "u", title: "a.md" });
    repo.updateSourceTopic("ag", "u", a.id, "工作", "项目");

    repo.applyTopicMutation({
      op: "mergeSubtopic",
      fromCategory: "工作",
      fromName: "项目",
      toCategory: "工作",
      toName: "对外",
    });
    expect(repo.findSourceById(a.id)!.topic_subtopic).toBe("对外");
  });

  it("树是全局的，级联覆盖所有 agent，改名后不留孤儿", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const mine = repo.createSource({ agentId: "ag", userId: "u", title: "mine" });
    const other = repo.createSource({ agentId: "other", userId: "u2", title: "other" });
    repo.updateSourceTopic("ag", "u", mine.id, "工作", "项目");
    repo.updateSourceTopic("other", "u2", other.id, "工作", "项目");

    const r = repo.applyTopicMutation({ op: "renameCategory", from: "工作", to: "工作产出" });
    expect(r.movedCount).toBe(2);
    expect(repo.findSourceById(mine.id)!.topic_category).toBe("工作产出");
    expect(repo.findSourceById(other.id)!.topic_category).toBe("工作产出");
    // 不留孤儿：随后整树覆盖校验应通过
    expect(() => repo.setTopicTree(r.tree)).not.toThrow();
  });
});

describe("WikiRepo 资料层检索", () => {
  it("索引后按中文片段命中 extracted_text，命中即 touchSource", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = repo.createSource({
      agentId: "ag",
      userId: "u",
      title: "架构设计文档",
      extractedText: "这是一份关于系统架构设计的说明",
    });
    repo.indexSource(source.id);

    const hits = repo.searchSources("ag", "u", "架构设计");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.source.id).toBe(source.id);
    expect(hits[0]!.snippet).toContain("架构设计");
    expect(repo.findSourceById(source.id)!.use_count).toBe(1);
  });

  it("空关键词返回空数组", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    expect(repo.searchSources("ag", "u", "")).toEqual([]);
  });

  it("已归档资料不出现在检索结果中", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = repo.createSource({ agentId: "ag", userId: "u", title: "旧资料", extractedText: "归档内容示例" });
    repo.indexSource(source.id);
    repo.archiveSources("ag", "u", [source.id]);

    expect(repo.searchSources("ag", "u", "归档内容")).toEqual([]);
  });

  it("命中片段返回全文，不截断到 200 字", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const longText = "架构设计".repeat(100); // 400 字，远超旧的 200 字截断
    const source = repo.createSource({ agentId: "ag", userId: "u", title: "长文档", extractedText: longText });
    repo.indexSource(source.id);

    const hits = repo.searchSources("ag", "u", "架构设计");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toBe(longText);
    expect(hits[0]!.snippet.length).toBeGreaterThan(200);
  });
});

describe("WikiRepo 索引健康检查", () => {
  it("主表有数据但 FTS 为空时判为不健康，rebuildIndex 后恢复", () => {
    const db = createMigratedTestDb();
    const repo = new WikiRepo(db);
    // 绕过 indexSource 直接写主表，模拟 migration 建完空虚表的老库
    const source = repo.createSource({ agentId: "ag", userId: "u", title: "老资料", extractedText: "升级前的正文" });
    expect(repo.checkIndexHealth().isHealthy).toBe(false);
    expect(repo.searchSources("ag", "u", "升级前")).toEqual([]);

    expect(repo.rebuildIndex()).toBeGreaterThan(0);
    expect(repo.checkIndexHealth().isHealthy).toBe(true);
    expect(repo.searchSources("ag", "u", "升级前").map((h) => h.source.id)).toEqual([source.id]);
  });

  it("索引与主表一致时判为健康", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = repo.createSource({ agentId: "ag", userId: "u", title: "新资料", extractedText: "正文" });
    repo.indexSource(source.id);

    expect(repo.checkIndexHealth().isHealthy).toBe(true);
  });
});

describe("WikiRepo 资料归属隔离", () => {
  it("updateSourceTopic 不能改别的 agent 的资料", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const mine = repo.createSource({ agentId: "ag1", userId: "u", title: "我的" });

    expect(() => repo.updateSourceTopic("ag2", "u", mine.id, "工作", "例行")).toThrow(/资料不存在/);
    expect(repo.findSourceById(mine.id)!.topic_category).toBeNull();
  });

  it("touchSource 不能改别的 agent 的使用统计", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const mine = repo.createSource({ agentId: "ag1", userId: "u", title: "我的" });

    repo.touchSource("ag2", "u", mine.id);
    expect(repo.findSourceById(mine.id)!.use_count).toBe(0);
  });

  it("findSourceById 带归属时查不到别人的资料，不带归属仍可跨归属反查", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const mine = repo.createSource({ agentId: "ag1", userId: "u", title: "我的" });

    expect(repo.findSourceById(mine.id, "ag2", "u")).toBeNull();
    expect(repo.findSourceById(mine.id, "ag1", "u")?.id).toBe(mine.id);
    expect(repo.findSourceById(mine.id)?.id).toBe(mine.id);
  });
});

describe("WikiRepo 按路径反查资料", () => {
  it("findSourceBySourcePath 按归属+路径命中，读到 wiki_search 返回的原始路径", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = repo.createSource({
      agentId: "ag",
      userId: "u",
      title: "会议纪要",
      sourcePath: "/tmp/uploads/meeting-notes.pdf",
      extractedText: "这是会议纪要正文",
    });

    const found = repo.findSourceBySourcePath("ag", "u", "/tmp/uploads/meeting-notes.pdf");
    expect(found?.id).toBe(source.id);
  });

  it("findSourceBySourcePath 不能跨归属命中", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.createSource({ agentId: "ag1", userId: "u", title: "我的", sourcePath: "/tmp/a.txt" });

    expect(repo.findSourceBySourcePath("ag2", "u", "/tmp/a.txt")).toBeNull();
  });

  it("findSourceBySourcePath 找不到时返回 null", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    expect(repo.findSourceBySourcePath("ag", "u", "/tmp/missing.txt")).toBeNull();
  });
});

describe("WikiRepo 归档事务性", () => {
  it("主题越权时不留下孤儿资料行，重试也不产生重复", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const item = repo.ingestToInbox({ agentId: "ag", userId: "u", itemType: "upload", title: "会议纪要" });

    for (let i = 0; i < 3; i++) {
      expect(() => repo.archiveInboxItem(item, "不存在的大类", "x")).toThrow();
    }

    expect(repo.listSources("ag", "u")).toHaveLength(0);
    expect(repo.findInboxById(item.id)!.status).toBe("pending");
  });

  it("归档成功后资料可检索且条目转为 organized", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const item = repo.ingestToInbox({
      agentId: "ag",
      userId: "u",
      itemType: "upload",
      title: "会议纪要",
      contentPreview: "讨论了归档流程",
    });

    const source = repo.archiveInboxItem(item, "工作", "例行");
    expect(source.topic_category).toBe("工作");
    expect(repo.findInboxById(item.id)!.status).toBe("organized");
    expect(repo.searchSources("ag", "u", "归档流程").map((h) => h.source.id)).toEqual([source.id]);
  });
});

describe("WikiRepo 未分类归档", () => {
  it("fileInboxItemUnclassified 建资料但不写主题，条目转 organized", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const item = repo.ingestToInbox({
      agentId: "ag",
      userId: "u",
      itemType: "upload",
      title: "没分类的会议纪要",
      contentPreview: "讨论了收件流程",
    });

    const source = repo.fileInboxItemUnclassified(item);
    expect(source.topic_category).toBeNull();
    expect(source.topic_subtopic).toBeNull();
    expect(repo.findInboxById(item.id)!.status).toBe("organized");
    expect(repo.listSourcesByTopic("ag", "u", { unfiled: true }).map((s) => s.id)).toEqual([source.id]);
  });

  it("fileInboxItemUnclassified 建完索引即可被检索", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const item = repo.ingestToInbox({
      agentId: "ag",
      userId: "u",
      itemType: "upload",
      title: "调研",
      contentPreview: "关于向量检索的调研笔记",
    });

    const source = repo.fileInboxItemUnclassified(item);
    expect(repo.searchSources("ag", "u", "向量检索").map((h) => h.source.id)).toEqual([source.id]);
  });

  it("fileInboxItemUnclassified 保留搜索条目的原文链接", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const item = repo.ingestToInbox({
      agentId: "ag",
      userId: "u",
      itemType: "search",
      title: "网页结果",
      sourceUrl: "https://example.com/post",
    });

    const source = repo.fileInboxItemUnclassified(item);
    expect(source.origin_url).toBe("https://example.com/post");
  });
});

describe("WikiRepo 删除资料清理索引", () => {
  it("删除资料时同步删掉 FTS 行，不留孤儿", () => {
    const db = createMigratedTestDb();
    const repo = new WikiRepo(db);
    const first = repo.createSource({ agentId: "ag", userId: "u", title: "旧资料", extractedText: "机密内容甲" });
    repo.indexSource(first.id);
    repo.deleteSources("ag", "u", [first.id]);

    // searchSources 会 JOIN wiki_sources，孤儿行在搜索结果里看不出来，必须直查虚表：
    // wiki_sources_fts 不是 external content 表，漏删会留行，而 SQLite 回收 rowid 后
    // 新资料可能继承它，于是搜出别人的正文。
    const ftsCount = db
      .prepare<{ c: number }>("SELECT COUNT(*) as c FROM wiki_sources_fts")
      .get()?.c;
    expect(ftsCount).toBe(0);
    expect(repo.checkIndexHealth().isHealthy).toBe(true);
  });

  it("删除后新建的资料不会搜出被删资料的正文", () => {    const repo = new WikiRepo(createMigratedTestDb());
    const first = repo.createSource({ agentId: "ag", userId: "u", title: "旧资料", extractedText: "机密内容甲" });
    repo.indexSource(first.id);
    repo.deleteSources("ag", "u", [first.id]);

    const second = repo.createSource({ agentId: "ag", userId: "u", title: "新资料", extractedText: "无关正文乙" });
    repo.indexSource(second.id);

    expect(repo.searchSources("ag", "u", "机密内容")).toEqual([]);
    expect(repo.searchSources("ag", "u", "无关正文").map((h) => h.source.id)).toEqual([second.id]);
  });
});

describe("WikiRepo 未归档原因区分", () => {
  it("degraded 与 failed 都占重试预算，但 last_outcome 可区分", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const skipped = repo.ingestToInbox({ agentId: "ag", userId: "u", itemType: "upload", title: "拿不准" });
    const broken = repo.ingestToInbox({ agentId: "ag", userId: "u", itemType: "upload", title: "真出错" });

    repo.markInboxAttemptFailed(skipped.id, "无法归类", "degraded");
    repo.markInboxAttemptFailed(broken.id, "磁盘写入失败");

    expect(repo.findInboxById(skipped.id)!.last_outcome).toBe("degraded");
    expect(repo.findInboxById(broken.id)!.last_outcome).toBe("failed");
    // 两者都仍是 pending，用户可以手动归档
    expect(repo.findInboxById(skipped.id)!.status).toBe("pending");
    expect(repo.findInboxById(skipped.id)!.attempt_count).toBe(1);
  });

  it("重试时清掉上一次的 outcome", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const item = repo.ingestToInbox({ agentId: "ag", userId: "u", itemType: "upload", title: "a" });
    repo.markInboxAttemptFailed(item.id, "无法归类", "degraded");

    expect(repo.retryInbox(item.id)).toBe(true);
    expect(repo.findInboxById(item.id)!.last_outcome).toBeNull();
    expect(repo.findInboxById(item.id)!.last_error).toBeNull();
  });
});

describe("WikiRepo 图谱抽取游标（三期）", () => {
  it("空库返回空对象", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    expect(repo.getGraphExtractCursor("ag", "u")).toEqual({});
  });

  it("可往返且按归属隔离", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.setGraphExtractCursor("ag", "u", { s1: "h1", s2: "h2" });
    expect(repo.getGraphExtractCursor("ag", "u")).toEqual({ s1: "h1", s2: "h2" });
    expect(repo.getGraphExtractCursor("ag2", "u")).toEqual({});
    expect(repo.getGraphExtractCursor("ag", "u2")).toEqual({});
  });

  it("JSON 损坏时退化为空对象，不让图谱视图整体报错", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.setIndexMeta(`${GRAPH_EXTRACT_CURSOR_META_KEY}:ag:u`, "{ not json");
    expect(repo.getGraphExtractCursor("ag", "u")).toEqual({});
  });

  it("结构非法（数组、值非字符串）也退化为空对象", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.setIndexMeta(`${GRAPH_EXTRACT_CURSOR_META_KEY}:ag:u`, JSON.stringify(["s1"]));
    expect(repo.getGraphExtractCursor("ag", "u")).toEqual({});
    repo.setIndexMeta(`${GRAPH_EXTRACT_CURSOR_META_KEY}:ag:u`, JSON.stringify({ s1: 42 }));
    expect(repo.getGraphExtractCursor("ag", "u")).toEqual({});
    repo.setIndexMeta(`${GRAPH_EXTRACT_CURSOR_META_KEY}:ag:u`, JSON.stringify(null));
    expect(repo.getGraphExtractCursor("ag", "u")).toEqual({});
  });

  it("覆盖式写入：后一次完全替换前一次", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.setGraphExtractCursor("ag", "u", { s1: "h1" });
    repo.setGraphExtractCursor("ag", "u", { s2: "h2" });
    expect(repo.getGraphExtractCursor("ag", "u")).toEqual({ s2: "h2" });
  });
});

describe("WikiRepo 主题树 V1→V2 迁移", () => {
  it("已是 v2 时返回 alreadyMigrated，不改树", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.getOrCreateTopicTree(); // 写入 v2 默认树
    const report = repo.migrateTopicTreeToV2();
    expect(report.alreadyMigrated).toBe(true);
    expect(repo.getOrCreateTopicTree().version).toBe(2);
  });

  it("v1→v2：六大类改写规则各统计命中数，用户自建大类追加到 v2 末尾", () => {
    const db = createMigratedTestDb();
    const repo = new WikiRepo(db);
    // 手动写入 v1 树（含一个用户自建大类「自定义」）
    const v1Tree = {
      version: 1,
      categories: [
        { name: "做事记录", subtopics: ["会议聊天记录"] },
        { name: "学习资料", subtopics: ["调研搜集材料"] },
        { name: "自定义", subtopics: ["特殊小类"] },
      ],
    };
    repo.setIndexMeta("topic_categories", JSON.stringify(v1Tree));

    // 创建一些资料（V26 SQL 已把大类改写、小类置空并存 legacy_subtopic）
    const s1 = repo.createSource({ agentId: "ag", userId: "u", title: "工作文档" });
    db.prepare("UPDATE wiki_sources SET topic_category = ?, legacy_subtopic = ? WHERE id = ?").run(
      "工作",
      "会议聊天记录",
      s1.id,
    );
    const s2 = repo.createSource({ agentId: "ag", userId: "u", title: "学习笔记" });
    db.prepare("UPDATE wiki_sources SET topic_category = ?, legacy_subtopic = ? WHERE id = ?").run(
      "学习",
      "调研搜集材料",
      s2.id,
    );
    const s3 = repo.createSource({ agentId: "ag", userId: "u", title: "自定义文档" });
    db.prepare("UPDATE wiki_sources SET topic_category = ?, topic_subtopic = ? WHERE id = ?").run(
      "自定义",
      "特殊小类",
      s3.id,
    );

    const report = repo.migrateTopicTreeToV2();
    expect(report.alreadyMigrated).toBe(false);

    // 六大类规则统计（做事记录→工作 1条，学习资料→学习 1条）
    const workRule = report.categoryRules.find((r) => r.from === "做事记录");
    expect(workRule).toMatchObject({ from: "做事记录", to: "工作", count: 1 });
    const studyRule = report.categoryRules.find((r) => r.from === "学习资料");
    expect(studyRule).toMatchObject({ from: "学习资料", to: "学习", count: 1 });

    // 用户自建大类「自定义」追加到 v2 末尾
    expect(report.userCategories).toEqual(["自定义"]);
    const nextTree = repo.getOrCreateTopicTree();
    expect(nextTree.version).toBe(2);
    expect(nextTree.categories.map((c) => c.name)).toContain("自定义");
    expect(nextTree.categories.find((c) => c.name === "自定义")?.subtopics).toEqual(["特殊小类"]);
  });

  it("legacySubtopicTop 统计前 20 个旧小类及其资料数", () => {
    const db = createMigratedTestDb();
    const repo = new WikiRepo(db);
    // 空 categories 会被 validateTopicTree 拒绝，parseTopicTree 返回 null 后
    // getOrCreateTopicTree 会写回 v2 默认树，迁移就变成 alreadyMigrated。给一个最小合法 v1 树。
    repo.setIndexMeta(
      "topic_categories",
      JSON.stringify({ version: 1, categories: [{ name: "做事记录", subtopics: ["会议聊天记录"] }] }),
    );

    // 创建带 legacy_subtopic 的资料
    for (let i = 0; i < 5; i++) {
      const s = repo.createSource({ agentId: "ag", userId: "u", title: `doc${i}` });
      db.prepare("UPDATE wiki_sources SET legacy_subtopic = ? WHERE id = ?").run("会议聊天记录", s.id);
    }
    for (let i = 0; i < 3; i++) {
      const s = repo.createSource({ agentId: "ag", userId: "u", title: `note${i}` });
      db.prepare("UPDATE wiki_sources SET legacy_subtopic = ? WHERE id = ?").run("调研搜集材料", s.id);
    }

    const report = repo.migrateTopicTreeToV2();
    expect(report.legacySubtopicTop).toContainEqual({ subtopic: "会议聊天记录", count: 5 });
    expect(report.legacySubtopicTop).toContainEqual({ subtopic: "调研搜集材料", count: 3 });
  });

  it("inboxCount 统计进收件箱的资料数（topic_category IS NULL 且 legacy_subtopic 非空）", () => {
    const db = createMigratedTestDb();
    const repo = new WikiRepo(db);
    repo.setIndexMeta(
      "topic_categories",
      JSON.stringify({ version: 1, categories: [{ name: "计划与复盘", subtopics: ["目标规划方案"] }] }),
    );

    // 「计划与复盘」→ NULL（进收件箱）
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "规划文档" });
    db.prepare("UPDATE wiki_sources SET topic_category = NULL, legacy_subtopic = ? WHERE id = ?").run(
      "目标规划方案",
      s.id,
    );

    const report = repo.migrateTopicTreeToV2();
    expect(report.inboxCount).toBe(1);
  });

  it("重复调用幂等：第二次返回 alreadyMigrated，不重写树", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.setIndexMeta(
      "topic_categories",
      JSON.stringify({ version: 1, categories: [{ name: "做事记录", subtopics: ["会议聊天记录"] }] }),
    );

    const r1 = repo.migrateTopicTreeToV2();
    expect(r1.alreadyMigrated).toBe(false);

    const r2 = repo.migrateTopicTreeToV2();
    expect(r2.alreadyMigrated).toBe(true);
  });
});
