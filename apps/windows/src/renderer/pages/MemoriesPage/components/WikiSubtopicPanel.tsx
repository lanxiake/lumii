/**
 * WikiSubtopicPanel — 一级分区下的二级分类（小类）入口
 */
import React, { useMemo } from 'react'
import { Tooltip } from '../../../components/ui/Tooltip/Tooltip'
import type { WikiTopicTree } from '../../../hooks/business/useWikiPage'
import {
  UNFILED_SUBTOPIC_LABEL,
  navSectionLabel,
  parseTopicCountKey,
  topicCountKey,
  type WikiNavSection,
} from './wikiTopicDisplay'

interface WikiSubtopicPanelProps {
  /** v1.1：分区即树中的大类名 */
  readonly section: WikiNavSection
  readonly topicTree: WikiTopicTree | null
  readonly topicCounts: Record<string, number>
  /** subtopic 为 null 表示进入该大类的「未细分」分组 */
  readonly onSelectSubtopic: (category: string, subtopic: string | null) => void
}

/**
 * 渲染一级分区下的二级小类列表，点击进入小类资料列表。
 */
export const WikiSubtopicPanel: React.FC<WikiSubtopicPanelProps> = ({
  section,
  topicTree,
  topicCounts,
  onSelectSubtopic,
}) => {
  /** 该大类下的小类 chip；未细分 + 树里没有、但库里还有文件的旧小类也列出来 */
  const chips = useMemo(() => {
    const cat = topicTree?.categories.find((c) => c.name === section)
    if (!cat) return []
    const known = new Set(cat.subtopics)
    const items = cat.subtopics.map((subtopic) => ({
      key: subtopic,
      label: subtopic,
      subtopic: subtopic as string | null,
      count: topicCounts[topicCountKey(cat.name, subtopic)] ?? 0,
    }))
    // 只在真有未细分资料时才显示这一组，避免空 chip 占位
    const unfiledCount = topicCounts[topicCountKey(cat.name)] ?? 0
    if (unfiledCount > 0) {
      items.push({
        key: '__unfiled__',
        label: UNFILED_SUBTOPIC_LABEL,
        subtopic: null,
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
        subtopic: parsed.subtopic,
        count,
      })
    }
    return items
  }, [section, topicTree, topicCounts])

  const totalInSection = chips.reduce((sum, c) => sum + c.count, 0)

  if (!topicTree) {
    return <p className="wiki-empty-hint">加载分类结构…</p>
  }

  if (chips.length === 0) {
    return (
      <p className="wiki-empty-hint">
        「{navSectionLabel(section)}」下还没有小类。可在 更多 → 编辑主题树 中添加。
      </p>
    )
  }

  return (
    <div className="wiki-subtopic-panel">
      <p className="wiki-subtopic-panel-intro">共 {totalInSection} 个文件 · 选择小类查看</p>
      <ul className="wiki-subtopic-chips">
        {chips.map((chip) => (
          <li key={chip.key}>
            <Tooltip
              content={
                chip.subtopic === null
                  ? `进入「${section}」下还没细分小类的资料`
                  : `进入「${chip.label}」查看该小类下的全部资料`
              }
              placement="top"
            >
              <button
                type="button"
                className="wiki-subtopic-chip"
                onClick={() => onSelectSubtopic(section, chip.subtopic)}
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
