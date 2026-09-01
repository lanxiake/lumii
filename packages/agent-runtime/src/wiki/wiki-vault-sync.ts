/**
 * 将 wiki_sources 行同步到 workspace/wiki/ 目录（ref / native md）。
 */
import type { WikiSource, WikiStorageMode } from "./types.js";
import { sanitizeFilenameSegment, resolveUniqueFilename } from "./wiki-exporter.js";
import { vaultDirSegmentsForSource } from "./wiki-nav-map.js";
import {
  type WikiRefStoreFs,
  isVaultRefPath,
  moveRefFile,
  readRefTarget,
  writeFileRef,
  writeUrlRef,
  URL_REF_EXT,
} from "./wiki-ref-store.js";
import type { WikiVaultLayoutFs } from "./wiki-vault-layout.js";
import { ensureWikiVaultLayout } from "./wiki-vault-layout.js";
import type { WikiTopicTree } from "./wiki-topic-tree.js";

export type WikiVaultFs = WikiRefStoreFs &
  WikiVaultLayoutFs & {
    readonly copyFile?: (from: string, to: string) => void;
  };

export interface WikiVaultSyncDeps {
  readonly vaultRoot: string;
  readonly workspaceRoot: string;
  readonly fs: WikiVaultFs;
  readonly toRelPath: (absPath: string) => string;
  readonly toAbsPath: (relOrAbs: string) => string;
}

export interface WikiVaultSyncResult {
  readonly relPath: string;
  readonly absPath: string;
}

/**
 * 解析资料在 vault 内的目标目录绝对路径。
 */
export function resolveVaultDirAbs(deps: WikiVaultSyncDeps, source: WikiSource): string {
  const segments = vaultDirSegmentsForSource({
    topicCategory: source.topic_category,
    topicSubtopic: source.topic_subtopic,
    archivedAt: source.archived_at,
  }).map(sanitizeFilenameSegment);
  return deps.fs.joinPath(deps.vaultRoot, ...segments);
}

/**
 * 判断资料是否应以 ref 侧车文件表示（非 native 实体 md）。
 */
export function shouldUseRefSidecar(source: WikiSource): boolean {
  if (source.storage_mode === "native") {
    const p = source.source_path?.replace(/\\/g, "/") ?? "";
    return !p.endsWith(".md");
  }
  return source.storage_mode === "ref";
}

/**
 * 解析 file-ref 指向的原始文件路径（穿过多层 .lumii-ref，避免新侧车把旧侧车当成原文件）。
 */
export function resolveOriginalFilePath(deps: WikiVaultSyncDeps, source: WikiSource): string | null {
  let current = source.source_path;
  if (!current) return null;
  const seen = new Set<string>();
  while (isVaultRefPath(current)) {
    const absRef = deps.toAbsPath(current);
    if (seen.has(absRef)) return null;
    seen.add(absRef);
    const next = readRefTarget(deps.fs, absRef);
    if (!next) return null;
    current = next;
  }
  return current;
}

/**
 * 确保 vault 目标目录存在（旧主题目录、用户自建类在重建后可能尚未建出）。
 */
function ensureVaultDestDir(fs: WikiVaultFs, dirAbs: string): void {
  if (!fs.exists(dirAbs)) {
    fs.mkdir(dirAbs);
  }
}

/**
 * 把单条资料同步到 vault；返回应写入 DB 的 source_path（相对 workspace）。
 */
export function syncSourceToVault(deps: WikiVaultSyncDeps, source: WikiSource): WikiVaultSyncResult | null {
  ensureWikiVaultLayout(deps.vaultRoot, deps.fs);

  const destDirAbs = resolveVaultDirAbs(deps, source);
  ensureVaultDestDir(deps.fs, destDirAbs);

  // native markdown：若已在 vault 外，复制/移动到 vault；已在 vault 内则随分类移动
  if (source.storage_mode === "native" && source.source_path?.replace(/\\/g, "/").endsWith(".md")) {
    return syncNativeMarkdown(deps, source, destDirAbs);
  }

  if (!shouldUseRefSidecar(source)) {
    return null;
  }

  const currentAbs =
    source.source_path && isVaultRefPath(source.source_path)
      ? deps.toAbsPath(source.source_path)
      : null;

  let refAbs: string;

  if (source.origin_url) {
    if (currentAbs && deps.fs.exists(currentAbs)) {
      refAbs = moveRefFile(deps.fs, currentAbs, destDirAbs, source.title);
      const raw = deps.fs.readFile(refAbs);
      const doc = JSON.parse(raw) as Record<string, unknown>;
      doc.targetUrl = source.origin_url;
      doc.title = source.title;
      doc.sourceId = source.id;
      deps.fs.writeFile(refAbs, `${JSON.stringify(doc, null, 2)}\n`);
    } else {
      refAbs = writeUrlRef(deps.fs, destDirAbs, {
        title: source.title,
        targetUrl: source.origin_url,
        sourceId: source.id,
      });
    }
  } else {
    const targetPath = resolveOriginalFilePath(deps, source) ?? source.source_path;
    if (!targetPath) return null;

    if (currentAbs && deps.fs.exists(currentAbs)) {
      refAbs = moveRefFile(deps.fs, currentAbs, destDirAbs, source.title);
      const raw = deps.fs.readFile(refAbs);
      const doc = JSON.parse(raw) as Record<string, unknown>;
      doc.targetPath = targetPath;
      doc.title = source.title;
      doc.sourceId = source.id;
      deps.fs.writeFile(refAbs, `${JSON.stringify(doc, null, 2)}\n`);
    } else {
      refAbs = writeFileRef(deps.fs, destDirAbs, {
        title: source.title,
        targetPath,
        sourceId: source.id,
      });
    }
  }

  return { relPath: deps.toRelPath(refAbs), absPath: refAbs };
}

/**
 * 同步 native markdown 笔记到 vault 目录。
 */
function syncNativeMarkdown(
  deps: WikiVaultSyncDeps,
  source: WikiSource,
  destDirAbs: string,
): WikiVaultSyncResult {
  const currentAbs = source.source_path ? deps.toAbsPath(source.source_path) : null;
  const baseName = `${sanitizeFilenameSegment(source.title).slice(0, 80) || "note"}.md`;
  let destAbs = deps.fs.joinPath(destDirAbs, baseName);
  let i = 2;
  while (deps.fs.exists(destAbs) && destAbs !== currentAbs) {
    destAbs = deps.fs.joinPath(destDirAbs, `${sanitizeFilenameSegment(source.title).slice(0, 72) || "note"}-${i}.md`);
    i += 1;
  }

  if (currentAbs && deps.fs.exists(currentAbs)) {
    if (currentAbs !== destAbs) {
      if (deps.fs.copyFile) {
        deps.fs.copyFile(currentAbs, destAbs);
        deps.fs.unlink(currentAbs);
      } else {
        deps.fs.rename(currentAbs, destAbs);
      }
    }
  } else if (source.content_md) {
    deps.fs.writeFile(destAbs, source.content_md);
  }

  return { relPath: deps.toRelPath(destAbs), absPath: destAbs };
}

/**
 * 批量回填：为尚无 vault 路径的资料创建 ref / 移动 md。
 */
export function backfillVaultFromSources(
  deps: WikiVaultSyncDeps,
  sources: readonly WikiSource[],
): readonly WikiVaultSyncResult[] {
  const results: WikiVaultSyncResult[] = [];
  for (const source of sources) {
    const synced = syncSourceToVault(deps, source);
    if (synced) results.push(synced);
  }
  return results;
}

/**
 * 根据 storage_mode 与 origin_url 推断 ref 类型展示用后缀。
 */
export function refExtForSource(source: { readonly origin_url: string | null; readonly storage_mode: WikiStorageMode }): string {
  if (source.origin_url) return URL_REF_EXT;
  return ".lumii-ref";
}
