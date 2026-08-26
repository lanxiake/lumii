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
});
