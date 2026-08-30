import React from 'react'
import { Inbox, Archive, Briefcase, BookOpen, Home, Star, MoreHorizontal } from 'lucide-react'
import { navSectionLabel, topicCountKey, type WikiNavSection } from './wikiNavMapping'

// 导出 topicCountKey 供 WikiTab 与 WikiTopicTreeEditor 复用
export { topicCountKey }

/**
 * P0 左栏显示 6 个导航分区（工作/学习/生活/收藏/收件箱/归档）+ 更多。
 * WikiNav 保留 category/subtopic/parking/graph 等旧 kind（从 ⋯ 菜单或芯片进入），
 * 新增 section 与 archived kind。
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
  unfiled: Inbox, // 不在左栏渲染，但类型完整性需要
}

/** 左栏分区顺序 */
const NAV_SECTIONS: readonly WikiNavSection[] = ['inbox', 'work', 'study', 'life', 'collection', 'archived']

/**
 * 左栏 = 6 个分区按钮（收件箱带角标）+ 更多。
 * 删除旧的固定项（待整理/知识图谱/临时存放）与用途树渲染。
 */
export const WikiLeftNav: React.FC<WikiLeftNavProps> = ({
  active,
  inboxCount,
  sectionCounts,
  archivedCount,
  moreButtonRef,
  onSelect,
  onOpenMore,
}) => {
  const renderSection = (section: WikiNavSection, count: number, warn = false) => {
    const nav: WikiNav = section === 'inbox' || section === 'archived' ? { kind: section } : { kind: 'section', name: section }
    const Icon = SECTION_ICONS[section]
    const label = navSectionLabel(section)
    return (
      <button
        key={section}
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
