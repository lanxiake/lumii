import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiRepo } from "./wiki-repo.js";
import { WikiCleanupScanner } from "./wiki-cleanup.js";
import { PARKING_CATEGORY } from "./wiki-topic-tree.js";

describe("WikiCleanupScanner", () => {
  it("命中内容重复规则：content_hash 相同的资料，保留最早一条，其余建议清理", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const a = repo.createSource({ agentId: "ag", userId: "u", title: "a", contentHash: "h1" });
    const b = repo.createSource({ agentId: "ag", userId: "u", title: "b", contentHash: "h1" });
    const scanner = new WikiCleanupScanner(repo);

    const suggestions = scanner.scan("ag", "u");
    const dup = suggestions.find((s) => s.reason === "duplicate_content");
    expect(dup).toBeDefined();
    expect(dup!.source.id).toBe(b.id);
    expect(dup!.duplicateOfSourceId).toBe(a.id);
  });

  it("不命中重复：content_hash 不同或为空不建议", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.createSource({ agentId: "ag", userId: "u", title: "a", contentHash: "h1" });
    repo.createSource({ agentId: "ag", userId: "u", title: "b", contentHash: "h2" });
    repo.createSource({ agentId: "ag", userId: "u", title: "c" });
    const scanner = new WikiCleanupScanner(repo);

    const suggestions = scanner.scan("ag", "u");
    expect(suggestions.filter((s) => s.reason === "duplicate_content")).toHaveLength(0);
  });

  it("命中来源失效规则：source_path 非空且文件不存在", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "a", sourcePath: "/tmp/missing.txt" });
    const scanner = new WikiCleanupScanner(repo);

    const suggestions = scanner.scan("ag", "u", { fileExists: () => false });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ reason: "broken_source" });
    expect(suggestions[0]!.source.id).toBe(s.id);
  });

  it("不命中来源失效：文件存在或未提供 fileExists 时跳过该规则", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.createSource({ agentId: "ag", userId: "u", title: "a", sourcePath: "/tmp/exists.txt" });
    const scanner = new WikiCleanupScanner(repo);

    expect(scanner.scan("ag", "u", { fileExists: () => true })).toHaveLength(0);
    expect(scanner.scan("ag", "u")).toHaveLength(0);
  });

  it("命中长期未用规则：从未使用且 created_at 早于阈值", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const db = (repo as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } } }).db;
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "old" });
    db.prepare("UPDATE wiki_sources SET created_at = ? WHERE id = ?").run(old, s.id);

    const scanner = new WikiCleanupScanner(repo);
    const suggestions = scanner.scan("ag", "u", { staleDays: 90 });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ reason: "stale" });
  });

  it("不命中长期未用：资料近期被打开过（touchSource 写 last_used）", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const db = (repo as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } } }).db;
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "old" });
    db.prepare("UPDATE wiki_sources SET created_at = ? WHERE id = ?").run(old, s.id);
    repo.touchSource("ag", "u", s.id);

    const scanner = new WikiCleanupScanner(repo);
    expect(scanner.scan("ag", "u", { staleDays: 90 })).toHaveLength(0);
  });

  it("命中长期未用：用过但最后一次使用也早于阈值", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const db = (repo as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } } }).db;
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "old" });
    db.prepare("UPDATE wiki_sources SET created_at = ?, last_used = ?, use_count = 3 WHERE id = ?").run(old, old, s.id);

    const scanner = new WikiCleanupScanner(repo);
    expect(scanner.scan("ag", "u", { staleDays: 90 })).toHaveLength(1);
  });

  // 回归：归档不再写 wiki_pages（见 wiki-organizer），旧规则 join 页面判使用情况，
  // 会把每条新归档的资料都误判为「长期未用」并送进批量删除的候选。
  it("不命中长期未用：新归档资料没有页面行，也不该被判为长期未用", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "刚归档" });
    repo.updateSourceTopic("ag", "u", s.id, "做事记录", "会议聊天记录");

    const scanner = new WikiCleanupScanner(repo);
    expect(scanner.scan("ag", "u", { staleDays: 90 })).toHaveLength(0);
  });

  it("归档后检索排除，恢复后检索回来", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "src" });
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/x",
      title: "唯一关键词页面",
      contentMd: "内容包含唯一关键词",
      editor: "ai",
      sourceRef: s.id,
    });

    const archived = repo.archiveSources("ag", "u", [s.id]);
    expect(archived).toBe(1);
    expect(repo.findSourceById(s.id)!.archived_at).not.toBeNull();

    const restored = repo.restoreSources("ag", "u", [s.id]);
    expect(restored).toBe(1);
    expect(repo.findSourceById(s.id)!.archived_at).toBeNull();
  });

  it("删除资料不级联删除引用它的页面", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "src" });
    const page = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/x",
      title: "x",
      contentMd: "内容",
      editor: "ai",
      sourceRef: s.id,
    });

    const deleted = repo.deleteSources("ag", "u", [s.id]);
    expect(deleted).toBe(1);
    expect(repo.findSourceById(s.id)).toBeNull();
    expect(repo.findPageById(page.id)).not.toBeNull();
  });

  it("删除页面返回受影响反链数", () => {
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
      contentMd: "参见 [[微信语音]]",
      editor: "ai",
    });

    const result = repo.deletePages("ag", "u", [target.id]);
    expect(result).toEqual({ deleted: 1, affectedBacklinks: 1 });
    expect(repo.findPageById(target.id)).toBeNull();
  });
});

describe("WikiCleanupScanner 建议动作（二期 §12）", () => {
  it("正式目录里的长期未用 → 建议移到临时存放", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "老调研" });
    repo.updateSourceTopic("ag", "u", s.id, "学习资料", "调研搜集材料");
    const scanner = new WikiCleanupScanner(repo);

    // staleDays 取负数把阈值推到未来，让所有资料都算长期未用
    const out = scanner.scan("ag", "u", { staleDays: -1 });
    const hit = out.find((x) => x.source.id === s.id)!;
    expect(hit).toMatchObject({ reason: "stale", suggestedAction: "parking" });
  });

  it("已在临时存放且长期未用 → 建议删除，不再移一次", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "搁置很久" });
    repo.updateSourceTopic("ag", "u", s.id, PARKING_CATEGORY, null);
    const scanner = new WikiCleanupScanner(repo);

    const out = scanner.scan("ag", "u", { staleDays: -1 });
    expect(out.find((x) => x.source.id === s.id)!.suggestedAction).toBe("delete");
  });

  it("来源失效 → 建议删除", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "丢了", sourcePath: "/gone.docx" });
    const scanner = new WikiCleanupScanner(repo);

    const out = scanner.scan("ag", "u", { fileExists: () => false });
    expect(out.find((x) => x.source.id === s.id)!.suggestedAction).toBe("delete");
  });

  it("内容重复 → 建议移到临时存放（保留原件，先降级不删）", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.createSource({ agentId: "ag", userId: "u", title: "a", contentHash: "h1" });
    const b = repo.createSource({ agentId: "ag", userId: "u", title: "b", contentHash: "h1" });
    const scanner = new WikiCleanupScanner(repo);

    const out = scanner.scan("ag", "u");
    expect(out.find((x) => x.source.id === b.id)!.suggestedAction).toBe("parking");
  });
});
