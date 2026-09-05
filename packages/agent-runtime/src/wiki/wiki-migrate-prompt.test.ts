/**
 * Wiki 库级迁移 — 目录映射 prompt 与解析
 */
import { describe, expect, it } from "vitest";
import type { MigrateFolderCluster, MigrateInventory } from "./wiki-migrate-inventory.js";
import {
  MIGRATE_PLAN_BATCH_SIZE,
  buildMigratePlanPrompt,
  parseMigratePlanResponse,
} from "./wiki-migrate-prompt.js";
import { DEFAULT_TOPIC_TREE, type WikiTopicTree } from "./wiki-topic-tree.js";

const tree: WikiTopicTree = DEFAULT_TOPIC_TREE;

function fakeInventory(overrides?: Partial<MigrateInventory>): MigrateInventory {
  return {
    importRoot: "E:/data/outputs",
    directoryTreeText: "outputs/\n  proj/\n    a.md\n    b.md",
    clusters: [],
    wikiOccupancyText: "工作/项目: 2 个",
    wikiAnchorsText: "工作/项目：已有项目.docx",
    alreadyInWikiCount: 0,
    pendingCount: 2,
    ...overrides,
  };
}

function fakeCluster(partial: Partial<MigrateFolderCluster> & { folderRel: string }): MigrateFolderCluster {
  return {
    folderRel: partial.folderRel,
    fileCount: partial.fileCount ?? 1,
    sampleNames: partial.sampleNames ?? ["a.md"],
    inboxIds: partial.inboxIds ?? ["1"],
  };
}

describe("MIGRATE_PLAN_BATCH_SIZE", () => {
  it("建议每批 30 簇", () => {
    expect(MIGRATE_PLAN_BATCH_SIZE).toBe(30);
  });
});

describe("buildMigratePlanPrompt", () => {
  const inventory = fakeInventory();
  const batchClusters: MigrateFolderCluster[] = [
    fakeCluster({ folderRel: "proj", fileCount: 2, sampleNames: ["a.md", "b.md"], inboxIds: ["1", "2"] }),
  ];

  it("含源目录树与占用且不含正文预览长段", () => {
    const p = buildMigratePlanPrompt(tree, inventory, batchClusters);
    expect(p).toMatch(/口诀|工作/);
    expect(p).toMatch(/源目录|目录结构/);
    expect(p).not.toMatch(/内容预览:/);
  });

  it("含 wiki 占用与锚点摘要", () => {
    const p = buildMigratePlanPrompt(tree, inventory, batchClusters);
    expect(p).toMatch(/工作\/项目/);
    expect(p).toMatch(/已有项目/);
  });

  it("含本批文件夹簇信息", () => {
    const p = buildMigratePlanPrompt(tree, inventory, batchClusters);
    expect(p).toMatch(/proj/);
    expect(p).toMatch(/a\.md/);
  });

  it("含映射规则与 JSON 输出说明", () => {
    const p = buildMigratePlanPrompt(tree, inventory, batchClusters);
    expect(p).toMatch(/同.*夹|同一文件夹/);
    expect(p).toMatch(/proposedSubtopic|新小类/);
    expect(p).toMatch(/folderRel/);
  });
});

describe("parseMigratePlanResponse", () => {
  const batchClusters: MigrateFolderCluster[] = [
    fakeCluster({ folderRel: "proj", inboxIds: ["1", "2"], fileCount: 2, sampleNames: ["a.md", "b.md"] }),
  ];

  it("校验越权大类为 conflict", () => {
    const mappings = parseMigratePlanResponse(
      JSON.stringify([{ folderRel: "proj", category: "火星", subtopic: null, confidence: 0.9, reason: "x" }]),
      tree,
      batchClusters,
    );
    expect(mappings).toHaveLength(1);
    expect(mappings[0]!.status).toBe("conflict");
    expect(mappings[0]!.category).toBeNull();
    expect(mappings[0]!.inboxIds).toEqual(["1", "2"]);
  });

  it("confidence < 0.6 → conflict", () => {
    const mappings = parseMigratePlanResponse(
      JSON.stringify([{ folderRel: "proj", category: "工作", subtopic: "项目", confidence: 0.5, reason: "不确定" }]),
      tree,
      batchClusters,
    );
    expect(mappings[0]!.status).toBe("conflict");
    expect(mappings[0]!.category).toBeNull();
  });

  it("合法映射 → ok，inboxIds 从输入簇补回", () => {
    const mappings = parseMigratePlanResponse(
      JSON.stringify([
        { folderRel: "proj", category: "工作", subtopic: "项目", confidence: 0.9, reason: "同项目资料" },
      ]),
      tree,
      batchClusters,
    );
    expect(mappings[0]!.status).toBe("ok");
    expect(mappings[0]!.category).toBe("工作");
    expect(mappings[0]!.subtopic).toBe("项目");
    expect(mappings[0]!.inboxIds).toEqual(["1", "2"]);
  });

  it("category 空 → conflict", () => {
    const mappings = parseMigratePlanResponse(
      JSON.stringify([{ folderRel: "proj", category: null, subtopic: null, confidence: 0.9, reason: "拿不准" }]),
      tree,
      batchClusters,
    );
    expect(mappings[0]!.status).toBe("conflict");
    expect(mappings[0]!.category).toBeNull();
  });

  it("needContent 且无合法 category → needContent", () => {
    const mappings = parseMigratePlanResponse(
      JSON.stringify([
        { folderRel: "proj", needContent: true, confidence: 0.4, reason: "路径语义不足" },
      ]),
      tree,
      batchClusters,
    );
    expect(mappings[0]!.status).toBe("needContent");
    expect(mappings[0]!.category).toBeNull();
  });

  it("保留 proposedSubtopic 提案字段", () => {
    const mappings = parseMigratePlanResponse(
      JSON.stringify([
        {
          folderRel: "proj",
          category: "工作",
          subtopic: null,
          proposedSubtopic: "新专项",
          confidence: 0.85,
          reason: "新项目",
        },
      ]),
      tree,
      batchClusters,
    );
    expect(mappings[0]!.status).toBe("ok");
    expect(mappings[0]!.proposedSubtopic).toBe("新专项");
  });

  it("本批未返回的簇标记 conflict", () => {
    const clusters = [
      fakeCluster({ folderRel: "proj", inboxIds: ["1"] }),
      fakeCluster({ folderRel: "other", inboxIds: ["2"] }),
    ];
    const mappings = parseMigratePlanResponse(
      JSON.stringify([
        { folderRel: "proj", category: "工作", subtopic: "项目", confidence: 0.9, reason: "ok" },
      ]),
      tree,
      clusters,
    );
    expect(mappings).toHaveLength(2);
    const other = mappings.find((m) => m.folderRel === "other");
    expect(other?.status).toBe("conflict");
    expect(other?.reason).toMatch(/未返回/);
  });

  it("非法 JSON 时本批全部 conflict", () => {
    const mappings = parseMigratePlanResponse("not json", tree, batchClusters);
    expect(mappings).toHaveLength(1);
    expect(mappings[0]!.status).toBe("conflict");
  });
});
