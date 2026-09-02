/**
 * 判断 Wiki 资料指向的「真实文件」是否仍存在（含 .lumii-ref 侧车解引用）。
 */

import type { WikiSource } from "./types.js";
import { isVaultRefPath } from "./wiki-ref-store.js";

export interface WikiSourceExistsChecker {
  readonly fileExists: (absPath: string) => boolean;
  readonly readRefTarget?: (refAbsPath: string) => string | null;
  readonly toAbsPath: (relOrAbs: string) => string;
}

/**
 * 解析资料底层文件是否可访问。
 * @returns true=存在，false=已失效，null=无法判定（如纯 URL / 仅 DB 正文）
 */
export function resolveWikiSourceFileExists(
  source: WikiSource,
  checker: WikiSourceExistsChecker,
): boolean | null {
  if (source.origin_url?.trim()) return true;

  if (!source.source_path?.trim()) {
    return source.content_md?.trim() ? true : null;
  }

  let current = source.source_path.replace(/\\/g, "/");
  const seen = new Set<string>();

  while (isVaultRefPath(current)) {
    const absRef = checker.toAbsPath(current);
    if (seen.has(absRef)) return false;
    seen.add(absRef);
    if (!checker.fileExists(absRef)) return false;
    if (!checker.readRefTarget) return null;
    const next = checker.readRefTarget(absRef);
    if (!next) return false;
    current = next.replace(/\\/g, "/");
  }

  return checker.fileExists(checker.toAbsPath(current));
}
