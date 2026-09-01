/**
 * ERO 仓储单测：概率并集、退役观察
 */
import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiEroRepo, mergeRelationStrength } from "./wiki-ero.js";

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

});

describe("WikiEroRepo 资料归属（三期）", () => {
  it("upsertEntity 可绑定 sourceId", () => {
    const db = createMigratedTestDb();
    const ero = new WikiEroRepo(db);
    const e = ero.upsertEntity({
      agentId: "ag",
      userId: "u",
      name: "Lumii",
      entityType: "project",
      sourceId: "s1",
    });
    expect(e.source_id).toBe("s1");
    db.close();
  });

  it("已有实体的首次资料归属不被后续覆盖，空则回填", () => {
    const db = createMigratedTestDb();
    const ero = new WikiEroRepo(db);
    // 首次无归属
    const first = ero.upsertEntity({ agentId: "ag", userId: "u", name: "Lumii", entityType: "project" });
    expect(first.source_id).toBeNull();
    // 第二次带归属 → 回填
    const filled = ero.upsertEntity({
      agentId: "ag",
      userId: "u",
      name: "Lumii",
      entityType: "project",
      sourceId: "s1",
    });
    expect(filled.id).toBe(first.id);
    expect(filled.source_id).toBe("s1");
    // 第三次换归属 → 保留首次
    const kept = ero.upsertEntity({
      agentId: "ag",
      userId: "u",
      name: "Lumii",
      entityType: "project",
      sourceId: "s2",
    });
    expect(kept.source_id).toBe("s1");
    db.close();
  });

  it("观察与关系可带 sourceId", () => {
    const db = createMigratedTestDb();
    const ero = new WikiEroRepo(db);
    const a = ero.upsertEntity({ agentId: "ag", userId: "u", name: "A", entityType: "concept" });
    const b = ero.upsertEntity({ agentId: "ag", userId: "u", name: "B", entityType: "tool" });
    const obs = ero.addObservation({
      agentId: "ag",
      userId: "u",
      entityId: a.id,
      content: "本地优先",
      sourceId: "s1",
    });
    expect(obs.source_id).toBe("s1");
    const rel = ero.upsertRelation({
      agentId: "ag",
      userId: "u",
      sourceEntityId: a.id,
      targetEntityId: b.id,
      relationType: "uses",
      sourceId: "s1",
    });
    expect(rel.source_id).toBe("s1");
    db.close();
  });

  it("按资料反查实体（观察聚合 + 实体归属兜底）", () => {
    const db = createMigratedTestDb();
    const ero = new WikiEroRepo(db);
    const e = ero.upsertEntity({
      agentId: "ag",
      userId: "u",
      name: "Lumii",
      entityType: "project",
      sourceId: "s1",
    });
    ero.addObservation({ agentId: "ag", userId: "u", entityId: e.id, content: "a", sourceId: "s2" });
    const pairs = ero.listEntitiesBySources("ag", "u", ["s1", "s2"]);
    // s1 来自实体自身归属，s2 来自观察
    expect(pairs.map((p) => p.sourceId).sort()).toEqual(["s1", "s2"]);
    expect(pairs.every((p) => p.entityId === e.id)).toBe(true);
    db.close();
  });

  it("空 sourceIds 直接返回空数组，不拼出 IN () 语法错", () => {
    const db = createMigratedTestDb();
    const ero = new WikiEroRepo(db);
    expect(ero.listEntitiesBySources("ag", "u", [])).toEqual([]);
    db.close();
  });

  it("实体可反查出现于哪些资料（去重）", () => {
    const db = createMigratedTestDb();
    const ero = new WikiEroRepo(db);
    const e = ero.upsertEntity({
      agentId: "ag",
      userId: "u",
      name: "Lumii",
      entityType: "project",
      sourceId: "s1",
    });
    ero.addObservation({ agentId: "ag", userId: "u", entityId: e.id, content: "a", sourceId: "s1" });
    ero.addObservation({ agentId: "ag", userId: "u", entityId: e.id, content: "b", sourceId: "s2" });
    ero.addObservation({ agentId: "ag", userId: "u", entityId: e.id, content: "c", sourceId: "s1" });
    expect([...ero.listSourceIdsForEntity("ag", "u", e.id)].sort()).toEqual(["s1", "s2"]);
    db.close();
  });

  it("退役观察不再计入实体的出现资料", () => {
    const db = createMigratedTestDb();
    const ero = new WikiEroRepo(db);
    const e = ero.upsertEntity({ agentId: "ag", userId: "u", name: "X", entityType: "concept" });
    const obs = ero.addObservation({
      agentId: "ag",
      userId: "u",
      entityId: e.id,
      content: "过时事实",
      sourceId: "s9",
    });
    expect(ero.listSourceIdsForEntity("ag", "u", e.id)).toEqual(["s9"]);
    ero.retireObservation(obs.id);
    expect(ero.listSourceIdsForEntity("ag", "u", e.id)).toEqual([]);
    db.close();
  });
});
