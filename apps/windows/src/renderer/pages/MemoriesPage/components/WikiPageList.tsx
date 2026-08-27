import React from 'react'
import type {
  WikiPageListItem,
  WikiSearchHit,
} from '../../../hooks/business/useWikiPage'
import { formatRelativeTime } from './wikiStatusLabels'

interface WikiPageListProps {
  readonly pages?: readonly WikiPageListItem[]
  readonly searchHits?: readonly WikiSearchHit[]
  readonly selectedPageId: string | null
  readonly onOpen: (pageId: string) => void
}

interface WikiPageRow {
  readonly id: string
  readonly path: string
  readonly category: string
  readonly title: string
  readonly snippet?: string
  readonly updatedAt: number
}

const CATEGORY_LABELS: Record<string, string> = {
  sources: '资料',
  media: '多媒体',
}

/**
 * 将页面列表或搜索结果归一化为统一的列表行数据。
 */
function createPageRows(
  pages: readonly WikiPageListItem[] | undefined,
  searchHits: readonly WikiSearchHit[] | undefined,
): readonly WikiPageRow[] {
  if (searchHits) {
    return searchHits.map((hit) => ({
      id: hit.pageId,
      path: hit.path,
      category: hit.category,
      title: hit.title,
      snippet: hit.snippet,
      updatedAt: hit.updatedAt,
    }))
  }
  return pages ?? []
}

/**
 * 渲染 Wiki 页面或搜索结果列表，并保留当前页面的选中指示。
 */
export const WikiPageList: React.FC<WikiPageListProps> = ({
  pages,
  searchHits,
  selectedPageId,
  onOpen,
}) => {
  const rows = createPageRows(pages, searchHits)

  return (
    <div className="wiki-page-list">
      {rows.map((page) => (
        <button
          key={page.id}
          type="button"
          className={`wiki-page-list-item${selectedPageId === page.id ? ' wiki-page-list-item--selected' : ''}`}
          onClick={() => onOpen(page.id)}
        >
          <span className="wiki-page-list-heading">
            <span className="wiki-page-list-title">{page.title}</span>
            <span className="wiki-page-list-category">{CATEGORY_LABELS[page.category] ?? page.category}</span>
          </span>
          {page.snippet ? <span className="wiki-page-list-snippet">{page.snippet}</span> : null}
          <span className="wiki-page-list-path">
            {page.path} · {formatRelativeTime(page.updatedAt)}
          </span>
        </button>
      ))}
    </div>
  )
}

export default WikiPageList
