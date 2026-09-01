/**
 * 结构轮/内容轮提示词与解析
 * 计划：docs/plans/记忆重构/2026-08-31-wiki-intelligent-vault-p5-cataloging.md Task 2
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_TOPIC_TREE } from "./wiki-topic-tree.js";
import type { LibraryInventory, InventoryFileRow } from "./wiki-library-inventory.js";
import {
  buildLibraryImpression,
  buildStructurePrompt,
  parseStructureResponse,
} from "./wiki-catalog-prompt.js";

function mkInventory(overrides?: Partial<LibraryInventory>): LibraryInventory {
  return {
    tree: DEFAULT_TOPIC_TREE,
    leaves: DEFAULT_TOPIC_TREE.categories.flatMap((c) =>
      c.subtopics.map((s) => ({ category: c.name, subtopic: s, count: 0, anchors: [] as string[] })),
    ),
    inboxCount: 0,
    files: [],
    ...overrides,
  };
}

const longTextFixture = "正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文";

function mkFile(overrides: Partial<InventoryFileRow>): InventoryFileRow {
  return {
    id: "s1",
    fileName: "文档.docx",
    relPath: "工作/项目/文档.docx",
    fromCategory: "工作",
    fromSubtopic: "项目",
    mediaType: "document",
    hasText: true,
    clusterKey: "工作/项目",
    ...overrides,
  };
}

describe("buildLibraryImpression", () => {
  it("含每叶子计数与未细分槽位", () => {
    const inv = mkInventory({
      leaves: [
        { category: "工作", subtopic: "项目", count: 3, anchors: ["a"] },
        { category: "工作", subtopic: null, count: 2, anchors: [] },
      ],
      tree: { version: 2, categories: [{ name: "工作", subtopics: ["项目"] }] },
    });
    const text = buildLibraryImpression(inv);
    expect(text).toContain("项目(3)");
    expect(text).toContain("未细分(2)");
  });

  it("规模不随批次增长：行数固定为叶子数 + 固定头部", () => {
    const inv = mkInventory();
    const text = buildLibraryImpression(inv);
    const lines = text.split("\n");
    // 固定头部：标题行 x2 + 收件箱行 + 样例段标题 = 4，剩下是大类行与锚点行
    const leafCount = inv.leaves.length;
    const categoryCount = inv.tree.categories.length;
    expect(lines.length).toBeLessThanOrEqual(4 + categoryCount + leafCount);
  });
});

describe("buildStructurePrompt", () => {
  it("不含正文", () => {
    const inv = mkInventory();
    const batch = [mkFile({})];
    const p = buildStructurePrompt(inv.tree, buildLibraryImpression(inv), batch);
    expect(p).not.toContain(longTextFixture.slice(0, 50));
  });

  it("标注无正文资料的 mediaType", () => {
    const inv = mkInventory();
    const batch = [mkFile({ hasText: false, mediaType: "image", fileName: "IMG_1.jpg" })];
    const p = buildStructurePrompt(inv.tree, buildLibraryImpression(inv), batch);
    expect(p).toContain("image，无正文");
  });
});

describe("parseStructureResponse", () => {
  const batch = [
    mkFile({ id: "s1" }),
    mkFile({ id: "s2", fileName: "s2.docx" }),
  ];

  it("解析 needContent 条目", () => {
    const raw = JSON.stringify({ items: [{ id: "s1", needContent: true, reason: "判不了" }] });
    const { decisions } = parseStructureResponse(raw, batch, DEFAULT_TOPIC_TREE);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ id: "s1", needContent: true, category: null });
  });

  it("解析 subtopic 留空的条目", () => {
    const raw = JSON.stringify({ items: [{ id: "s1", category: "工作", confidence: 0.9, reason: "x" }] });
    const { decisions } = parseStructureResponse(raw, batch, DEFAULT_TOPIC_TREE);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ id: "s1", category: "工作", subtopic: null, needContent: false });
  });

  it("drop 不在本批的 id", () => {
    const raw = JSON.stringify({ items: [{ id: "unknown", category: "工作", confidence: 0.9, reason: "x" }] });
    const { decisions, droppedInvalid } = parseStructureResponse(raw, batch, DEFAULT_TOPIC_TREE);
    expect(decisions).toHaveLength(0);
    expect(droppedInvalid).toBe(1);
  });

  it("drop 非法 subtopic 组合", () => {
    const raw = JSON.stringify({
      items: [{ id: "s1", category: "工作", subtopic: "不存在的小类", confidence: 0.9, reason: "x" }],
    });
    const { decisions, droppedInvalid } = parseStructureResponse(raw, batch, DEFAULT_TOPIC_TREE);
    expect(decisions).toHaveLength(0);
    expect(droppedInvalid).toBe(1);
  });

  it("容忍 <think> 块与代码围栏", () => {
    const raw = `<think>先想想</think>\n\`\`\`json\n${JSON.stringify({
      items: [{ id: "s1", category: "工作", confidence: 0.9, reason: "x" }],
    })}\n\`\`\``;
    const { decisions } = parseStructureResponse(raw, batch, DEFAULT_TOPIC_TREE);
    expect(decisions).toHaveLength(1);
  });

  it("category 与 needContent 同时给出时以 category 为准", () => {
    const raw = JSON.stringify({
      items: [{ id: "s1", category: "工作", needContent: true, confidence: 0.9, reason: "x" }],
    });
    const { decisions } = parseStructureResponse(raw, batch, DEFAULT_TOPIC_TREE);
    expect(decisions[0]).toMatchObject({ needContent: false, category: "工作" });
  });
});
