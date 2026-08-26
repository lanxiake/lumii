/**
 * Wikilink 解析——纯函数，仅在单行内匹配 `[[标题]]` / `[[目录/标题]]`
 *
 * 设计：`docs/plans/记忆重构/2026-08-26-wiki-p1-implementation.md` §4.1
 * 不支持别名（`[[a|b]]`）、锚点、块引用、嵌入——这些写法会被当作普通文本原样保留，
 * 不产生候选（正则要求内容不含 `|`，因此别名语法天然跳过）。
 * 跨行不解析：正则不含 `s` 标志，`.`/`[^...]` 均不跨越换行。
 */

/** 单行内匹配 `[[...]]`，内容不含 `[`、`]`、换行、`|`（排除别名写法） */
const WIKILINK_PATTERN = /\[\[([^[\]\n|]+)\]\]/g;

export interface ParsedWikilink {
  /** `[[...]]` 内的原始文本，未做任何规范化 */
  readonly anchorText: string;
}

/** 从正文中提取所有候选 wikilink（不去重，允许同一目标被多次链接） */
export function parseWikilinks(contentMd: string): readonly ParsedWikilink[] {
  const results: ParsedWikilink[] = [];
  const lines = contentMd.split("\n");
  for (const line of lines) {
    for (const match of line.matchAll(WIKILINK_PATTERN)) {
      const anchorText = match[1]?.trim();
      if (anchorText) results.push({ anchorText });
    }
  }
  return results;
}
