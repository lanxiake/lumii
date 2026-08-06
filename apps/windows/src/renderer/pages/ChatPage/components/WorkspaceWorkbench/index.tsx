/**
 * WorkspaceWorkbench — Chat 右侧工作空间共享壳
 *
 * 文件 / 版本共用玻璃侧栏；左侧可拖拽改宽，对话区 padding 随之收缩（Cursor 式）。
 * 全屏 = 拉满对话区可用宽度。
 */

import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { X, RefreshCw } from 'lucide-react'
import styles from './WorkspaceWorkbench.module.css'

export type WorkbenchTab = 'files' | 'vcs'
export type WorkbenchLayoutMode = 'default' | 'wide' | 'fullscreen'

export interface WorkspaceWorkbenchProps {
  open: boolean
  tab: WorkbenchTab
  onTabChange: (tab: WorkbenchTab) => void
  onClose: () => void
  uncommittedCount: number
  onRefresh?: () => void
  childrenFiles: ReactNode
  childrenVcs: ReactNode
  /** 宽度变化时通知（用于对话区 padding 自适应） */
  onWidthChange?: (width: number) => void
  /** 拖拽改宽进行中（对话区关闭 padding 过渡） */
  onResizingChange?: (resizing: boolean) => void
  /**
   * 外部请求布局（版本面板顶栏按钮）。
   * 传入后由壳层改宽；不传则仅用拖拽。
   */
  layoutMode?: WorkbenchLayoutMode
  onLayoutModeChange?: (mode: WorkbenchLayoutMode) => void
}

const WIDTH_FILES = 280
const WIDTH_VCS = 760
const WIDTH_VCS_WIDE = 1100
const WIDTH_MIN = 240
/** 对话区至少保留的可见宽度（px） */
const CHAT_MIN_REMAIN = 280

/** 判断焦点是否在可编辑控件内（避免抢快捷键） */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return Boolean(target.closest('[contenteditable="true"]'))
}

/** 计算工作台最大宽度：对话区宽度减去最小对话残留 */
function getMaxWidth(): number {
  const dialog = document.querySelector('[data-chat-dialog]') as HTMLElement | null
  const base = dialog?.clientWidth ?? Math.floor(window.innerWidth * 0.9)
  return Math.max(WIDTH_MIN, base - CHAT_MIN_REMAIN)
}

/** 按 tab / 布局模式解析目标宽度 */
function resolveWidth(tab: WorkbenchTab, mode: WorkbenchLayoutMode): number {
  const max = getMaxWidth()
  if (mode === 'fullscreen') return max
  if (tab === 'files') return Math.min(WIDTH_FILES, max)
  if (mode === 'wide') return Math.min(WIDTH_VCS_WIDE, max)
  return Math.min(WIDTH_VCS, max)
}

/**
 * 右侧工作台壳层（可拖拽改宽）
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
  onWidthChange,
  onResizingChange,
  layoutMode = 'default',
  onLayoutModeChange,
}) => {
  const [width, setWidth] = useState(() => resolveWidth(tab, layoutMode))
  const [resizing, setResizing] = useState(false)
  const widthRef = useRef(width)
  widthRef.current = width
  /** 各 tab 上次拖拽宽度（切换 tab 时恢复） */
  const remembered = useRef<Record<WorkbenchTab, number>>({
    files: WIDTH_FILES,
    vcs: WIDTH_VCS,
  })
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  /** 拖拽触发的 layoutMode→default 时跳过一次宽度回弹 */
  const skipNextLayoutSync = useRef(false)

  const applyWidth = useCallback(
    (next: number, opts?: { remember?: boolean }) => {
      const max = getMaxWidth()
      const clamped = Math.min(max, Math.max(WIDTH_MIN, Math.round(next)))
      setWidth(clamped)
      if (opts?.remember !== false) {
        remembered.current[tab] = clamped
      }
      onWidthChange?.(open ? clamped : 0)
    },
    [tab, open, onWidthChange],
  )

  // 打开 / 切换 tab：恢复该 tab 记忆宽度
  useEffect(() => {
    if (!open) {
      onWidthChange?.(0)
      return
    }
    if (layoutMode === 'fullscreen' || layoutMode === 'wide') {
      applyWidth(resolveWidth(tab, layoutMode), { remember: false })
      return
    }
    applyWidth(remembered.current[tab] || resolveWidth(tab, 'default'), { remember: false })
  }, [open, tab]) // eslint-disable-line react-hooks/exhaustive-deps -- 仅开合与 tab

  // 顶栏布局按钮：改宽（拖拽引起的 default 同步跳过）
  useEffect(() => {
    if (!open) return
    if (skipNextLayoutSync.current) {
      skipNextLayoutSync.current = false
      return
    }
    if (layoutMode === 'fullscreen' || layoutMode === 'wide') {
      applyWidth(resolveWidth(tab, layoutMode), { remember: false })
    } else {
      applyWidth(resolveWidth(tab, 'default'), { remember: true })
    }
  }, [layoutMode]) // eslint-disable-line react-hooks/exhaustive-deps -- 仅模式按钮

  // 窗口尺寸变化时夹紧宽度
  useEffect(() => {
    if (!open) return
    const onResize = () => {
      const max = getMaxWidth()
      if (layoutMode === 'fullscreen') {
        applyWidth(max, { remember: false })
      } else if (widthRef.current > max) {
        applyWidth(max, { remember: true })
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open, layoutMode, applyWidth])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      if (e.key === 'Escape') {
        // 文件预览弹窗打开时，Esc 先交给预览关闭，不关工作台
        if (document.querySelector('[data-file-preview-open]')) return
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

  /** 开始拖拽左缘改宽 */
  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!open) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      dragRef.current = { startX: e.clientX, startW: widthRef.current }
      setResizing(true)
      onResizingChange?.(true)
      if (layoutMode !== 'default') {
        skipNextLayoutSync.current = true
        onLayoutModeChange?.('default')
      }
    },
    [open, layoutMode, onLayoutModeChange, onResizingChange],
  )

  const onResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return
      // 向左拖 → 变宽（clientX 减小）
      const delta = dragRef.current.startX - e.clientX
      applyWidth(dragRef.current.startW + delta, { remember: true })
    },
    [applyWidth],
  )

  const onResizePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return
      dragRef.current = null
      setResizing(false)
      onResizingChange?.(false)
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    },
    [onResizingChange],
  )

  if (typeof document === 'undefined') return null

  return createPortal(
    <aside
      className={clsx(
        styles.shell,
        open && styles.shellOpen,
        resizing && styles.shellResizing,
      )}
      style={{ width: open ? width : undefined }}
      aria-hidden={!open}
      aria-label="工作空间"
    >
      <div
        className={styles.resizeHandle}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖拽调整工作台宽度"
        title="拖拽调整宽度"
      />
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
