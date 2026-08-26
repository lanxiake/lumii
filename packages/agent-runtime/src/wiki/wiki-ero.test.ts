/**
 * ERO 仓储单测：概率并集、退役观察、双链引导
 */
import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiRepo } from "./wiki-repo.js";
import { WikiEroRepo, bootstrapEroFromWikilinks, mergeRelationStrength } from "./wiki-ero.js";

describe("mergeRelationStrength", () => {
  it("概率并集强化且不超过 1", () => {
    expect(mergeRelationStrength(0.5, 0.5)).toBeCloseTo(0.75);
    expect(mergeRelationStrength(0.9, 0.9)).toBeLessThanOrEqual(1);
  });
});

describe("WikiEroRepo", () => {
  it("upsert 关系合并 strength；观察可退役", () => {
    const db = createMigratedTestDb();
    const ero = new WikiEroRepo(db);
    const a = ero.upsertEntity({ agentId: "ag", userId: "u", name: "A", entityType: "concept" });
    const b = ero.upsertEntity({ agentId: "ag", userId: "u", name: "B", entityType: "tool" });
    const r1 = ero.upsertRelation({
      agentId: "ag",
      userId: "u",
      sourceEntityId: a.id,
      targetEntityId: b.id,
      relationType: "uses",
      strength: 0.4,
    });
    const r2 = ero.upsertRelation({
      agentId: "ag",
      userId: "u",
      sourceEntityId: a.id,
      targetEntityId: b.id,
      relationType: "uses",
      strength: 0.4,
    });
    expect(r2.id).toBe(r1.id);
    expect(r2.strength).toBeCloseTo(mergeRelationStrength(0.4, 0.4));

    const obs = ero.addObservation({
      agentId: "ag",
      userId: "u",
      entityId: a.id,
      content: "事实一",
    });
    expect(ero.listActiveObservations(a.id)).toHaveLength(1);
    ero.retireObservation(obs.id);
    expect(ero.listActiveObservations(a.id)).toHaveLength(0);
    db.close();
  });

  it("从双链引导实体与关系", () => {
    const db = createMigratedTestDb();
    const repo = new WikiRepo(db);
    const ero = new WikiEroRepo(db);
    const p1 = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/a",
      title: "页甲",
      contentMd: "见 [[页乙]]",
      editor: "user",
    });
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/b",
      title: "页乙",
      contentMd: "正文",
      editor: "user",
    });
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/a",
      title: "页甲",
      contentMd: "见 [[页乙]]",
      editor: "user",
    });

    const result = bootstrapEroFromWikilinks(db, repo, ero, "ag", "u");
    expect(result.entities).toBeGreaterThanOrEqual(2);
    expect(result.relations).toBeGreaterThanOrEqual(1);
    expect(ero.listEntities("ag", "u").some((e) => e.page_id === p1.id)).toBe(true);
    db.close();
  });
});
