/**
 * 重新编目的共享类型与常量
 *
 * 单独成文件：WikiReclassifier 依赖 WikiRepo，而 WikiRepo 需要批次存储键，
 * 放在一起会形成循环 import。
 *
 * 设计：docs/design/记忆设计/2026-08-27-wiki-topic-hierarchy-redesign.md §9
 */

/** wiki_index_meta 中存放重编目批次的键前缀（实际键含 agentId/userId） */
export const RECLASSIFY_RUN_META_KEY = "reclassify_run";

export type WikiReclassifyStatus = "running" | "review" | "applying" | "failed" | "discarded";

export type WikiReclassifyScope =
  | { readonly kind: "source"; readonly sourceId: string }
  | { readonly kind: "subtopic"; readonly category: string; readonly subtopic: string }
  | { readonly kind: "all" };

export interface WikiReclassifyCandidate {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly fromCategory: string;
  readonly fromSubtopic: string;
  readonly toCategory: string;
  readonly toSubtopic: string;
  readonly reason: string;
  decision: "pending" | "applied" | "ignored";
  /** 接受失败（目标小类已被删）时的中文原因，条目留在 review */
  applyError?: string;
}

export interface WikiReclassifyRun {
  readonly runId: string;
  readonly status: WikiReclassifyStatus;
  readonly scope: WikiReclassifyScope;
  readonly total: number;
  readonly processed: number;
  readonly droppedInvalid: number;
  readonly unchanged: number;
  readonly candidates: readonly WikiReclassifyCandidate[];
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
