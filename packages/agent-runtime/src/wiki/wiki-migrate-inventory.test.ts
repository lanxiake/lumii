/**
 * Wiki 库级迁移 — 源目录簇盘点（零 LLM）
 */
import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import type { WikiInboxItem } from "./types.js";
import { WikiRepo } from "./wiki-repo.js";
import { DEFAULT_TOPIC_TREE } from "./wiki-topic-tree.js";
import { buildMigrateInventory } from "./wiki-migrate-inventory.js";

const VAULT_ROOT = "E:/data";

/** 构造最小 inbox 测试夹具 */
function fakeInbox(partial: Partial<WikiInboxItem> & { id: string; title: string }): WikiInboxItem {
  return {
    id: partial.id,
    agent_id: "ag",
    user_id: "u",
    item_type: "output",
    source_path: partial.source_path ?? null,
    source_url: null,
    title: partial.title,
    content_preview: null,
    media_type: "document",
    status: "pending",
    attempt_count: 0,
    last_error: null,
    last_outcome: null,
    organized_source_id: null,
    content_hash: null,
    created_at: "2026-01-01T00:00:00.000Z",
    organized_at: null,
    ...partial,
  };
}

describe("buildMigrateInventory", () => {
  it("按相对父目录聚簇，同夹文件进同一 cluster", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const inv = buildMigrateInventory({
      importRoot: "E:/data/outputs",
      workspaceRoot: "E:/data",
      inboxItems: [
        fakeInbox({ id: "1", source_path: "E:/data/outputs/proj/a.md", title: "a.md" }),
        fakeInbox({ id: "2", source_path: "E:/data/outputs/proj/b.md", title: "b.md" }),
        fakeInbox({ id: "3", source_path: "E:/data/outputs/other/c.md", title: "c.md" }),
      ],
      repo,
      agentId: "ag",
      userId: "u",
      topicTree: DEFAULT_TOPIC_TREE,
      vaultRoot: VAULT_ROOT,
    });
    expect(inv.clusters).toHaveLength(2);
    const proj = inv.clusters.find((c) => c.folderRel.endsWith("proj") || c.folderRel === "proj");
    expect(proj?.inboxIds).toEqual(expect.arrayContaining(["1", "2"]));
    expect(inv.directoryTreeText).toMatch(/proj/);
  });

  it("importRoot 根下文件 folderRel 为空串", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const inv = buildMigrateInventory({
      importRoot: "E:/data/outputs",
      workspaceRoot: "E:/data",
      inboxItems: [fakeInbox({ id: "1", source_path: "E:/data/outputs/root.md", title: "root.md" })],
      repo,
      agentId: "ag",
      userId: "u",
      topicTree: DEFAULT_TOPIC_TREE,
      vaultRoot: VAULT_ROOT,
    });
    expect(inv.clusters).toHaveLength(1);
    expect(inv.clusters[0]!.folderRel).toBe("");
    expect(inv.clusters[0]!.fileCount).toBe(1);
  });

  it("sampleNames 最多 3 条", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const inv = buildMigrateInventory({
      importRoot: "E:/data/outputs",
      workspaceRoot: "E:/data",
      inboxItems: [1, 2, 3, 4, 5].map((n) =>
        fakeInbox({
          id: String(n),
          source_path: `E:/data/outputs/batch/f${n}.md`,
          title: `f${n}.md`,
        }),
      ),
      repo,
      agentId: "ag",
      userId: "u",
      topicTree: DEFAULT_TOPIC_TREE,
      vaultRoot: VAULT_ROOT,
    });
    expect(inv.clusters[0]!.sampleNames.length).toBeLessThanOrEqual(3);
    expect(inv.clusters[0]!.fileCount).toBe(5);
  });

  it("wikiOccupancyText 与 wikiAnchorsText 来自库内已有资料", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "已有项目.docx" });
    repo.updateSourceTopic("ag", "u", s.id, "工作", "项目");

    const inv = buildMigrateInventory({
      importRoot: "E:/data/outputs",
      workspaceRoot: "E:/data",
      inboxItems: [fakeInbox({ id: "1", source_path: "E:/data/outputs/a.md", title: "a.md" })],
      repo,
      agentId: "ag",
      userId: "u",
      topicTree: DEFAULT_TOPIC_TREE,
      vaultRoot: VAULT_ROOT,
    });
    expect(inv.wikiOccupancyText).toMatch(/项目/);
    expect(inv.wikiAnchorsText).toMatch(/已有项目/);
    expect(inv.pendingCount).toBe(1);
  });
});
