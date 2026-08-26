/**
 * Wiki ERO 最小模型：实体 / 观察 / 关系
 *
 * 设计：`docs/design/记忆设计/2026-08-25-wiki-design-p0p1p2.md` §5.3
 * 关系重复以概率并集强化 strength：1-(1-a)(1-b)；观察退役用 retired_at，不物理删。
 */

import type { DatabaseAdapter } from "../storage/local-database.js";
import { withTransaction } from "../storage/local-database.js";
import { generateWikiId } from "./types.js";
import type { WikiRepo } from "./wiki-repo.js";

export type WikiEntityType = "person" | "project" | "tool" | "concept" | "other";

export interface WikiEntity {
  readonly id: string;
  readonly agent_id: string;
  readonly user_id: string;
  readonly name: string;
  readonly entity_type: WikiEntityType;
  readonly page_id: string | null;
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
  }): WikiEntity {
    const existing = this.db
      .prepare<{
        id: string;
        agent_id: string;
        user_id: string;
        name: string;
        entity_type: string;
        page_id: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT * FROM wiki_entities
         WHERE agent_id = ? AND user_id = ? AND name = ? AND entity_type = ?`,
      )
      .get(params.agentId, params.userId, params.name, params.entityType);

    const now = new Date().toISOString();
    if (existing) {
      if (params.pageId && !existing.page_id) {
        this.db
          .prepare("UPDATE wiki_entities SET page_id = ?, updated_at = ? WHERE id = ?")
          .run(params.pageId, now, existing.id);
        return { ...existing, entity_type: existing.entity_type as WikiEntityType, page_id: params.pageId, updated_at: now };
      }
      return { ...existing, entity_type: existing.entity_type as WikiEntityType };
    }

    const id = generateWikiId();
    this.db
      .prepare(
        `INSERT INTO wiki_entities
         (id, agent_id, user_id, name, entity_type, page_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, params.agentId, params.userId, params.name, params.entityType, params.pageId ?? null, now, now);
    return {
      id,
      agent_id: params.agentId,
      user_id: params.userId,
      name: params.name,
      entity_type: params.entityType,
      page_id: params.pageId ?? null,
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
  }): WikiObservation {
    const id = generateWikiId();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO wiki_observations
         (id, agent_id, user_id, entity_id, content, source_page_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, params.agentId, params.userId, params.entityId, params.content, params.sourcePageId ?? null, now);
    return {
      id,
      agent_id: params.agentId,
      user_id: params.userId,
      entity_id: params.entityId,
      content: params.content,
      source_page_id: params.sourcePageId ?? null,
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
        .prepare("UPDATE wiki_relations SET strength = ?, updated_at = ?, source_page_id = COALESCE(?, source_page_id) WHERE id = ?")
        .run(next, now, params.sourcePageId ?? null, existing.id);
      return { ...existing, strength: next, updated_at: now };
    }

    const id = generateWikiId();
    this.db
      .prepare(
        `INSERT INTO wiki_relations
         (id, agent_id, user_id, source_entity_id, target_entity_id, relation_type, strength, source_page_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
}

/**
 * 从页面双链引导 ERO：页面标题作概念实体，出站已解析链接建 relates_to 边。
 * 不调用 LLM；用户可后续补充观察。
 */
export function bootstrapEroFromWikilinks(
  db: DatabaseAdapter,
  wikiRepo: WikiRepo,
  ero: WikiEroRepo,
  agentId: string,
  userId: string,
): { readonly entities: number; readonly relations: number } {
  return withTransaction(db, () => {
    const pages = wikiRepo.listPages(agentId, userId);
    let entities = 0;
    let relations = 0;
    const byPageId = new Map<string, ReturnType<WikiEroRepo["upsertEntity"]>>();

    for (const page of pages) {
      const entity = ero.upsertEntity({
        agentId,
        userId,
        name: page.title,
        entityType: page.category === "entities" ? "other" : "concept",
        pageId: page.id,
      });
      byPageId.set(page.id, entity);
      entities += 1;
    }

    for (const page of pages) {
      const source = byPageId.get(page.id);
      if (!source) continue;
      for (const link of wikiRepo.listOutboundLinks(agentId, userId, page.id)) {
        if (!link.is_resolved || !link.target_page_id) continue;
        const target = byPageId.get(link.target_page_id);
        if (!target) continue;
        ero.upsertRelation({
          agentId,
          userId,
          sourceEntityId: source.id,
          targetEntityId: target.id,
          relationType: "relates_to",
          strength: 0.4,
          sourcePageId: page.id,
        });
        relations += 1;
      }
    }

    return { entities, relations };
  });
}
