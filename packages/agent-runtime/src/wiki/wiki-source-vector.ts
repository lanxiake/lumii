/**
 * Wiki 资料层向量索引 —— 与 wiki_sources_fts 做 RRF，失败显式降级
 *
 * 与页面版 wiki-vector.ts 同构，但语料是 title + extracted_text，且没有页面的
 * 遗忘分，改用 use_count 做轻微加权。embedder 为 null 时整体禁用，检索返回空数组，
 * 由调用方写 degradeReason，禁止静默降级。
 *
 * 设计：docs/design/记忆设计/2026-08-27-wiki-topic-hierarchy-redesign.md §5.1
 */

import type { DatabaseAdapter } from "../storage/local-database.js";
import {
  bufferToFloat32,
  cosineSimilarity,
  float32ToBuffer,
  hashContent,
  reciprocalRankFusion,
  type WikiEmbedder,
} from "./wiki-vector.js";
import type { WikiSource } from "./types.js";

export class WikiSourceVectorIndex {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly embedder: WikiEmbedder | null,
  ) {}

  get enabled(): boolean {
    return this.embedder !== null;
  }

  /** 语料 = title + extracted_text；content_hash 未变且模型一致时跳过 */
  async upsertSource(
    source: Pick<WikiSource, "id" | "agent_id" | "user_id" | "title" | "extracted_text">,
  ): Promise<void> {
    if (!this.embedder) return;
    const corpus = `${source.title}\n\n${source.extracted_text ?? ""}`.trim();
    if (!corpus) return;
    const contentHash = hashContent(corpus);

    const existing = this.db
      .prepare<{ content_hash: string; model_id: string }>(
        "SELECT content_hash, model_id FROM wiki_source_embeddings WHERE source_id = ?",
      )
      .get(source.id);
    if (existing?.content_hash === contentHash && existing.model_id === this.embedder.modelId) {
      return;
    }

    const vec = await this.embedder.embed(corpus);
    this.db
      .prepare(
        `INSERT INTO wiki_source_embeddings
           (source_id, agent_id, user_id, model_id, dims, embedding, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           model_id = excluded.model_id,
           dims = excluded.dims,
           embedding = excluded.embedding,
           content_hash = excluded.content_hash,
           updated_at = excluded.updated_at`,
      )
      .run(
        source.id,
        source.agent_id,
        source.user_id,
        this.embedder.modelId,
        vec.length,
        float32ToBuffer(vec),
        contentHash,
        new Date().toISOString(),
      );
  }

  /** 全量重建，返回写入条数；关闭时返回 0 */
  async rebuild(
    sources: readonly Pick<WikiSource, "id" | "agent_id" | "user_id" | "title" | "extracted_text">[],
  ): Promise<number> {
    if (!this.embedder) return 0;
    this.db.prepare("DELETE FROM wiki_source_embeddings").run();
    let n = 0;
    for (const source of sources) {
      await this.upsertSource(source);
      n += 1;
    }
    return n;
  }

  /** 线性余弦检索；关闭或空查询返回空数组（调用方据此写降级原因） */
  async searchSimilar(
    agentId: string,
    userId: string,
    query: string,
    limit: number,
  ): Promise<readonly { sourceId: string; score: number }[]> {
    if (!this.embedder || !query.trim()) return [];
    const q = await this.embedder.embed(query);
    const rows = this.db
      .prepare<{ source_id: string; embedding: Buffer }>(
        `SELECT source_id, embedding FROM wiki_source_embeddings
         WHERE agent_id = ? AND user_id = ? AND model_id = ?`,
      )
      .all(agentId, userId, this.embedder.modelId);

    return rows
      .map((row) => ({
        sourceId: row.source_id,
        score: cosineSimilarity(q, bufferToFloat32(row.embedding)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

/**
 * 把 FTS id 与向量 id 做 RRF，再按资料自身 use_count 轻微加权（没有页面遗忘分可用）。
 */
export function mergeSourceHybridRanks(params: {
  readonly ftsIds: readonly string[];
  readonly vectorIds: readonly string[];
  readonly sourceById: ReadonlyMap<string, WikiSource>;
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
      const useCount = params.sourceById.get(id)?.use_count ?? 0;
      return { id, score: rrfScore + 0.01 * useCount };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.id);

  return { ids, mode };
}
