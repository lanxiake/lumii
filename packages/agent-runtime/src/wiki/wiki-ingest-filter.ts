/**
 * Wiki 自动摄入路径过滤：默认跳过代码、脚本与临时产物。
 *
 * 供 WikiIngestHook、WikiFolderImporter、宿主 file_write 旁路共用，避免 Agent
 * 临时脚本/代码文件写入后被自动灌进 Wiki 收件箱。
 */

/** 默认不自动摄入的扩展名（小写，不含点） */
export const DEFAULT_EXCLUDED_WIKI_INGEST_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "sql",
  "graphql",
  "vue",
  "svelte",
  "css",
]);

/**
 * 从文件名解析扩展名；无扩展名时返回 null。
 */
export function wikiIngestFileExtension(fileName: string): string | null {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) return null;
  return fileName.slice(lastDot + 1).toLowerCase();
}

/**
 * 判断路径是否应跳过 Wiki 自动摄入。
 * @returns 跳过原因字符串；null 表示可摄入。
 */
export function shouldSkipWikiIngestPath(sourcePath: string, fileName?: string): string | null {
  const baseName = fileName ?? sourcePath.split(/[/\\]/).pop() ?? sourcePath;
  if (baseName.startsWith(".")) return "ignored:dotfile";

  const normalized = sourcePath.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/.git/") || normalized.includes("/node_modules/")) {
    return "ignored:system-dir";
  }
  if (normalized.includes("/temp/") || normalized.includes("/tmp/")) {
    return "ignored:temp";
  }

  const ext = wikiIngestFileExtension(baseName);
  if (ext && DEFAULT_EXCLUDED_WIKI_INGEST_EXTENSIONS.has(ext)) {
    return "ignored:code-or-script";
  }
  return null;
}
