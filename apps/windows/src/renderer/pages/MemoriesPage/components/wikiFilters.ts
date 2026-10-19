/**
 * Wiki 资料列表的本地筛选（标签 / 用户路径前缀）。
 *
 * 为什么在前端做：当前列表本来就是「按大类拉回来的一组资料」，标签与路径前缀
 * 只在这组里收窄；为此加一条后端查询会把 IPC/CLI/Repo 全拉长一遍，收益不成比例。
 * 数据量变大（单大类上千条）时再下沉到 SQL。
 *
 * 背景：`user_path` / `tags` 是 V39 新增字段，此前 UI 只能当文本搜索用 ——
 * 而 `wiki_sources_fts` 只索引 title/content，搜标签其实搜不到。
 */
import type { WikiSourceListItem } from '../../../hooks/business/useWikiPage'

export interface WikiTagCount {
  readonly tag: string
  readonly count: number
}

/** 统计列表里出现过的标签，按次数降序（同次数按名称，保证顺序稳定） */
export function buildTagCounts(items: readonly WikiSourceListItem[]): WikiTagCount[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    for (const raw of item.tags ?? []) {
      const tag = raw.trim()
      if (!tag) continue
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  // 同次数时按**码点**排序而不是 localeCompare：后者的结果依赖运行环境的
  // ICU/语言设置，同一份数据在两台机器上可能给出不同顺序（测试也不稳）。
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
}

/** 按标签收窄；tag 为空表示不筛 */
export function filterByTag(
  items: readonly WikiSourceListItem[],
  tag: string | null | undefined,
): WikiSourceListItem[] {
  if (!tag) return [...items]
  return items.filter((item) => (item.tags ?? []).includes(tag))
}

/**
 * 按用户路径**前缀**收窄（层级浏览）：prefix 的每一段都要与 item.userPath 对应位置相等。
 * 空 prefix 表示不筛。
 */
export function filterByUserPathPrefix(
  items: readonly WikiSourceListItem[],
  prefix: readonly string[] | null | undefined,
): WikiSourceListItem[] {
  if (!prefix || prefix.length === 0) return [...items]
  return items.filter((item) => {
    const path = item.userPath ?? []
    return prefix.every((segment, index) => path[index] === segment)
  })
}

// ── 编辑草稿的解析/回显 ────────────────────────────────────────────────────
// 用户路径按 `/` 分段，标签按中英文逗号分隔。空串一律解析为 null（清空）。

/** 路径草稿 → 数组；空或全是分隔符时返回 null（表示清空 user_path） */
export function parseUserPathDraft(draft: string): string[] | null {
  const segments = draft
    .split(/[/\\]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return segments.length > 0 ? segments : null
}

/** 数组 → 路径草稿（用 ` / ` 连接，便于阅读） */
export function formatUserPathDraft(path: readonly string[] | null | undefined): string {
  return (path ?? []).join(' / ')
}

/** 标签草稿 → 数组；支持中英文逗号，去重保序；空返回 null */
export function parseTagsDraft(draft: string): string[] | null {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const raw of draft.split(/[,，]/)) {
    const tag = raw.trim()
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
  }
  return tags.length > 0 ? tags : null
}

/** 数组 → 标签草稿 */
export function formatTagsDraft(tags: readonly string[] | null | undefined): string {
  return (tags ?? []).join(', ')
}
