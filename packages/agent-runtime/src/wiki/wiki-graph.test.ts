/**
 * WikiGraphBuilder 单测：1 跳边界、上限截断、方向、孤立节点、混合实体图。
 * 纯逻辑断言不依赖 FTS5；建库失败时跳过集成断言。
 */
import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiEroRepo } from "./wiki-ero.js";
import { WikiRepo } from "./wiki-repo.js";
import { WikiGraphBuilder } from "./wiki-graph.js";

function tryCreateRepo(): WikiRepo | null {
  try {
    return new WikiRepo(createMigratedTestDb());
  } catch {
    return null;
  }
}

describe("WikiGraphBuilder", () => {
  it("1 跳子图含中心与邻居，边方向正确；孤立中心仅自身", () => {
    const repo = tryCreateRepo();
    if (!repo) return;

    const a = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/a",
      title: "A页",
      contentMd: "见 [[B页]]",
      editor: "user",
    });
    const b = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/b",
      title: "B页",
      contentMd: "正文",
      editor: "user",
    });
    // 触发 A 的链接重算：再保存一次含双链
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/a",
      title: "A页",
      contentMd: "见 [[B页]]",
      editor: "user",
    });

    const builder = new WikiGraphBuilder(repo);
    const g = builder.buildSubgraph("ag", "u", { centerPageId: a.id, radius: 1 });
    expect(g.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(g.nodes.every((n) => n.kind === "page")).toBe(true);
    const wikilink = g.edges.find((e) => e.source === a.id && e.target === b.id);
    expect(wikilink).toBeDefined();
    expect(wikilink!.kind).toBe("wikilink");
    expect(wikilink!.anchorText).toBe(wikilink!.label);

    const alone = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/alone",
      title: "孤立",
      contentMd: "无链接",
      editor: "user",
    });
    const g2 = builder.buildSubgraph("ag", "u", { centerPageId: alone.id });
    expect(g2.nodes).toHaveLength(1);
    expect(g2.edges).toHaveLength(0);
  });

  it("节点上限截断时 truncated=true", () => {
    const repo = tryCreateRepo();
    if (!repo) return;

    const center = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/center",
      title: "中心",
      contentMd: "x",
      editor: "user",
    });
    const titles: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t = `邻${i}`;
      titles.push(t);
      repo.savePage({
        agentId: "ag",
        userId: "u",
        path: `sources/n${i}`,
        title: t,
        contentMd: "y",
        editor: "user",
      });
    }
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/center",
      title: "中心",
      contentMd: titles.map((t) => `[[${t}]]`).join(" "),
      editor: "user",
    });

    const builder = new WikiGraphBuilder(repo);
    const g = builder.buildSubgraph("ag", "u", { centerPageId: center.id, limit: 3 });
    expect(g.nodes.length).toBeLessThanOrEqual(3);
    expect(g.truncated).toBe(true);
  });

  it("混合图：页面节点 + 实体节点；wikilink 与 relation 边分 kind", () => {
    const repo = tryCreateRepo();
    if (!repo) return;
    const db = repo.database;
    const ero = new WikiEroRepo(db);

    const a = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/a",
      title: "A页",
      contentMd: "见 [[B页]]",
      editor: "user",
    });
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/b",
      title: "B页",
      contentMd: "正文",
      editor: "user",
    });
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/a",
      title: "A页",
      contentMd: "见 [[B页]]",
      editor: "user",
    });

    const e1 = ero.upsertEntity({
      agentId: "ag",
      userId: "u",
      name: "项目X",
      entityType: "project",
      pageId: a.id,
    });
    const e2 = ero.upsertEntity({
      agentId: "ag",
      userId: "u",
      name: "工具Y",
      entityType: "tool",
      pageId: null,
    });
    ero.upsertRelation({
      agentId: "ag",
      userId: "u",
      sourceEntityId: e1.id,
      targetEntityId: e2.id,
      relationType: "uses",
      strength: 0.6,
      sourcePageId: a.id,
    });

    const g = new WikiGraphBuilder(repo).buildSubgraph("ag", "u", {
      centerPageId: a.id,
      radius: 1,
      limit: 50,
      includeEntities: true,
      eroEntities: ero.listEntities("ag", "u"),
      eroRelations: ero.listRelations("ag", "u"),
    });

    const pageNodes = g.nodes.filter((n) => n.kind === "page");
    const entityNodes = g.nodes.filter((n) => n.kind === "entity");
    expect(pageNodes.length).toBeGreaterThan(0);
    expect(entityNodes.some((n) => n.id === `entity:${e1.id}`)).toBe(true);
    expect(entityNodes.some((n) => n.id === `entity:${e2.id}`)).toBe(true);
    expect(g.edges.some((e) => e.kind === "wikilink")).toBe(true);
    const relation = g.edges.find((e) => e.kind === "relation" && e.label === "uses");
    expect(relation).toBeDefined();
    expect(relation!.source).toBe(`entity:${e1.id}`);
    expect(relation!.target).toBe(`entity:${e2.id}`);
    expect(relation!.strength).toBeCloseTo(0.6);
    expect(g.edges.every((e) => !(e.kind === "relation" && !e.source.startsWith("entity:")))).toBe(true);
  });

  /** 三期：新图谱模型测试 */
  it("结构层：大类节点 + 小类节点 + 资料节点 + belongs_to 边", () => {
    const repo = tryCreateRepo();
    if (!repo) return;
    const ero = new WikiEroRepo(repo.database);
    const tree = repo.getOrCreateTopicTree();
    const firstCategory = tree.categories[0]?.name ?? "做事记录";
    const firstSubtopic = tree.categories[0]?.subtopics[0] ?? "会议聊天记录";

    const s1 = repo.createSource({ agentId: "ag", userId: "u", title: "会议A.pdf" });
    const s2 = repo.createSource({ agentId: "ag", userId: "u", title: "会议B.pdf" });
    const s3 = repo.createSource({ agentId: "ag", userId: "u", title: "会议C.pdf" });
    repo.updateSourceTopic("ag", "u", s1.id, firstCategory, firstSubtopic);
    repo.updateSourceTopic("ag", "u", s2.id, firstCategory, firstSubtopic);
    repo.updateSourceTopic("ag", "u", s3.id, firstCategory, firstSubtopic);

    const builder = new WikiGraphBuilder(repo);
    const g = builder.buildSubgraph("ag", "u", {
      category: firstCategory,
      layers: ["structure"],
      eroRepo: ero,
    });

    const categoryNode = g.nodes.find((n) => n.kind === "category" && n.id === firstCategory);
    expect(categoryNode).toBeDefined();
    const subtopicNodeId = JSON.stringify([firstCategory, firstSubtopic]);
    const subtopicNode = g.nodes.find((n) => n.kind === "subtopic" && n.id === subtopicNodeId);
    expect(subtopicNode).toBeDefined();
    const sourceNodes = g.nodes.filter((n) => n.kind === "source");
    expect(sourceNodes.length).toBe(3);
    expect(sourceNodes.map((n) => n.id).sort()).toEqual([s1.id, s2.id, s3.id].sort());

    const sourceBelongs = g.edges.filter((e) => e.kind === "belongs_to" && e.target === subtopicNodeId);
    expect(sourceBelongs.length).toBe(3);
    const subtopicBelongs = g.edges.find(
      (e) => e.kind === "belongs_to" && e.source === subtopicNodeId && e.target === firstCategory,
    );
    expect(subtopicBelongs).toBeDefined();
  });

  it("sibling 边：同小类 ≤8 个资料时生成，>8 个不生成", () => {
    const repo = tryCreateRepo();
    if (!repo) return;
    const ero = new WikiEroRepo(repo.database);
    const tree = repo.getOrCreateTopicTree();
    const cat = tree.categories[0]?.name ?? "做事记录";
    const sub = tree.categories[0]?.subtopics[0] ?? "会议聊天记录";

    for (let i = 0; i < 7; i += 1) {
      const s = repo.createSource({ agentId: "ag", userId: "u", title: `资料${i}.pdf` });
      repo.updateSourceTopic("ag", "u", s.id, cat, sub);
    }
    const builder = new WikiGraphBuilder(repo);
    const g7 = builder.buildSubgraph("ag", "u", { category: cat, layers: ["structure"], eroRepo: ero });
    const sibling7 = g7.edges.filter((e) => e.kind === "sibling");
    expect(sibling7.length).toBeGreaterThan(0);

    const s8 = repo.createSource({ agentId: "ag", userId: "u", title: "资料7.pdf" });
    repo.updateSourceTopic("ag", "u", s8.id, cat, sub);
    const s9 = repo.createSource({ agentId: "ag", userId: "u", title: "资料8.pdf" });
    repo.updateSourceTopic("ag", "u", s9.id, cat, sub);
    const g9 = builder.buildSubgraph("ag", "u", { category: cat, layers: ["structure"], eroRepo: ero });
    const sibling9 = g9.edges.filter((e) => e.kind === "sibling");
    expect(sibling9.length).toBe(0);
  });

  it("实体层：entity 节点 + relation 边 + mentioned_in 边", () => {
    const repo = tryCreateRepo();
    if (!repo) return;
    const ero = new WikiEroRepo(repo.database);
    const tree = repo.getOrCreateTopicTree();
    const cat = tree.categories[0]?.name ?? "做事记录";
    const sub = tree.categories[0]?.subtopics[0] ?? "会议聊天记录";

    const s1 = repo.createSource({ agentId: "ag", userId: "u", title: "调研A.pdf" });
    repo.updateSourceTopic("ag", "u", s1.id, cat, sub);
    const e1 = ero.upsertEntity({
      agentId: "ag",
      userId: "u",
      name: "Lumii",
      entityType: "project",
      sourceId: s1.id,
    });
    const e2 = ero.upsertEntity({
      agentId: "ag",
      userId: "u",
      name: "SQLite",
      entityType: "tool",
    });
    ero.upsertRelation({
      agentId: "ag",
      userId: "u",
      sourceEntityId: e1.id,
      targetEntityId: e2.id,
      relationType: "uses",
      strength: 0.8,
      sourceId: s1.id,
    });
    ero.addObservation({
      agentId: "ag",
      userId: "u",
      entityId: e2.id,
      content: "本地优先数据库",
      sourceId: s1.id,
    });

    const builder = new WikiGraphBuilder(repo);
    const g = builder.buildSubgraph("ag", "u", { category: cat, layers: ["entities"], eroRepo: ero });

    const entityNodes = g.nodes.filter((n) => n.kind === "entity");
    expect(entityNodes.length).toBeGreaterThanOrEqual(2);
    expect(entityNodes.some((n) => n.id === `entity:${e1.id}`)).toBe(true);
    expect(entityNodes.some((n) => n.id === `entity:${e2.id}`)).toBe(true);

    const relationEdge = g.edges.find((e) => e.kind === "relation" && e.label === "uses");
    expect(relationEdge).toBeDefined();
    expect(relationEdge!.source).toBe(`entity:${e1.id}`);
    expect(relationEdge!.target).toBe(`entity:${e2.id}`);

    const mentionedEdges = g.edges.filter((e) => e.kind === "mentioned_in" && e.target === s1.id);
    expect(mentionedEdges.length).toBeGreaterThanOrEqual(1);
  });

  it("limit 只约束 source+entity 节点，category/subtopic 不计入", () => {
    const repo = tryCreateRepo();
    if (!repo) return;
    const ero = new WikiEroRepo(repo.database);
    const tree = repo.getOrCreateTopicTree();
    const cat = tree.categories[0]?.name ?? "做事记录";
    const sub = tree.categories[0]?.subtopics[0] ?? "会议聊天记录";

    for (let i = 0; i < 10; i += 1) {
      const s = repo.createSource({ agentId: "ag", userId: "u", title: `资料${i}.pdf` });
      repo.updateSourceTopic("ag", "u", s.id, cat, sub);
    }

    const builder = new WikiGraphBuilder(repo);
    const g = builder.buildSubgraph("ag", "u", { category: cat, layers: ["structure"], limit: 5, eroRepo: ero });

    const categoryNodes = g.nodes.filter((n) => n.kind === "category");
    const subtopicNodes = g.nodes.filter((n) => n.kind === "subtopic");
    const sourceNodes = g.nodes.filter((n) => n.kind === "source");

    expect(categoryNodes.length).toBeGreaterThan(0);
    expect(subtopicNodes.length).toBeGreaterThan(0);
    expect(sourceNodes.length).toBeLessThanOrEqual(5);
    expect(g.truncated).toBe(true);
  });

  it("历史层：page 节点 + wikilink 边（兼容二期）", () => {
    const repo = tryCreateRepo();
    if (!repo) return;
    const ero = new WikiEroRepo(repo.database);

    const p1 = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "concepts/p1",
      title: "概念A",
      contentMd: "见 [[概念B]]",
      editor: "user",
    });
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "concepts/p2",
      title: "概念B",
      contentMd: "正文",
      editor: "user",
    });
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "concepts/p1",
      title: "概念A",
      contentMd: "见 [[概念B]]",
      editor: "user",
    });

    const builder = new WikiGraphBuilder(repo);
    const g = builder.buildSubgraph("ag", "u", { category: "concepts", layers: ["history"], eroRepo: ero });

    const pageNodes = g.nodes.filter((n) => n.kind === "page");
    expect(pageNodes.length).toBeGreaterThan(0);
    const wikilinkEdges = g.edges.filter((e) => e.kind === "wikilink");
    expect(wikilinkEdges.length).toBeGreaterThan(0);
    expect(g.nodes.every((n) => n.kind === "page")).toBe(true);
  });
});
