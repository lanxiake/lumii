import React, { useEffect, useMemo, useState } from 'react'
import { PARKING_CATEGORY } from '@mtbot/agent-runtime/browser'
import { Modal } from '../../../components/ui/Modal'
import { Button } from '../../../components/ui/Button/Button'
import type { WikiTopicTree } from '../../../hooks/business/useWikiPage'

interface WikiTopicPickerProps {
  open: boolean
  tree: WikiTopicTree | null
  /** 弹窗标题，默认「归档到…」 */
  title?: string
  /** 待归档条目名称，展示在选择区上方帮助用户确认对象 */
  itemTitle?: string
  onCancel: () => void
  onConfirm: (category: string, subtopic: string) => void
  /** 提供时显示次要按钮「让 AI 建议」；不传则完全保持一期行为 */
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
 * 用途目录两级选择器：先选大类再选小类，只允许从主题树里挑，不提供自由输入。
 * 临时存放不是正式目录，这里始终不列出，只能通过文件列表的「存到临时存放」进入。
 */
export const WikiTopicPicker: React.FC<WikiTopicPickerProps> = ({
  open,
  tree,
  title = '归档到…',
  itemTitle,
  onCancel,
  onConfirm,
  onRequestSuggestion,
  suggestion,
  suggestionState = 'idle',
  onAdoptSuggestion,
  extraSection,
}) => {
  const categories = useMemo(
    () => (tree?.categories ?? []).filter((item) => item.name !== PARKING_CATEGORY),
    [tree],
  )
  const [category, setCategory] = useState<string | null>(null)
  const [subtopic, setSubtopic] = useState<string | null>(null)

  // 每次重新打开都回到大类选择，避免沿用上一个条目的选择造成误归档
  useEffect(() => {
    if (open) {
      setCategory(null)
      setSubtopic(null)
    }
  }, [open])

  const subtopics = useMemo(
    () => categories.find((item) => item.name === category)?.subtopics ?? [],
    [categories, category],
  )

  return (
    <Modal
      open={open}
      title={title}
      width={460}
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
          <Button
            variant="primary"
            size="sm"
            disabled={!category || !subtopic}
            onClick={() => {
              if (category && subtopic) onConfirm(category, subtopic)
            }}
          >
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
          <h4 className="wiki-topic-picker-heading">选择大类</h4>
          <div className="wiki-topic-picker-options">
            {categories.map((item) => (
              <button
                key={item.name}
                type="button"
                className={`wiki-topic-picker-option${category === item.name ? ' wiki-topic-picker-option--active' : ''}`}
                aria-pressed={category === item.name}
                onClick={() => {
                  setCategory(item.name)
                  setSubtopic(null)
                }}
              >
                {item.name}
              </button>
            ))}
          </div>
        </section>

        {category && (
          <section className="wiki-topic-picker-section">
            <h4 className="wiki-topic-picker-heading">选择小类</h4>
            <div className="wiki-topic-picker-options">
              {subtopics.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`wiki-topic-picker-option${subtopic === name ? ' wiki-topic-picker-option--active' : ''}`}
                  aria-pressed={subtopic === name}
                  onClick={() => setSubtopic(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          </section>
        )}

        {!category && <p className="wiki-topic-picker-hint">先选一个大类，再选具体小类。</p>}
        {extraSection}
      </div>
    </Modal>
  )
}

export default WikiTopicPicker
