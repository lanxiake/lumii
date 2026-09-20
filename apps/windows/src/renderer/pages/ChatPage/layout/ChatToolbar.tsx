import React from 'react'
import clsx from 'clsx'
import { BookOpen, FolderOpen, PanelLeft, Sparkles, Volume2, VolumeX } from 'lucide-react'
import { useFeatureAvailability } from '../../../hooks/business/useFeatureAvailability'
import styles from '../ChatPage.module.css'

export interface ChatToolbarProps {
  title: string
  pageZoom: number
  autoApprove: boolean
  readAloudActive: boolean
  readAloudSpeaking: boolean
  workbenchOpen: boolean
  /** 开发上下文 chip（非主 Agent 后端时展示「工具 · 项目」） */
  devContextChip?: React.ReactNode
  onToggleSidebar: () => void
  onResetZoom: () => void
  onToggleAutoApprove: () => void
  onToggleReadAloud: () => void
  onToggleWorkbench: () => void
  onOpenWiki?: () => void
  onEnterPetMode: () => void | Promise<void>
}

export const ChatToolbar: React.FC<ChatToolbarProps> = ({
  title,
  pageZoom,
  autoApprove,
  readAloudActive,
  readAloudSpeaking,
  workbenchOpen,
  devContextChip,
  onToggleSidebar,
  onResetZoom,
  onToggleAutoApprove,
  onToggleReadAloud,
  onToggleWorkbench,
  onOpenWiki,
  onEnterPetMode,
}) => {
  // 屏蔽平台上 pet:* 的 main 侧 handler 没注册（见 pet-mode-ipc.ts 的入口层屏蔽），
  // 这个入口必须置灰并给出原因（设计 D4：不能静默可用）。
  // 按钮的 disabled 只判 blocked、**不等 ready**——先亮着再置灰是无害的，
  // 反过来会让用户看到一瞬间没有原因的灰按钮（blockMessage 未就绪时返回 null）。
  const { isAvailable, blockMessage } = useFeatureAvailability()
  const petModeBlocked = !isAvailable('petMode')

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
        <button type="button" className={clsx(styles['icon-btn'], workbenchOpen && styles['icon-btn--active'])} onClick={onToggleWorkbench} title="工作空间文件" aria-label="工作空间文件" aria-pressed={workbenchOpen}>
          <FolderOpen size={16} strokeWidth={1.8} />
        </button>
        {onOpenWiki && (
          <button type="button" className={styles['icon-btn']} onClick={onOpenWiki} title="资料库" aria-label="资料库">
            <BookOpen size={16} strokeWidth={1.8} />
          </button>
        )}
        <button
          type="button"
          className={styles['icon-btn']}
          onClick={() => void onEnterPetMode()}
          title={petModeBlocked ? (blockMessage('petMode') ?? undefined) : 'Enter pet mode'}
          aria-label="Enter pet mode"
          disabled={petModeBlocked}
        >
          <Sparkles size={16} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  )
}
