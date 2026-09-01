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
  | { readonly kind: "subtopic"; readonly category: string; readonly subtopic: string | null }
  | { readonly kind: "all" };

export interface WikiReclassifyCandidate {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  /** null = 收件箱（v1.1 scope=all 纳入收件箱后，来源可能本就未分类） */
  readonly fromCategory: string | null;
  /** null = 未细分（大类下没有小类，或来源本就是收件箱） */
  readonly fromSubtopic: string | null;
  readonly toCategory: string;
  /** null = 只定大类，不细分 */
  readonly toSubtopic: string | null;
  readonly reason: string;
  /** 结构轮（不带正文）还是内容轮（补了摘要）判定的（P5 §5.1-§5.2） */
  readonly decidedBy: "structure" | "content";
  /** AI 改名提案；P6 落地，本期只占位透传 */
  readonly renameTitle?: string;
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
  /** 断点续跑游标：run 中途失败时记录当前进行到哪一轮哪一批，续跑时跳过已完成的批次 */
  readonly resumeCursor?: { readonly pass: "structure" | "content"; readonly batchIndex: number };
}
