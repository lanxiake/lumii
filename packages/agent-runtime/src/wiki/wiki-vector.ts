/**
 * Wiki 向量检索通用工具：embedder 接口、哈希、余弦、RRF、buffer 编解码
 *
 * 页面向量索引（WikiVectorIndex）随 P3 历史页面全链路删除一并移除
 * （wiki_page_embeddings 表已在 V27 DROP）。本文件只保留资料层
 * wiki-source-vector.ts 复用的通用工具函数。
 *
 * 设计：`docs/plans/记忆重构/2026-08-26-wiki-p2-implementation.md` §9.1
 */

import { tokenizeBigram } from "../memory/segmentation.js";
import { wikiBigramJoin } from "./wiki-index.js";

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

/** 导出供索引重建提示：bigram 列仍由 WikiIndexRepo 维护 */
export { wikiBigramJoin };
