/**
 * WikiGraphBuilder — 基于 wiki_links 与 ERO 的受限混合子图构建（知识图谱数据层）
 *
 * 节点 = 页面 + 实体；边 = 已解析双链（wikilink）+ ERO 关系（relation）。
 * 默认半径 1、节点上限 50，优先保留全部页面节点，剩余名额填充实体节点。
 */

import type { WikiRepo } from "./wiki-repo.js";
import type { WikiCategory, WikiPage } from "./types.js";

export type WikiGraphNodeKind = "page" | "entity";
export type WikiGraphEdgeKind = "wikilink" | "relation";

export interface WikiGraphNode {
  readonly id: string;
  readonly kind: WikiGraphNodeKind;
  readonly title: string;
  readonly path?: string;
  readonly category?: string;
  readonly useCount?: number;
  readonly entityType?: string;
  readonly pageId?: string | null;
}

export interface WikiGraphEdge {
  readonly id: string;
  readonly kind: WikiGraphEdgeKind;
  readonly source: string;
  readonly target: string;
  readonly label: string;
  readonly strength?: number;
  /** @deprecated 兼容：等于 label */
  readonly anchorText?: string;
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
  /** 是否纳入 ERO 实体节点，默认 true */
  readonly includeEntities?: boolean;
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
    readonly entity_type?: string;
  }[];
}

const DEFAULT_RADIUS = 1;
const DEFAULT_LIMIT = 50;

/** 将 Wiki 页面转为图谱 page 节点 */
function toPageNode(page: WikiPage): WikiGraphNode {
  return {
    id: page.id,
    kind: "page",
    title: page.title,
    path: page.path,
    category: page.category,
    useCount: page.use_count,
  };
}

/** 将 ERO 实体转为图谱 entity 节点 */
function toEntityNode(e: {
  readonly id: string;
  readonly name: string;
  readonly entity_type?: string;
  readonly page_id: string | null;
}): WikiGraphNode {
  return {
    id: `entity:${e.id}`,
    kind: "entity",
    title: e.name,
    entityType: e.entity_type ?? "concept",
    pageId: e.page_id,
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

  /**
   * 汇总页面节点、双链边与可选 ERO 实体/关系边。
   * 页面先占满 limit 截断逻辑；实体用剩余名额；关系边仅连 entity 节点。
   */
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
    const pageNodes = [...keptIds].map((id) => toPageNode(nodeMap.get(id)!));

    const edges: WikiGraphEdge[] = [];
    for (const id of keptIds) {
      for (const link of this.repo.listOutboundLinks(agentId, userId, id)) {
        if (!link.is_resolved || !link.target_page_id) continue;
        if (!keptIds.has(link.target_page_id)) continue;
        const label = link.anchor_text;
        edges.push({
          id: link.id,
          kind: "wikilink",
          source: link.source_page_id,
          target: link.target_page_id,
          label,
          anchorText: label,
        });
      }
    }

    const includeEntities = options.includeEntities !== false;
    let entityNodes: WikiGraphNode[] = [];

    if (includeEntities && options.eroEntities) {
      const entityPageMap = new Map<string, string>();
      for (const e of options.eroEntities) {
        if (e.page_id) entityPageMap.set(e.id, e.page_id);
      }

      const relevantEntityIds = new Set<string>();
      for (const e of options.eroEntities) {
        if (e.page_id && keptIds.has(e.page_id)) {
          relevantEntityIds.add(e.id);
        }
      }
      if (options.eroRelations) {
        for (const rel of options.eroRelations) {
          const srcPage = entityPageMap.get(rel.source_entity_id);
          const tgtPage = entityPageMap.get(rel.target_entity_id);
          const srcLinked = srcPage !== undefined && keptIds.has(srcPage);
          const tgtLinked = tgtPage !== undefined && keptIds.has(tgtPage);
          if (srcLinked || tgtLinked) {
            relevantEntityIds.add(rel.source_entity_id);
            relevantEntityIds.add(rel.target_entity_id);
          }
        }
      }

      const remainingSlots = Math.max(0, limit - pageNodes.length);
      const keptEntities = options.eroEntities
        .filter((e) => relevantEntityIds.has(e.id))
        .slice(0, remainingSlots);
      const keptEntityIds = new Set(keptEntities.map((e) => e.id));
      entityNodes = keptEntities.map((e) => toEntityNode(e));

      if (options.eroRelations) {
        for (const rel of options.eroRelations) {
          if (!keptEntityIds.has(rel.source_entity_id) || !keptEntityIds.has(rel.target_entity_id)) {
            continue;
          }
          edges.push({
            id: `ero:${rel.id}`,
            kind: "relation",
            source: `entity:${rel.source_entity_id}`,
            target: `entity:${rel.target_entity_id}`,
            label: rel.relation_type,
            strength: rel.strength,
            anchorText: rel.relation_type,
          });
        }
      }
    }

    const nodes = [...pageNodes, ...entityNodes];
    return { nodes, edges, truncated };
  }
}
