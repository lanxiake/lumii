/**
 * WikiGraphBuilder — 三期：基于主题树 + 资料 + 实体的分层混合图
 *
 * 节点：category/subtopic/source/entity；边：relation/belongs_to/sibling/mentioned_in。
 * 两层可选：structure（用途结构）+ entities（ERO 知识图谱）。历史页面双链图（page/wikilink）
 * 已随 P3 删除——「以某份资料为中心看关联」改用 category/subtopic 路径起步查询。
 * limit 只约束 source+entity 数量，category/subtopic 容器节点不计数。
 */

import type { WikiRepo } from "./wiki-repo.js";
import type { WikiCategory, WikiSource } from "./types.js";
import type { WikiEroRepo } from "./wiki-ero.js";

export type WikiGraphNodeKind = "entity" | "category" | "subtopic" | "source";
export type WikiGraphEdgeKind = "relation" | "belongs_to" | "sibling" | "mentioned_in";
export type WikiGraphLayer = "structure" | "entities";

export interface WikiGraphNode {
  readonly id: string;
  readonly kind: WikiGraphNodeKind;
  readonly title: string;
  readonly path?: string;
  readonly category?: string;
  readonly useCount?: number;
  readonly entityType?: string;
  readonly pageId?: string | null;
  readonly topicCategory?: string | null;
  readonly topicSubtopic?: string | null;
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
  readonly category?: WikiCategory | string;
  readonly subtopic?: string;
  /** 邻域半径（跳数），默认 1；当前未被结构/实体层使用，保留字段供未来扩展 */
  readonly radius?: number;
  /** 节点数上限，默认 50；只约束 source+entity */
  readonly limit?: number;
  /** 要构建的图层，默认 ['structure', 'entities'] */
  readonly layers?: readonly WikiGraphLayer[];
  /** 是否纳入 ERO 实体节点，默认 true（等价于 layers 含 'entities'，兼容旧调用） */
  readonly includeEntities?: boolean;
  readonly eroRepo?: WikiEroRepo;
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

const DEFAULT_LIMIT = 50;
/** sibling 边只在同小类资料数 ≤ 此值时生成，避免完全图边数爆炸 */
const SIBLING_MAX_SOURCES = 8;

/** 小类节点 ID：JSON 两列序列化，小类名含 `/` 也不歧义；与 topicCountKey 语义一致 */
export function subtopicNodeId(category: string, subtopic: string): string {
  return JSON.stringify([category, subtopic]);
}

/** 反解小类节点 ID；非法输入返回 null */
export function parseSubtopicNodeId(id: string): { category: string; subtopic: string } | null {
  try {
    const parsed: unknown = JSON.parse(id);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [category, subtopic] = parsed;
    if (typeof category !== "string" || typeof subtopic !== "string") return null;
    return { category, subtopic };
  } catch {
    return null;
  }
}

/** 将资料转为图谱 source 节点 */
function toSourceNode(source: WikiSource): WikiGraphNode {
  return {
    id: source.id,
    kind: "source",
    title: source.title,
    useCount: source.use_count,
    topicCategory: source.topic_category,
    topicSubtopic: source.topic_subtopic,
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

const DEFAULT_LAYERS: readonly WikiGraphLayer[] = ["structure", "entities"];

export class WikiGraphBuilder {
  constructor(private readonly repo: WikiRepo) {}

  /**
   * 构建受限子图：按 category（+可选 subtopic）取用途结构 + 实体层。
   */
  buildSubgraph(agentId: string, userId: string, options: WikiGraphBuildOptions = {}): WikiGraphData {
    const limit = options.limit ?? DEFAULT_LIMIT;

    if (!options.category) {
      throw new Error("图谱需要 category");
    }

    const layers = options.layers ?? (options.includeEntities === false ? ["structure"] : DEFAULT_LAYERS);
    return this.buildFromTopic(agentId, userId, options.category, options.subtopic, limit, layers, options);
  }

  // ── 三期：主题结构 + 实体层 ──────────────────────────────

  private buildFromTopic(
    agentId: string,
    userId: string,
    category: string,
    subtopic: string | undefined,
    limit: number,
    layers: readonly WikiGraphLayer[],
    options: WikiGraphBuildOptions,
  ): WikiGraphData {
    const nodes: WikiGraphNode[] = [];
    const edges: WikiGraphEdge[] = [];
    let truncated = false;

    const wantsStructure = layers.includes("structure");
    const wantsEntities = layers.includes("entities");

    if (wantsStructure || wantsEntities) {
      const sources = this.repo.listSourcesByTopic(agentId, userId, {
        category,
        subtopic,
      });

      const sourcesSorted = [...sources].sort((a, b) => {
        if (a.use_count !== b.use_count) return b.use_count - a.use_count;
        return (b.last_used ?? "").localeCompare(a.last_used ?? "");
      });

      const sourceLimitTruncated = sourcesSorted.length > limit;
      const keptSources = sourceLimitTruncated ? sourcesSorted.slice(0, limit) : sourcesSorted;
      const keptSourceIds = new Set(keptSources.map((s) => s.id));

      if (wantsStructure) {
        const structureResult = this.buildStructureLayer(category, keptSources);
        nodes.push(...structureResult.nodes);
        edges.push(...structureResult.edges);
      } else {
        nodes.push(...keptSources.map((s) => toSourceNode(s)));
      }

      if (wantsEntities) {
        const remainingSlots = Math.max(0, limit - keptSourceIds.size);
        const entityResult = this.buildEntityLayer(agentId, userId, keptSourceIds, remainingSlots, options);
        nodes.push(...entityResult.nodes);
        edges.push(...entityResult.edges);
        truncated = truncated || entityResult.truncated;
      }

      truncated = truncated || sourceLimitTruncated;
    }

    return { nodes, edges, truncated };
  }

  /** 结构层：category 节点 + subtopic 节点 + source 节点 + belongs_to/sibling 边 */
  private buildStructureLayer(
    category: string,
    sources: readonly WikiSource[],
  ): { readonly nodes: WikiGraphNode[]; readonly edges: WikiGraphEdge[] } {
    const nodes: WikiGraphNode[] = [];
    const edges: WikiGraphEdge[] = [];

    const categoryNode: WikiGraphNode = { id: category, kind: "category", title: category };
    nodes.push(categoryNode);

    const bySubtopic = new Map<string, WikiSource[]>();
    for (const s of sources) {
      if (!s.topic_subtopic) continue;
      const list = bySubtopic.get(s.topic_subtopic) ?? [];
      list.push(s);
      bySubtopic.set(s.topic_subtopic, list);
    }

    for (const [subtopic, subSources] of bySubtopic) {
      const subNodeId = subtopicNodeId(category, subtopic);
      nodes.push({ id: subNodeId, kind: "subtopic", title: subtopic, category });
      edges.push({
        id: `belongs_to:${subNodeId}->${category}`,
        kind: "belongs_to",
        source: subNodeId,
        target: category,
        label: "belongs_to",
      });

      for (const s of subSources) {
        nodes.push(toSourceNode(s));
        edges.push({
          id: `belongs_to:${s.id}->${subNodeId}`,
          kind: "belongs_to",
          source: s.id,
          target: subNodeId,
          label: "belongs_to",
        });
      }

      if (subSources.length > 1 && subSources.length <= SIBLING_MAX_SOURCES) {
        for (let i = 0; i < subSources.length; i += 1) {
          for (let j = i + 1; j < subSources.length; j += 1) {
            const a = subSources[i]!;
            const b = subSources[j]!;
            edges.push({
              id: `sibling:${a.id}<->${b.id}`,
              kind: "sibling",
              source: a.id,
              target: b.id,
              label: "sibling",
            });
          }
        }
      }
    }

    return { nodes, edges };
  }

  /** 实体层：entity 节点（限量）+ relation 边 + mentioned_in 边 */
  private buildEntityLayer(
    agentId: string,
    userId: string,
    sourceIds: ReadonlySet<string>,
    limit: number,
    options: WikiGraphBuildOptions,
  ): { readonly nodes: WikiGraphNode[]; readonly edges: WikiGraphEdge[]; readonly truncated: boolean } {
    const ero = options.eroRepo;
    if (!ero || sourceIds.size === 0) return { nodes: [], edges: [], truncated: false };

    const pairs = ero.listEntitiesBySources(agentId, userId, [...sourceIds]);
    if (pairs.length === 0) return { nodes: [], edges: [], truncated: false };

    const entityIds = [...new Set(pairs.map((p) => p.entityId))];
    const allEntities = ero.listEntities(agentId, userId);
    const entityById = new Map(allEntities.map((e) => [e.id, e]));

    const truncated = entityIds.length > limit;
    const keptEntityIds = new Set(truncated ? entityIds.slice(0, limit) : entityIds);

    const nodes: WikiGraphNode[] = [];
    for (const id of keptEntityIds) {
      const e = entityById.get(id);
      if (!e) continue;
      nodes.push(toEntityNode(e));
    }

    const edges: WikiGraphEdge[] = [];
    for (const { entityId, sourceId } of pairs) {
      if (!keptEntityIds.has(entityId)) continue;
      edges.push({
        id: `mentioned_in:${entityId}->${sourceId}`,
        kind: "mentioned_in",
        source: `entity:${entityId}`,
        target: sourceId,
        label: "mentioned_in",
      });
    }

    const relations = ero.listRelations(agentId, userId);
    for (const rel of relations) {
      if (!keptEntityIds.has(rel.source_entity_id) || !keptEntityIds.has(rel.target_entity_id)) continue;
      edges.push({
        id: `relation:${rel.id}`,
        kind: "relation",
        source: `entity:${rel.source_entity_id}`,
        target: `entity:${rel.target_entity_id}`,
        label: rel.relation_type,
        strength: rel.strength,
        anchorText: rel.relation_type,
      });
    }

    return { nodes, edges, truncated };
  }
}

