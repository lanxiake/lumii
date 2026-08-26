import type { WikiCleanupSuggestionItem } from '../../../hooks/business/useWikiPage'

export type CleanupReasonFilter = 'all' | WikiCleanupSuggestionItem['reason']

/**
 * 按原因筛选清理建议；`all` 时返回原列表副本语义（同一引用）。
 */
export function filterCleanupSuggestions(
  items: readonly WikiCleanupSuggestionItem[],
  reason: CleanupReasonFilter,
): readonly WikiCleanupSuggestionItem[] {
  if (reason === 'all') return items
  return items.filter((i) => i.reason === reason)
}
