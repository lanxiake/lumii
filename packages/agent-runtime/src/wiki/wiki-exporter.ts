/**
 * WikiExporter — 按页面 path 结构批量导出为 Markdown
 *
 * 设计：`docs/plans/记忆重构/2026-08-26-wiki-p1-implementation.md` Task 7 §9.1
 * agent-runtime 不直接依赖 node:fs——文件系统操作通过 WikiExporterDeps 注入，
 * 宿主（apps/windows 主进程）负责实际写盘。逐页失败返回清单，不静默跳过。
 * `[[标题]]` 链接语法不转换、原样保留，兼容 Obsidian。
 */

import type { WikiPage, WikiSource } from "./types.js";

export interface WikiExporterDeps {
  /** 递归创建目录（已存在不报错，同 fs.mkdir 的 recursive:true 语义） */
  readonly mkdir: (dirPath: string) => Promise<void>;
  /** 写入文本文件（覆盖已存在文件；调用方已保证目标路径不冲突） */
  readonly writeFile: (filePath: string, content: string) => Promise<void>;
  /** 复制文件（供附件导出）；未提供时不导出附件文件 */
  readonly copyFile?: (src: string, dest: string) => Promise<void>;
  /** 路径拼接（宿主按平台分隔符实现，agent-runtime 不依赖 node:path） */
  readonly joinPath: (...segments: string[]) => string;
}

export interface WikiExportOptions {
  readonly includeSources?: boolean;
  readonly includeAttachments?: boolean;
}

export interface WikiExportFailure {
  readonly path: string;
  readonly error: string;
}

export interface WikiExportResult {
  readonly exported: number;
  readonly failed: readonly WikiExportFailure[];
}

/** Windows 非法文件名字符 + 保留名，替换为下划线 */
// 含 `/` 与 `\`：小类名允许含斜杠（如「项目/任务资料」），但作为单个路径段使用时
// 斜杠会被当成分隔符，凭空造出一层嵌套目录。这里一并替换掉。
const ILLEGAL_FILENAME_CHARS = /[<>:"|?*/\\\x00-\x1f]/g;

/** 安全化单个路径段：替换非法字符，去除首尾空白与点（Windows 不允许以点/空格结尾） */
export function sanitizeFilenameSegment(segment: string): string {
  const cleaned = segment.replace(ILLEGAL_FILENAME_CHARS, "_").trim();
  const trimmedTrailing = cleaned.replace(/[.\s]+$/, "");
  return trimmedTrailing || "_";
}

/**
 * 校验导出目标路径段是否安全：不含空段、`..`、绝对路径逃逸。
 * 复用 validateWikiPath 的思路，但导出场景任意分类都可用，只查逃逸不查白名单分类。
 */
export function isPathTraversalSafe(pathStr: string): boolean {
  if (!pathStr || pathStr.startsWith("/") || pathStr.startsWith("\\")) return false;
  const segments = pathStr.split(/[/\\]/);
  return !segments.some((s) => s.length === 0 || s === "." || s === "..");
}

interface ManifestEntry {
  readonly path: string;
  readonly title: string;
  readonly version: number;
}

export class WikiExporter {
  constructor(private readonly deps: WikiExporterDeps) {}

  /**
   * 导出页面列表到目标目录。按 path 结构建目录树，每页写为 `<title 安全化>.md`
   * （用标题而非 path 末段命名文件，path 末段仅用于目录结构）。
   * 文件名冲突时追加序号，不覆盖已导出的同批次文件。
   */
  async exportPages(
    targetDir: string,
    pages: readonly WikiPage[],
    options: WikiExportOptions = {},
    context?: { readonly sources?: readonly WikiSource[]; readonly attachmentsByPageId?: ReadonlyMap<string, readonly { filePath: string; displayName: string }[]> },
  ): Promise<WikiExportResult> {
    const failed: WikiExportFailure[] = [];
    const manifestEntries: ManifestEntry[] = [];
    const usedFilePaths = new Set<string>();

    for (const page of pages) {
      try {
        if (!isPathTraversalSafe(page.path)) {
          throw new Error(`路径逃逸被拒绝: ${page.path}`);
        }
        const segments = page.path.split("/").map(sanitizeFilenameSegment);
        const dirSegments = segments.slice(0, -1);
        const dirPath = dirSegments.length > 0 ? this.deps.joinPath(targetDir, ...dirSegments) : targetDir;
        await this.deps.mkdir(dirPath);

        const fileName = this.resolveUniqueFileName(dirPath, page.title, usedFilePaths);
        const filePath = this.deps.joinPath(dirPath, fileName);

        const frontmatter = [
          "---",
          `title: ${page.title}`,
          `category: ${page.category}`,
          `version: ${page.version}`,
          `updatedAt: ${page.updated_at}`,
          "---",
          "",
        ].join("\n");
        await this.deps.writeFile(filePath, frontmatter + page.content_md);

        if (options.includeAttachments && context?.attachmentsByPageId && this.deps.copyFile) {
          await this.exportAttachments(dirPath, page.id, context.attachmentsByPageId);
        }

        manifestEntries.push({ path: page.path, title: page.title, version: page.version });
      } catch (err) {
        failed.push({ path: page.path, error: (err as Error).message });
      }
    }

    if (options.includeSources && context?.sources) {
      await this.exportSources(targetDir, context.sources, failed);
    }

    await this.writeManifest(targetDir, manifestEntries, failed, options);

    return { exported: manifestEntries.length, failed };
  }

  private resolveUniqueFileName(dirPath: string, title: string, used: Set<string>): string {
    const baseName = sanitizeFilenameSegment(title);
    let candidate = `${baseName}.md`;
    let counter = 1;
    let key = this.deps.joinPath(dirPath, candidate);
    while (used.has(key)) {
      candidate = `${baseName}-${counter}.md`;
      counter += 1;
      key = this.deps.joinPath(dirPath, candidate);
    }
    used.add(key);
    return candidate;
  }

  private async exportAttachments(
    dirPath: string,
    pageId: string,
    attachmentsByPageId: ReadonlyMap<string, readonly { filePath: string; displayName: string }[]>,
  ): Promise<void> {
    const attachments = attachmentsByPageId.get(pageId);
    if (!attachments || attachments.length === 0) return;
    const attachmentsDir = this.deps.joinPath(dirPath, "_attachments");
    await this.deps.mkdir(attachmentsDir);
    for (const att of attachments) {
      const destName = sanitizeFilenameSegment(att.displayName);
      await this.deps.copyFile!(att.filePath, this.deps.joinPath(attachmentsDir, destName));
    }
  }

  private async exportSources(
    targetDir: string,
    sources: readonly WikiSource[],
    failed: WikiExportFailure[],
  ): Promise<void> {
    const sourcesDir = this.deps.joinPath(targetDir, "_sources");
    await this.deps.mkdir(sourcesDir);
    const used = new Set<string>();
    for (const source of sources) {
      try {
        const fileName = this.resolveUniqueFileName(sourcesDir, source.title, used);
        await this.deps.writeFile(this.deps.joinPath(sourcesDir, fileName), source.content_md ?? "");
      } catch (err) {
        failed.push({ path: `_sources/${source.title}`, error: (err as Error).message });
      }
    }
  }

  private async writeManifest(
    targetDir: string,
    entries: readonly ManifestEntry[],
    failed: readonly WikiExportFailure[],
    options: WikiExportOptions,
  ): Promise<void> {
    const manifest = {
      exportedAt: new Date().toISOString(),
      options,
      exported: entries,
      failed,
    };
    await this.deps.writeFile(
      this.deps.joinPath(targetDir, "_export-manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
  }
}
