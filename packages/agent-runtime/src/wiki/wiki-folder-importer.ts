/**
 * WikiFolderImporter — 扫描目录并批量摄入 Wiki 收件箱（引用优先，不移动原文件）
 *
 * 供 CLI / IPC / UI 共用：scan 预览候选，import 调用 WikiIngestHook 写入 inbox。
 * 文件系统操作通过注入的 fs 适配器完成，agent-runtime 不直接依赖 node:fs。
 */

import type { WikiInboxItemType } from "./types.js";
import type { WikiIngestHook } from "./wiki-ingest-hook.js";
import { shouldSkipWikiIngestPath } from "./wiki-ingest-filter.js";
import type { WikiRepo } from "./wiki-repo.js";

/** 目录项 stat 结果（由宿主注入） */
export interface WikiFolderImporterFsEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

/** 同步文件系统适配器 */
export interface WikiFolderImporterFs {
  statSync(path: string): { isFile: boolean; isDirectory: boolean; size: number } | null;
  readdirSync(path: string): readonly WikiFolderImporterFsEntry[];
}

/** 扫描/导入共用选项 */
export interface WikiFolderImporterBaseOptions {
  readonly agentId: string;
  readonly userId: string;
  /** 已规范化的绝对目录路径 */
  readonly dir: string;
  readonly recursive?: boolean;
  /** upload | output | auto（按路径段 uploads/ outputs/ 推断） */
  readonly itemType?: "upload" | "output" | "auto";
  readonly maxDepth?: number;
  /** 工作区根目录：用于将路径存为相对路径，并排除 wiki/ 下的文件 */
  readonly workspaceRoot?: string;
}

export interface WikiFolderCandidate {
  readonly path: string;
  readonly title: string;
  readonly size: number;
  readonly itemType: "upload" | "output";
  readonly skipReason: string | null;
  readonly alreadyInWiki: boolean;
}

export interface WikiFolderScanResult {
  readonly dir: string;
  readonly candidates: readonly WikiFolderCandidate[];
  readonly summary: {
    readonly total: number;
    readonly importable: number;
    readonly skipped: number;
    readonly alreadyInWiki: number;
  };
}

export interface WikiFolderImportResult {
  readonly dir: string;
  readonly dryRun: boolean;
  readonly imported: number;
  readonly skipped: number;
  readonly inboxIds: readonly string[];
  readonly candidates: readonly WikiFolderCandidate[];
}

/** 默认跳过的目录名（小写比较） */
const DEFAULT_EXCLUDE_DIR_NAMES = new Set([".git", "node_modules", "temp", "wiki"]);

/** 可导入的扩展名（文档/数据/媒体；代码与脚本见 wiki-ingest-filter） */
const IMPORTABLE_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "yaml", "yml", "toml", "ini", "csv", "tsv",
  "log", "xml", "html", "htm", "properties", "env",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "rtf", "odt",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico",
  "mp3", "wav", "flac", "m4a", "aac", "ogg",
  "mp4", "mov", "avi", "mkv", "webm",
  "zip", "7z", "rar", "tar", "gz",
]);

const DEFAULT_MAX_DEPTH = 8;

/**
 * 扫描目录并批量导入 Wiki 收件箱。
 */
export class WikiFolderImporter {
  constructor(
    private readonly repo: WikiRepo,
    private readonly hook: WikiIngestHook,
    private readonly fs: WikiFolderImporterFs,
  ) {}

  /**
   * 预览目录内可导入文件，不写库。
   */
  scan(options: WikiFolderImporterBaseOptions): WikiFolderScanResult {
    const candidates = this.collectCandidates(options);
    const importable = candidates.filter((c) => !c.skipReason && !c.alreadyInWiki);
    const skipped = candidates.filter((c) => c.skipReason !== null).length;
    const alreadyInWiki = candidates.filter((c) => c.alreadyInWiki).length;
    return {
      dir: options.dir,
      candidates,
      summary: {
        total: candidates.length,
        importable: importable.length,
        skipped,
        alreadyInWiki,
      },
    };
  }

  /**
   * 批量摄入收件箱；dryRun 时只返回 scan 结果形态。
   */
  import(
    options: WikiFolderImporterBaseOptions & { readonly dryRun?: boolean },
  ): WikiFolderImportResult {
    const candidates = this.collectCandidates(options);
    if (options.dryRun) {
      const importable = candidates.filter((c) => !c.skipReason && !c.alreadyInWiki);
      return {
        dir: options.dir,
        dryRun: true,
        imported: importable.length,
        skipped: candidates.length - importable.length,
        inboxIds: [],
        candidates,
      };
    }

    const inboxIds: string[] = [];
    let imported = 0;
    let skipped = 0;

    for (const c of candidates) {
      if (c.skipReason || c.alreadyInWiki) {
        skipped += 1;
        continue;
      }
      const id =
        c.itemType === "upload"
          ? this.hook.ingestUpload(options.agentId, options.userId, c.path, c.title)
          : this.hook.ingestOutput(options.agentId, options.userId, c.path, c.title);
      if (id) {
        imported += 1;
        inboxIds.push(id);
      } else {
        skipped += 1;
      }
    }

    return {
      dir: options.dir,
      dryRun: false,
      imported,
      skipped,
      inboxIds,
      candidates,
    };
  }

  /**
   * 递归收集目录下候选文件。
   */
  private collectCandidates(options: WikiFolderImporterBaseOptions): WikiFolderCandidate[] {
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const results: WikiFolderCandidate[] = [];
    this.walkDir(options.dir, options.dir, 0, maxDepth, options, results);
    return results;
  }

  /**
   * 深度优先遍历目录，填充候选列表。
   */
  private walkDir(
    rootDir: string,
    currentDir: string,
    depth: number,
    maxDepth: number,
    options: WikiFolderImporterBaseOptions,
    out: WikiFolderCandidate[],
  ): void {
    if (depth > maxDepth) return;

    let entries: readonly WikiFolderImporterFsEntry[];
    try {
      entries = this.fs.readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const absPath = joinPath(currentDir, entry.name);
      if (entry.isDirectory) {
        if (options.recursive !== false && !shouldExcludeDir(entry.name)) {
          this.walkDir(rootDir, absPath, depth + 1, maxDepth, options, out);
        }
        continue;
      }
      if (!entry.isFile) continue;

      const sourcePath = toSourcePath(absPath, options.workspaceRoot);
      const skipReason = resolveSkipReason(sourcePath, entry.name, options.workspaceRoot);
      const stat = this.fs.statSync(absPath);
      const size = stat?.size ?? 0;
      const itemType = resolveItemType(sourcePath, options.itemType);
      const alreadyInWiki = this.repo.isSourcePathKnown(
        options.agentId,
        options.userId,
        sourcePath,
      );

      out.push({
        path: sourcePath,
        title: entry.name,
        size,
        itemType,
        skipReason,
        alreadyInWiki,
      });
    }
  }
}

/**
 * 判断目录名是否应跳过（隐藏目录、wiki 库自身等）。
 */
function shouldExcludeDir(name: string): boolean {
  const lower = name.toLowerCase();
  if (name.startsWith(".") && name !== ".") return true;
  return DEFAULT_EXCLUDE_DIR_NAMES.has(lower);
}

/**
 * 解析跳过原因；null 表示可导入。
 */
function resolveSkipReason(
  sourcePath: string,
  fileName: string,
  workspaceRoot?: string,
): string | null {
  const ingestSkip = shouldSkipWikiIngestPath(sourcePath, fileName);
  if (ingestSkip) return ingestSkip;

  const normalized = sourcePath.replace(/\\/g, "/").toLowerCase();

  if (workspaceRoot) {
    const rel = toRelativePosix(sourcePath, workspaceRoot);
    if (rel && (rel === "wiki" || rel.startsWith("wiki/"))) {
      return "ignored:wiki-vault";
    }
  } else if (normalized.startsWith("wiki/") || normalized.includes("/wiki/")) {
    return "ignored:wiki-vault";
  }

  const ext = fileExtension(fileName);
  if (!ext || !IMPORTABLE_EXTENSIONS.has(ext)) return "ignored:extension";
  return null;
}

/**
 * 按路径推断 itemType；auto 时看 uploads/ 与 outputs/ 段。
 */
function resolveItemType(
  sourcePath: string,
  explicit?: "upload" | "output" | "auto",
): "upload" | "output" {
  if (explicit === "upload" || explicit === "output") return explicit;
  const normalized = sourcePath.replace(/\\/g, "/").toLowerCase();
  if (normalized.startsWith("uploads/") || normalized.includes("/uploads/")) {
    return "upload";
  }
  return "output";
}

/**
 * 将绝对路径转为入库用的 sourcePath（工作区内用相对路径）。
 */
function toSourcePath(absPath: string, workspaceRoot?: string): string {
  if (!workspaceRoot) return absPath.replace(/\\/g, "/");
  const rel = toRelativePosix(absPath, workspaceRoot);
  if (rel && !rel.startsWith("..") && !isAbsolutePath(rel)) {
    return rel;
  }
  return absPath.replace(/\\/g, "/");
}

/**
 * 计算相对 POSIX 路径；失败返回 null。
 */
function toRelativePosix(absPath: string, workspaceRoot: string): string | null {
  const a = normalizeSlashes(absPath);
  const root = normalizeSlashes(workspaceRoot).replace(/\/+$/, "");
  if (!a.toLowerCase().startsWith(root.toLowerCase())) return null;
  const rest = a.slice(root.length).replace(/^\/+/, "");
  return rest || null;
}

function fileExtension(fileName: string): string | null {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) return null;
  return fileName.slice(lastDot + 1).toLowerCase();
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:[/\\]|\/)/.test(p);
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}
