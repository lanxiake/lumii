import React from 'react'
import { Inbox, Archive, Briefcase, BookOpen, Home, Star, MoreHorizontal, Package, Folder } from 'lucide-react'
import { Tooltip } from '../../../components/ui/Tooltip/Tooltip'
import { navSectionLabel, topicCountKey, type WikiNavSection } from './wikiTopicDisplay'
import { WIKI_LEFT_FIXED_TOOLTIPS, WIKI_MORE_TOOLTIP, WIKI_NAV_TOOLTIPS } from './wikiTooltips'

// 导出 topicCountKey 供 WikiTab 与 WikiTopicTreeEditor 复用
export { topicCountKey }

/**
 * P0 左栏显示用途目录、临时存放与更多入口。
 */
export type WikiNav =
  | { kind: 'inbox' }
  | { kind: 'section'; name: WikiNavSection }
  | { kind: 'archived' }
  | { kind: 'parking' }
  | { kind: 'cleanup' }
  | { kind: 'reclassify' }
  | { kind: 'migrate' }
  | { kind: 'category'; name: string }
  /** subtopic 为 null 表示该大类下的「未细分」分组（小类可选，见设计 §2.1.1） */
  | { kind: 'subtopic'; category: string; subtopic: string | null }

interface WikiLeftNavProps {
  active: WikiNav | { kind: 'more' }
  /** 收件箱角标（pending 条数，不含未分类） */
  inboxCount: number
  /**
   * 大类分区，按树序。v1.1 起左栏分区即树中的大类，随树动态变化
   * （用户自建大类会出现在这里），不再是写死的四项。
   */
  categories: readonly string[]
  /** 各分区计数；key = 大类名 */
  sectionCounts: Record<string, number>
  archivedCount: number
  parkingCount: number
  moreButtonRef?: React.RefObject<HTMLButtonElement>
  onSelect: (nav: WikiNav) => void
  onOpenMore: () => void
}

function isActive(active: WikiLeftNavProps['active'], nav: WikiNav): boolean {
  if (nav.kind === 'section') {
    if (active.kind === 'section') return active.name === nav.name
    if (active.kind === 'subtopic') return active.category === nav.name
    if (active.kind === 'category') return active.name === nav.name
    return false
  }
  if (active.kind !== nav.kind) return false
  return true
}

/**
 * 分区图标。键是系统分区 id 或 v2 树的大类名；
 * 用户自建大类取不到时兜底 Folder（分区集合开放，不能穷举）。
 */
const SECTION_ICONS: Record<string, React.FC<{ size?: number | string }>> = {
  inbox: Inbox,
  archived: Archive,
  unfiled: Inbox,
  工作: Briefcase,
  学习: BookOpen,
  生活: Home,
  收藏: Star,
}

/** 左栏固定入口（排在已归档之后） */
const FIXED_NAV_ITEMS = [
  { kind: 'parking' as const, label: '临时存放', icon: Package },
]

/**
 * 左栏 = 用途目录 + 临时存放 + 更多；悬停显示使用说明。
 */
export const WikiLeftNav: React.FC<WikiLeftNavProps> = ({
  active,
  inboxCount,
  categories,
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
    const nav: WikiNav =
      section === 'inbox'
        ? { kind: 'inbox' }
        : section === 'archived'
          ? { kind: 'archived' }
          : { kind: 'section', name: section }
    const Icon = SECTION_ICONS[section] ?? Folder
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
   * 渲染临时存放等固定入口。
   */
  const renderFixedNav = (kind: 'parking', label: string, Icon: React.FC<{ size?: number | string }>, count = 0) => {
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
        {/* 收件箱固定在最前、归档固定在最后，中间按树序渲染大类 */}
        {renderSection('inbox', inboxCount, true)}
        {categories.map((category) => renderSection(category, sectionCounts[category] ?? 0))}
        {renderSection('archived', archivedCount)}
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
