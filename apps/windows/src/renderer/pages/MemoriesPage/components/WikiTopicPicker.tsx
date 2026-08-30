import React, { useEffect, useMemo, useState } from 'react'
import { Modal } from '../../../components/ui/Modal'
import { WIKI_MODAL_LAYER } from './wikiModalLayer'
import { Button } from '../../../components/ui/Button/Button'
import type { WikiTopicTree } from '../../../hooks/business/useWikiPage'
import {
  legacyCategoriesForSection,
  navSectionLabel,
  type WikiNavSection,
} from './wikiNavMapping'

/** 归档弹层第一步可选分区（不含待整理 / 临时存放） */
export const WIKI_TOPIC_PICKER_SECTIONS: readonly WikiNavSection[] = [
  'work',
  'study',
  'life',
  'collection',
  'archived',
]

/** 待整理批量归档：只选活跃分区，不含「已归档」冷存储 */
export const WIKI_TOPIC_PICKER_ACTIVE_SECTIONS: readonly WikiNavSection[] = [
  'work',
  'study',
  'life',
  'collection',
]

interface TopicTarget {
  readonly category: string
  readonly subtopic: string
}

interface WikiTopicPickerProps {
  open: boolean
  tree: WikiTopicTree | null
  /** 弹窗标题，默认「归档到…」 */
  title?: string
  /** 待归档条目名称，展示在选择区上方帮助用户确认对象 */
  itemTitle?: string
  /** 第一步分区列表；默认含「已归档」 */
  sections?: readonly WikiNavSection[]
  onCancel: () => void
  /** 写入主题树；category 为旧大类真名（与左栏分区映射一致） */
  onConfirm: (category: string, subtopic: string) => void
  /** 选中「已归档」分区时调用，不走 update-topic */
  onConfirmArchive?: () => void
  /** 提供时显示次要按钮「让 AI 建议」 */
  onRequestSuggestion?: () => void
  /** AI 建议结果 */
  suggestion?: { category: string; subtopic: string; reason: string } | null
  suggestionState?: 'idle' | 'loading' | 'failed'
  /** 采用建议：走确定性写入路径，不占用重编目批次 */
  onAdoptSuggestion?: () => void
  /** 选目录区下方的附加内容（如整合接受选项） */
  extraSection?: React.ReactNode
}

/**
 * 根据分区从主题树取出小类分组（与 WikiSubtopicPanel 同源逻辑）。
 */
function buildSubtopicGroups(
  tree: WikiTopicTree | null,
  section: WikiNavSection,
): ReadonlyArray<{ category: string; subtopics: readonly string[] }> {
  const legacyNames = legacyCategoriesForSection(section)
  if (!tree || legacyNames.length === 0) return []
  return tree.categories
    .filter((cat) => legacyNames.includes(cat.name))
    .map((cat) => ({ category: cat.name, subtopics: cat.subtopics }))
}

/**
 * 用途目录两级选择器：先选左栏分区（工作/学习/生活/收藏），再选小类。
 * 回调仍传旧大类真名 + 小类，与 updateSourceTopic / organizeInbox 兼容。
 */
export const WikiTopicPicker: React.FC<WikiTopicPickerProps> = ({
  open,
  tree,
  title = '归档到…',
  itemTitle,
  sections = WIKI_TOPIC_PICKER_SECTIONS,
  onCancel,
  onConfirm,
  onConfirmArchive,
  onRequestSuggestion,
  suggestion,
  suggestionState = 'idle',
  onAdoptSuggestion,
  extraSection,
}) => {
  const [section, setSection] = useState<WikiNavSection | null>(null)
  const [target, setTarget] = useState<TopicTarget | null>(null)

  /** 每次重新打开都回到分区选择，避免沿用上一个条目的选择造成误归档 */
  useEffect(() => {
    if (open) {
      setSection(null)
      setTarget(null)
    }
  }, [open])

  const subtopicGroups = useMemo(
    () => (section && section !== 'archived' ? buildSubtopicGroups(tree, section) : []),
    [tree, section],
  )

  const isArchiveSection = section === 'archived'
  const canConfirm = isArchiveSection ? Boolean(onConfirmArchive) : Boolean(target)

  /**
   * 确认：已归档走 archive；其余走主题写入。
   */
  const handleConfirm = () => {
    if (isArchiveSection) {
      onConfirmArchive?.()
      return
    }
    if (target) onConfirm(target.category, target.subtopic)
  }

  return (
    <Modal
      open={open}
      title={title}
      width={460}
      layer={WIKI_MODAL_LAYER}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
          {onRequestSuggestion && suggestionState === 'idle' && !suggestion && (
            <Button variant="ghost" size="sm" onClick={onRequestSuggestion}>
              让 AI 建议
            </Button>
          )}
          {suggestion && onAdoptSuggestion && (
            <Button variant="primary" size="sm" onClick={onAdoptSuggestion}>
              采用建议
            </Button>
          )}
          <Button variant="primary" size="sm" disabled={!canConfirm} onClick={handleConfirm}>
            确认归档
          </Button>
        </>
      }
    >
      <div className="wiki-topic-picker">
        {itemTitle && <p className="wiki-topic-picker-item">{itemTitle}</p>}

        {suggestionState === 'loading' && <p className="wiki-topic-picker-hint">正在请求 AI 建议…</p>}
        {suggestionState === 'failed' && (
          <p className="wiki-topic-picker-error">建议失败：模型不可用或返回格式错误</p>
        )}
        {suggestion && (
          <p className="wiki-topic-picker-suggestion">
            AI 建议：{suggestion.category} / {suggestion.subtopic} — {suggestion.reason}
          </p>
        )}

        <section className="wiki-topic-picker-section">
          <h4 className="wiki-topic-picker-heading">选择分区</h4>
          <div className="wiki-topic-picker-options">
            {sections.map((item) => (
              <button
                key={item}
                type="button"
                className={`wiki-topic-picker-option${section === item ? ' wiki-topic-picker-option--active' : ''}`}
                aria-pressed={section === item}
                onClick={() => {
                  setSection(item)
                  setTarget(null)
                }}
              >
                {navSectionLabel(item)}
              </button>
            ))}
          </div>
        </section>

        {section && !isArchiveSection && (
          <section className="wiki-topic-picker-section">
            <h4 className="wiki-topic-picker-heading">选择小类</h4>
            {subtopicGroups.length === 0 ? (
              <p className="wiki-topic-picker-hint">该分区下还没有小类，可在 更多 → 编辑主题树 中添加。</p>
            ) : (
              <div className="wiki-topic-picker-options">
                {subtopicGroups.flatMap((group) =>
                  group.subtopics.map((name) => {
                    const active = target?.category === group.category && target?.subtopic === name
                    return (
                      <button
                        key={`${group.category}/${name}`}
                        type="button"
                        className={`wiki-topic-picker-option${active ? ' wiki-topic-picker-option--active' : ''}`}
                        aria-pressed={active}
                        onClick={() => setTarget({ category: group.category, subtopic: name })}
                      >
                        {name}
                      </button>
                    )
                  }),
                )}
              </div>
            )}
          </section>
        )}

        {isArchiveSection && (
          <p className="wiki-topic-picker-hint">移入「已归档」后资料不再出现在活跃分区，可随时恢复。</p>
        )}

        {!section && <p className="wiki-topic-picker-hint">先选一个分区，再选具体小类。</p>}
        {extraSection}
      </div>
    </Modal>
  )
}

export default WikiTopicPicker
