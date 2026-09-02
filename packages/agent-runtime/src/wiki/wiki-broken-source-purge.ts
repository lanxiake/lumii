/**
 * 扫描并删除来源已失效的 Wiki 资料（仅 broken_source，不碰 stale/duplicate）。
 */

import type { WikiRepo } from "./wiki-repo.js";
import { WikiCleanupScanner, type WikiCleanupScanOptions } from "./wiki-cleanup.js";
import type { WikiSource } from "./types.js";

export interface WikiBrokenSourcePurgeResult {
  readonly deleted: number;
  readonly sources: readonly WikiSource[];
}

/**
 * 列出所有来源失效的资料条目。
 */
export function listBrokenWikiSources(
  scanner: WikiCleanupScanner,
  agentId: string,
  userId: string,
  options: WikiCleanupScanOptions = {},
): readonly WikiSource[] {
  return scanner
    .scan(agentId, userId, options)
    .filter((s) => s.reason === "broken_source")
    .map((s) => s.source);
}

/**
 * 删除来源失效的资料；可选在删库前清理 vault 侧车（由宿主注入）。
 */
export function purgeBrokenWikiSources(
  repo: WikiRepo,
  scanner: WikiCleanupScanner,
  agentId: string,
  userId: string,
  options: WikiCleanupScanOptions = {},
  onBeforeDelete?: (sources: readonly WikiSource[]) => void,
): WikiBrokenSourcePurgeResult {
  const sources = listBrokenWikiSources(scanner, agentId, userId, options);
  if (sources.length === 0) {
    return { deleted: 0, sources: [] };
  }
  onBeforeDelete?.(sources);
  const deleted = repo.deleteSources(
    agentId,
    userId,
    sources.map((s) => s.id),
  );
  return { deleted, sources };
}
