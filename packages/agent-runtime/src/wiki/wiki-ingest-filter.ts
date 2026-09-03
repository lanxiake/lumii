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
 * 剥掉 vault 侧车后缀（.lumii-ref / .url.lumii-ref）与去重序号（-2），
 * 还原背后的真实文件名，供扩展名判定使用。
 * 例：verify-public-texts.js.lumii-ref → verify-public-texts.js
 *     download-public-texts.js-2.lumii-ref → download-public-texts.js
 */
export function stripWikiRefSuffix(fileName: string): string {
  return fileName
    .replace(/(\.url)?\.lumii-ref$/i, "")
    .replace(/-[0-9]+$/, "");
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
  // 只拦截路径中的 /temp/ 中间目录段，不拦截 /tmp/（测试夹具与类 Unix 真实路径都用它）
  if (normalized.includes("/temp/")) {
    return "ignored:temp";
  }

  // vault 同步后 source_path 会变成「真实文件名(.url)?.lumii-ref(-N)?」侧车，
  // 直接取扩展名会得到 lumii-ref 而漏掉背后的 .js/.html 等代码脚本。先剥侧车还原真实名。
  const ext = wikiIngestFileExtension(stripWikiRefSuffix(baseName));
  if (ext && DEFAULT_EXCLUDED_WIKI_INGEST_EXTENSIONS.has(ext)) {
    return "ignored:code-or-script";
  }
  return null;
}
