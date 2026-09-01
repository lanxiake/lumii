/**
 * Wiki ERO 最小模型：实体 / 观察 / 关系
 *
 * 设计：`docs/design/记忆设计/2026-08-25-wiki-design-p0p1p2.md` §5.3
 * 关系重复以概率并集强化 strength：1-(1-a)(1-b)；观察退役用 retired_at，不物理删。
 */

import type { DatabaseAdapter } from "../storage/local-database.js";
import { generateWikiId } from "./types.js";

export type WikiEntityType = "person" | "project" | "tool" | "concept" | "other";

export interface WikiEntity {
  readonly id: string;
  readonly agent_id: string;
  readonly user_id: string;
  readonly name: string;
  readonly entity_type: WikiEntityType;
  readonly page_id: string | null;
  /** 三期：首次抽出该实体的资料；历史数据为 null */
  readonly source_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface WikiObservation {
  readonly id: string;
  readonly agent_id: string;
  readonly user_id: string;
  readonly entity_id: string;
  readonly content: string;
  readonly source_page_id: string | null;
  /** 三期：该观察抽自哪份资料 */
  readonly source_id: string | null;
  readonly retired_at: string | null;
  readonly created_at: string;
}

export interface WikiRelation {
  readonly id: string;
  readonly agent_id: string;
  readonly user_id: string;
  readonly source_entity_id: string;
  readonly target_entity_id: string;
  readonly relation_type: string;
  readonly strength: number;
  readonly source_page_id: string | null;
  /** 三期：该关系抽自哪份资料 */
  readonly source_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** 概率并集合并关系强度 */
export function mergeRelationStrength(a: number, b: number): number {
  const clampedA = Math.min(1, Math.max(0, a));
  const clampedB = Math.min(1, Math.max(0, b));
  return 1 - (1 - clampedA) * (1 - clampedB);
}

export class WikiEroRepo {
  constructor(private readonly db: DatabaseAdapter) {}

  /** 按名查找或创建实体 */
  upsertEntity(params: {
    readonly agentId: string;
    readonly userId: string;
    readonly name: string;
    readonly entityType: WikiEntityType;
    readonly pageId?: string | null;
    readonly sourceId?: string | null;
  }): WikiEntity {
    const existing = this.db
      .prepare<{
        id: string;
        agent_id: string;
        user_id: string;
        name: string;
        entity_type: string;
        page_id: string | null;
        source_id: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT * FROM wiki_entities
         WHERE agent_id = ? AND user_id = ? AND name = ? AND entity_type = ?`,
      )
      .get(params.agentId, params.userId, params.name, params.entityType);

    const now = new Date().toISOString();
    if (existing) {
      let needsUpdate = false;
      let nextPageId = existing.page_id;
      let nextSourceId = existing.source_id;

      // pageId 空则回填
      if (params.pageId && !existing.page_id) {
        nextPageId = params.pageId;
        needsUpdate = true;
      }
      // sourceId 空则回填，非空则保留（首次归属不覆盖）
      if (params.sourceId && !existing.source_id) {
        nextSourceId = params.sourceId;
        needsUpdate = true;
      }

      if (needsUpdate) {
        this.db
          .prepare("UPDATE wiki_entities SET page_id = ?, source_id = ?, updated_at = ? WHERE id = ?")
          .run(nextPageId, nextSourceId, now, existing.id);
        return {
          ...existing,
          entity_type: existing.entity_type as WikiEntityType,
          page_id: nextPageId,
          source_id: nextSourceId,
          updated_at: now,
        };
      }
      return { ...existing, entity_type: existing.entity_type as WikiEntityType };
    }

    const id = generateWikiId();
    this.db
      .prepare(
        `INSERT INTO wiki_entities
         (id, agent_id, user_id, name, entity_type, page_id, source_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.agentId,
        params.userId,
        params.name,
        params.entityType,
        params.pageId ?? null,
        params.sourceId ?? null,
        now,
        now,
      );
    return {
      id,
      agent_id: params.agentId,
      user_id: params.userId,
      name: params.name,
      entity_type: params.entityType,
      page_id: params.pageId ?? null,
      source_id: params.sourceId ?? null,
      created_at: now,
      updated_at: now,
    };
  }

  addObservation(params: {
    readonly agentId: string;
    readonly userId: string;
    readonly entityId: string;
    readonly content: string;
    readonly sourcePageId?: string | null;
    readonly sourceId?: string | null;
  }): WikiObservation {
    const id = generateWikiId();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO wiki_observations
         (id, agent_id, user_id, entity_id, content, source_page_id, source_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.agentId,
        params.userId,
        params.entityId,
        params.content,
        params.sourcePageId ?? null,
        params.sourceId ?? null,
        now,
      );
    return {
      id,
      agent_id: params.agentId,
      user_id: params.userId,
      entity_id: params.entityId,
      content: params.content,
      source_page_id: params.sourcePageId ?? null,
      source_id: params.sourceId ?? null,
      retired_at: null,
      created_at: now,
    };
  }

  retireObservation(id: string): void {
    this.db
      .prepare("UPDATE wiki_observations SET retired_at = ? WHERE id = ? AND retired_at IS NULL")
      .run(new Date().toISOString(), id);
  }

  /**
   * 写入或强化关系：同 (source,target,type) 用概率并集合并 strength。
   */
  upsertRelation(params: {
    readonly agentId: string;
    readonly userId: string;
    readonly sourceEntityId: string;
    readonly targetEntityId: string;
    readonly relationType: string;
    readonly strength?: number;
    readonly sourcePageId?: string | null;
    readonly sourceId?: string | null;
  }): WikiRelation {
    const strength = params.strength ?? 0.5;
    const existing = this.db
      .prepare<{
        id: string;
        agent_id: string;
        user_id: string;
        source_entity_id: string;
        target_entity_id: string;
        relation_type: string;
        strength: number;
        source_page_id: string | null;
        source_id: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT * FROM wiki_relations
         WHERE agent_id = ? AND user_id = ? AND source_entity_id = ? AND target_entity_id = ? AND relation_type = ?`,
      )
      .get(
        params.agentId,
        params.userId,
        params.sourceEntityId,
        params.targetEntityId,
        params.relationType,
      );

    const now = new Date().toISOString();
    if (existing) {
      const next = mergeRelationStrength(existing.strength, strength);
      this.db
        .prepare(
          "UPDATE wiki_relations SET strength = ?, updated_at = ?, source_page_id = COALESCE(?, source_page_id), source_id = COALESCE(?, source_id) WHERE id = ?",
        )
        .run(next, now, params.sourcePageId ?? null, params.sourceId ?? null, existing.id);
      return { ...existing, strength: next, updated_at: now };
    }

    const id = generateWikiId();
    this.db
      .prepare(
        `INSERT INTO wiki_relations
         (id, agent_id, user_id, source_entity_id, target_entity_id, relation_type, strength, source_page_id, source_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.agentId,
        params.userId,
        params.sourceEntityId,
        params.targetEntityId,
        params.relationType,
        strength,
        params.sourcePageId ?? null,
        params.sourceId ?? null,
        now,
        now,
      );
    return {
      id,
      agent_id: params.agentId,
      user_id: params.userId,
      source_entity_id: params.sourceEntityId,
      target_entity_id: params.targetEntityId,
      relation_type: params.relationType,
      strength,
      source_page_id: params.sourcePageId ?? null,
      source_id: params.sourceId ?? null,
      created_at: now,
      updated_at: now,
    };
  }

  listEntities(agentId: string, userId: string): readonly WikiEntity[] {
    return this.db
      .prepare<WikiEntity>(
        "SELECT * FROM wiki_entities WHERE agent_id = ? AND user_id = ? ORDER BY name ASC",
      )
      .all(agentId, userId)
      .map((r) => ({ ...r, entity_type: r.entity_type as WikiEntityType }));
  }

  listRelations(agentId: string, userId: string): readonly WikiRelation[] {
    return this.db
      .prepare<WikiRelation>(
        "SELECT * FROM wiki_relations WHERE agent_id = ? AND user_id = ? ORDER BY strength DESC",
      )
      .all(agentId, userId);
  }

  listActiveObservations(entityId: string): readonly WikiObservation[] {
    return this.db
      .prepare<WikiObservation>(
        "SELECT * FROM wiki_observations WHERE entity_id = ? AND retired_at IS NULL ORDER BY created_at DESC",
      )
      .all(entityId);
  }

  /**
   * 三期：按资料反查实体（供 mentioned_in 边现推）
   * 从 wiki_observations.source_id 聚合，并联 wiki_entities.source_id 兜底首次归属
   */
  listEntitiesBySources(
    agentId: string,
    userId: string,
    sourceIds: readonly string[],
  ): readonly { readonly entityId: string; readonly sourceId: string }[] {
    if (sourceIds.length === 0) return [];

    const placeholders = sourceIds.map(() => "?").join(",");
    // 观察表聚合
    const obsRows = this.db
      .prepare<{ entity_id: string; source_id: string }>(
        `SELECT DISTINCT entity_id, source_id FROM wiki_observations
         WHERE agent_id = ? AND user_id = ? AND source_id IN (${placeholders}) AND retired_at IS NULL`,
      )
      .all(agentId, userId, ...sourceIds);
    // 实体自身归属
    const entityRows = this.db
      .prepare<{ id: string; source_id: string }>(
        `SELECT id, source_id FROM wiki_entities
         WHERE agent_id = ? AND user_id = ? AND source_id IN (${placeholders})`,
      )
      .all(agentId, userId, ...sourceIds);

    const pairs = new Set<string>();
    for (const { entity_id, source_id } of obsRows) {
      pairs.add(JSON.stringify({ entityId: entity_id, sourceId: source_id }));
    }
    for (const { id, source_id } of entityRows) {
      pairs.add(JSON.stringify({ entityId: id, sourceId: source_id }));
    }
    return [...pairs].map((s) => JSON.parse(s));
  }

  /**
   * 三期：实体出现于哪些资料（实体侧栏）
   * 从 wiki_observations.source_id 聚合，并联 wiki_entities.source_id
   */
  listSourceIdsForEntity(agentId: string, userId: string, entityId: string): readonly string[] {
    const obs = this.db
      .prepare<{ source_id: string }>(
        `SELECT DISTINCT source_id FROM wiki_observations
         WHERE agent_id = ? AND user_id = ? AND entity_id = ? AND source_id IS NOT NULL AND retired_at IS NULL`,
      )
      .all(agentId, userId, entityId);
    const entity = this.db
      .prepare<{ source_id: string | null }>(
        "SELECT source_id FROM wiki_entities WHERE id = ?",
      )
      .get(entityId);
    const ids = new Set(obs.map((r) => r.source_id));
    if (entity?.source_id) ids.add(entity.source_id);
    return [...ids];
  }
}
