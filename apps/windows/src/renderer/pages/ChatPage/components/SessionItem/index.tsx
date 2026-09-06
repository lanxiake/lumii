import React, { useRef, useState } from 'react'
import clsx from 'clsx'
import { Pin, PinOff, Trash2, PenLine, Circle, MoreHorizontal } from '../../../../components/ui/Icon'
import { ContextMenu } from '../ContextMenu'
import type { ContextMenuItem } from '../ContextMenu'
import type { ChatSession } from '../../../../hooks/business/useChat'
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

/**
 * 格式化会话更新时间，用于 tooltip。
 */
function formatTooltipTime(date: Date): string {
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

/**
 * 会话列表单行项：状态图标 + 标题（运行中标题光波）+ ··· 菜单。
 */
const SessionItem: React.FC<SessionItemProps> = ({
  session,
  isActive,
  onSelect,
  onPin,
  onDelete,
  onRename,
}) => {
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 })
  const [isEditing, setIsEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(session.title)
  const moreBtnRef = useRef<HTMLButtonElement>(null)

  /**
   * 在指定屏幕坐标打开上下文菜单。
   */
  const openContextMenuAt = (x: number, y: number) => {
    setContextMenuPosition({ x, y })
    setShowContextMenu(true)
  }

  /**
   * 右键整行打开菜单。
   */
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    openContextMenuAt(e.clientX, e.clientY)
  }

  /**
   * 点击 ··· 在按钮下方打开菜单。
   */
  const handleMoreClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    const rect = moreBtnRef.current?.getBoundingClientRect()
    if (rect) {
      openContextMenuAt(rect.right - 168, rect.bottom + 4)
    } else {
      openContextMenuAt(e.clientX, e.clientY)
    }
  }

  /**
   * 进入行内重命名。
   */
  const handleStartRename = () => {
    setEditTitle(session.title)
    setIsEditing(true)
    setShowContextMenu(false)
  }

  /**
   * 保存重命名结果。
   */
  const handleSaveRename = () => {
    if (editTitle.trim() && editTitle !== session.title) {
      onRename(editTitle.trim())
    }
    setIsEditing(false)
  }

  /**
   * 取消重命名。
   */
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

  const displayTitle = session.title || '新对话'
  const tooltipTime = formatTooltipTime(session.updatedAt)
  const itemTitle = session.isStreaming
    ? `${displayTitle} · AI 正在回复${tooltipTime ? ` · ${tooltipTime}` : ''}`
    : tooltipTime
      ? `${displayTitle} · ${tooltipTime}`
      : displayTitle

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

  /**
   * 渲染左侧状态圆点：选中实心 / 默认空心（运行态改由标题光波表达）。
   */
  const renderStatusIcon = () => {
    if (isActive) {
      return (
        <Circle
          className={clsx(styles['status-icon'], styles['status-icon--active'])}
          size={10}
          strokeWidth={0}
          fill="currentColor"
          aria-hidden
        />
      )
    }
    return (
      <Circle
        className={clsx(styles['status-icon'], styles['status-icon--idle'])}
        size={10}
        strokeWidth={1.6}
        fill="none"
        aria-hidden
      />
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
        title={itemTitle}
        aria-busy={session.isStreaming || undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect()
          }
        }}
      >
        <span className={styles['status-slot']}>{renderStatusIcon()}</span>

        {session.isPinned && (
          <Pin className={styles['session-pin-icon']} size={11} strokeWidth={2} aria-hidden />
        )}

        <span
          className={clsx(
            styles['session-title'],
            session.isStreaming && styles['session-title--streaming'],
          )}
        >
          {displayTitle}
        </span>

        <button
          ref={moreBtnRef}
          type="button"
          className={styles['session-more-btn']}
          onClick={handleMoreClick}
          aria-label="会话操作"
          title="会话操作"
        >
          <MoreHorizontal size={14} strokeWidth={1.8} />
        </button>
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
