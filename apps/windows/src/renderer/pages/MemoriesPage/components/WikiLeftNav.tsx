import React from 'react'
import { Archive, Inbox, FolderOpen, MoreHorizontal } from 'lucide-react'

/**
 * P0 简化：只保留 inbox / unfiled / archived 三项 + more。
 * 取消折叠树：5 个 nav section（工作/学习/生活/收藏）由 WikiMoreMenu 进入，
 * 或通过点击资料卡片的主题标签快速跳转（归属视图）。
 */
export type WikiNav =
  | { kind: 'inbox' }
  | { kind: 'unfiled' }
  | { kind: 'archived' }
  | { kind: 'graph' }
  | { kind: 'history' }
  | { kind: 'cleanup' }
  | { kind: 'synthesis' }
  | { kind: 'reclassify' }
  | { kind: 'section'; name: string }

interface WikiLeftNavProps {
  active: WikiNav | { kind: 'more' }
  /** 待整理角标 = 收件箱 pending 条数 */
  inboxCount: number
  unfiledCount: number
  archivedCount: number
  moreButtonRef?: React.RefObject<HTMLButtonElement>
  onSelect: (nav: WikiNav) => void
  onOpenMore: () => void
}

function isActive(active: WikiLeftNavProps['active'], nav: WikiNav): boolean {
  if (active.kind !== nav.kind) return false
  if (nav.kind === 'section') return active.kind === 'section' && active.name === nav.name
  return true
}

/**
 * 左栏 = inbox（待整理）/ unfiled（未分类）/ archived（已归档）+ 更多。
 * 折叠树移除——P0 简化设计，5 区导航交给 more 菜单或卡片主题快速跳转。
 */
export const WikiLeftNav: React.FC<WikiLeftNavProps> = ({
  active,
  inboxCount,
  unfiledCount,
  archivedCount,
  moreButtonRef,
  onSelect,
  onOpenMore,
}) => {
  const renderItem = (
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
        {renderItem({ kind: 'inbox' }, '待整理', Inbox, inboxCount, true)}
        {renderItem({ kind: 'unfiled' }, '未分类', FolderOpen, unfiledCount)}
        {renderItem({ kind: 'archived' }, '已归档', Archive, archivedCount)}
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
          <span className="wiki-left-nav-label">更多</span>
        </button>
      </div>
    </nav>
  )
}

export default WikiLeftNav
