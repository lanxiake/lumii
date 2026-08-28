/**
 * WikiCleanupScanner — 归档清理建议扫描（只读，不执行任何写操作）
 *
 * 设计：`docs/plans/记忆重构/2026-08-26-wiki-p1-implementation.md` Task 4 §6.1
 * 三条规则：长期未用 / 来源失效 / 内容重复。扫描结果只是「待清理清单」，
 * 一切写操作（归档/恢复/删除）由用户在 UI 确认后调用 WikiRepo 的批量方法。
 */

import type { WikiRepo } from "./wiki-repo.js";
import type { WikiSource } from "./types.js";

export type WikiCleanupReason = "stale" | "broken_source" | "duplicate_content";

export interface WikiCleanupSuggestion {
  readonly source: WikiSource;
  readonly reason: WikiCleanupReason;
  /** duplicate_content 时指向被保留的那一条（content_hash 相同、created_at 最早） */
  readonly duplicateOfSourceId?: string;
}

export interface WikiCleanupScanOptions {
  /** 长期未用判定天数阈值，默认 90 天 */
  readonly staleDays?: number;
  /** 判断来源文件是否仍存在（宿主注入，agent-runtime 不直接依赖 node:fs） */
  readonly fileExists?: (path: string) => boolean;
}

const DEFAULT_STALE_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class WikiCleanupScanner {
  constructor(private readonly repo: WikiRepo) {}

  /**
   * 扫描三类清理建议。资料条目已归档（archived_at 非空）的不再重复建议。
   * 同一条资料若命中多条规则，只取优先级最高的一条：来源失效 > 内容重复 > 长期未用
   * （失效最紧急，重复次之，未用最宽松）。
   */
  scan(agentId: string, userId: string, options: WikiCleanupScanOptions = {}): readonly WikiCleanupSuggestion[] {
    const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
    const sources = this.repo.listSources(agentId, userId).filter((s) => !s.archived_at);

    const suggestions = new Map<string, WikiCleanupSuggestion>();

    // 规则：内容重复——content_hash 相同且非空，按 created_at 分组，保留最早一条
    const byHash = new Map<string, WikiSource[]>();
    for (const s of sources) {
      if (!s.content_hash) continue;
      const group = byHash.get(s.content_hash) ?? [];
      group.push(s);
      byHash.set(s.content_hash, group);
    }
    for (const group of byHash.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => a.created_at.localeCompare(b.created_at));
      const keep = sorted[0]!;
      for (const dup of sorted.slice(1)) {
        suggestions.set(dup.id, { source: dup, reason: "duplicate_content", duplicateOfSourceId: keep.id });
      }
    }

    // 规则：来源失效——source_path 非空且文件已不存在（未注入 fileExists 时跳过该规则）
    if (options.fileExists) {
      for (const s of sources) {
        if (suggestions.has(s.id)) continue;
        if (s.source_path && !options.fileExists(s.source_path)) {
          suggestions.set(s.id, { source: s, reason: "broken_source" });
        }
      }
    }

    // 规则：长期未用——资料自身的使用统计（wiki_sources.last_used / use_count）判定
    // 归档不再写 wiki_pages，使用信号只落在资料行上（touchSource 维护），
    // 所以这里不能再 join 页面判使用情况：那样每条老资料都会被误判为「长期未用」。
    // 用过（use_count > 0）就看最后一次使用时间，没用过就看创建时间。
    const staleThresholdMs = Date.now() - staleDays * MS_PER_DAY;
    for (const s of sources) {
      if (suggestions.has(s.id)) continue;
      const lastActivity = s.use_count > 0 && s.last_used ? s.last_used : s.created_at;
      const lastActivityMs = new Date(lastActivity).getTime();
      if (Number.isNaN(lastActivityMs) || lastActivityMs >= staleThresholdMs) continue;
      suggestions.set(s.id, { source: s, reason: "stale" });
    }

    return [...suggestions.values()];
  }
}
