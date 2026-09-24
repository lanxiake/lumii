/**
 * Wiki 向量检索通用工具：embedder 接口、哈希、余弦、RRF、buffer 编解码
 *
 * 页面向量索引（WikiVectorIndex）随 P3 历史页面全链路删除一并移除
 * （wiki_page_embeddings 表已在 V27 DROP）。本文件只保留资料层
 * wiki-source-vector.ts 复用的通用工具函数。
 *
 * 设计：`docs/plans/Wiki知识库/基础与设置/2026-08-26-Wiki知识库P2实施计划.md` §9.1
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

/** 凸组合里稀疏路（BM25）的权重。实测最优区间 0.6~0.7，取 0.6。 */
const CONVEX_ALPHA_SPARSE = 0.6;

/**
 * 凸组合分数融合：`α·norm(稀疏) + (1−α)·norm(稠密)`。
 *
 * ## 为什么不用 RRF（本函数取代 `reciprocalRankFusion` 的检索用途）
 *
 * Bruch et al. *An Analysis of Fusion Functions for Hybrid Retrieval*
 * （arXiv:2210.11934，TOIS 2023）证明凸组合显著优于 RRF，且 RRF 的参数
 * 敏感性其实很高、跨域不迁移。本仓库的实测与此一致（n=53，判据=drawer_id）：
 *
 * | 融合方式 | nDCG@10 | R@1 |
 * |---|---|---|
 * | convex α=0.6（本函数） | **0.906** | **45/53** |
 * | rrf k=60（原实现） | 0.794 | 34/53 |
 * | 纯 FTS（无融合） | 0.844 | 41/53 |
 *
 * 即原 RRF 实现**比不融合还差 5.9%**。机制：RRF 奖励「两路都中上」而惩罚
 * 「一路独占第一」，当一路在目标上系统性失明时它就是纯拖累——RRF 给
 * FTS #1 的 1/(60+1)=0.0164，却给「FTS #30 + 向量 #1」1/90+1/61=0.0275。
 * 详见 `docs/test/memory-eval/2026-09-19-混合检索评测方法论复盘与优化.md`。
 *
 * ## 为什么用 min-max 而不是 TM2（理论界）
 *
 * 论文推荐 TM2（用理论界而非 batch 内实际 min/max），因为它能保证失明那一路
 * 不扭曲强路的排序。但本仓库实测**TM2 反而更差**（0.896 vs 0.906）——
 * 原因是 e5 在本语料上的余弦只落在 **0.862~0.931**，用理论界 [-1,1] 归一化后
 * 只用到 3% 量程，所有向量分被压成 ~0.93 的窄带、区分度归零。
 *
 * **结论**：TM2 的前提是「分数分布跨查询可比**且铺满理论量程**」，稠密检索在
 * 同构语料上不满足后半句。故这里用 per-query min-max。
 */
export function convexScoreFusion(
  sparse: readonly { readonly id: string; readonly score: number }[],
  dense: readonly { readonly id: string; readonly score: number }[],
  alpha = CONVEX_ALPHA_SPARSE,
): Map<string, number> {
  const scores = new Map<string, number>();
  if (sparse.length === 0 && dense.length === 0) return scores;

  // min-max 到 [0,1]。**span 为 0 时全体记 0.5**（而不是 1 或 0）——
  // 全等分意味着这一路没有信息，给中间值既不打压也不抬举，与「缺席记 0」区分开。
  const norm = (
    rows: readonly { readonly id: string; readonly score: number }[],
    invert: boolean,
  ): Map<string, number> => {
    const out = new Map<string, number>();
    if (rows.length === 0) return out;
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of rows) {
      if (r.score < lo) lo = r.score;
      if (r.score > hi) hi = r.score;
    }
    const span = hi - lo;
    for (const r of rows) {
      if (span === 0) {
        out.set(r.id, 0.5);
        continue;
      }
      const t = (r.score - lo) / span;
      out.set(r.id, invert ? 1 - t : t);
    }
    return out;
  };

  // BM25 越小越相关，故翻转；余弦越大越相关，不翻转。
  const s = norm(sparse, true);
  const d = norm(dense, false);

  // 两路都不在的 id 不产生条目；只在一路的按 0 参与另一路（等价于「缺席」）
  for (const [id, v] of s) scores.set(id, alpha * v);
  for (const [id, v] of d) scores.set(id, (scores.get(id) ?? 0) + (1 - alpha) * v);
  return scores;
}

/** 导出供索引重建提示：bigram 列仍由 WikiIndexRepo 维护 */
