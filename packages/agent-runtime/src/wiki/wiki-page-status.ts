/**
 * WikiPageStatusScanner — 页面状态规则层扫描（无 LLM）
 *
 * 设计：`docs/plans/记忆重构/2026-08-26-wiki-p2-implementation.md` Task 4
 * 规则：来源失效 → outdated；长期未用 → archived；否定表述 → doubtful。
 * 候选存 wiki_index_meta（前缀 page_status_candidate:），确认后才写 wiki_pages.status。
 */

import type { WikiRepo } from "./wiki-repo.js";
import type { WikiPage, WikiPageStatus } from "./types.js";

const CANDIDATE_KEY_PREFIX = "page_status_candidate:";

/** 否定表述关键词（doubtful） */
const DOUBTFUL_PATTERNS = ["已失效", "已废弃", "不再适用", "已下线"];

export type WikiStatusScanReason = "broken_source" | "stale" | "doubtful_phrase";

export interface WikiPageStatusCandidate {
  readonly pageId: string;
  readonly title: string;
  readonly path: string;
  readonly suggestedStatus: Exclude<WikiPageStatus, "active">;
  readonly reason: WikiStatusScanReason;
}

export interface WikiPageStatusScanOptions {
  readonly staleDays?: number;
  readonly fileExists?: (path: string) => boolean;
}

const DEFAULT_STALE_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function candidateKey(agentId: string, userId: string, pageId: string): string {
  return `${CANDIDATE_KEY_PREFIX}${agentId}:${userId}:${pageId}`;
}

export class WikiPageStatusScanner {
  constructor(private readonly repo: WikiRepo) {}

  /**
   * 扫描并写入候选。同一页只保留优先级最高规则：broken_source > doubtful_phrase > stale。
   */
  scan(
    agentId: string,
    userId: string,
    options: WikiPageStatusScanOptions = {},
  ): readonly WikiPageStatusCandidate[] {
    const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
    const pages = this.repo.listPages(agentId, userId);
    const byPage = new Map<string, WikiPageStatusCandidate>();

    for (const page of pages) {
      if (page.status !== "active") continue;

      const broken = this.matchBrokenSource(agentId, userId, page, options.fileExists);
      if (broken) {
        byPage.set(page.id, broken);
        continue;
      }

      const doubtful = this.matchDoubtful(page);
      if (doubtful) {
        byPage.set(page.id, doubtful);
        continue;
      }

      const stale = this.matchStale(page, staleDays);
      if (stale) byPage.set(page.id, stale);
    }

    const candidates = [...byPage.values()];
    for (const c of candidates) {
      this.repo.setIndexMeta(candidateKey(agentId, userId, c.pageId), JSON.stringify(c));
    }
    return candidates;
  }

  /** 列出已写入的状态候选 */
  listCandidates(agentId: string, userId: string): readonly WikiPageStatusCandidate[] {
    const prefix = `${CANDIDATE_KEY_PREFIX}${agentId}:${userId}:`;
    return this.repo
      .listIndexMetaByPrefix(prefix)
      .map((row) => {
        try {
          return JSON.parse(row.value) as WikiPageStatusCandidate;
        } catch {
          return null;
        }
      })
      .filter((c): c is WikiPageStatusCandidate => c !== null);
  }

  /** 确认：更新页面 status 并清除候选 */
  confirm(
    agentId: string,
    userId: string,
    pageId: string,
    status: Exclude<WikiPageStatus, "active">,
  ): void {
    const key = candidateKey(agentId, userId, pageId);
    const raw = this.repo.getIndexMeta(key);
    if (!raw) throw new Error(`状态候选不存在: ${pageId}`);
    const page = this.repo.findPageById(pageId);
    if (!page || page.agent_id !== agentId || page.user_id !== userId) {
      throw new Error(`页面不存在: ${pageId}`);
    }
    this.repo.updatePageStatus(pageId, status);
    this.repo.deleteIndexMeta(key);
  }

  /** 拒绝：仅清除候选，不改页面 status */
  reject(agentId: string, userId: string, pageId: string): void {
    this.repo.deleteIndexMeta(candidateKey(agentId, userId, pageId));
  }

  private matchBrokenSource(
    agentId: string,
    userId: string,
    page: WikiPage,
    fileExists?: (path: string) => boolean,
  ): WikiPageStatusCandidate | null {
    if (!fileExists) return null;
    const revs = this.repo.listRevisions(page.id);
    for (const rev of revs) {
      if (!rev.source_ref || rev.source_ref.startsWith("rollback:") || rev.source_ref.startsWith("synthesis:")) {
        continue;
      }
      const source = this.repo.findSourceById(rev.source_ref);
      if (!source || source.agent_id !== agentId || source.user_id !== userId) continue;
      if (source.source_path && !fileExists(source.source_path)) {
        return {
          pageId: page.id,
          title: page.title,
          path: page.path,
          suggestedStatus: "outdated",
          reason: "broken_source",
        };
      }
    }
    return null;
  }

  private matchDoubtful(page: WikiPage): WikiPageStatusCandidate | null {
    if (page.category === "inbox") return null;
    const hit = DOUBTFUL_PATTERNS.some((p) => page.content_md.includes(p));
    if (!hit) return null;
    return {
      pageId: page.id,
      title: page.title,
      path: page.path,
      suggestedStatus: "doubtful",
      reason: "doubtful_phrase",
    };
  }

  private matchStale(page: WikiPage, staleDays: number): WikiPageStatusCandidate | null {
    const threshold = Date.now() - staleDays * MS_PER_DAY;
    const createdMs = new Date(page.created_at).getTime();
    if (Number.isNaN(createdMs) || createdMs >= threshold) return null;
    if (page.last_used) {
      const usedMs = new Date(page.last_used).getTime();
      if (!Number.isNaN(usedMs) && usedMs >= threshold) return null;
    } else if (page.use_count > 0) {
      return null;
    }
    // last_used 空且 created 过旧 → archived 候选
    if (page.last_used === null) {
      return {
        pageId: page.id,
        title: page.title,
        path: page.path,
        suggestedStatus: "archived",
        reason: "stale",
      };
    }
    return null;
  }
}
