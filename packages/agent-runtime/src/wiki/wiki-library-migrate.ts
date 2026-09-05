/**
 * WikiLibraryMigrate — 库级迁移状态机（plan / cancel / discard / replan）
 *
 * 盘点零 LLM；规划以文件夹簇为单元分批调 LLM；默认停在 review，apply 在 Task 5。
 * 与 WikiReclassifier 互斥：reclassify running 时拒绝启动 migrate。
 *
 * 设计：docs/design/记忆设计/2026-09-05-wiki-library-migrate-design.md
 */

import { generateWikiId } from "./types.js";
import type { WikiInboxItem } from "./types.js";
import { buildMigrateInventory } from "./wiki-migrate-inventory.js";
import {
  MIGRATE_PLAN_BATCH_SIZE,
  buildMigratePlanPrompt,
  parseMigratePlanResponse,
} from "./wiki-migrate-prompt.js";
import type {
  MigrateFolderMapping,
  WikiMigratePhase,
  WikiMigrateProgress,
  WikiMigrateRun,
} from "./wiki-migrate-types.js";
import type { WikiRepo } from "./wiki-repo.js";
import { WikiReclassifier } from "./wiki-reclassifier.js";
import { validateTopicAssignment } from "./wiki-topic-tree.js";

/** plan / replan 入参 */
export interface WikiLibraryMigratePlanOptions {
  readonly agentId: string;
  readonly userId: string;
  readonly importRoot: string;
  readonly inboxIds: readonly string[];
  readonly workspaceRoot?: string;
  readonly vaultRoot: string;
}

/** replan 额外入参（vaultRoot 供盘点复用） */
export interface WikiLibraryMigrateReplanOptions {
  readonly vaultRoot: string;
  readonly workspaceRoot?: string;
}

/** updateMapping 可改字段 */
export type WikiMigrateMappingPatch = Partial<
  Pick<MigrateFolderMapping, "category" | "subtopic" | "approvedProposedSubtopic" | "ignored">
>;

const PHASE_LABELS: Record<WikiMigratePhase, string> = {
  inventorying: "正在盘点源目录",
  planning: "正在规划目录映射",
  review: "映射方案待确认",
  applying: "正在整理入库",
  succeeded: "整理完成",
  partial: "部分整理完成",
  failed: "规划失败",
  cancelled: "已取消",
  discarded: "已丢弃",
  undone: "已撤销",
};

/** 将数组按固定大小切批 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push([...items.slice(i, i + size)]);
  }
  return out;
}

export class WikiLibraryMigrate {
  constructor(
    private readonly repo: WikiRepo,
    private readonly callLLM: (prompt: string) => Promise<string>,
    /** 测试注入固定 id；生产用 generateWikiId */
    private readonly newId: () => string = generateWikiId,
    private readonly onProgress?: (p: WikiMigrateProgress) => void,
  ) {}

  /** inventorying / planning / applying 视为 busy，阻塞 organizer 与 reclassify */
  static isBusy(run: WikiMigrateRun | null): boolean {
    return (
      !!run &&
      (run.phase === "inventorying" || run.phase === "planning" || run.phase === "applying")
    );
  }

  /** 读取当前 migrate run */
  get(agentId: string, userId: string): WikiMigrateRun | null {
    return this.repo.getMigrateRun(agentId, userId);
  }

  /**
   * 盘点 + 分批规划 → review。
   * reclassify running 或已有 busy migrate 时抛错；不写入 wiki_sources。
   */
  async plan(opts: WikiLibraryMigratePlanOptions): Promise<WikiMigrateRun> {
    this.assertCanStartPlan(opts.agentId, opts.userId);

    const inboxItems = this.resolvePendingInboxItems(opts.inboxIds);
    if (inboxItems.length === 0) {
      throw new Error("没有可规划的待整理条目");
    }

    const runId = this.newId();
    const now = new Date().toISOString();
    const topicTree = this.repo.getOrCreateTopicTree();

    let run = this.makeRun({
      id: runId,
      agentId: opts.agentId,
      userId: opts.userId,
      importRoot: opts.importRoot,
      phase: "inventorying",
      inboxIds: inboxItems.map((i) => i.id),
      mappings: [],
      createdAt: now,
      progress: this.makeProgress(runId, "inventorying", 0, inboxItems.length, null),
    });
    this.persistRun(opts.agentId, opts.userId, run);

    const inventory = buildMigrateInventory({
      importRoot: opts.importRoot,
      workspaceRoot: opts.workspaceRoot,
      inboxItems,
      repo: this.repo,
      agentId: opts.agentId,
      userId: opts.userId,
      topicTree,
      vaultRoot: opts.vaultRoot,
    });

    if (this.isCancelRequested(opts.agentId, opts.userId)) {
      return this.finishCancelled(opts.agentId, opts.userId, run, inventory.clusters.length);
    }

    run = {
      ...run,
      phase: "planning",
      progress: this.makeProgress(runId, "planning", 0, inventory.clusters.length, null),
    };
    this.persistRun(opts.agentId, opts.userId, run);

    const batches = chunk(inventory.clusters, MIGRATE_PLAN_BATCH_SIZE);
    const mappings: MigrateFolderMapping[] = [];
    let doneClusters = 0;

    try {
      for (let bi = 0; bi < batches.length; bi++) {
        if (this.isCancelRequested(opts.agentId, opts.userId)) {
          return this.finishCancelled(opts.agentId, opts.userId, { ...run, mappings }, doneClusters);
        }

        const batch = batches[bi]!;
        const currentItem = batch[0]?.folderRel ?? null;
        run = {
          ...run,
          progress: this.makeProgress(runId, "planning", doneClusters, inventory.clusters.length, currentItem),
        };
        this.persistRun(opts.agentId, opts.userId, run);

        const prompt = buildMigratePlanPrompt(topicTree, inventory, batch);
        const raw = await this.callLLM(prompt);

        if (this.isCancelRequested(opts.agentId, opts.userId)) {
          mappings.push(...parseMigratePlanResponse(raw, topicTree, batch));
          return this.finishCancelled(opts.agentId, opts.userId, { ...run, mappings }, doneClusters + batch.length);
        }

        mappings.push(...parseMigratePlanResponse(raw, topicTree, batch));
        doneClusters += batch.length;

        run = {
          ...run,
          mappings,
          progress: this.makeProgress(runId, "planning", doneClusters, inventory.clusters.length, currentItem),
        };
        this.persistRun(opts.agentId, opts.userId, run);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      run = {
        ...run,
        phase: "failed",
        error: message,
        finishedAt: new Date().toISOString(),
        progress: this.makeProgress(runId, "failed", doneClusters, inventory.clusters.length, null, message),
      };
      this.persistRun(opts.agentId, opts.userId, run);
      return run;
    }

    run = {
      ...run,
      phase: "review",
      mappings,
      finishedAt: new Date().toISOString(),
      progress: this.makeProgress(runId, "review", mappings.length, mappings.length, null),
    };
    this.persistRun(opts.agentId, opts.userId, run);
    return run;
  }

  /**
   * 置 cancelRequested；inventorying / planning / applying 循环内会检查并尽快结束。
   */
  cancel(agentId: string, userId: string): WikiMigrateRun | null {
    const run = this.repo.getMigrateRun(agentId, userId);
    if (!run) return null;
    if (!WikiLibraryMigrate.isBusy(run)) return run;

    const updated: WikiMigrateRun = {
      ...run,
      cancelRequested: true,
      progress: {
        ...run.progress,
        cancelRequested: true,
      },
    };
    this.repo.setMigrateRun(agentId, userId, updated);
    return updated;
  }

  /** 丢弃映射方案；inbox 保持 pending，不撤销已归档（plan 阶段本就不归档） */
  discard(agentId: string, userId: string): void {
    this.repo.setMigrateRun(agentId, userId, null);
  }

  /**
   * 预览中改单簇映射、批准 proposedSubtopic 或标记 ignored。
   * 仅 review 阶段允许；非法 topic 保持 conflict。
   */
  updateMapping(
    agentId: string,
    userId: string,
    folderRel: string,
    patch: WikiMigrateMappingPatch,
  ): WikiMigrateRun {
    const run = this.repo.getMigrateRun(agentId, userId);
    if (!run) throw new Error("无迁移方案可编辑");
    if (run.phase !== "review") {
      throw new Error("仅预览阶段可修改映射");
    }

    const tree = this.repo.getOrCreateTopicTree();
    const mappings = run.mappings.map((m) => {
      if (m.folderRel !== folderRel) return m;
      return this.applyMappingPatch(m, patch, tree);
    });

    const idx = mappings.findIndex((m) => m.folderRel === folderRel);
    if (idx < 0) throw new Error(`未找到文件夹映射: ${folderRel}`);

    const updated: WikiMigrateRun = { ...run, mappings };
    this.repo.setMigrateRun(agentId, userId, updated);
    return updated;
  }

  /**
   * 对仍 pending 的 inbox 子集重跑盘点 + 规划 → review。
   * 会先清空当前 run 再 plan。
   */
  async replan(
    agentId: string,
    userId: string,
    opts: WikiLibraryMigrateReplanOptions,
  ): Promise<WikiMigrateRun> {
    const existing = this.get(agentId, userId);
    if (!existing) throw new Error("无迁移方案可重新规划");

    const pendingIds = existing.inboxIds.filter((id) => {
      const item = this.repo.findInboxById(id);
      return item?.status === "pending";
    });
    if (pendingIds.length === 0) {
      throw new Error("没有仍待整理的条目");
    }

    this.repo.setMigrateRun(agentId, userId, null);
    return this.plan({
      agentId,
      userId,
      importRoot: existing.importRoot,
      inboxIds: pendingIds,
      workspaceRoot: opts.workspaceRoot,
      vaultRoot: opts.vaultRoot,
    });
  }

  /** 启动前互斥检查 */
  private assertCanStartPlan(agentId: string, userId: string): void {
    const reclassify = this.repo.getReclassifyRun(agentId, userId);
    if (WikiReclassifier.isRunning(reclassify)) {
      throw new Error("已有正在进行的重新编目，请等它结束后再整理入库");
    }

    const existing = this.repo.getMigrateRun(agentId, userId);
    if (WikiLibraryMigrate.isBusy(existing)) {
      throw new Error("已有正在进行的库级迁移，请稍候");
    }
    if (existing?.phase === "review") {
      throw new Error("已有待确认的迁移方案，请先处理或丢弃");
    }
  }

  /** 解析 inboxIds 为仍 pending 的条目 */
  private resolvePendingInboxItems(inboxIds: readonly string[]): WikiInboxItem[] {
    const items: WikiInboxItem[] = [];
    for (const id of inboxIds) {
      const item = this.repo.findInboxById(id);
      if (item?.status === "pending") items.push(item);
    }
    return items;
  }

  /** 合并用户 patch 并重新计算 status */
  private applyMappingPatch(
    mapping: MigrateFolderMapping,
    patch: WikiMigrateMappingPatch,
    tree: ReturnType<WikiRepo["getOrCreateTopicTree"]>,
  ): MigrateFolderMapping {
    const category = patch.category !== undefined ? patch.category : mapping.category;
    const subtopic = patch.subtopic !== undefined ? patch.subtopic : mapping.subtopic;
    const approvedProposedSubtopic =
      patch.approvedProposedSubtopic !== undefined
        ? patch.approvedProposedSubtopic
        : mapping.approvedProposedSubtopic;
    const ignored = patch.ignored !== undefined ? patch.ignored : mapping.ignored;

    if (ignored) {
      return { ...mapping, ignored: true, approvedProposedSubtopic, category, subtopic };
    }

    if (category === null) {
      return {
        ...mapping,
        category: null,
        subtopic: null,
        approvedProposedSubtopic,
        ignored: false,
        status: "conflict",
      };
    }

    const validation = validateTopicAssignment(tree, category, subtopic);
    if (!validation.ok) {
      return {
        ...mapping,
        category: null,
        subtopic: null,
        approvedProposedSubtopic,
        ignored: false,
        status: "conflict",
        reason: validation.reason,
      };
    }

    return {
      ...mapping,
      category,
      subtopic,
      approvedProposedSubtopic,
      ignored: false,
      status: "ok",
    };
  }

  /** 构造初始 run 骨架 */
  private makeRun(partial: Omit<WikiMigrateRun, "appliedSourceIds" | "appliedInboxIds" | "cancelRequested">): WikiMigrateRun {
    return {
      ...partial,
      appliedSourceIds: [],
      appliedInboxIds: [],
      cancelRequested: false,
    };
  }

  /** 构造 progress 快照并触发回调 */
  private makeProgress(
    runId: string,
    phase: WikiMigratePhase,
    done: number,
    total: number,
    currentItem: string | null,
    message?: string,
    cancelRequested?: boolean,
  ): WikiMigrateProgress {
    const progress: WikiMigrateProgress = {
      runId,
      phase,
      phaseLabel: PHASE_LABELS[phase],
      done,
      total,
      currentItem,
      ...(message ? { message } : {}),
      ...(cancelRequested ? { cancelRequested } : {}),
    };
    this.onProgress?.(progress);
    return progress;
  }

  /** 写入 run 并广播进度 */
  private persistRun(agentId: string, userId: string, run: WikiMigrateRun): void {
    this.repo.setMigrateRun(agentId, userId, run);
    this.onProgress?.(run.progress);
  }

  /** 读取 cancelRequested（以 repo 为准，支持外部 cancel 调用） */
  private isCancelRequested(agentId: string, userId: string): boolean {
    return this.repo.getMigrateRun(agentId, userId)?.cancelRequested === true;
  }

  /** 将 run 收尾为 cancelled */
  private finishCancelled(
    agentId: string,
    userId: string,
    run: WikiMigrateRun,
    doneClusters: number,
  ): WikiMigrateRun {
    const finished: WikiMigrateRun = {
      ...run,
      phase: "cancelled",
      cancelRequested: true,
      finishedAt: new Date().toISOString(),
      progress: this.makeProgress(
        run.id,
        "cancelled",
        doneClusters,
        run.progress.total,
        null,
        undefined,
        true,
      ),
    };
    this.persistRun(agentId, userId, finished);
    return finished;
  }
}
