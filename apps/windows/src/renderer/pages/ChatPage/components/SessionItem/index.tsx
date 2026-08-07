import React, { useState } from 'react'
import clsx from 'clsx'
import { Pin, PinOff, Trash2, PenLine } from '../../../../components/ui/Icon'
import { ContextMenu } from '../ContextMenu'
import type { ContextMenuItem } from '../ContextMenu'
import type { ChatSession } from '../../../../hooks/business/useChat'
import { getDisplayMessagePreview } from '../../utils/file-attachment-strategy'
import styles from './SessionItem.module.css'

interface SessionItemProps {
  session: ChatSession
  isActive: boolean
  onSelect: () => void
  onPin: () => void
  onDelete: () => void
  onRename: (newTitle: string) => void
  agent?: { id: string; name: string }
}

const SessionItem: React.FC<SessionItemProps> = ({
  session,
  isActive,
  onSelect,
  onPin,
  onDelete,
  onRename,
  agent,
}) => {
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 })
  const [isEditing, setIsEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(session.title)

  const formatTime = (date: Date): string => {
    const d = new Date(date)
    if (isNaN(d.getTime())) return ''
    const now = new Date()
    const isToday =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    if (isToday) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenuPosition({ x: e.clientX, y: e.clientY })
    setShowContextMenu(true)
  }

  const handleStartRename = () => {
    setEditTitle(session.title)
    setIsEditing(true)
    setShowContextMenu(false)
  }

  const handleSaveRename = () => {
    if (editTitle.trim() && editTitle !== session.title) {
      onRename(editTitle.trim())
    }
    setIsEditing(false)
  }

  const handleCancelRename = () => {
    setEditTitle(session.title)
    setIsEditing(false)
  }

  const contextMenuItems: ContextMenuItem[] = [
    {
      id: 'pin',
      label: session.isPinned ? '取消置顶' : '置顶会话',
      icon: session.isPinned ? <PinOff size={14} strokeWidth={1.8} /> : <Pin size={14} strokeWidth={1.8} />,
      onClick: onPin,
    },
    {
      id: 'rename',
      label: '重命名',
      icon: <PenLine size={14} strokeWidth={1.8} />,
      onClick: handleStartRename,
    },
    {
      id: 'delete',
      label: '删除会话',
      icon: <Trash2 size={14} strokeWidth={1.8} />,
      danger: true,
      onClick: onDelete,
    },
  ]

  // Get last message preview（剥离附件与 Agent 注入的 parsed text 等标记）
  const lastMessage = session.messages[session.messages.length - 1]
  const preview = lastMessage?.content
    ? getDisplayMessagePreview(lastMessage.content)
    : '暂无消息'

  if (isEditing) {
    return (
      <div className={clsx(styles['session-item'], styles.editing)}>
        <input
          type="text"
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSaveRename()
            if (e.key === 'Escape') handleCancelRename()
          }}
          onBlur={handleSaveRename}
          autoFocus
          className={styles['session-edit-input']}
        />
      </div>
    )
  }

  return (
    <>
      <div
        className={clsx(
          styles['session-item'],
          isActive && styles.active,
          session.isPinned && styles.pinned,
          session.isStreaming && styles.streaming,
        )}
        onClick={onSelect}
        onContextMenu={handleContextMenu}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect()
          }
        }}
      >
        <div className={styles['session-content']}>
          <div className={styles['session-title-row']}>
            {session.isPinned && (
              <Pin className={styles['session-pin-icon']} size={11} strokeWidth={2} />
            )}
            <span className={styles['session-title']}>{session.title || '新对话'}</span>
            <div className={styles['status-badges']}>
              {isActive && <span className={styles['active-dot']} title="当前查看会话" />}
              {session.isStreaming && <span className={styles['streaming-dot']} title="AI 正在回复" />}
            </div>
            <span className={styles['session-time']}>{formatTime(session.updatedAt)}</span>
          </div>
          {agent && (
            <span className={styles['agent-badge']}>{agent.name}</span>
          )}
          <div className={styles['session-preview']}>{preview}</div>
        </div>

        {/* Hover actions */}
        <div className={styles['session-hover-actions']}>
          <button
            className={styles['session-action-btn']}
            onClick={(e) => {
              e.stopPropagation()
              onPin()
            }}
            title={session.isPinned ? '取消置顶' : '置顶'}
            aria-label={session.isPinned ? '取消置顶' : '置顶'}
          >
            {session.isPinned ? (
              <PinOff size={13} strokeWidth={1.8} />
            ) : (
              <Pin size={13} strokeWidth={1.8} />
            )}
          </button>
          <button
            className={clsx(styles['session-action-btn'], styles.delete)}
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            title="删除"
            aria-label="删除会话"
          >
            <Trash2 size={13} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {showContextMenu && (
        <ContextMenu
          items={contextMenuItems}
          position={contextMenuPosition}
          onClose={() => setShowContextMenu(false)}
        />
      )}
    </>
  )
}

export default SessionItem
export { SessionItem }
