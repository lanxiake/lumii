import React from 'react'
import clsx from 'clsx'
import { BookOpen, FolderOpen, PanelLeft, Volume2, VolumeX } from 'lucide-react'
import styles from '../ChatPage.module.css'

export interface ChatToolbarProps {
  title: string
  pageZoom: number
  autoApprove: boolean
  readAloudActive: boolean
  readAloudSpeaking: boolean
  workbenchOpen: boolean
  /** 「上次看工作台之后新增了几份成品」（0 = 不显示角标） */
  workbenchBadge?: number
  /** 开发上下文 chip（非主 Agent 后端时展示「工具 · 项目」） */
  devContextChip?: React.ReactNode
  onToggleSidebar: () => void
  onResetZoom: () => void
  onToggleAutoApprove: () => void
  onToggleReadAloud: () => void
  onToggleWorkbench: () => void
  onOpenWiki?: () => void
}

export const ChatToolbar: React.FC<ChatToolbarProps> = ({
  title,
  pageZoom,
  autoApprove,
  readAloudActive,
  readAloudSpeaking,
  workbenchOpen,
  workbenchBadge = 0,
  devContextChip,
  onToggleSidebar,
  onResetZoom,
  onToggleAutoApprove,
  onToggleReadAloud,
  onToggleWorkbench,
  onOpenWiki,
}) => {
  return (
    <div className={styles['chat-toolbar']}>
      <button type="button" className={styles['icon-btn']} onClick={onToggleSidebar} title="Toggle sidebar" aria-label="Toggle sidebar">
        <PanelLeft size={16} strokeWidth={1.8} />
      </button>
      <h2 className={styles['chat-title']}>{title}</h2>
      {devContextChip}
      <div className={styles['toolbar-actions']}>
        {pageZoom !== 1 && (
          <button type="button" className={styles['icon-btn']} onClick={onResetZoom} title="Reset zoom" aria-label="Reset zoom" style={{ fontSize: 11, fontWeight: 600 }}>
            {Math.round(pageZoom * 100)}%
          </button>
        )}
        <button type="button" className={clsx(styles['auto-approve-toggle'], autoApprove && styles['auto-approve-toggle--on'])} onClick={onToggleAutoApprove}>
          {autoApprove ? '自动审批' : '人工审批'}
        </button>
        <button type="button" className={clsx(styles['icon-btn'], readAloudActive && styles['icon-btn--active'], readAloudSpeaking && styles['read-aloud-speaking'])} onClick={onToggleReadAloud} title="Toggle read aloud" aria-label="Toggle read aloud" aria-pressed={readAloudActive}>
          {readAloudActive ? <Volume2 size={16} strokeWidth={1.8} /> : <VolumeX size={16} strokeWidth={1.8} />}
        </button>
        <button
          type="button"
          className={clsx(styles['icon-btn'], workbenchBadge > 0 && styles['icon-btn--badged'], workbenchOpen && styles['icon-btn--active'])}
          onClick={onToggleWorkbench}
          title={workbenchBadge > 0 ? `工作空间文件 · ${workbenchBadge} 个新产出` : '工作空间文件'}
          aria-label={workbenchBadge > 0 ? `工作空间文件（${workbenchBadge} 个新产出）` : '工作空间文件'}
          aria-pressed={workbenchOpen}
        >
          <FolderOpen size={16} strokeWidth={1.8} />
          {workbenchBadge > 0 && (
            <span className={styles['icon-badge']}>{workbenchBadge > 99 ? '99+' : workbenchBadge}</span>
          )}
        </button>
        {onOpenWiki && (
          <button type="button" className={styles['icon-btn']} onClick={onOpenWiki} title="资料库" aria-label="资料库">
            <BookOpen size={16} strokeWidth={1.8} />
          </button>
        )}
      </div>
    </div>
  )
}
