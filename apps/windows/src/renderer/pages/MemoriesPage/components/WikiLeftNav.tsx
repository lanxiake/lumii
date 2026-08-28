import React, { useState } from 'react'
import { Archive, ChevronDown, ChevronRight, Inbox, MoreHorizontal, Network } from 'lucide-react'
import type { WikiTopicTree } from '../../../hooks/business/useWikiPage'

export type WikiNav =
  | { kind: 'inbox' }
  | { kind: 'parking' }
  | { kind: 'graph' }
  | { kind: 'history' }
  | { kind: 'cleanup' }
  | { kind: 'synthesis' }
  | { kind: 'reclassify' }
  | { kind: 'category'; name: string }
  | { kind: 'subtopic'; category: string; subtopic: string }

/**
 * 两列分组计数的 key。
 * 不能用 `/` 拼：小类名本身允许含斜杠（如「项目/任务资料」）。
 * 也不能用空格拼：大类名可能带空格，`「做事 记录」` 会和 `「做事」+「记录」` 撞 key。
 * 直接序列化两列，天然无歧义，且不引入不可见的分隔符。
 */
export function topicCountKey(category: string, subtopic?: string | null): string {
  return subtopic ? JSON.stringify([category, subtopic]) : JSON.stringify([category])
}

interface WikiLeftNavProps {
  active: WikiNav | { kind: 'more' }
  tree: WikiTopicTree | null
  /** 待整理角标 = 队列条数 + 待补分条数 */
  pendingCount: number
  parkingCount: number
  /** key 由 topicCountKey 生成 */
  topicCounts: Record<string, number>
  moreButtonRef?: React.RefObject<HTMLButtonElement>
  onSelect: (nav: WikiNav) => void
  onOpenMore: () => void
}

function isActive(active: WikiLeftNavProps['active'], nav: WikiNav): boolean {
  if (active.kind !== nav.kind) return false
  if (nav.kind === 'category') return active.kind === 'category' && active.name === nav.name
  if (nav.kind === 'subtopic') {
    return active.kind === 'subtopic' && active.category === nav.category && active.subtopic === nav.subtopic
  }
  return true
}

/**
 * 左栏 = 固定区（待整理 / 知识图谱 / 临时存放）+ 用途目录树 + 更多。
 * 目录顺序完全按主题树数组序，只渲染树里存在的小类，空小类也可点。
 */
export const WikiLeftNav: React.FC<WikiLeftNavProps> = ({
  active,
  tree,
  pendingCount,
  parkingCount,
  topicCounts,
  moreButtonRef,
  onSelect,
  onOpenMore,
}) => {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const renderFixed = (
    nav: WikiNav,
    label: string,
    Icon: React.FC<{ size?: number | string }>,
    count: number | null,
    warn = false,
  ) => (
    <button
      type="button"
      className={`wiki-left-nav-item${isActive(active, nav) ? ' wiki-left-nav-item--active' : ''}`}
      onClick={() => onSelect(nav)}
      aria-current={isActive(active, nav) ? 'page' : undefined}
    >
      <Icon size={15} />
      <span className="wiki-left-nav-label">{label}</span>
      {count !== null && count > 0 && (
        <span className={`wiki-left-nav-count${warn ? ' wiki-left-nav-count--warn' : ''}`}>{count}</span>
      )}
    </button>
  )

  return (
    <nav className="wiki-left-nav" aria-label="Wiki 导航">
      <div className="wiki-left-nav-primary">
        {renderFixed({ kind: 'inbox' }, '待整理', Inbox, pendingCount, true)}
        {renderFixed({ kind: 'graph' }, '知识图谱', Network, null)}
        {renderFixed({ kind: 'parking' }, '临时存放', Archive, parkingCount)}
      </div>

      <div className="wiki-left-nav-tree">
        {(tree?.categories ?? []).map((category) => {
          const isCollapsed = collapsed[category.name] ?? false
          const nav: WikiNav = { kind: 'category', name: category.name }
          const count = topicCounts[topicCountKey(category.name)] ?? 0
          return (
            <div key={category.name} className="wiki-left-nav-group">
              <div className="wiki-left-nav-group-header">
                <button
                  type="button"
                  className="wiki-left-nav-chevron"
                  aria-label={isCollapsed ? `展开 ${category.name}` : `折叠 ${category.name}`}
                  aria-expanded={!isCollapsed}
                  onClick={() => setCollapsed((prev) => ({ ...prev, [category.name]: !isCollapsed }))}
                >
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </button>
                <button
                  type="button"
                  className={`wiki-left-nav-item wiki-left-nav-item--group${isActive(active, nav) ? ' wiki-left-nav-item--active' : ''}`}
                  onClick={() => onSelect(nav)}
                  aria-current={isActive(active, nav) ? 'page' : undefined}
                >
                  <span className="wiki-left-nav-label">{category.name}</span>
                  {count > 0 && <span className="wiki-left-nav-count">{count}</span>}
                </button>
              </div>

              {!isCollapsed && (
                <div className="wiki-left-nav-subtopics">
                  {category.subtopics.map((subtopic) => {
                    const subNav: WikiNav = { kind: 'subtopic', category: category.name, subtopic }
                    const subCount = topicCounts[topicCountKey(category.name, subtopic)] ?? 0
                    return (
                      <button
                        key={subtopic}
                        type="button"
                        className={`wiki-left-nav-item wiki-left-nav-item--sub${isActive(active, subNav) ? ' wiki-left-nav-item--active' : ''}`}
                        onClick={() => onSelect(subNav)}
                        aria-current={isActive(active, subNav) ? 'page' : undefined}
                      >
                        <span className="wiki-left-nav-label">{subtopic}</span>
                        {subCount > 0 && <span className="wiki-left-nav-count">{subCount}</span>}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="wiki-left-nav-footer">
        <button
          ref={moreButtonRef}
          type="button"
          className={`wiki-left-nav-item${active.kind === 'more' ? ' wiki-left-nav-item--active' : ''}`}
          onClick={onOpenMore}
          aria-expanded={active.kind === 'more'}
        >
          <MoreHorizontal size={15} />
          <span className="wiki-left-nav-label">⋯ 更多</span>
        </button>
      </div>
    </nav>
  )
}

export default WikiLeftNav
