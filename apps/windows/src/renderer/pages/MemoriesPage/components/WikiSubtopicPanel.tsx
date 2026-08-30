/**
 * WikiSubtopicPanel — 一级分区下的二级分类（小类）入口
 */
import React, { useMemo } from 'react'
import { Tooltip } from '../../../components/ui/Tooltip/Tooltip'
import type { WikiTopicTree } from '../../../hooks/business/useWikiPage'
import {
  legacyCategoriesForSection,
  navSectionLabel,
  topicCountKey,
  type WikiNavSection,
} from './wikiNavMapping'

interface WikiSubtopicPanelProps {
  readonly section: WikiNavSection
  /** 若指定则只展示该 legacy 大类下的小类 */
  readonly categoryFilter?: string
  readonly topicTree: WikiTopicTree | null
  readonly topicCounts: Record<string, number>
  readonly onSelectSubtopic: (category: string, subtopic: string) => void
}

/**
 * 渲染一级分区下的二级小类列表，点击进入小类资料列表。
 */
export const WikiSubtopicPanel: React.FC<WikiSubtopicPanelProps> = ({
  section,
  categoryFilter,
  topicTree,
  topicCounts,
  onSelectSubtopic,
}) => {
  const groups = useMemo(() => {
    const legacyNames = categoryFilter
      ? [categoryFilter]
      : legacyCategoriesForSection(section)
    if (!topicTree || legacyNames.length === 0) return []
    return topicTree.categories
      .filter((cat) => legacyNames.includes(cat.name))
      .map((cat) => ({
        category: cat.name,
        subtopics: cat.subtopics.map((subtopic) => ({
          name: subtopic,
          count: topicCounts[topicCountKey(cat.name, subtopic)] ?? 0,
        })),
      }))
  }, [section, categoryFilter, topicTree, topicCounts])

  const totalInSection = groups.reduce(
    (sum, g) => sum + g.subtopics.reduce((s, st) => s + st.count, 0),
    0,
  )

  if (!topicTree) {
    return <p className="wiki-empty-hint">加载分类结构…</p>
  }

  if (groups.every((g) => g.subtopics.length === 0)) {
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
        {groups.flatMap((group) =>
          group.subtopics.map((subtopic) => (
            <li key={`${group.category}/${subtopic.name}`}>
              <Tooltip
                content={`进入「${subtopic.name}」查看该小类下的全部资料`}
                placement="top"
              >
                <button
                  type="button"
                  className="wiki-subtopic-chip"
                  onClick={() => onSelectSubtopic(group.category, subtopic.name)}
                >
                  <span>{subtopic.name}</span>
                  {subtopic.count > 0 && (
                    <span className="wiki-subtopic-chip-count">{subtopic.count}</span>
                  )}
                </button>
              </Tooltip>
            </li>
          )),
        )}
      </ul>
    </div>
  )
}

export default WikiSubtopicPanel
