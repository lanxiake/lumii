import React, { useState } from 'react'
import clsx from 'clsx'
import { toPng } from 'html-to-image'
import { ConfirmModal } from '../../../../components/ui/Modal/ConfirmModal'
import { useTtsPreview } from '../../../../hooks/business/useTtsPreview'
import styles from './MessageActions.module.css'

interface MessageActionsProps {
  messageId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  isEditing: boolean
  onCopy: (content: string) => void
  onEditStart: () => void
  onEditCancel: () => void
  onEditSave: (newContent: string) => void
  onDelete: (messageId: string) => void
  onRegenerate: (messageId: string) => void
  sessionBusy?: boolean
  isVoice?: boolean
  isReplaying?: boolean
  onReplay?: () => void
  bubbleRef?: React.RefObject<HTMLDivElement>
}

const MessageActions: React.FC<MessageActionsProps> = ({
  messageId,
  role,
  content,
  isEditing,
  onCopy,
  onEditStart,
  onEditCancel,
  onEditSave,
  onDelete,
  onRegenerate,
  sessionBusy,
  isVoice,
  isReplaying,
  onReplay,
  bubbleRef,
}) => {
  const [editValue, setEditValue] = useState(content)
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [feedback, setFeedback] = useState<'like' | 'dislike' | null>(null)
  const [copyingImage, setCopyingImage] = useState(false)

  /**
   * 朗读：chunk 排队播放、只停自己那一次、卸载不误伤别人的朗读 —— 全在 hook 里，
   * 与划词气泡共用同一份实现（见 useTtsPreview 文件头）。
   */
  const { isSpeaking, speak, stop: stopSpeaking } = useTtsPreview()

  const handleCopy = () => onCopy(content)

  const handleCopyAsImage = async () => {
    if (!bubbleRef?.current || copyingImage) return
    setCopyingImage(true)
    try {
      const dataUrl = await toPng(bubbleRef.current, { cacheBust: true, pixelRatio: 2 })
      const blob = await (async () => {
        const base64 = dataUrl.split(',')[1]
        const bytes = atob(base64)
        const arr = new Uint8Array(bytes.length)
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
        return new Blob([arr], { type: 'image/png' })
      })()
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    } catch (err) {
      console.error('[MessageActions] 复制为图片失败:', err)
    } finally {
      setCopyingImage(false)
    }
  }

  const handleDelete = () => setIsDeleteModalOpen(true)
  const handleConfirmDelete = () => { onDelete(messageId); setIsDeleteModalOpen(false) }
  const handleCancelDelete = () => setIsDeleteModalOpen(false)

  const handleSave = () => {
    if (editValue.trim()) onEditSave(editValue.trim())
  }
  const handleCancel = () => { setEditValue(content); onEditCancel() }

  /**
   * 朗读开关。chunk 播放、只停自己那一次、卸载不误伤 —— 都在 useTtsPreview 里。
   *
   * 消息朗读要用 8000 的上限：设置页试听的 100 字上限会把后半段静默截断，
   * 而且因为分片看起来像「缓存命中」，很难被发现。
   */
  const handleSpeak = async () => {
    if (isSpeaking) {
      await stopSpeaking()
      return
    }
    await speak(content, { maxChars: 8000 })
  }

  if (isEditing) {
    return (
      <div className={styles['message-edit-mode']}>
        <textarea
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          className={styles['edit-textarea']}
          autoFocus
        />
        <div className={styles['edit-actions']}>
          <button className={clsx(styles['edit-btn'], styles.save)} onClick={handleSave}>保存</button>
          <button className={clsx(styles['edit-btn'], styles.cancel)} onClick={handleCancel}>取消</button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles['message-actions']}>
      {/* 复制 */}
      <button className={styles['action-btn']} onClick={handleCopy} title="复制">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>

      {/* 复制为图片 */}
      <button
        className={styles['action-btn']}
        onClick={handleCopyAsImage}
        disabled={copyingImage}
        title={copyingImage ? '正在截图...' : '复制为图片'}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      </button>

      {/* 语音朗读（仅 assistant） */}
      {role === 'assistant' && (
        <button
          className={clsx(styles['action-btn'], isSpeaking && styles.active)}
          onClick={handleSpeak}
          title={isSpeaking ? '停止朗读' : '朗读'}
        >
          {isSpeaking ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
          )}
        </button>
      )}

      {/* 点赞（仅 assistant） */}
      {role === 'assistant' && (
        <button
          className={clsx(styles['action-btn'], feedback === 'like' && styles.liked)}
          onClick={() => setFeedback((p) => (p === 'like' ? null : 'like'))}
          title="有帮助"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill={feedback === 'like' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
            <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z" />
            <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
          </svg>
        </button>
      )}

      {/* 点踩（仅 assistant） */}
      {role === 'assistant' && (
        <button
          className={clsx(styles['action-btn'], feedback === 'dislike' && styles.disliked)}
          onClick={() => setFeedback((p) => (p === 'dislike' ? null : 'dislike'))}
          title="没有帮助"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill={feedback === 'dislike' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
            <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z" />
            <path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
          </svg>
        </button>
      )}

      {/* 编辑（仅 user） */}
      {role === 'user' && (
        <button className={styles['action-btn']} onClick={onEditStart} title="编辑">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
      )}

      {/* 回放对话（仅语音消息） */}
      {isVoice && onReplay && (
        <button
          className={clsx(styles['action-btn'], isReplaying && styles.active)}
          onClick={onReplay}
          title={isReplaying ? '正在回放...' : '从此处回放对话'}
        >
          {isReplaying ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <polygon points="5,3 19,12 5,21" />
            </svg>
          )}
        </button>
      )}

      {/* 重新生成（user / assistant 均可）：回到对应提问，删后续重答 */}
      {(role === 'user' || role === 'assistant') && (
        <button
          className={clsx(styles['action-btn'], styles.regenerate)}
          onClick={() => onRegenerate(messageId)}
          disabled={sessionBusy}
          title={sessionBusy ? '正在回复中…' : '重新生成'}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      )}

      {/* 分享（复制到剪贴板） */}
      <button className={styles['action-btn']} onClick={() => onCopy(content)} title="分享">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </svg>
      </button>

      {/* 删除 */}
      <button className={clsx(styles['action-btn'], styles.delete)} onClick={handleDelete} title="删除">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>

      <ConfirmModal
        open={isDeleteModalOpen}
        title="确认删除消息"
        content="确定要删除这条消息吗？此操作不可恢复。"
        confirmText="删除"
        cancelText="取消"
        confirmVariant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </div>
  )
}

export default MessageActions
export { MessageActions }
