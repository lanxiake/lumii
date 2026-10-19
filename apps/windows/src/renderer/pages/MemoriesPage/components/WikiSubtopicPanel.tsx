/**
 * WikiSubtopicPanel — 大类下的小类筛选条（默认「全部」，点击小类过滤文件列表）
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Tooltip } from '../../../components/ui/Tooltip/Tooltip'
import type { WikiTopicTree } from '../../../hooks/business/useWikiPage'
import {
  UNFILED_SUBTOPIC_LABEL,
  WIKI_SUBTOPIC_FILTER_ALL,
  WIKI_SUBTOPIC_FILTER_UNFILED,
  navSectionLabel,
  parseTopicCountKey,
  topicCountKey,
  type WikiNavSection,
  type WikiSubtopicFilter,
} from './wikiTopicDisplay'
import styles from './WikiSubtopicPanel.module.css'
import shared from './wiki-shared.module.css'
import type { WikiTagCount } from './wikiFilters'

/** 标签芯片默认显示数量；超出的收进「更多标签」 */
const TAG_CHIP_LIMIT = 12

interface WikiSubtopicPanelProps {
  /** v1.1：分区即树中的大类名 */
  readonly section: WikiNavSection
  readonly topicTree: WikiTopicTree | null
  readonly topicCounts: Record<string, number>
  /** 该大类下的文件总数（左栏角标同源） */
  readonly sectionFileCount: number
  readonly activeFilter: WikiSubtopicFilter
  readonly onSelectFilter: (filter: WikiSubtopicFilter) => void
  /** 当前选中的标签（本地筛选，见 wikiFilters.ts） */
  readonly activeTag?: string | null
  readonly onSelectTag?: (tag: string | null) => void
  /** 当前列表里出现过的标签及次数 */
  readonly tagCounts?: readonly WikiTagCount[]
  /** 当前按哪个目录前缀收窄（层级浏览） */
  readonly activePathPrefix?: readonly string[] | null
  readonly onClearPathPrefix?: () => void
}

/**
 * 渲染大类下的小类筛选芯片：默认「全部」，再列出各小类与「未细分」。
 */
export const WikiSubtopicPanel: React.FC<WikiSubtopicPanelProps> = ({
  section,
  topicTree,
  topicCounts,
  sectionFileCount,
  activeFilter,
  onSelectFilter,
  activeTag,
  onSelectTag,
  tagCounts,
  activePathPrefix,
  onClearPathPrefix,
}) => {
  /** 除「全部」外的小类 chip */
  const subtopicChips = useMemo(() => {
    const cat = topicTree?.categories.find((c) => c.name === section)
    if (!cat) return []
    const known = new Set(cat.subtopics)
    const items: Array<{ key: string; label: string; filter: WikiSubtopicFilter; count: number }> = []

    for (const subtopic of cat.subtopics) {
      items.push({
        key: subtopic,
        label: subtopic,
        filter: subtopic,
        count: topicCounts[topicCountKey(cat.name, subtopic)] ?? 0,
      })
    }

    const unfiledCount = topicCounts[topicCountKey(cat.name)] ?? 0
    if (unfiledCount > 0) {
      items.push({
        key: '__unfiled__',
        label: UNFILED_SUBTOPIC_LABEL,
        filter: WIKI_SUBTOPIC_FILTER_UNFILED,
        count: unfiledCount,
      })
    }

    for (const [key, count] of Object.entries(topicCounts)) {
      if (count <= 0) continue
      const parsed = parseTopicCountKey(key)
      if (!parsed || parsed.category !== cat.name || parsed.subtopic === null) continue
      if (known.has(parsed.subtopic)) continue
      items.push({
        key: parsed.subtopic,
        label: parsed.subtopic,
        filter: parsed.subtopic,
        count,
      })
    }

    return items
  }, [section, topicTree, topicCounts])

  /**
   * 标签筛选芯片：计数由调用方按当前列表统计（见 wikiFilters.buildTagCounts）。
   *
   * 默认只显示前 TAG_CHIP_LIMIT 个：实测「学习」大类有 100+ 个标签，
   * 全量渲染会把整块面板撑满、把文件列表挤出视口（2026-10-19 真机截图确认）。
   * 切换大类时收起，避免上一类的展开状态带到下一类。
   */
  const allTagChips = onSelectTag ? (tagCounts ?? []) : []
  const [showAllTags, setShowAllTags] = useState(false)
  useEffect(() => {
    setShowAllTags(false)
  }, [section])
  const tagChips = showAllTags ? allTagChips : allTagChips.slice(0, TAG_CHIP_LIMIT)

  if (!topicTree) {
    return <p className={shared['wiki-empty-hint']}>加载分类结构…</p>
  }

  return (
    <div className="wiki-subtopic-panel">
      <p className={styles['wiki-subtopic-panel-intro']}>
        共 {sectionFileCount} 个文件 · 按小类筛选
      </p>
      <ul className={styles['wiki-subtopic-chips']} role="tablist" aria-label={`${navSectionLabel(section)}小类筛选`}>
        <li role="presentation">
          <Tooltip
            content={`显示「${section}」下的全部文件`}
            placement="bottom"
            className={`${styles['wiki-subtopic-chip-tooltip']} ${shared['wiki-tooltip-below']}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeFilter === WIKI_SUBTOPIC_FILTER_ALL}
              className={`${styles['wiki-subtopic-chip']}${activeFilter === WIKI_SUBTOPIC_FILTER_ALL ? ` ${styles['wiki-subtopic-chip--active']}` : ''}`}
              onClick={() => onSelectFilter(WIKI_SUBTOPIC_FILTER_ALL)}
            >
              <span>全部</span>
              {sectionFileCount > 0 && (
                <span className={styles['wiki-subtopic-chip-count']}>{sectionFileCount}</span>
              )}
            </button>
          </Tooltip>
        </li>
        {subtopicChips.map((chip) => (
          <li key={chip.key} role="presentation">
            <Tooltip
              content={
                chip.filter === WIKI_SUBTOPIC_FILTER_UNFILED
                  ? `只显示「${section}」下尚未细分小类的资料`
                  : `只显示「${chip.label}」小类下的资料`
              }
              placement="bottom"
              className={`${styles['wiki-subtopic-chip-tooltip']} ${shared['wiki-tooltip-below']}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeFilter === chip.filter}
                className={`${styles['wiki-subtopic-chip']}${activeFilter === chip.filter ? ` ${styles['wiki-subtopic-chip--active']}` : ''}`}
                onClick={() => onSelectFilter(chip.filter)}
              >
                <span>{chip.label}</span>
                {chip.count > 0 && <span className={styles['wiki-subtopic-chip-count']}>{chip.count}</span>}
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>

      {activePathPrefix && activePathPrefix.length > 0 && onClearPathPrefix && (
        <div className={styles['wiki-subtopic-chips']} role="group" aria-label="路径筛选">
          <span className={`${styles['wiki-subtopic-chip']} ${styles['wiki-subtopic-chip--active']}`}>
            <span>路径：{activePathPrefix.join(' / ')}</span>
          </span>
          <button type="button" className={styles['wiki-subtopic-chip']} onClick={onClearPathPrefix}>
            清除路径筛选
          </button>
        </div>
      )}

      {tagChips.length > 0 && onSelectTag && (
        <>
          <p className={`${styles['wiki-subtopic-panel-intro']} wiki-subtopic-panel-intro--projects`}>
            标签筛选
          </p>
          <ul className={styles['wiki-subtopic-chips']} role="tablist" aria-label="标签筛选">
            <li role="presentation">
              <button
                type="button"
                role="tab"
                aria-selected={activeTag === null || activeTag === undefined}
                className={`${styles['wiki-subtopic-chip']}${activeTag === null || activeTag === undefined ? ` ${styles['wiki-subtopic-chip--active']}` : ''}`}
                onClick={() => onSelectTag(null)}
              >
                <span>全部标签</span>
              </button>
            </li>
            {tagChips.map((chip) => (
              <li key={chip.tag} role="presentation">
                <Tooltip
                  content={`只显示带「${chip.tag}」标签的资料`}
                  placement="bottom"
                  className={`${styles['wiki-subtopic-chip-tooltip']} ${shared['wiki-tooltip-below']}`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTag === chip.tag}
                    className={`${styles['wiki-subtopic-chip']}${activeTag === chip.tag ? ` ${styles['wiki-subtopic-chip--active']}` : ''}`}
                    onClick={() => onSelectTag(chip.tag)}
                  >
                    <span>{chip.tag}</span>
                    {chip.count > 0 && <span className={styles['wiki-subtopic-chip-count']}>{chip.count}</span>}
                  </button>
                </Tooltip>
              </li>
            ))}
            {allTagChips.length > TAG_CHIP_LIMIT && (
              <li role="presentation">
                <button
                  type="button"
                  className={styles['wiki-subtopic-chip']}
                  onClick={() => setShowAllTags((v) => !v)}
                >
                  {showAllTags ? '收起标签' : `更多标签 +${allTagChips.length - TAG_CHIP_LIMIT}`}
                </button>
              </li>
            )}
          </ul>
        </>
      )}
    </div>
  )
}
