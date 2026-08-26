/**
 * WikiOrganizer — 整理主流程：取件 → 内容提取 → 批量分类 → 落库 → 写运行日志
 *
 * 失败不静默：分类整批失败时条目保持 pending 并记 attempt_count，交由退避重试
 * （见 wiki-organize-queue.ts 的 computeBackoffDelayMs）；单条落库失败降级到 inbox/
 * 而非丢弃，整批不因一条脏数据崩掉。
 */

import { classifyBatch, type ClassifiedItem } from "./wiki-classifier.js";
import type { WikiContentExtractor } from "./wiki-content-extractor.js";
import type { WikiRepo } from "./wiki-repo.js";
import type {
  WikiInboxItem,
  WikiInboxItemType,
  WikiOrganizeRun,
  WikiOrganizeRunDetailExtract,
  WikiOrganizeRunDetailItem,
  WikiPage,
} from "./types.js";

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

/**
 * 由分类结果与落库成败组装单条运行明细。
 */
function buildDetailItem(
  item: WikiInboxItem,
  result: ClassifiedItem,
  extract: WikiOrganizeRunDetailExtract,
  savedPath: string,
  outcome: WikiOrganizeRunDetailItem["outcome"],
  reason?: string,
): WikiOrganizeRunDetailItem {
  return {
    inboxId: result.inboxId,
    title: result.title,
    path: savedPath,
    mediaType: item.media_type,
    outcome,
    ...(reason ? { reason } : {}),
    extract,
  };
}

export class WikiOrganizer {
  constructor(
    private readonly repo: WikiRepo,
    private readonly callLLM: (prompt: string) => Promise<string>,
    private readonly extractor: WikiContentExtractor,
  ) {}

  /**
   * 整理一批同类型待办条目。取件为空返回 null（无运行可言）。
   * 返回的 run 已是终态（succeeded / partial / failed）。
   */
  async organizeBatch(
    agentId: string,
    userId: string,
    itemType: WikiInboxItemType,
    batchSize = 10,
  ): Promise<WikiOrganizeRun | null> {
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

    const run = this.repo.createRun(
      agentId,
      userId,
      items.map((i) => i.id),
    );

    let classified;
    try {
      classified = await classifyBatch(enriched, this.callLLM);
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
      try {
        const source = this.repo.createSource({
          agentId,
          userId,
          title: result.title,
          sourcePath: item.source_path ?? undefined,
          contentMd: item.content_preview ?? undefined,
          contentHash: item.content_hash ?? undefined,
          mediaType: item.media_type,
          extractedText: item.content_preview ?? undefined,
        });
        const savedPage = this.savePageWithFallback(agentId, userId, result, source.id);
        this.repo.markInboxOrganized(item.id, source.id);
        this.attachMediaIfApplicable(savedPage.id, source.id, item);
        if (result.degraded) {
          degraded += 1;
          if (result.degradeReason) degradeReasons.add(result.degradeReason);
          detailItems.push(
            buildDetailItem(item, result, extract, savedPage.path, "degraded", result.degradeReason),
          );
        } else if (result.corrected) {
          detailItems.push(
            buildDetailItem(item, result, extract, savedPage.path, "corrected", result.correctReason),
          );
        } else {
          detailItems.push(buildDetailItem(item, result, extract, savedPage.path, "archived"));
        }
      } catch (err) {
        failed += 1;
        const reason = (err as Error).message;
        detailItems.push(
          buildDetailItem(item, result, extract, result.path || "", "failed", reason),
        );
        this.repo.markInboxAttemptFailed(item.id, reason);
      }
    }

    // 分类降级不是「成功」：资料没丢，但落点是兜底的 inbox/，用户需要知道并可手动归档。
    // failed（落库异常，条目仍 pending 待重试）优先级高于 degraded（已归档但落点兜底）。
    const status = failed > 0 ? "partial" : degraded > 0 ? "degraded" : "succeeded";
    const organized = classified.length - failed;
    const corrected = detailItems.filter((d) => d.outcome === "corrected").length;
    const summary = [
      `${organized} 项已归档`,
      corrected > 0 ? `其中 ${corrected} 项纠正到 sources/` : "",
      degraded > 0 ? `其中 ${degraded} 项分类降级到 inbox/` : "",
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

  /** 路径非法（分类器已校验，但 savePage 是最后防线）时降级到 inbox/<收件箱id> */
  private savePageWithFallback(
    agentId: string,
    userId: string,
    result: { readonly inboxId: string; readonly path: string; readonly title: string; readonly summaryMd: string },
    sourceRef: string,
  ): WikiPage {
    const common = {
      agentId,
      userId,
      title: result.title,
      contentMd: result.summaryMd,
      editor: "ai" as const,
      sourceRef,
    };
    try {
      return this.repo.savePage({ ...common, path: result.path });
    } catch {
      return this.repo.savePage({ ...common, path: `inbox/${result.inboxId}` });
    }
  }

  /**
   * 图片/音频/视频资料在建页时顺手登记为该页附件（P1 §7.2），复用既有资料路径
   * 不重复存储文件。文档类不登记——文档正文已内嵌到页面 content_md，无需附件引用。
   */
  private attachMediaIfApplicable(pageId: string, sourceId: string, item: WikiInboxItem): void {
    if (item.media_type === "document") return;
    if (!item.source_path) return;
    this.repo.attachFile({
      pageId,
      sourceId,
      filePath: item.source_path,
      mediaType: item.media_type,
      displayName: item.title,
    });
  }
}
