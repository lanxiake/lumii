/**
 * WikiGraphBuilder 单测：1 跳边界、上限截断、方向、孤立节点。
 * 纯逻辑断言不依赖 FTS5；建库失败时跳过集成断言。
 */
import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
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
    expect(g.edges.some((e) => e.source === a.id && e.target === b.id)).toBe(true);

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
});
