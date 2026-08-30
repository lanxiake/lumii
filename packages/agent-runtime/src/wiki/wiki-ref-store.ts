/**
 * Wiki `.lumii-ref` 侧车文件的读写。
 * 引用优先：文件/链接默认只写 ref，不复制原文件。
 */
import { sanitizeFilenameSegment } from "./wiki-exporter.js";

export const WIKI_REF_KIND = "wiki-ref";
export const WIKI_REF_VERSION = 1;
export const FILE_REF_EXT = ".lumii-ref";
export const URL_REF_EXT = ".url.lumii-ref";

export type WikiRefType = "file" | "url";

export interface WikiRefDocument {
  readonly kind: typeof WIKI_REF_KIND;
  readonly version: typeof WIKI_REF_VERSION;
  readonly refType: WikiRefType;
  readonly title: string;
  readonly linkedAt: string;
  readonly targetPath?: string;
  readonly targetUrl?: string;
  readonly sourceId?: string;
}

export interface WikiRefStoreFs {
  readonly writeFile: (filePath: string, content: string) => void;
  readonly readFile: (filePath: string) => string;
  readonly exists: (filePath: string) => boolean;
  readonly rename: (from: string, to: string) => void;
  readonly unlink: (filePath: string) => void;
  readonly joinPath: (...segments: string[]) => string;
}

/**
 * 判断路径是否为 vault 内的 ref 侧车文件。
 */
export function isVaultRefPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/");
  return norm.endsWith(FILE_REF_EXT) || norm.endsWith(URL_REF_EXT);
}

/**
 * 构造 file-ref JSON 文档。
 */
export function buildFileRefDoc(params: {
  readonly title: string;
  readonly targetPath: string;
  readonly sourceId?: string;
  readonly linkedAt?: string;
}): WikiRefDocument {
  return {
    kind: WIKI_REF_KIND,
    version: WIKI_REF_VERSION,
    refType: "file",
    title: params.title,
    targetPath: params.targetPath,
    sourceId: params.sourceId,
    linkedAt: params.linkedAt ?? new Date().toISOString(),
  };
}

/**
 * 构造 url-ref JSON 文档。
 */
export function buildUrlRefDoc(params: {
  readonly title: string;
  readonly targetUrl: string;
  readonly sourceId?: string;
  readonly linkedAt?: string;
}): WikiRefDocument {
  return {
    kind: WIKI_REF_KIND,
    version: WIKI_REF_VERSION,
    refType: "url",
    title: params.title,
    targetUrl: params.targetUrl,
    sourceId: params.sourceId,
    linkedAt: params.linkedAt ?? new Date().toISOString(),
  };
}

/**
 * 解析 ref 文件 JSON；格式不对时返回 null。
 */
export function parseRefDocument(raw: string): WikiRefDocument | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const doc = parsed as Partial<WikiRefDocument>;
    if (doc.kind !== WIKI_REF_KIND || doc.version !== WIKI_REF_VERSION) return null;
    if (doc.refType !== "file" && doc.refType !== "url") return null;
    if (typeof doc.title !== "string") return null;
    return doc as WikiRefDocument;
  } catch {
    return null;
  }
}

/**
 * 读取 ref 指向的目标（文件绝对/相对路径或 URL）。
 */
export function readRefTarget(fs: WikiRefStoreFs, refAbsPath: string): string | null {
  if (!fs.exists(refAbsPath)) return null;
  const doc = parseRefDocument(fs.readFile(refAbsPath));
  if (!doc) return null;
  if (doc.refType === "file") return doc.targetPath ?? null;
  return doc.targetUrl ?? null;
}

/**
 * 在目录下生成不冲突的 ref 文件名。
 */
export function resolveUniqueRefBasename(
  fs: WikiRefStoreFs,
  dirAbs: string,
  title: string,
  ext: typeof FILE_REF_EXT | typeof URL_REF_EXT,
): string {
  const base = sanitizeFilenameSegment(title).slice(0, 80) || "_";
  let name = `${base}${ext}`;
  let i = 2;
  while (fs.exists(fs.joinPath(dirAbs, name))) {
    name = `${base}-${i}${ext}`;
    i += 1;
  }
  return name;
}

/**
 * 写入 file-ref 到指定目录，返回绝对路径。
 */
export function writeFileRef(
  fs: WikiRefStoreFs,
  dirAbs: string,
  params: { readonly title: string; readonly targetPath: string; readonly sourceId?: string },
): string {
  const basename = resolveUniqueRefBasename(fs, dirAbs, params.title, FILE_REF_EXT);
  const abs = fs.joinPath(dirAbs, basename);
  const doc = buildFileRefDoc(params);
  fs.writeFile(abs, `${JSON.stringify(doc, null, 2)}\n`);
  return abs;
}

/**
 * 写入 url-ref 到指定目录，返回绝对路径。
 */
export function writeUrlRef(
  fs: WikiRefStoreFs,
  dirAbs: string,
  params: { readonly title: string; readonly targetUrl: string; readonly sourceId?: string },
): string {
  const basename = resolveUniqueRefBasename(fs, dirAbs, params.title, URL_REF_EXT);
  const abs = fs.joinPath(dirAbs, basename);
  const doc = buildUrlRefDoc(params);
  fs.writeFile(abs, `${JSON.stringify(doc, null, 2)}\n`);
  return abs;
}

/**
 * 将 ref 文件移动到新目录（必要时改文件名避免冲突）。
 */
export function moveRefFile(
  fs: WikiRefStoreFs,
  refAbsPath: string,
  destDirAbs: string,
  title: string,
): string {
  const ext = refAbsPath.replace(/\\/g, "/").endsWith(URL_REF_EXT) ? URL_REF_EXT : FILE_REF_EXT;
  const basename = resolveUniqueRefBasename(fs, destDirAbs, title, ext);
  const destAbs = fs.joinPath(destDirAbs, basename);
  if (refAbsPath !== destAbs) {
    if (fs.exists(destAbs)) fs.unlink(destAbs);
    fs.rename(refAbsPath, destAbs);
  }
  return destAbs;
}
