/**
 * 查询匹配 — `skill_search` / `tool_search` 共用的多关键词语义。
 *
 * 逗号分隔为 OR 组，组内空格分隔为 AND：
 *   `"pr review, code analysis"` → `(pr AND review) OR (code AND analysis)`
 *
 * **为什么抽出来**：这两个工具是同一件「从惰性目录里捞回能力」的事，
 * 语义若各写一份，改一处忘另一处就静默退化成不同的检索行为
 * （模型会以为「搜不到」是能力不存在）。
 */

/** `orGroups` 为空（查询串只有空白/逗号）时返回 false —— 与 `skill_search` 引入时逐字一致 */
export function matchByQuery(query: string, haystack: string): boolean {
  const orGroups = query
    .split(",")
    .map((group) => group.toLowerCase().trim().split(/\s+/).filter(Boolean))
    .filter((g) => g.length > 0);
  if (orGroups.length === 0) return false;
  const hay = haystack.toLowerCase();
  return orGroups.some((andTerms) => andTerms.every((t) => hay.includes(t)));
}
