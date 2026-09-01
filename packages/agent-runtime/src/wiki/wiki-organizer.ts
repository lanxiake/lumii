/**
 * WikiOrganizer — 整理主流程：取件 → 内容提取 → 批量分类 → 落库 → 写运行日志
 *
 * 失败不静默：分类整批失败时条目保持 pending 并记 attempt_count（见
 * wiki-organize-queue.ts 的 computeBackoffDelayMs）；单条无法归类（skip/越权/漏答）
 * 不建 source、条目留在收件箱待整理，不再臆造分类或落到兜底目录。
 *
 * 设计：docs/design/记忆设计/2026-08-27-wiki-topic-hierarchy-redesign.md §4
 */

import { classifyBatch, type ClassifiedItem } from "./wiki-classifier.js";
import type { WikiClassifyContext } from "./wiki-classify-context.js";
import { WikiReclassifier } from "./wiki-reclassifier.js";
import type { WikiContentExtractor } from "./wiki-content-extractor.js";
import type { WikiRepo } from "./wiki-repo.js";
import { WikiSummarizer } from "./wiki-summary.js";
import type {
  WikiInboxItem,
  WikiInboxItemType,
  WikiOrganizeRun,
  WikiOrganizeRunDetailExtract,
  WikiOrganizeRunDetailItem,
  WikiSource,
} from "./types.js";

export interface WikiOrganizerHooks {
  /** 资料落库后回调（供宿主同步 vault 目录） */
  readonly onSourceCreated?: (source: WikiSource) => void;
}

/**
 * 根据 enrich 前后正文预览判定 extract 字段：
 * 原有预览 → preview；本次补齐 → extracted；仍无正文 → none。
 */
function resolveExtractState(
  beforePreview: string | null | undefined,
  afterPreview: string | null | undefined,
): WikiOrganizeRunDetailExtract {
  if (beforePreview) return "preview";
  if (afterPreview) return "extracted";
  return "none";
}

export class WikiOrganizer {
  private readonly summarizer: WikiSummarizer;

  constructor(
    private readonly repo: WikiRepo,
    private readonly callLLM: (prompt: string) => Promise<string>,
    private readonly extractor: WikiContentExtractor,
    private readonly hooks?: WikiOrganizerHooks,
  ) {
    // 摄入时只跑零成本层（allowLlm=false），故不需要真的注入 LLM 调用。
    this.summarizer = new WikiSummarizer(repo, null);
  }

  /**
   * 落库后立即补零成本摘要（heuristic/extractive），再回调 onSourceCreated——
   * 保证宿主同步 vault 时读到的已是带摘要的最新行。顺序很重要：先摘要后向量/vault，
   * 否则向量语料与列表副标题都会短暂缺摘要。
   */
  private async finalizeCreatedSource(source: WikiSource): Promise<WikiSource> {
    await this.summarizer.getOrBuildSummary(source, { allowLlm: false }).catch(() => null);
    const updated = this.repo.findSourceById(source.id) ?? source;
    this.hooks?.onSourceCreated?.(updated);
    return updated;
  }

  /**
   * 整理一批同类型待办条目。取件为空返回 null（无运行可言）。
   * 返回的 run 已是终态（succeeded / partial / failed）。
   *
   * 重新编目进行中（status = running）时直接返回 null：不取件、不动 attempt_count，
   * 条目留在 pending，编目结束后下一轮轮询自然恢复（设计 §7 / §9.2）。
   * review 状态不阻塞——用户可能长期不处理候选，不该因此停掉自动归档。
   */
  /**
   * 取件 + 补正文预览。两条整理路径（organizeBatch / intakeBatch）共用，
   * 保证「重新编目进行中不取件」与 extract 状态判定只有一份实现。
   */
  private async takeAndEnrich(
    agentId: string,
    userId: string,
    itemType: WikiInboxItemType,
    batchSize: number,
  ): Promise<{
    readonly items: readonly WikiInboxItem[];
    readonly enriched: readonly WikiInboxItem[];
    readonly extractById: Map<string, WikiOrganizeRunDetailExtract>;
  } | null> {
    if (WikiReclassifier.isRunning(this.repo.getReclassifyRun(agentId, userId) as never)) {
      return null;
    }
    const items = this.repo.takeInboxBatch(agentId, userId, itemType, batchSize);
    if (items.length === 0) return null;

    // 内容提取：补齐缺失的正文预览（图片描述等），失败已在 extractor 内降级为 null
    const enriched = await Promise.all(
      items.map(async (item) => {
        if (item.content_preview) return item;
        const text = await this.extractor.extract({
          mediaType: item.media_type,
          sourcePath: item.source_path,
          text: item.content_preview,
        });
        return text === null ? item : { ...item, content_preview: text };
      }),
    );

    const extractById = new Map(
      items.map((item) => {
        const after = enriched.find((e) => e.id === item.id);
        return [item.id, resolveExtractState(item.content_preview, after?.content_preview)] as const;
      }),
    );

    return { items, enriched, extractById };
  }

  /**
   * 对指定 inbox 条目批量 AI 分类归档（文件夹导入等场景）。
   * 与 takeInboxBatch 不同：只处理给定 id，且整批共享 classify 上下文。
   */
  async organizeInboxIds(
    agentId: string,
    userId: string,
    inboxIds: readonly string[],
    context?: WikiClassifyContext | null,
    batchSize = 10,
  ): Promise<WikiOrganizeRun | null> {
    if (inboxIds.length === 0) return null;
    if (WikiReclassifier.isRunning(this.repo.getReclassifyRun(agentId, userId) as never)) {
      return null;
    }

    const pending = inboxIds
      .map((id) => this.repo.findInboxById(id))
      .filter((item): item is WikiInboxItem => item !== null && item.status === "pending");

    if (pending.length === 0) return null;

    const run = this.repo.createRun(
      agentId,
      userId,
      pending.map((i) => i.id),
    );

    const topicTree = this.repo.getOrCreateTopicTree();
    let totalOrganized = 0;
    let totalDegraded = 0;
    let totalFailed = 0;
    const allDetailItems: WikiOrganizeRunDetailItem[] = [];
    const degradeReasons = new Set<string>();

    for (let offset = 0; offset < pending.length; offset += batchSize) {
      const chunk = pending.slice(offset, offset + batchSize);
      const enriched = await Promise.all(
        chunk.map(async (item) => {
          if (item.content_preview) return item;
          const text = await this.extractor.extract({
            mediaType: item.media_type,
            sourcePath: item.source_path,
            text: item.content_preview,
          });
          return text === null ? item : { ...item, content_preview: text };
        }),
      );

      const extractById = new Map(
        chunk.map((item) => {
          const after = enriched.find((e) => e.id === item.id);
          return [item.id, resolveExtractState(item.content_preview, after?.content_preview)] as const;
        }),
      );

      let classified: readonly ClassifiedItem[];
      try {
        classified = await classifyBatch(enriched, this.callLLM, topicTree, context);
      } catch (err) {
        const message = (err as Error).message;
        for (const item of chunk) this.repo.markInboxAttemptFailed(item.id, message);
        totalFailed += chunk.length;
        for (const item of chunk) {
          allDetailItems.push({
            inboxId: item.id,
            title: item.title,
            path: "",
            mediaType: item.media_type,
            outcome: "failed",
            reason: message,
            extract: extractById.get(item.id) ?? "none",
          });
        }
        continue;
      }

      const byId = new Map(enriched.map((i) => [i.id, i]));
      for (const result of classified) {
        const item = byId.get(result.inboxId);
        if (!item) continue;
        const extract = extractById.get(item.id) ?? "none";

        if (result.degraded || result.skip || !result.category || !result.subtopic) {
          const reason = result.degradeReason ?? result.reason ?? "无法归类";
          totalDegraded += 1;
          degradeReasons.add(reason);
          this.repo.markInboxAttemptFailed(item.id, reason, "degraded");
          allDetailItems.push({
            inboxId: item.id,
            title: item.title,
            path: "",
            mediaType: item.media_type,
            outcome: "degraded",
            reason,
            extract,
          });
          continue;
        }

        try {
          const source = this.repo.archiveInboxItem(item, result.category, result.subtopic);
          await this.finalizeCreatedSource(source);
          totalOrganized += 1;
          allDetailItems.push({
            inboxId: item.id,
            title: item.title,
            path: `${result.category}/${result.subtopic}`,
            mediaType: item.media_type,
            outcome: "archived",
            extract,
          });
        } catch (err) {
          totalFailed += 1;
          const reason = (err as Error).message;
          this.repo.markInboxAttemptFailed(item.id, reason);
          allDetailItems.push({
            inboxId: item.id,
            title: item.title,
            path: "",
            mediaType: item.media_type,
            outcome: "failed",
            reason,
            extract,
          });
        }
      }
    }

    const status =
      totalFailed > 0 ? "partial" : totalDegraded > 0 ? "degraded" : "succeeded";
    const summary = [
      `${totalOrganized} 项已归档`,
      totalDegraded > 0 ? `${totalDegraded} 项无法归类留在待整理` : "",
      totalFailed > 0 ? `${totalFailed} 项待重试` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const error = degradeReasons.size > 0 ? [...degradeReasons].join("; ") : undefined;
    const detailJson = JSON.stringify({ items: allDetailItems });
    this.repo.finishRun(run.id, status, summary, error, detailJson);
    return {
      ...run,
      status,
      result_summary: summary,
      result_detail: detailJson,
      ...(error ? { error } : {}),
      finished_at: new Date().toISOString(),
    };
  }

  /**
   * 对指定 inbox 条目只做收件（不调 LLM），落为未分类资料。
   * 供文件夹导入等在关闭自动分类后立即落库，避免只写 inbox 队列导致 UI 无可见资料。
   */
  async intakeInboxIds(
    agentId: string,
    userId: string,
    inboxIds: readonly string[],
  ): Promise<WikiOrganizeRun | null> {
    if (inboxIds.length === 0) return null;
    if (WikiReclassifier.isRunning(this.repo.getReclassifyRun(agentId, userId) as never)) {
      return null;
    }

    const pending = inboxIds
      .map((id) => this.repo.findInboxById(id))
      .filter((item): item is WikiInboxItem => item !== null && item.status === "pending");

    if (pending.length === 0) return null;

    const run = this.repo.createRun(
      agentId,
      userId,
      pending.map((i) => i.id),
    );

    const enriched = await Promise.all(
      pending.map(async (item) => {
        if (item.content_preview) return item;
        const text = await this.extractor.extract({
          mediaType: item.media_type,
          sourcePath: item.source_path,
          text: item.content_preview,
        });
        return text === null ? item : { ...item, content_preview: text };
      }),
    );

    const extractById = new Map(
      pending.map((item) => {
        const after = enriched.find((e) => e.id === item.id);
        return [item.id, resolveExtractState(item.content_preview, after?.content_preview)] as const;
      }),
    );

    const byId = new Map(enriched.map((i) => [i.id, i]));
    let failed = 0;
    const failReasons = new Set<string>();
    const detailItems: WikiOrganizeRunDetailItem[] = [];

    for (const item of pending) {
      const enrichedItem = byId.get(item.id) ?? item;
      const extract = extractById.get(item.id) ?? "none";
      try {
        const source = this.repo.fileInboxItemUnclassified(enrichedItem);
        await this.finalizeCreatedSource(source);
        detailItems.push({
          inboxId: item.id,
          title: item.title,
          path: "",
          mediaType: item.media_type,
          outcome: "archived",
          extract,
        });
      } catch (err) {
        failed += 1;
        const reason = (err as Error).message;
        failReasons.add(reason);
        this.repo.markInboxAttemptFailed(item.id, reason);
        detailItems.push({
          inboxId: item.id,
          title: item.title,
          path: "",
          mediaType: item.media_type,
          outcome: "failed",
          reason,
          extract,
        });
      }
    }

    const status = failed > 0 ? "partial" : "succeeded";
    const filed = pending.length - failed;
    const summary = [`${filed} 项已收进未分类`, failed > 0 ? `${failed} 项待重试` : ""]
      .filter(Boolean)
      .join(" · ");
    const error = failReasons.size > 0 ? [...failReasons].join("; ") : undefined;
    const detailJson = JSON.stringify({ items: detailItems });
    this.repo.finishRun(run.id, status, summary, error, detailJson);
    return {
      ...run,
      status,
      result_summary: summary,
      result_detail: detailJson,
      ...(error ? { error } : {}),
      finished_at: new Date().toISOString(),
    };
  }

  /**
   * 只做收件：把一批条目原样归档成未分类资料，不调 LLM、不写主题。
   * 关掉自动分类后的默认路径——资料先安全落库，分类交给用户或显式的「AI 整理」。
   */
  async intakeBatch(
    agentId: string,
    userId: string,
    itemType: WikiInboxItemType,
    batchSize = 10,
  ): Promise<WikiOrganizeRun | null> {
    const taken = await this.takeAndEnrich(agentId, userId, itemType, batchSize);
    if (!taken) return null;
    const { items, enriched, extractById } = taken;

    const run = this.repo.createRun(
      agentId,
      userId,
      items.map((i) => i.id),
    );

    const byId = new Map(enriched.map((i) => [i.id, i]));
    let failed = 0;
    const failReasons = new Set<string>();
    const detailItems: WikiOrganizeRunDetailItem[] = [];

    for (const item of items) {
      const enrichedItem = byId.get(item.id) ?? item;
      const extract = extractById.get(item.id) ?? "none";
      try {
        const source = this.repo.fileInboxItemUnclassified(enrichedItem);
        await this.finalizeCreatedSource(source);
        detailItems.push({
          inboxId: item.id,
          title: item.title,
          path: "",
          mediaType: item.media_type,
          outcome: "archived",
          extract,
        });
      } catch (err) {
        failed += 1;
        const reason = (err as Error).message;
        failReasons.add(reason);
        this.repo.markInboxAttemptFailed(item.id, reason);
        detailItems.push({
          inboxId: item.id,
          title: item.title,
          path: "",
          mediaType: item.media_type,
          outcome: "failed",
          reason,
          extract,
        });
      }
    }

    const status = failed > 0 ? "partial" : "succeeded";
    const filed = items.length - failed;
    const summary = [`${filed} 项已收进未分类`, failed > 0 ? `${failed} 项待重试` : ""]
      .filter(Boolean)
      .join(" · ");
    const error = failReasons.size > 0 ? [...failReasons].join("; ") : undefined;
    const detailJson = JSON.stringify({ items: detailItems });
    this.repo.finishRun(run.id, status, summary, error, detailJson);
    return {
      ...run,
      status,
      result_summary: summary,
      result_detail: detailJson,
      ...(error ? { error } : {}),
      finished_at: new Date().toISOString(),
    };
  }

  async organizeBatch(
    agentId: string,
    userId: string,
    itemType: WikiInboxItemType,
    batchSize = 10,
  ): Promise<WikiOrganizeRun | null> {
    const taken = await this.takeAndEnrich(agentId, userId, itemType, batchSize);
    if (!taken) return null;
    const { items, enriched, extractById } = taken;

    const run = this.repo.createRun(
      agentId,
      userId,
      items.map((i) => i.id),
    );

    const topicTree = this.repo.getOrCreateTopicTree();

    let classified;
    try {
      classified = await classifyBatch(enriched, this.callLLM, topicTree);
    } catch (err) {
      // 整批分类失败：条目保持 pending 且记一次尝试，下次退避后重试——数据不丢
      const message = (err as Error).message;
      for (const item of items) this.repo.markInboxAttemptFailed(item.id, message);
      const detailItems: WikiOrganizeRunDetailItem[] = items.map((item) => ({
        inboxId: item.id,
        title: item.title,
        path: "",
        mediaType: item.media_type,
        outcome: "failed",
        reason: message,
        extract: extractById.get(item.id) ?? "none",
      }));
      const detailJson = JSON.stringify({ items: detailItems });
      this.repo.finishRun(run.id, "failed", undefined, message, detailJson);
      return {
        ...run,
        status: "failed",
        error: message,
        result_detail: detailJson,
        finished_at: new Date().toISOString(),
      };
    }

    const byId = new Map(enriched.map((i) => [i.id, i]));
    let failed = 0;
    let degraded = 0;
    const degradeReasons = new Set<string>();
    const detailItems: WikiOrganizeRunDetailItem[] = [];

    for (const result of classified) {
      const item = byId.get(result.inboxId);
      if (!item) continue;
      const extract = extractById.get(item.id) ?? "none";

      if (result.degraded || result.skip || !result.category || !result.subtopic) {
        const reason = result.degradeReason ?? result.reason ?? "无法归类";
        degraded += 1;
        degradeReasons.add(reason);
        this.repo.markInboxAttemptFailed(item.id, reason, "degraded");
        detailItems.push({
          inboxId: item.id,
          title: item.title,
          path: "",
          mediaType: item.media_type,
          outcome: "degraded",
          reason,
          extract,
        });
        continue;
      }

      try {
        const source = this.repo.archiveInboxItem(item, result.category, result.subtopic);
        await this.finalizeCreatedSource(source);
        detailItems.push({
          inboxId: item.id,
          title: item.title,
          path: `${result.category}/${result.subtopic}`,
          mediaType: item.media_type,
          outcome: "archived",
          extract,
        });
      } catch (err) {
        failed += 1;
        const reason = (err as Error).message;
        detailItems.push({
          inboxId: item.id,
          title: item.title,
          path: "",
          mediaType: item.media_type,
          outcome: "failed",
          reason,
          extract,
        });
        this.repo.markInboxAttemptFailed(item.id, reason);
      }
    }

    // 无法归类不是「成功」：资料没丢（仍在收件箱待整理），但不能报成 succeeded 让用户以为已归档。
    // failed（落库异常，条目仍 pending 待重试）优先级高于 degraded（skip/越权，留待整理）。
    const status = failed > 0 ? "partial" : degraded > 0 ? "degraded" : "succeeded";
    const organized = classified.length - failed - degraded;
    const summary = [
      `${organized} 项已归档`,
      degraded > 0 ? `${degraded} 项无法归类留在待整理` : "",
      failed > 0 ? `${failed} 项待重试` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const error = degradeReasons.size > 0 ? [...degradeReasons].join("; ") : undefined;
    const detailJson = JSON.stringify({ items: detailItems });
    this.repo.finishRun(run.id, status, summary, error, detailJson);
    return {
      ...run,
      status,
      result_summary: summary,
      result_detail: detailJson,
      ...(error ? { error } : {}),
      finished_at: new Date().toISOString(),
    };
  }
}
