/**
 * WikiGraphBuilder — 基于 wiki_links 的受限子图构建（P2 图谱数据层）
 *
 * 设计：`docs/plans/记忆重构/2026-08-26-wiki-p2-implementation.md` Task 3
 * 节点 = 页面，边 = 已解析有向链接；未解析链接不画边。
 * 默认半径 1、节点上限 50，避免全库大图。
 */

import type { WikiRepo } from "./wiki-repo.js";
import type { WikiCategory, WikiPage } from "./types.js";

export interface WikiGraphNode {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly category: string;
  readonly useCount: number;
}

export interface WikiGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly anchorText: string;
}

export interface WikiGraphData {
  readonly nodes: readonly WikiGraphNode[];
  readonly edges: readonly WikiGraphEdge[];
  /** 因节点上限被截断时为 true */
  readonly truncated: boolean;
}

export interface WikiGraphBuildOptions {
  readonly centerPageId?: string;
  readonly category?: WikiCategory;
  /** 邻域半径（跳数），默认 1 */
  readonly radius?: number;
  /** 节点数上限，默认 50 */
  readonly limit?: number;
  /** 可选：叠加 ERO 关系边（将实体 page_id 映射为图节点） */
  readonly eroRelations?: readonly {
    readonly id: string;
    readonly source_entity_id: string;
    readonly target_entity_id: string;
    readonly relation_type: string;
    readonly strength: number;
  }[];
  readonly eroEntities?: readonly {
    readonly id: string;
    readonly page_id: string | null;
    readonly name: string;
  }[];
}

const DEFAULT_RADIUS = 1;
const DEFAULT_LIMIT = 50;

function toNode(page: WikiPage): WikiGraphNode {
  return {
    id: page.id,
    title: page.title,
    path: page.path,
    category: page.category,
    useCount: page.use_count,
  };
}

export class WikiGraphBuilder {
  constructor(private readonly repo: WikiRepo) {}

  /**
   * 构建受限子图：以中心页 ±radius 跳邻居，或按分类局部图。
   * 必须提供 centerPageId 或 category 之一。
   */
  buildSubgraph(agentId: string, userId: string, options: WikiGraphBuildOptions = {}): WikiGraphData {
    const radius = options.radius ?? DEFAULT_RADIUS;
    const limit = options.limit ?? DEFAULT_LIMIT;

    if (!options.centerPageId && !options.category) {
      throw new Error("图谱需要 centerPageId 或 category");
    }

    if (options.centerPageId) {
      return this.buildFromCenter(agentId, userId, options.centerPageId, radius, limit, options);
    }
    return this.buildFromCategory(agentId, userId, options.category!, limit, options);
  }

  private buildFromCenter(
    agentId: string,
    userId: string,
    centerPageId: string,
    radius: number,
    limit: number,
    options: WikiGraphBuildOptions,
  ): WikiGraphData {
    const center = this.repo.findPageById(centerPageId);
    if (!center || center.agent_id !== agentId || center.user_id !== userId) {
      throw new Error(`中心页不存在: ${centerPageId}`);
    }

    const nodeMap = new Map<string, WikiPage>();
    nodeMap.set(center.id, center);
    let frontier = [center.id];

    for (let hop = 0; hop < radius; hop += 1) {
      const next: string[] = [];
      for (const pageId of frontier) {
        const outbound = this.repo.listOutboundLinks(agentId, userId, pageId);
        for (const link of outbound) {
          if (!link.is_resolved || !link.target_page_id) continue;
          if (nodeMap.has(link.target_page_id)) continue;
          const target = this.repo.findPageById(link.target_page_id);
          if (!target) continue;
          nodeMap.set(target.id, target);
          next.push(target.id);
        }
        const backlinks = this.repo.listBacklinks(agentId, userId, pageId);
        for (const bl of backlinks) {
          if (!bl.isResolved) continue;
          if (nodeMap.has(bl.sourcePageId)) continue;
          const src = this.repo.findPageById(bl.sourcePageId);
          if (!src) continue;
          nodeMap.set(src.id, src);
          next.push(src.id);
        }
      }
      frontier = next;
    }

    return this.finalize(agentId, userId, nodeMap, limit, options);
  }

  private buildFromCategory(
    agentId: string,
    userId: string,
    category: WikiCategory,
    limit: number,
    options: WikiGraphBuildOptions,
  ): WikiGraphData {
    const pages = this.repo.listPages(agentId, userId, category);
    const nodeMap = new Map<string, WikiPage>();
    for (const p of pages) nodeMap.set(p.id, p);
    return this.finalize(agentId, userId, nodeMap, limit, options);
  }

  private finalize(
    agentId: string,
    userId: string,
    nodeMap: Map<string, WikiPage>,
    limit: number,
    options: WikiGraphBuildOptions,
  ): WikiGraphData {
    const allIds = [...nodeMap.keys()];
    const truncated = allIds.length > limit;
    const keptIds = new Set(truncated ? allIds.slice(0, limit) : allIds);
    const nodes = [...keptIds].map((id) => toNode(nodeMap.get(id)!));

    const edges: WikiGraphEdge[] = [];
    for (const id of keptIds) {
      for (const link of this.repo.listOutboundLinks(agentId, userId, id)) {
        if (!link.is_resolved || !link.target_page_id) continue;
        if (!keptIds.has(link.target_page_id)) continue;
        edges.push({
          id: link.id,
          source: link.source_page_id,
          target: link.target_page_id,
          anchorText: link.anchor_text,
        });
      }
    }

    if (options.eroEntities && options.eroRelations) {
      const entityToPage = new Map<string, string>();
      for (const e of options.eroEntities) {
        if (e.page_id) entityToPage.set(e.id, e.page_id);
      }
      for (const rel of options.eroRelations) {
        const src = entityToPage.get(rel.source_entity_id);
        const tgt = entityToPage.get(rel.target_entity_id);
        if (!src || !tgt) continue;
        if (!keptIds.has(src) || !keptIds.has(tgt)) continue;
        edges.push({
          id: `ero:${rel.id}`,
          source: src,
          target: tgt,
          anchorText: rel.relation_type,
        });
      }
    }

    return { nodes, edges, truncated };
  }
}
