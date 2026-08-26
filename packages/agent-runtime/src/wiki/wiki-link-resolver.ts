/**
 * Wikilink 目标解析——纯函数，输入候选页面列表，输出解析结果
 *
 * 设计：`docs/plans/记忆重构/2026-08-26-wiki-p1-implementation.md` §4.1 四条规则：
 * 1. 带路径（含 `/`）按规范化路径精确匹配 `WikiPage.path`；
 * 2. 不带路径先匹配当前目录下同标题，再匹配全库唯一标题；
 * 3. 多重匹配不写边，返回歧义候选列表；
 * 4. 未匹配不写边但保留原文（允许先链接后建页）。
 *
 * 解析永不抛异常：任何异常输入都归入未解析分支。
 */

export interface WikilinkCandidatePage {
  readonly id: string;
  readonly path: string;
  readonly title: string;
}

export interface WikilinkResolution {
  readonly targetPageId: string | null;
  readonly isResolved: boolean;
  /** 歧义候选（长度 >= 2 时命中歧义规则），非歧义情况恒为空数组 */
  readonly ambiguous: readonly WikilinkCandidatePage[];
}

const UNRESOLVED: WikilinkResolution = { targetPageId: null, isResolved: false, ambiguous: [] };

function dirnameOfPath(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/** 规范化路径型锚文本；segments 含空段/`.`/`..` 视为无效路径 */
function normalizePathAnchor(anchorText: string): string | null {
  const segments = anchorText.split("/").map((s) => s.trim());
  if (segments.some((s) => s.length === 0 || s === "." || s === "..")) return null;
  return segments.join("/");
}

export function resolveWikilinkTarget(
  anchorText: string,
  sourcePagePath: string,
  pages: readonly WikilinkCandidatePage[],
): WikilinkResolution {
  try {
    const trimmed = anchorText.trim();
    if (!trimmed) return UNRESOLVED;

    if (trimmed.includes("/")) {
      const normalized = normalizePathAnchor(trimmed);
      if (normalized === null) return UNRESOLVED;
      const matches = pages.filter((p) => p.path === normalized);
      if (matches.length === 1) {
        return { targetPageId: matches[0]!.id, isResolved: true, ambiguous: [] };
      }
      return matches.length > 1
        ? { targetPageId: null, isResolved: false, ambiguous: matches }
        : UNRESOLVED;
    }

    const currentDir = dirnameOfPath(sourcePagePath);
    const sameDirMatches = pages.filter(
      (p) => p.title === trimmed && dirnameOfPath(p.path) === currentDir,
    );
    if (sameDirMatches.length === 1) {
      return { targetPageId: sameDirMatches[0]!.id, isResolved: true, ambiguous: [] };
    }
    if (sameDirMatches.length > 1) {
      return { targetPageId: null, isResolved: false, ambiguous: sameDirMatches };
    }

    const globalMatches = pages.filter((p) => p.title === trimmed);
    if (globalMatches.length === 1) {
      return { targetPageId: globalMatches[0]!.id, isResolved: true, ambiguous: [] };
    }
    if (globalMatches.length > 1) {
      return { targetPageId: null, isResolved: false, ambiguous: globalMatches };
    }

    return UNRESOLVED;
  } catch {
    return UNRESOLVED;
  }
}
