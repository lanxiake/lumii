/**
 * PalaceVectorIndex — 宫殿抽屉的向量索引（语义改写检索立项 T3）
 *
 * 与 `wiki-source-vector.ts` 的 `WikiSourceVectorIndex` **同构**：同一个
 * `WikiEmbedder` 接口、同一套 `float32ToBuffer` / `cosineSimilarity` /
 * `hashContent`、同样的「embedder 为 null 即整体禁用，禁止静默降级」纪律。
 * 刻意的重复而非抽公共基类——两者的**语料口径不同**（见下），将来可能各自演化。
 *
 * ## 语料口径必须与离线跑分一致
 *
 * 用 `content.slice(0, 300)`，**与 `scripts/semantic-eval.mjs` 跑的完全一样**。
 * T1 的结论（语义类 5/10 → 8/10、精确类零损失）是在这个口径下算出来的；
 * 换一个口径，那个结论就不再适用，等于没有依据。
 *
 * 为什么不是 wiki 的 `buildVectorCorpus`（title + summary + 主题路径）：
 * 宫殿表**没有 title/summary 字段**，只有 `content`（段原文或每轮回复的原文）。
 * 而 T1 实验里对宫殿同类语料用的就是截断原文——两侧若不一致，
 * 就会变成「用 A 口径证明有效、用 B 口径上线」。
 *
 * ## 一个如实记录的口径缺憾
 *
 * 宫殿段均值 1673 字、最长 94479，`slice(0, 300)` 只覆盖开头。开头常是
 * 「收到，先看一下…」这类对话语气词，信息密度低于 wiki 的 title+summary。
 * T1 跑分是在同样口径下做的，所以结论对当前语料有效；但若将来上游能提供
 * 段摘要（`memory_segments` 有总结），换成 `summary` 会明显更好——
 * **那需要重跑 T1**，不能凭直觉换。
 *
 * 已知槽点（命中后需人工看）：探测脚本产物（`NO_REPLY`、`PROBE-OK-*`、
 * `ENOENT: no such file...`）也进了索引。它们本身无语义价值，但数量少
 * （实测个位数），暂不做过滤——过滤规则要单独论证，不值得为几条噪声引入。
 *
 * 设计依据：`docs/plans/记忆系统/2026-09-18-语义改写检索开发计划.md` §5.1/§5.3
 */

import type { DatabaseAdapter } from "../storage/local-database.js";
import {
  bufferToFloat32,
  cosineSimilarity,
  float32ToBuffer,
  hashContent,
  type WikiEmbedder,
} from "../wiki/wiki-vector.js";

/**
 * 向量语料上限，**必须与 `scripts/semantic-eval.mjs` 一致**。
 *
 * 这个数字不是"看着合适"选的：T1 的全部结论都在它之下得出。改它＝换口径＝
 * 需要重跑 T1，不能顺手调。
 */
export const PALACE_VECTOR_CORPUS_MAX_CHARS = 300;

/** 向量语料：与跑分台同一行代码 */
export function buildPalaceVectorCorpus(content: string): string {
  return content.slice(0, PALACE_VECTOR_CORPUS_MAX_CHARS).trim();
}

export interface PalaceVectorHit {
  readonly drawerId: string;
  readonly score: number;
}

export class PalaceVectorIndex {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly embedder: WikiEmbedder | null,
  ) {}

  get enabled(): boolean {
    return this.embedder !== null;
  }

  /**
   * 写入/覆盖一条抽屉的向量。
   *
   * 语料没变且模型一致时跳过——与 wiki 侧同一优化，避免每次归档都重算
   * （嵌入是 30ms/条 量级的开销）。
   */
  async upsertDrawer(drawer: {
    readonly drawerId: string;
    readonly agentId: string;
    readonly userId: string;
    readonly content: string;
  }): Promise<void> {
    if (!this.embedder) return;
    const corpus = buildPalaceVectorCorpus(drawer.content);
    if (!corpus) return;
    const contentHash = hashContent(corpus);

    const existing = this.db
      .prepare<{ content_hash: string; model_id: string }>(
        "SELECT content_hash, model_id FROM palace_drawer_embeddings WHERE drawer_id = ?",
      )
      .get(drawer.drawerId);
    if (existing?.content_hash === contentHash && existing.model_id === this.embedder.modelId) {
      return;
    }

    const vec = await this.embedder.embed(corpus);
    this.db
      .prepare(
        `INSERT INTO palace_drawer_embeddings
           (drawer_id, agent_id, user_id, model_id, dims, embedding, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(drawer_id) DO UPDATE SET
           agent_id = excluded.agent_id,
           user_id = excluded.user_id,
           model_id = excluded.model_id,
           dims = excluded.dims,
           embedding = excluded.embedding,
           content_hash = excluded.content_hash,
           updated_at = excluded.updated_at`,
      )
      .run(
        drawer.drawerId,
        drawer.agentId,
        drawer.userId,
        this.embedder.modelId,
        vec.length,
        float32ToBuffer(vec),
        contentHash,
        new Date().toISOString(),
      );
  }

  /**
   * 线性余弦检索（作用域内全量扫描）。
   *
   * 993 条实测 <10ms，**不做 ANN**（约束 §7.3）。关闭或空查询返回空数组，
   * 由调用方写降级原因——不在这里静默退回别的东西。
   */
  async searchSimilar(params: {
    readonly query: string;
    readonly userId: string;
    readonly agentId?: string;
    readonly limit: number;
  }): Promise<readonly PalaceVectorHit[]> {
    if (!this.embedder || !params.query.trim()) return [];

    const scope = params.agentId ? "AND e.agent_id = ?" : "";
    const args: unknown[] = params.agentId
      ? [params.userId, this.embedder.modelId, params.agentId]
      : [params.userId, this.embedder.modelId];

    // 已写墓碑的抽屉不进向量检索——与 FTS 侧同一条纪律（deleted_at 的读侧过滤）
    const rows = this.db
      .prepare<{ drawer_id: string; embedding: Buffer }>(
        `SELECT e.drawer_id, e.embedding
           FROM palace_drawer_embeddings e
           JOIN palace_drawers d ON d.drawer_id = e.drawer_id
          WHERE e.user_id = ? AND e.model_id = ? AND d.deleted_at IS NULL ${scope}`,
      )
      .all(...args);

    const q = await this.embedder.embed(params.query);
    return rows
      .map((row) => ({
        drawerId: row.drawer_id,
        score: cosineSimilarity(q, bufferToFloat32(row.embedding)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, params.limit));
  }

  /**
   * 统计索引进度，供启动体检与后台补齐判断。
   *
   * `pending` = 活跃抽屉里还没有向量的条数。首次启用时它是全量（993 条），
   * 补齐需 ~32 秒，**必须后台跑**，不能阻塞启动。
   */
  stats(userId: string): { indexed: number; pending: number } {
    if (!this.embedder) return { indexed: 0, pending: 0 };
    const indexed =
      this.db
        .prepare<{ c: number }>(
          `SELECT COUNT(*) AS c FROM palace_drawer_embeddings e
             JOIN palace_drawers d ON d.drawer_id = e.drawer_id
            WHERE e.user_id = ? AND e.model_id = ? AND d.deleted_at IS NULL`,
        )
        .get(userId, this.embedder.modelId)?.c ?? 0;
    const active =
      this.db
        .prepare<{ c: number }>(
          "SELECT COUNT(*) AS c FROM palace_drawers WHERE user_id = ? AND deleted_at IS NULL",
        )
        .get(userId)?.c ?? 0;
    return { indexed, pending: Math.max(0, active - indexed) };
  }

  /** 清空索引（换模型或重建时用）；关闭时为 no-op */
  clear(): void {
    if (!this.embedder) return;
    this.db.prepare("DELETE FROM palace_drawer_embeddings").run();
  }
}
