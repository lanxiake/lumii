/**
 * LinkAutocomplete — 编辑正文时输入 [[ 弹出候选页面，选择后插入 [[标题]]
 *
 * 设计：docs/plans/记忆重构/2026-08-26-wiki-p1-implementation.md Task 8 §10.3
 * 候选页面列表由调用方传入（wiki:page:list 缓存到本地做前缀过滤），本组件只负责
 * 检测触发时机与渲染候选下拉，不直接操作 DOM 光标（由调用方的 onInsert 处理插入）。
 */
import React, { useMemo } from 'react'
import type { WikiPageListItem } from '../../../hooks/business/useWikiPage'

interface LinkAutocompleteProps {
  readonly query: string
  readonly pages: readonly WikiPageListItem[]
  readonly onSelect: (page: WikiPageListItem) => void
  readonly onDismiss: () => void
}

/** 检测光标前是否处于 [[未闭合 的触发状态；返回触发后已输入的查询文本，未触发返回 null */
export function detectWikilinkTrigger(textBeforeCursor: string): string | null {
  const lastOpen = textBeforeCursor.lastIndexOf('[[')
  if (lastOpen === -1) return null
  const afterOpen = textBeforeCursor.slice(lastOpen + 2)
  // 已闭合（含 ]] ）或换行则不算触发中
  if (afterOpen.includes(']]') || afterOpen.includes('\n')) return null
  return afterOpen
}

export const LinkAutocomplete: React.FC<LinkAutocompleteProps> = ({ query, pages, onSelect, onDismiss }) => {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches = q
      ? pages.filter((p) => p.title.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
      : pages
    return matches.slice(0, 8)
  }, [query, pages])

  if (filtered.length === 0) return null

  // 存在同名页面时展示路径消歧（对应解析规则 2/3：不带路径可能歧义）
  const titleCounts = new Map<string, number>()
  for (const p of pages) titleCounts.set(p.title, (titleCounts.get(p.title) ?? 0) + 1)

  return (
    <div className="wiki-link-autocomplete">
      {filtered.map((p) => (
        <button
          key={p.id}
          type="button"
          className="wiki-link-autocomplete-item"
          onClick={() => onSelect(p)}
          onMouseDown={(e) => e.preventDefault()}
        >
          <span className="wiki-link-autocomplete-title">{p.title}</span>
          {(titleCounts.get(p.title) ?? 0) > 1 && (
            <span className="wiki-link-autocomplete-path">{p.path}</span>
          )}
        </button>
      ))}
      <button type="button" className="wiki-link-autocomplete-dismiss" onClick={onDismiss} onMouseDown={(e) => e.preventDefault()}>
        取消
      </button>
    </div>
  )
}

export default LinkAutocomplete
