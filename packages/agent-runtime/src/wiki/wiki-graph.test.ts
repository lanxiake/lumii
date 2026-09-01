/**
 * WikiGraphBuilder 单测：结构层/实体层/limit 截断/sibling 边。
 * 页面双链图（centerPageId/history 层）已随 P3 删除，改用 category/subtopic 起步查询。
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
  it("无 category 时抛错", () => {
    const repo = tryCreateRepo();
    if (!repo) return;
    const builder = new WikiGraphBuilder(repo);
    expect(() => builder.buildSubgraph("ag", "u", {})).toThrow(/category/);
  });

  it("结构层：大类节点 + 小类节点 + 资料节点 + belongs_to 边", () => {
    const repo = tryCreateRepo();
    if (!repo) return;
    const ero = new WikiEroRepo(repo.database);
    const tree = repo.getOrCreateTopicTree();
    const firstCategory = tree.categories[0]?.name ?? "工作";
    const firstSubtopic = tree.categories[0]?.subtopics[0] ?? "例行";

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
    const cat = tree.categories[0]?.name ?? "工作";
    const sub = tree.categories[0]?.subtopics[0] ?? "例行";

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
    const cat = tree.categories[0]?.name ?? "工作";
    const sub = tree.categories[0]?.subtopics[0] ?? "例行";

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
    const cat = tree.categories[0]?.name ?? "工作";
    const sub = tree.categories[0]?.subtopics[0] ?? "例行";

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

  it("默认 layers 为 structure+entities，不再有 history 层", () => {
    const repo = tryCreateRepo();
    if (!repo) return;
    const ero = new WikiEroRepo(repo.database);
    const tree = repo.getOrCreateTopicTree();
    const cat = tree.categories[0]?.name ?? "工作";

    const s1 = repo.createSource({ agentId: "ag", userId: "u", title: "资料.pdf" });
    repo.updateSourceTopic("ag", "u", s1.id, cat, null);

    const builder = new WikiGraphBuilder(repo);
    const g = builder.buildSubgraph("ag", "u", { category: cat, eroRepo: ero });

    expect(g.nodes.some((n) => n.kind === "category")).toBe(true);
    expect(g.nodes.some((n) => (n.kind as string) === "page")).toBe(false);
    expect(g.edges.some((e) => (e.kind as string) === "wikilink")).toBe(false);
  });
});
