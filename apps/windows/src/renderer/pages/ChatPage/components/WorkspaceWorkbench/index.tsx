/**
 * WorkspaceWorkbench — Chat 右侧工作空间共享壳
 *
 * 文件 / 版本两个 tab 共用玻璃侧栏；无全屏遮罩；宽度随 tab 过渡。
 */

import React, { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { X, RefreshCw } from 'lucide-react'
import styles from './WorkspaceWorkbench.module.css'

export type WorkbenchTab = 'files' | 'vcs'

export interface WorkspaceWorkbenchProps {
  open: boolean
  tab: WorkbenchTab
  onTabChange: (tab: WorkbenchTab) => void
  onClose: () => void
  uncommittedCount: number
  onRefresh?: () => void
  childrenFiles: ReactNode
  childrenVcs: ReactNode
}

/** 判断焦点是否在可编辑控件内（避免抢快捷键） */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return Boolean(target.closest('[contenteditable="true"]'))
}

/**
 * 右侧工作台壳层
 */
export const WorkspaceWorkbench: React.FC<WorkspaceWorkbenchProps> = ({
  open,
  tab,
  onTabChange,
  onClose,
  uncommittedCount,
  onRefresh,
  childrenFiles,
  childrenVcs,
}) => {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === '1') {
        e.preventDefault()
        onTabChange('files')
      } else if (e.key === '2') {
        e.preventDefault()
        onTabChange('vcs')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, onTabChange])

  if (typeof document === 'undefined') return null

  return createPortal(
    <aside
      className={clsx(
        styles.shell,
        open && styles.shellOpen,
        tab === 'vcs' ? styles.shellWide : styles.shellNarrow,
      )}
      aria-hidden={!open}
      aria-label="工作空间"
    >
      <header className={styles.header}>
        <nav className={styles.tabs} aria-label="工作空间分区">
          <button
            type="button"
            className={clsx(styles.tab, tab === 'files' && styles.tabActive)}
            onClick={() => onTabChange('files')}
          >
            文件
          </button>
          <button
            type="button"
            className={clsx(styles.tab, tab === 'vcs' && styles.tabActive)}
            onClick={() => onTabChange('vcs')}
          >
            版本
            {uncommittedCount > 0 && (
              <span className={styles.badge}>{uncommittedCount}</span>
            )}
          </button>
        </nav>
        <div className={styles.actions}>
          {onRefresh && (
            <button
              type="button"
              className={clsx(styles.iconBtn, 'mt-press')}
              onClick={onRefresh}
              title="刷新"
            >
              <RefreshCw size={14} strokeWidth={1.8} />
            </button>
          )}
          <button
            type="button"
            className={clsx(styles.iconBtn, 'mt-press')}
            onClick={onClose}
            title="关闭"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      </header>
      <div className={styles.body}>
        <div
          className={clsx(styles.pane, tab === 'files' && styles.paneVisible)}
          hidden={tab !== 'files'}
        >
          {childrenFiles}
        </div>
        <div
          className={clsx(styles.pane, tab === 'vcs' && styles.paneVisible)}
          hidden={tab !== 'vcs'}
        >
          {childrenVcs}
        </div>
      </div>
    </aside>,
    document.body,
  )
}
