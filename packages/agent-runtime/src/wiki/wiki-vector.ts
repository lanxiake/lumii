/**
 * Wiki 向量检索：可注入 embedder + 线性余弦 + RRF 与 FTS 融合
 *
 * 设计：`docs/plans/记忆重构/2026-08-26-wiki-p2-implementation.md` §9.1
 * 默认可关闭；失败时降级全文检索并返回 degradeReason（无静默降级）。
 * 默认 embedder 为确定性 bigram 哈希向量（零模型依赖，供测试与离线）；
 * 宿主可注入 transformers.js / ONNX 等真实嵌入。
 */

import type { DatabaseAdapter } from "../storage/local-database.js";
import { tokenizeBigram } from "../memory/segmentation.js";
import { wikiBigramJoin } from "./wiki-index.js";
import type { WikiPage } from "./types.js";
import { computeForgettingScore } from "./wiki-forgetting.js";

export const DEFAULT_EMBED_MODEL_ID = "lumii-bigram-hash-v1";
export const DEFAULT_EMBED_DIMS = 256;
export const RRF_K = 60;

export interface WikiEmbedder {
  readonly modelId: string;
  readonly dims: number;
  embed(text: string): Promise<Float32Array>;
}

/** 简单内容哈希，用于判断是否需要重算向量 */
export function hashContent(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/**
 * 确定性 bigram 哈希嵌入：将 token 映射到 dims 维并 L2 归一化。
 * 不依赖外部模型，召回弱于真模型，但可验证管线与 RRF。
 */
export function createBigramHashEmbedder(dims = DEFAULT_EMBED_DIMS): WikiEmbedder {
  return {
    modelId: DEFAULT_EMBED_MODEL_ID,
    dims,
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(dims);
      const tokens = [...tokenizeBigram(text)];
      if (tokens.length === 0) return vec;
      for (const token of tokens) {
        let h = 2166136261;
        for (let i = 0; i < token.length; i += 1) {
          h ^= token.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        const idx = (h >>> 0) % dims;
        const sign = (h & 1) === 0 ? 1 : -1;
        vec[idx]! += sign;
      }
      let norm = 0;
      for (let i = 0; i < dims; i += 1) norm += vec[i]! * vec[i]!;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < dims; i += 1) vec[i]! /= norm;
      return vec;
    },
  };
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function float32ToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function bufferToFloat32(buf: Buffer | Uint8Array): Float32Array {
  const copy = buf instanceof Buffer ? buf : Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

/** RRF：score = Σ 1/(k + rank)，rank 从 1 起 */
export function reciprocalRankFusion(
  rankedLists: readonly (readonly string[])[],
  k = RRF_K,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    list.forEach((id, index) => {
      const add = 1 / (k + index + 1);
      scores.set(id, (scores.get(id) ?? 0) + add);
    });
  }
  return scores;
}

export interface WikiHybridSearchHit {
  readonly page: WikiPage;
  readonly snippet: string;
  readonly score: number;
  readonly mode: "fts" | "vector" | "hybrid";
}

export interface WikiHybridSearchResult {
  readonly hits: readonly WikiHybridSearchHit[];
  /** 向量关闭或失败时的显式原因；null 表示向量参与成功 */
  readonly degradeReason: string | null;
}

export class WikiVectorIndex {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly embedder: WikiEmbedder | null,
  ) {}

  get enabled(): boolean {
    return this.embedder !== null;
  }

  /** 为单页写入/更新向量；无 embedder 时空操作 */
  async upsertPage(page: {
    readonly id: string;
    readonly agent_id: string;
    readonly user_id: string;
    readonly title: string;
    readonly content_md: string;
  }): Promise<void> {
    if (!this.embedder) return;
    const text = `${page.title}\n${page.content_md}`;
    const contentHash = hashContent(text);
    const existing = this.db
      .prepare<{ content_hash: string; model_id: string }>(
        "SELECT content_hash, model_id FROM wiki_page_embeddings WHERE page_id = ?",
      )
      .get(page.id);
    if (
      existing &&
      existing.content_hash === contentHash &&
      existing.model_id === this.embedder.modelId
    ) {
      return;
    }
    const vec = await this.embedder.embed(text);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO wiki_page_embeddings
         (page_id, agent_id, user_id, model_id, dims, embedding, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(page_id) DO UPDATE SET
           model_id = excluded.model_id,
           dims = excluded.dims,
           embedding = excluded.embedding,
           content_hash = excluded.content_hash,
           updated_at = excluded.updated_at`,
      )
      .run(
        page.id,
        page.agent_id,
        page.user_id,
        this.embedder.modelId,
        this.embedder.dims,
        float32ToBuffer(vec),
        contentHash,
        now,
      );
  }

  /** 全量重建向量派生表，返回写入条数 */
  async rebuild(pages: readonly {
    readonly id: string;
    readonly agent_id: string;
    readonly user_id: string;
    readonly title: string;
    readonly content_md: string;
  }[]): Promise<number> {
    if (!this.embedder) return 0;
    this.db.prepare("DELETE FROM wiki_page_embeddings").run();
    let n = 0;
    for (const page of pages) {
      await this.upsertPage(page);
      n += 1;
    }
    return n;
  }

  /**
   * 线性余弦检索（小库路径）。返回按相似度降序的 pageId。
   */
  async searchSimilar(
    agentId: string,
    userId: string,
    query: string,
    limit: number,
  ): Promise<readonly { pageId: string; score: number }[]> {
    if (!this.embedder) return [];
    const q = await this.embedder.embed(query);
    const rows = this.db
      .prepare<{ page_id: string; embedding: Buffer; dims: number; model_id: string }>(
        `SELECT page_id, embedding, dims, model_id FROM wiki_page_embeddings
         WHERE agent_id = ? AND user_id = ? AND model_id = ?`,
      )
      .all(agentId, userId, this.embedder.modelId);

    const scored = rows.map((row) => ({
      pageId: row.page_id,
      score: cosineSimilarity(q, bufferToFloat32(row.embedding)),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}

/**
 * 将 FTS 命中 id 列表与向量命中 id 列表做 RRF，再按遗忘分数微调排序键。
 */
export function mergeHybridRanks(params: {
  readonly ftsIds: readonly string[];
  readonly vectorIds: readonly string[];
  readonly pageById: ReadonlyMap<string, WikiPage>;
  readonly forgettingBoost?: boolean;
}): { readonly ids: string[]; readonly mode: "fts" | "vector" | "hybrid" } {
  const lists: string[][] = [];
  if (params.ftsIds.length > 0) lists.push([...params.ftsIds]);
  if (params.vectorIds.length > 0) lists.push([...params.vectorIds]);
  if (lists.length === 0) return { ids: [], mode: "fts" };

  const rrf = reciprocalRankFusion(lists);
  let mode: "fts" | "vector" | "hybrid" = "hybrid";
  if (params.vectorIds.length === 0) mode = "fts";
  else if (params.ftsIds.length === 0) mode = "vector";

  const ids = [...rrf.entries()]
    .map(([id, rrfScore]) => {
      const page = params.pageById.get(id);
      const forget = page && params.forgettingBoost !== false
        ? computeForgettingScore({
            lastUsedAt: page.last_used,
            createdAt: page.created_at,
            useCount: page.use_count,
          })
        : 0;
      return { id, score: rrfScore + 0.05 * forget };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.id);

  return { ids, mode };
}

/** 导出供索引重建提示：bigram 列仍由 WikiIndexRepo 维护 */
export { wikiBigramJoin };
