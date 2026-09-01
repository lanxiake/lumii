/**
 * WikiExporter — 按用途目录结构批量导出资料为 Markdown
 *
 * 设计：`docs/plans/记忆重构/2026-08-31-wiki-intelligent-vault-p3-remove-pages.md` Task 5
 * agent-runtime 不直接依赖 node:fs——文件系统操作通过 WikiExporterDeps 注入，
 * 宿主（apps/windows 主进程）负责实际写盘。逐条失败返回清单，不静默跳过。
 * 历史页面导出（exportPages）已随 P3 删除，导出维度统一切到资料层：
 * 每条资料一个 md 文件，正文为「标题 + 摘要 + 原文/引用链接」。
 */

import type { WikiSource } from "./types.js";

export interface WikiExporterDeps {
  /** 递归创建目录（已存在不报错，同 fs.mkdir 的 recursive:true 语义） */
  readonly mkdir: (dirPath: string) => Promise<void>;
  /** 写入文本文件（覆盖已存在文件；调用方已保证目标路径不冲突） */
  readonly writeFile: (filePath: string, content: string) => Promise<void>;
  /** 路径拼接（宿主按平台分隔符实现，agent-runtime 不依赖 node:path） */
  readonly joinPath: (...segments: string[]) => string;
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
  readonly title: string;
  readonly category: string | null;
  readonly subtopic: string | null;
}

/** 资料一条的导出正文：标题 + 摘要 + 原文/引用链接 */
function buildSourceMarkdown(source: WikiSource): string {
  const lines = [`# ${source.title}`, ""];
  if (source.summary) {
    lines.push(source.summary, "");
  }
  if (source.origin_url) {
    lines.push(`原文链接: ${source.origin_url}`, "");
  } else if (source.source_path) {
    lines.push(`原始文件: ${source.source_path}`, "");
  }
  if (source.content_md) {
    lines.push(source.content_md);
  } else if (source.extracted_text) {
    lines.push(source.extracted_text);
  }
  return lines.join("\n");
}

export class WikiExporter {
  constructor(private readonly deps: WikiExporterDeps) {}

  /**
   * 导出资料清单到目标目录。按大类/小类分子目录，每条资料写为 `<标题 安全化>.md`。
   * 文件名冲突时追加序号，不覆盖已导出的同批次文件。
   */
  async exportSources(targetDir: string, sources: readonly WikiSource[]): Promise<WikiExportResult> {
    const failed: WikiExportFailure[] = [];
    const manifestEntries: ManifestEntry[] = [];
    const usedFilePaths = new Set<string>();

    for (const source of sources) {
      try {
        const dirSegments = [source.topic_category, source.topic_subtopic]
          .filter((s): s is string => Boolean(s))
          .map(sanitizeFilenameSegment);
        const dirPath = dirSegments.length > 0 ? this.deps.joinPath(targetDir, ...dirSegments) : targetDir;
        await this.deps.mkdir(dirPath);

        const fileName = this.resolveUniqueFileName(dirPath, source.title, usedFilePaths);
        const filePath = this.deps.joinPath(dirPath, fileName);
        await this.deps.writeFile(filePath, buildSourceMarkdown(source));

        manifestEntries.push({
          title: source.title,
          category: source.topic_category,
          subtopic: source.topic_subtopic,
        });
      } catch (err) {
        failed.push({ path: source.title, error: (err as Error).message });
      }
    }

    await this.writeManifest(targetDir, manifestEntries, failed);

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

  private async writeManifest(
    targetDir: string,
    entries: readonly ManifestEntry[],
    failed: readonly WikiExportFailure[],
  ): Promise<void> {
    const manifest = {
      exportedAt: new Date().toISOString(),
      exported: entries,
      failed,
    };
    await this.deps.writeFile(
      this.deps.joinPath(targetDir, "_export-manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
  }
}
