import React from 'react'
import clsx from 'clsx'
import { FolderOpen, PanelLeft, Sparkles, Volume2, VolumeX } from 'lucide-react'
import styles from '../ChatPage.module.css'

export interface ChatToolbarProps {
  title: string
  pageZoom: number
  autoApprove: boolean
  readAloudActive: boolean
  readAloudSpeaking: boolean
  workbenchOpen: boolean
  onToggleSidebar: () => void
  onResetZoom: () => void
  onToggleAutoApprove: () => void
  onToggleReadAloud: () => void
  onToggleWorkbench: () => void
  onEnterPetMode: () => void | Promise<void>
}

export const ChatToolbar: React.FC<ChatToolbarProps> = ({
  title,
  pageZoom,
  autoApprove,
  readAloudActive,
  readAloudSpeaking,
  workbenchOpen,
  onToggleSidebar,
  onResetZoom,
  onToggleAutoApprove,
  onToggleReadAloud,
  onToggleWorkbench,
  onEnterPetMode,
}) => (
  <div className={styles['chat-toolbar']}>
    <button type="button" className={styles['icon-btn']} onClick={onToggleSidebar} title="Toggle sidebar" aria-label="Toggle sidebar">
      <PanelLeft size={16} strokeWidth={1.8} />
    </button>
    <h2 className={styles['chat-title']}>{title}</h2>
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
      <button type="button" className={clsx(styles['icon-btn'], workbenchOpen && styles['icon-btn--active'])} onClick={onToggleWorkbench} title="Workspace files" aria-label="Workspace files" aria-pressed={workbenchOpen}>
        <FolderOpen size={16} strokeWidth={1.8} />
      </button>
      <button type="button" className={styles['icon-btn']} onClick={() => void onEnterPetMode()} title="Enter pet mode" aria-label="Enter pet mode">
        <Sparkles size={16} strokeWidth={1.8} />
      </button>
    </div>
  </div>
)
