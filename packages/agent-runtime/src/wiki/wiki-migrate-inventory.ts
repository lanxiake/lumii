/**
 * Wiki 库级迁移 — 源目录簇盘点（零 LLM）
 *
 * 按源文件夹聚簇 inbox 条目，附带目录树与 wiki 库内占用/锚点摘要，
 * 供 MapPlan LLM 以文件夹为决策单元规划映射。
 *
 * 设计：docs/design/记忆设计/2026-09-05-wiki-library-migrate-design.md §3.1
 */

import type { WikiInboxItem } from "./types.js";
import {
  buildDirectoryTreeText,
  buildTopicOccupancySummary,
} from "./wiki-classify-context.js";
import { buildLibraryInventory } from "./wiki-library-inventory.js";
import type { LibraryInventory } from "./wiki-library-inventory.js";
import type { WikiRepo } from "./wiki-repo.js";
import type { WikiTopicTree } from "./wiki-topic-tree.js";

/** 相对 importRoot 的源文件夹簇 */
export interface MigrateFolderCluster {
  /** 相对 importRoot 的文件夹路径；根下文件用 "" */
  readonly folderRel: string;
  readonly fileCount: number;
  /** 最多 3 条文件名样例 */
  readonly sampleNames: readonly string[];
  readonly inboxIds: readonly string[];
}

/** 迁移盘点输出：源目录簇 + wiki 侧占用摘要 */
export interface MigrateInventory {
  readonly importRoot: string;
  readonly directoryTreeText: string;
  readonly clusters: readonly MigrateFolderCluster[];
  /** 各小类已有资料数量与样例 */
  readonly wikiOccupancyText: string;
  /** 各叶子目录锚点样例（每叶 ≤3） */
  readonly wikiAnchorsText: string;
  /** 扫描阶段因已在 wiki 而跳过的文件数 */
  readonly alreadyInWikiCount: number;
  /** 本次待迁移 inbox 条数 */
  readonly pendingCount: number;
}

/** buildMigrateInventory 入参 */
export interface BuildMigrateInventoryParams {
  readonly importRoot: string;
  readonly workspaceRoot?: string;
  readonly inboxItems: readonly WikiInboxItem[];
  readonly repo: WikiRepo;
  readonly agentId: string;
  readonly userId: string;
  readonly topicTree: WikiTopicTree;
  /** vault 根路径，供 buildLibraryInventory 计算锚点 */
  readonly vaultRoot: string;
  /** 扫描时已跳过（已在 wiki）的文件数，默认 0 */
  readonly alreadyInWikiCount?: number;
}

const MAX_SAMPLE_NAMES = 3;

/**
 * 对一批 inbox 条目做零 LLM 盘点：按源父目录聚簇，并附带 wiki 库内占用与锚点文本。
 */
export function buildMigrateInventory(params: BuildMigrateInventoryParams): MigrateInventory {
  const {
    importRoot,
    workspaceRoot,
    inboxItems,
    repo,
    agentId,
    userId,
    topicTree,
    vaultRoot,
    alreadyInWikiCount = 0,
  } = params;

  const importRootNorm = normalizePosix(importRoot).replace(/\/+$/, "");
  const paths = inboxItems.map((item) => item.source_path ?? item.title);
  const directoryTreeText = buildDirectoryTreeText(paths, importRootNorm, workspaceRoot);

  const clusterMap = new Map<string, { inboxIds: string[]; sampleNames: string[] }>();

  for (const item of inboxItems) {
    const folderRel = folderRelFromSourcePath(item.source_path ?? item.title, importRootNorm, workspaceRoot);
    const sampleName = basename(item.source_path ?? item.title) || item.title;
    const bucket = clusterMap.get(folderRel);
    if (bucket) {
      bucket.inboxIds.push(item.id);
      if (bucket.sampleNames.length < MAX_SAMPLE_NAMES && !bucket.sampleNames.includes(sampleName)) {
        bucket.sampleNames.push(sampleName);
      }
    } else {
      clusterMap.set(folderRel, { inboxIds: [item.id], sampleNames: [sampleName] });
    }
  }

  const clusters: MigrateFolderCluster[] = [...clusterMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folderRel, { inboxIds, sampleNames }]) => ({
      folderRel,
      fileCount: inboxIds.length,
      sampleNames: sampleNames.slice(0, MAX_SAMPLE_NAMES),
      inboxIds,
    }));

  const libraryInv = buildLibraryInventory(repo, agentId, userId, { kind: "all" }, vaultRoot);
  const wikiOccupancyText = buildTopicOccupancySummary(repo, agentId, userId, topicTree);
  const wikiAnchorsText = buildWikiAnchorsText(libraryInv);

  return {
    importRoot: importRootNorm,
    directoryTreeText,
    clusters,
    wikiOccupancyText,
    wikiAnchorsText,
    alreadyInWikiCount,
    pendingCount: inboxItems.length,
  };
}

/**
 * 从 LibraryInventory 叶子占用生成锚点样例文本（对齐 P5 buildLibraryImpression 锚点段）。
 */
function buildWikiAnchorsText(inv: LibraryInventory): string {
  const anchorLines = inv.leaves
    .filter((l) => l.anchors.length > 0)
    .map((l) => `- ${l.category}/${l.subtopic ?? "未细分"}：${l.anchors.join("、")}`);

  if (anchorLines.length === 0) {
    return "（资料库中尚无已分类样例）";
  }
  return anchorLines.join("\n");
}

/**
 * 计算 source_path 的父目录相对 importRoot 的路径；根下文件返回 ""。
 */
function folderRelFromSourcePath(
  sourcePath: string,
  importRoot: string,
  workspaceRoot?: string,
): string {
  const parentDir = dirname(normalizePosix(sourcePath));
  const root = normalizePosix(importRoot).replace(/\/+$/, "");

  if (parentDir.toLowerCase() === root.toLowerCase()) {
    return "";
  }

  if (parentDir.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return parentDir.slice(root.length + 1);
  }

  if (workspaceRoot) {
    const ws = normalizePosix(workspaceRoot).replace(/\/+$/, "");
    const absParent = isAbsolutePosix(parentDir)
      ? parentDir
      : `${ws}/${parentDir}`.replace(/\/+/g, "/");
    const absRoot = isAbsolutePosix(root) ? root : `${ws}/${root}`.replace(/\/+/g, "/");
    if (absParent.toLowerCase().startsWith(`${absRoot.toLowerCase()}/`)) {
      return absParent.slice(absRoot.length + 1);
    }
    if (absParent.toLowerCase() === absRoot.toLowerCase()) {
      return "";
    }
  }

  return parentDir;
}

function normalizePosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function isAbsolutePosix(p: string): boolean {
  return p.startsWith("/") || /^[a-zA-Z]:/.test(p);
}

function dirname(p: string): string {
  const norm = normalizePosix(p).replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(0, idx) : "";
}

function basename(p: string): string {
  const norm = normalizePosix(p).replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}
