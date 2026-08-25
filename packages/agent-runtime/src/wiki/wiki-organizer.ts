/**
 * WikiOrganizer — 整理主流程：取件 → 内容提取 → 批量分类 → 落库 → 写运行日志
 *
 * 失败不静默：分类整批失败时条目保持 pending 并记 attempt_count，交由退避重试
 * （见 wiki-organize-queue.ts 的 computeBackoffDelayMs）；单条落库失败降级到 inbox/
 * 而非丢弃，整批不因一条脏数据崩掉。
 */

import { classifyBatch } from "./wiki-classifier.js";
import type { WikiContentExtractor } from "./wiki-content-extractor.js";
import type { WikiRepo } from "./wiki-repo.js";
import type { WikiInboxItemType, WikiOrganizeRun } from "./types.js";

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
      this.repo.finishRun(run.id, "failed", undefined, message);
      return { ...run, status: "failed", error: message, finished_at: new Date().toISOString() };
    }

    const byId = new Map(enriched.map((i) => [i.id, i]));
    let failed = 0;
    for (const result of classified) {
      const item = byId.get(result.inboxId);
      if (!item) continue;
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
        this.savePageWithFallback(agentId, userId, result, source.id);
        this.repo.markInboxOrganized(item.id, source.id);
      } catch (err) {
        failed += 1;
        this.repo.markInboxAttemptFailed(item.id, (err as Error).message);
      }
    }

    const status = failed === 0 ? "succeeded" : "partial";
    const summary = `${classified.length - failed} 项已归档${failed > 0 ? `，${failed} 项待重试` : ""}`;
    this.repo.finishRun(run.id, status, summary);
    return { ...run, status, result_summary: summary, finished_at: new Date().toISOString() };
  }

  /** 路径非法（分类器已校验，但 savePage 是最后防线）时降级到 inbox/<收件箱id> */
  private savePageWithFallback(
    agentId: string,
    userId: string,
    result: { readonly inboxId: string; readonly path: string; readonly title: string; readonly summaryMd: string },
    sourceRef: string,
  ): void {
    const common = {
      agentId,
      userId,
      title: result.title,
      contentMd: result.summaryMd,
      editor: "ai" as const,
      sourceRef,
    };
    try {
      this.repo.savePage({ ...common, path: result.path });
    } catch {
      this.repo.savePage({ ...common, path: `inbox/${result.inboxId}` });
    }
  }
}
