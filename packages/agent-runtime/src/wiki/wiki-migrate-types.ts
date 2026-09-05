/**
 * Wiki 库级迁移的共享类型与常量
 *
 * 单独成文件：WikiLibraryMigrate 依赖 WikiRepo，而 WikiRepo 需要批次存储键，
 * 放在一起会形成循环 import。
 *
 * 设计：docs/design/记忆设计/2026-09-05-wiki-library-migrate-design.md
 */

/** wiki_index_meta 中存放迁移批次的键前缀（实际键含 agentId/userId） */
export const MIGRATE_RUN_META_KEY = "wiki_migrate_run";

export type WikiMigratePhase =
  | "inventorying"
  | "planning"
  | "review"
  | "applying"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled"
  | "discarded"
  | "undone";

export interface WikiMigrateProgress {
  readonly runId: string;
  readonly phase: WikiMigratePhase;
  readonly phaseLabel: string;
  readonly done: number;
  readonly total: number;
  readonly currentItem: string | null;
  readonly message?: string;
  readonly appliedCount?: number;
  readonly cancelRequested?: boolean;
}

export interface MigrateFolderMapping {
  readonly folderRel: string;
  readonly category: string | null;
  readonly subtopic: string | null;
  readonly confidence: number;
  readonly reason: string;
  readonly proposedSubtopic?: string;
  readonly approvedProposedSubtopic?: boolean;
  readonly ignored?: boolean;
  readonly status: "ok" | "conflict" | "needContent";
  readonly exceptions?: readonly {
    readonly inboxId: string;
    readonly category: string | null;
    readonly subtopic: string | null;
    readonly reason: string;
  }[];
  readonly inboxIds: readonly string[];
}

export interface WikiMigrateRun {
  readonly id: string;
  readonly agentId: string;
  readonly userId: string;
  readonly importRoot: string;
  readonly phase: WikiMigratePhase;
  readonly inboxIds: readonly string[];
  readonly mappings: readonly MigrateFolderMapping[];
  readonly appliedSourceIds: readonly string[];
  readonly appliedInboxIds: readonly string[];
  readonly cancelRequested: boolean;
  readonly progress: WikiMigrateProgress;
  readonly error?: string;
  readonly createdAt: string;
  readonly finishedAt?: string;
}
