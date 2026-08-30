import React from 'react'
import { Inbox, Archive, Briefcase, BookOpen, Home, Star, MoreHorizontal, Network, Package } from 'lucide-react'
import { Tooltip } from '../../../components/ui/Tooltip/Tooltip'
import { navSectionLabel, topicCountKey, type WikiNavSection } from './wikiNavMapping'
import { WIKI_LEFT_FIXED_TOOLTIPS, WIKI_MORE_TOOLTIP, WIKI_NAV_TOOLTIPS } from './wikiTooltips'

// 导出 topicCountKey 供 WikiTab 与 WikiTopicTreeEditor 复用
export { topicCountKey }

/**
 * P0 左栏显示用途目录、临时存放、知识图谱与更多入口。
 */
export type WikiNav =
  | { kind: 'inbox' }
  | { kind: 'section'; name: WikiNavSection }
  | { kind: 'archived' }
  | { kind: 'parking' }
  | { kind: 'graph' }
  | { kind: 'history' }
  | { kind: 'cleanup' }
  | { kind: 'synthesis' }
  | { kind: 'reclassify' }
  | { kind: 'category'; name: string }
  | { kind: 'subtopic'; category: string; subtopic: string }

interface WikiLeftNavProps {
  active: WikiNav | { kind: 'more' }
  /** 收件箱角标（pending 条数，不含未分类） */
  inboxCount: number
  /** 各分区计数；key = section name */
  sectionCounts: Record<WikiNavSection, number>
  archivedCount: number
  parkingCount: number
  moreButtonRef?: React.RefObject<HTMLButtonElement>
  onSelect: (nav: WikiNav) => void
  onOpenMore: () => void
}

function isActive(active: WikiLeftNavProps['active'], nav: WikiNav): boolean {
  if (active.kind !== nav.kind) return false
  if (nav.kind === 'section') return active.kind === 'section' && active.name === nav.name
  return true
}

const SECTION_ICONS: Record<WikiNavSection, React.FC<{ size?: number | string }>> = {
  work: Briefcase,
  study: BookOpen,
  life: Home,
  collection: Star,
  inbox: Inbox,
  archived: Archive,
  unfiled: Inbox,
}

/** 左栏分区顺序 */
const NAV_SECTIONS: readonly WikiNavSection[] = ['inbox', 'work', 'study', 'life', 'collection', 'archived']

/** 左栏固定入口（排在已归档之后） */
const FIXED_NAV_ITEMS = [
  { kind: 'parking' as const, label: '临时存放', icon: Package },
  { kind: 'graph' as const, label: '知识图谱', icon: Network },
]

/**
 * 左栏 = 用途目录 + 临时存放/知识图谱 + 更多；悬停显示使用说明。
 */
export const WikiLeftNav: React.FC<WikiLeftNavProps> = ({
  active,
  inboxCount,
  sectionCounts,
  archivedCount,
  parkingCount,
  moreButtonRef,
  onSelect,
  onOpenMore,
}) => {
  /**
   * 渲染单个分区按钮（带 Tooltip）
   */
  const renderSection = (section: WikiNavSection, count: number, warn = false) => {
    const nav: WikiNav = section === 'inbox' || section === 'archived' ? { kind: section } : { kind: 'section', name: section }
    const Icon = SECTION_ICONS[section]
    const label = navSectionLabel(section)
    return (
      <Tooltip key={section} content={WIKI_NAV_TOOLTIPS[section]} placement="right">
        <button
          type="button"
          className={`wiki-left-nav-item${isActive(active, nav) ? ' wiki-left-nav-item--active' : ''}`}
          onClick={() => onSelect(nav)}
          aria-current={isActive(active, nav) ? 'page' : undefined}
        >
          <Icon size={15} />
          <span className="wiki-left-nav-label">{label}</span>
          {count > 0 && (
            <span className={`wiki-left-nav-count${warn ? ' wiki-left-nav-count--warn' : ''}`}>{count}</span>
          )}
        </button>
      </Tooltip>
    )
  }

  /**
   * 渲染临时存放、知识图谱等固定入口。
   */
  const renderFixedNav = (kind: 'parking' | 'graph', label: string, Icon: React.FC<{ size?: number | string }>, count = 0) => {
    const nav: WikiNav = { kind }
    return (
      <Tooltip key={kind} content={WIKI_LEFT_FIXED_TOOLTIPS[kind]} placement="right">
        <button
          type="button"
          className={`wiki-left-nav-item${isActive(active, nav) ? ' wiki-left-nav-item--active' : ''}`}
          onClick={() => onSelect(nav)}
          aria-current={isActive(active, nav) ? 'page' : undefined}
        >
          <Icon size={15} />
          <span className="wiki-left-nav-label">{label}</span>
          {count > 0 && <span className="wiki-left-nav-count">{count}</span>}
        </button>
      </Tooltip>
    )
  }

  return (
    <nav className="wiki-left-nav" aria-label="Wiki 导航">
      <div className="wiki-left-nav-primary">
        {NAV_SECTIONS.map((section) => {
          if (section === 'inbox') return renderSection(section, inboxCount, true)
          if (section === 'archived') return renderSection(section, archivedCount)
          return renderSection(section, sectionCounts[section] ?? 0)
        })}
        {FIXED_NAV_ITEMS.map(({ kind, label, icon: Icon }) =>
          renderFixedNav(kind, label, Icon, kind === 'parking' ? parkingCount : 0),
        )}
      </div>

      <div className="wiki-left-nav-footer">
        <Tooltip content={WIKI_MORE_TOOLTIP} placement="right">
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
        </Tooltip>
      </div>
    </nav>
  )
}

export default WikiLeftNav
