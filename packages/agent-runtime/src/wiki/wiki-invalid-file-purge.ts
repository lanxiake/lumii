/**
 * Wiki 不合规文件清理：删除不应被摄入的代码/脚本类文件
 */

import type { WikiRepo } from "./wiki-repo.js";
import type { WikiSource } from "./types.js";
import { shouldSkipWikiIngestPath } from "./wiki-ingest-filter.js";

export interface WikiInvalidFilePurgeResult {
  readonly deleted: number;
  readonly sources: readonly WikiSource[];
}

/**
 * 列出所有不符合摄入规则的资料（代码/脚本/临时文件等）。
 */
export function listInvalidWikiFiles(
  repo: WikiRepo,
  agentId: string,
  userId: string,
): readonly WikiSource[] {
  const allSources = repo.listSources(agentId, userId).filter((s) => !s.archived_at);
  const invalid: WikiSource[] = [];

  for (const source of allSources) {
    // origin_url 来源的文件不检查（网页/URL类资料）
    if (source.origin_url?.trim()) continue;

    // 没有 source_path 的纯内容资料不检查
    if (!source.source_path?.trim()) continue;

    // 按 source_path 的真实文件名判定。title 是展示用标题（分类器会改写，
    // 常常没有扩展名或带无关的点），拿它当文件名会误判成不合规文件而误删。
    const skipReason = shouldSkipWikiIngestPath(source.source_path);
    if (skipReason) {
      invalid.push(source);
    }
  }

  return invalid;
}

/**
 * 删除不符合摄入规则的资料；可选在删库前清理 vault 侧车（由宿主注入）。
 */
export function purgeInvalidWikiFiles(
  repo: WikiRepo,
  agentId: string,
  userId: string,
  onBeforeDelete?: (sources: readonly WikiSource[]) => void,
): WikiInvalidFilePurgeResult {
  const sources = listInvalidWikiFiles(repo, agentId, userId);
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
