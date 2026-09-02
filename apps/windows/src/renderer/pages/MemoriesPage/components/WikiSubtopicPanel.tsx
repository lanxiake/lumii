/**
 * WikiSubtopicPanel — 大类下的小类筛选条（默认「全部」，点击小类过滤文件列表）
 */
import React, { useMemo } from 'react'
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

interface WikiSubtopicPanelProps {
  /** v1.1：分区即树中的大类名 */
  readonly section: WikiNavSection
  readonly topicTree: WikiTopicTree | null
  readonly topicCounts: Record<string, number>
  /** 该大类下的文件总数（左栏角标同源） */
  readonly sectionFileCount: number
  readonly activeFilter: WikiSubtopicFilter
  readonly onSelectFilter: (filter: WikiSubtopicFilter) => void
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

  if (!topicTree) {
    return <p className="wiki-empty-hint">加载分类结构…</p>
  }

  return (
    <div className="wiki-subtopic-panel">
      <p className="wiki-subtopic-panel-intro">
        共 {sectionFileCount} 个文件 · 按小类筛选
      </p>
      <ul className="wiki-subtopic-chips" role="tablist" aria-label={`${navSectionLabel(section)}小类筛选`}>
        <li role="presentation">
          <Tooltip content={`显示「${section}」下的全部文件`} placement="top">
            <button
              type="button"
              role="tab"
              aria-selected={activeFilter === WIKI_SUBTOPIC_FILTER_ALL}
              className={`wiki-subtopic-chip${activeFilter === WIKI_SUBTOPIC_FILTER_ALL ? ' wiki-subtopic-chip--active' : ''}`}
              onClick={() => onSelectFilter(WIKI_SUBTOPIC_FILTER_ALL)}
            >
              <span>全部</span>
              {sectionFileCount > 0 && (
                <span className="wiki-subtopic-chip-count">{sectionFileCount}</span>
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
              placement="top"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeFilter === chip.filter}
                className={`wiki-subtopic-chip${activeFilter === chip.filter ? ' wiki-subtopic-chip--active' : ''}`}
                onClick={() => onSelectFilter(chip.filter)}
              >
                <span>{chip.label}</span>
                {chip.count > 0 && <span className="wiki-subtopic-chip-count">{chip.count}</span>}
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default WikiSubtopicPanel
