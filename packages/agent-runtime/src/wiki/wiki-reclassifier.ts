/**
 * WikiReclassifier — 全库编目 v2：两轮制（结构优先、正文按需）+ 断点续跑
 *
 * 与自动归档（WikiOrganizer）的区别：重编目**不直接写库**，先落候选态，
 * 用户接受后才改主题两列。每 agent+user 同时只允许一个批次。
 * AI 只能在当前树里选节点，不能自造、不能写临时存放。
 *
 * 算法（P5 v1.1）：
 * (1) 盘点线 — buildLibraryInventory：纯 DB+文件系统，输出全局视野。
 * (2) 两轮线 — 结构轮（不带正文，模型可 needContent）→ 内容轮（仅 needContent 且有正文，补摘要）。
 * (3) 无正文线 — needContent 且无正文的资料留收件箱，不进内容轮，不产候选。
 *
 * 设计：docs/plans/记忆重构/2026-08-31-wiki-intelligent-vault-p5-cataloging.md
 */

import type { WikiRepo } from "./wiki-repo.js";
import { generateWikiId } from "./types.js";
import { validateTopicAssignment } from "./wiki-topic-tree.js";
import { buildLibraryInventory, type InventoryFileRow, type LibraryInventoryScope } from "./wiki-library-inventory.js";
import {
  buildLibraryImpression,
  buildStructurePrompt,
  buildContentPrompt,
  parseStructureResponse,
  STRUCTURE_BATCH_SIZE,
  CONTENT_BATCH_SIZE,
} from "./wiki-catalog-prompt.js";
import { WikiSummarizer } from "./wiki-summary.js";
import { shouldAcceptRenameProposal } from "./wiki-title-score.js";
import type {
  WikiReclassifyCandidate,
  WikiReclassifyRun,
  WikiReclassifyScope,
} from "./wiki-reclassify-types.js";

export type {
  WikiReclassifyCandidate,
  WikiReclassifyRun,
  WikiReclassifyScope,
  WikiReclassifyStatus,
} from "./wiki-reclassify-types.js";
export { RECLASSIFY_RUN_META_KEY } from "./wiki-reclassify-types.js";

/** 结构轮/内容轮批量置信阈值：低于此不产候选（有人工复核，比增量 0.75 宽） */
export const RECLASSIFY_CONFIDENCE_THRESHOLD = 0.6;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push([...items.slice(i, i + size)]);
  return out;
}

function toInventoryScope(scope: WikiReclassifyScope): LibraryInventoryScope {
  return scope;
}

function rowOf(batch: readonly InventoryFileRow[], id: string): InventoryFileRow {
  const row = batch.find((f) => f.id === id);
  if (!row) throw new Error(`结构轮返回了本批之外的 id: ${id}`);
  return row;
}

export class WikiReclassifier {
  constructor(
    private readonly repo: WikiRepo,
    private readonly callLLM: (prompt: string) => Promise<string>,
    /** 测试注入固定 id；生产用 generateWikiId */
    private readonly newId: () => string = generateWikiId,
  ) {}

  get(agentId: string, userId: string): WikiReclassifyRun | null {
    return (this.repo.getReclassifyRun(agentId, userId) as WikiReclassifyRun | null) ?? null;
  }

  /** organizer 判暂停用：只有 running 才阻塞自动归档，review 不阻塞 */
  static isRunning(run: WikiReclassifyRun | null): boolean {
    return run?.status === "running";
  }

  /**
   * 启动一批编目：盘点 → 结构轮（分批）→ 内容轮（仅 needContent 且有正文）→ review。
   * 已有 running 一律拒绝；review/failed 需要 force。
   * failed 批次续跑：按 resumeCursor 跳过已完成的批次，已产候选按 sourceId 去重不重复生成。
   */
  async run(
    agentId: string,
    userId: string,
    scope: WikiReclassifyScope,
    opts: { readonly force?: boolean; readonly vaultRoot: string; readonly enableRename?: boolean },
  ): Promise<string> {
    const existing = this.get(agentId, userId);
    if (existing) {
      if (existing.status === "running") {
        throw new Error("已有正在进行的重新编目，请等它结束");
      }
      if (!opts?.force) {
        throw new Error("已有待审阅的重新编目结果，请先处理或丢弃");
      }
    }

    const resumable = existing?.status === "failed" ? existing : null;
    const inv = buildLibraryInventory(this.repo, agentId, userId, toInventoryScope(scope), opts.vaultRoot);

    const runId = resumable?.runId ?? this.newId();
    const now = new Date().toISOString();
    const priorCandidates = resumable?.candidates ?? [];
    const priorSourceIds = new Set(priorCandidates.map((c) => c.sourceId));

    let run: WikiReclassifyRun = {
      runId,
      status: "running",
      scope,
      total: inv.files.length,
      processed: resumable?.processed ?? 0,
      droppedInvalid: resumable?.droppedInvalid ?? 0,
      unchanged: resumable?.unchanged ?? 0,
      candidates: priorCandidates,
      error: null,
      createdAt: resumable?.createdAt ?? now,
      updatedAt: now,
    };
    this.repo.setReclassifyRun(agentId, userId, run);

    if (inv.files.length === 0) {
      run = { ...run, status: "review", updatedAt: new Date().toISOString() };
      this.repo.setReclassifyRun(agentId, userId, run);
      return runId;
    }

    const tree = inv.tree;
    const candidates: WikiReclassifyCandidate[] = [...priorCandidates];
    let droppedInvalid = run.droppedInvalid;
    let unchanged = run.unchanged;
    const needContent: InventoryFileRow[] = [];

    const resumeCursor = resumable?.resumeCursor;

    try {
      // ── 结构轮 ──────────────────────────────────────────
      const structureBatches = chunk(inv.files, STRUCTURE_BATCH_SIZE);
      const structureStart = resumeCursor?.pass === "structure" ? resumeCursor.batchIndex : 0;

      for (let bi = structureStart; bi < structureBatches.length; bi++) {
        const batch = structureBatches[bi]!;
        const impression = buildLibraryImpression(inv);
        const raw = await this.callLLM(buildStructurePrompt(tree, impression, batch));
        const { decisions, droppedInvalid: di } = parseStructureResponse(raw, batch, tree);
        droppedInvalid += di;

        for (const d of decisions) {
          if (d.needContent) {
            needContent.push(rowOf(batch, d.id));
            continue;
          }
          if (priorSourceIds.has(d.id)) continue;
          const row = rowOf(batch, d.id);
          const sameAsCurrent = d.category === row.fromCategory && d.subtopic === row.fromSubtopic;
          if (d.confidence < RECLASSIFY_CONFIDENCE_THRESHOLD || sameAsCurrent) {
            unchanged++;
            continue;
          }
          candidates.push({
            id: this.newId(),
            sourceId: row.id,
            title: row.fileName,
            fromCategory: row.fromCategory,
            fromSubtopic: row.fromSubtopic,
            toCategory: d.category!,
            toSubtopic: d.subtopic,
            reason: d.reason,
            decidedBy: "structure",
            decision: "pending",
          });
        }

        run = {
          ...run,
          processed: Math.min(run.processed + batch.length, inv.files.length),
          droppedInvalid,
          unchanged,
          candidates: [...candidates],
          resumeCursor: { pass: "structure", batchIndex: bi + 1 },
          updatedAt: new Date().toISOString(),
        };
        this.repo.setReclassifyRun(agentId, userId, run);
      }

      // ── 内容轮：仅 needContent 且有正文；无正文的留收件箱，不进内容轮不产候选 ──
      const withText = needContent.filter((f) => f.hasText);
      const contentBatches = chunk(withText, CONTENT_BATCH_SIZE);
      const contentStart = resumeCursor?.pass === "content" ? resumeCursor.batchIndex : 0;
      const summarizer = new WikiSummarizer(this.repo, this.callLLM);

      for (let bi = contentStart; bi < contentBatches.length; bi++) {
        const batch = contentBatches[bi]!;
        const summaries = new Map<string, string>();
        for (const f of batch) {
          const source = this.repo.findSourceById(f.id);
          if (!source) continue;
          const result = await summarizer.getOrBuildSummary(source, { allowLlm: true });
          if (result) summaries.set(f.id, result.summary);
        }

        const impression = buildLibraryImpression(inv);
        const raw = await this.callLLM(
          buildContentPrompt(tree, impression, batch, summaries, { enableRename: opts.enableRename }),
        );
        const { decisions } = parseStructureResponse(raw, batch, tree);

        for (const d of decisions) {
          if (priorSourceIds.has(d.id)) continue;
          if (d.category === null) continue; // 补了正文仍判不了：留收件箱，不产候选
          const row = rowOf(batch, d.id);
          const sameAsCurrent = d.category === row.fromCategory && d.subtopic === row.fromSubtopic;
          if (d.confidence < RECLASSIFY_CONFIDENCE_THRESHOLD || sameAsCurrent) {
            unchanged++;
            continue;
          }
          const source = this.repo.findSourceById(row.id);
          const renameTitle =
            opts.enableRename && source
              ? shouldAcceptRenameProposal({
                  renameTitle: d.renameTitle,
                  currentTitle: row.fileName,
                  titleLocked: source.title_locked === 1,
                  storageMode: source.storage_mode,
                  confidence: d.confidence,
                })
                ? d.renameTitle
                : undefined
              : undefined;
          candidates.push({
            id: this.newId(),
            sourceId: row.id,
            title: row.fileName,
            fromCategory: row.fromCategory,
            fromSubtopic: row.fromSubtopic,
            toCategory: d.category,
            toSubtopic: d.subtopic,
            reason: d.reason,
            decidedBy: "content",
            decision: "pending",
            ...(renameTitle ? { renameTitle } : {}),
          });
        }

        run = {
          ...run,
          droppedInvalid,
          unchanged,
          candidates: [...candidates],
          resumeCursor: { pass: "content", batchIndex: bi + 1 },
          updatedAt: new Date().toISOString(),
        };
        this.repo.setReclassifyRun(agentId, userId, run);
      }
    } catch (err) {
      this.repo.setReclassifyRun(agentId, userId, {
        ...run,
        status: "failed",
        error: (err as Error).message,
        updatedAt: new Date().toISOString(),
      });
      throw err;
    }

    const { resumeCursor: _drop, ...settled } = run;
    this.repo.setReclassifyRun(agentId, userId, {
      ...settled,
      status: "review",
      updatedAt: new Date().toISOString(),
    });
    return runId;
  }

  /**
   * 部分接受。逐条校验目标节点仍在树里（用户可能刚删掉它），
   * 失败的条目留在 review 并带 applyError；全部落定后清空批次。
   */
  apply(
    agentId: string,
    userId: string,
    candidateIds: readonly string[],
  ): { applied: number; failed: number; appliedSourceIds: readonly string[] } {
    const run = this.get(agentId, userId);
    if (!run) return { applied: 0, failed: 0, appliedSourceIds: [] };
    if (candidateIds.length === 0) return { applied: 0, failed: 0, appliedSourceIds: [] };

    const tree = this.repo.getOrCreateTopicTree();
    const wanted = new Set(candidateIds);
    let applied = 0;
    let failed = 0;
    const appliedSourceIds: string[] = [];

    const next = run.candidates.map((c) => {
      if (!wanted.has(c.id) || c.decision !== "pending") return c;
      const check = validateTopicAssignment(tree, c.toCategory, c.toSubtopic);
      if (!check.ok) {
        failed++;
        return { ...c, applyError: `目标目录已不存在：${c.toCategory}${c.toSubtopic ? ` / ${c.toSubtopic}` : ""}` };
      }
      try {
        this.repo.updateSourceTopic(agentId, userId, c.sourceId, c.toCategory, c.toSubtopic);
        applied++;
        appliedSourceIds.push(c.sourceId);
        const { applyError: _drop, ...rest } = c;
        return { ...rest, decision: "applied" as const };
      } catch (err) {
        failed++;
        return { ...c, applyError: (err as Error).message };
      }
    });

    this.persist(agentId, userId, run, next);
    return { applied, failed, appliedSourceIds };
  }

  ignore(agentId: string, userId: string, candidateId: string): void {
    const run = this.get(agentId, userId);
    if (!run) return;
    const next = run.candidates.map((c) =>
      c.id === candidateId ? { ...c, decision: "ignored" as const } : c,
    );
    this.persist(agentId, userId, run, next);
  }

  discard(agentId: string, userId: string): void {
    this.repo.setReclassifyRun(agentId, userId, null);
  }

  /**
   * 落盘：只留还需要用户处理的条目（pending，或接受失败带 applyError 的）。
   * 一条都不剩时整批清空，避免空批次占住「同时只允许一个」的槽位。
   */
  private persist(
    agentId: string,
    userId: string,
    run: WikiReclassifyRun,
    candidates: readonly WikiReclassifyCandidate[],
  ): void {
    const remaining = candidates.filter((c) => c.decision === "pending");
    if (remaining.length === 0) {
      this.repo.setReclassifyRun(agentId, userId, null);
      return;
    }
    this.repo.setReclassifyRun(agentId, userId, {
      ...run,
      status: "review",
      candidates: remaining,
      updatedAt: new Date().toISOString(),
    });
  }
}
