import React from 'react'
import { FileText, Image as ImageIcon, Inbox, MoreHorizontal, Network } from 'lucide-react'

export type WikiPrimaryNav = 'sources' | 'media' | 'inbox' | 'graph'

interface WikiLeftNavProps {
  active: WikiPrimaryNav | 'more'
  pendingCount: number
  pageCounts: Record<string, number>
  moreButtonRef?: React.RefObject<HTMLButtonElement>
  onSelect: (nav: WikiPrimaryNav) => void
  onOpenMore: () => void
}

const PRIMARY_ITEMS: ReadonlyArray<{
  key: WikiPrimaryNav
  label: string
  icon: React.FC<{ size?: number | string }>
}> = [
  { key: 'sources', label: '资料', icon: FileText },
  { key: 'media', label: '多媒体', icon: ImageIcon },
  { key: 'inbox', label: '待整理', icon: Inbox },
  { key: 'graph', label: '知识图谱', icon: Network },
]

/**
 * 渲染 Wiki 浏览分区一级导航，并将运维入口收纳到“更多”。
 */
export const WikiLeftNav: React.FC<WikiLeftNavProps> = ({
  active,
  pendingCount,
  pageCounts,
  moreButtonRef,
  onSelect,
  onOpenMore,
}) => (
  <nav className="wiki-left-nav" aria-label="Wiki 导航">
    <div className="wiki-left-nav-primary">
      {PRIMARY_ITEMS.map(({ key, label, icon: Icon }) => {
        const count = key === 'inbox'
          ? pendingCount
          : key === 'graph'
            ? null
            : (pageCounts[key] ?? 0)
        return (
          <button
            key={key}
            type="button"
            className={`wiki-left-nav-item${active === key ? ' wiki-left-nav-item--active' : ''}`}
            onClick={() => onSelect(key)}
            aria-current={active === key ? 'page' : undefined}
          >
            <Icon size={15} />
            <span className="wiki-left-nav-label">{label}</span>
            {count !== null && <span className="wiki-left-nav-count">{count}</span>}
          </button>
        )
      })}
    </div>

    <div className="wiki-left-nav-footer">
      <button
        ref={moreButtonRef}
        type="button"
        className={`wiki-left-nav-item${active === 'more' ? ' wiki-left-nav-item--active' : ''}`}
        onClick={onOpenMore}
        aria-expanded={active === 'more'}
      >
        <MoreHorizontal size={15} />
        <span className="wiki-left-nav-label">⋯ 更多</span>
      </button>
    </div>
  </nav>
)

export default WikiLeftNav
