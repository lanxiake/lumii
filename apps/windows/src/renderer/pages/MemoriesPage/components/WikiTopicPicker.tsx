import React, { useEffect, useMemo, useState } from 'react'
import { Modal } from '../../../components/ui/Modal'
import { WIKI_MODAL_LAYER } from './wikiModalLayer'
import { Button } from '../../../components/ui/Button/Button'
import type { WikiTopicTree } from '../../../hooks/business/useWikiPage'
import { navSectionLabel, type WikiNavSection } from './wikiTopicDisplay'

/** 「已归档」是系统分区，与树中的大类并列出现在第一步 */
const ARCHIVED_SECTION: WikiNavSection = 'archived'

interface TopicTarget {
  readonly category: string
  /** null = 暂不细分（小类可选，见设计 §2.1.1） */
  readonly subtopic: string | null
}

interface WikiTopicPickerProps {
  open: boolean
  tree: WikiTopicTree | null
  /** 弹窗标题，默认「归档到…」 */
  title?: string
  /** 待归档条目名称，展示在选择区上方帮助用户确认对象 */
  itemTitle?: string
  /** 是否在第一步提供「已归档」；收件箱批量归档场景传 false（不进冷存储） */
  includeArchived?: boolean
  onCancel: () => void
  /** 写入主题树；subtopic 为 null 表示只归大类、暂不细分 */
  onConfirm: (category: string, subtopic: string | null) => void
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
 * 用途目录两级选择器：先选大类，再选小类（可「暂不细分」）。
 * v1.1：分区就是树中的大类，不再有「分区 → 旧大类」的中间映射。
 */
export const WikiTopicPicker: React.FC<WikiTopicPickerProps> = ({
  open,
  tree,
  title = '归档到…',
  itemTitle,
  includeArchived = true,
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

  /** 第一步分区 = 树中的大类（按树序）+ 可选的「已归档」 */
  const sections = useMemo<readonly WikiNavSection[]>(() => {
    const categories = tree?.categories.map((c) => c.name) ?? []
    return includeArchived ? [...categories, ARCHIVED_SECTION] : categories
  }, [tree, includeArchived])

  const subtopics = useMemo<readonly string[]>(() => {
    if (!section || section === ARCHIVED_SECTION) return []
    return tree?.categories.find((c) => c.name === section)?.subtopics ?? []
  }, [tree, section])

  const isArchiveSection = section === ARCHIVED_SECTION
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
            <div className="wiki-topic-picker-options">
              {subtopics.map((name) => {
                const active = target?.category === section && target?.subtopic === name
                return (
                  <button
                    key={name}
                    type="button"
                    className={`wiki-topic-picker-option${active ? ' wiki-topic-picker-option--active' : ''}`}
                    aria-pressed={active}
                    onClick={() => setTarget({ category: section, subtopic: name })}
                  >
                    {name}
                  </button>
                )
              })}
              {/* 小类可选：拿不准就只归大类，不逼用户硬选一个（设计 §2.1.1） */}
              <button
                type="button"
                className={`wiki-topic-picker-option${
                  target?.category === section && target?.subtopic === null
                    ? ' wiki-topic-picker-option--active'
                    : ''
                }`}
                aria-pressed={target?.category === section && target?.subtopic === null}
                onClick={() => setTarget({ category: section, subtopic: null })}
              >
                暂不细分
              </button>
            </div>
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
