/**
 * WorkspaceWorkbench — Chat 右侧工作台壳
 *
 * 真 flex 分栏（不再是 fixed + padding）：拖宽时只有左边缘移动，对话区不重排。
 * 两个视图（工作区 / 版本）+ 「只看产出」开关；宽度三档（半 480 / 宽 860 / 满）。
 *
 * 结构：shell（宽度动画）→ inner（固定宽度，避免动画时内容重排）
 *       → header + [rail | main | inspector]
 */

import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { X, RefreshCw, AppWindow, Info } from 'lucide-react'
import {
  CHAT_MIN_REMAIN,
  INSPECTOR_WIDTH,
  PRESET_LABEL,
  WORKBENCH_WIDTH_MIN,
  isCompactWidth,
  isInspectorInline,
  railWidthFor,
  resolveWidth,
  type WorkbenchPreset,
  type WorkbenchView,
} from './layout'
import styles from './WorkspaceWorkbench.module.css'

export type {
  WorkbenchLayoutMode,
  WorkbenchPreset,
  WorkbenchView,
} from './layout'

/** 传给 main 渲染函数的宽度信息（对比视图据此决定并排上限） */
export interface WorkbenchMetrics {
  /** 工作台当前像素宽度（拖拽中为临时值） */
  width: number
  compact: boolean
}

export interface WorkspaceWorkbenchProps {
  open: boolean
  view: WorkbenchView
  /** 只看产出：工作区视图内的呈现密度开关 */
  onlyArtifacts: boolean
  preset: WorkbenchPreset
  customWidth?: number
  /** main 当前打开的产物（工作区相对路径） */
  selectedPath?: string
  onViewChange: (view: WorkbenchView) => void
  onOnlyArtifactsChange: (onlyArtifacts: boolean) => void
  onPresetChange: (preset: WorkbenchPreset, customWidth?: number) => void
  onClose: () => void
  /** 返回列表（单栏断点下取消选中） */
  onBack?: () => void
  /** 在独立窗打开当前选中产物（双击在单栏下做不到，这里给显式入口） */
  onOpenSelectedWindow?: () => void
  uncommittedCount: number
  onRefresh?: () => void
  vcsEnabled?: boolean
  /** rail：产物台账 / 工作区文件（由调用方按 onlyArtifacts 决定） */
  rail: ReactNode
  /** main：内嵌预览或空态；传函数时可拿到当前工作台宽度（对比视图按宽度限项数） */
  main: ReactNode | ((metrics: WorkbenchMetrics) => ReactNode)
  /** inspector：选中产物的规格 + 版本历史；宽度 ≥900 时并排，否则浮在 main 右侧 */
  inspector?: ReactNode
  /** inspector 是否展开（宽度不足时由 header 的「信息」按钮开关） */
  inspectorOpen?: boolean
  onInspectorOpenChange?: (open: boolean) => void
  /** 版本视图（vcs 插件） */
  childrenVcs?: ReactNode
}

/** 判断焦点是否在可编辑控件内（避免抢快捷键） */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return Boolean(target.closest('[contenteditable="true"]'))
}

export const WorkspaceWorkbench: React.FC<WorkspaceWorkbenchProps> = ({
  open,
  view,
  onlyArtifacts,
  preset,
  customWidth,
  selectedPath,
  onViewChange,
  onOnlyArtifactsChange,
  onPresetChange,
  onClose,
  onBack,
  onOpenSelectedWindow,
  uncommittedCount,
  onRefresh,
  vcsEnabled = true,
  rail,
  main,
  inspector,
  inspectorOpen = false,
  onInspectorOpenChange,
  childrenVcs,
}) => {
  const shellRef = useRef<HTMLElement | null>(null)
  const [maxWidth, setMaxWidth] = useState(() =>
    Math.max(WORKBENCH_WIDTH_MIN, (typeof window === 'undefined' ? 1280 : window.innerWidth) - CHAT_MIN_REMAIN),
  )
  /** 拖拽中的临时宽度；松手才写回 preset */
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  /** 关闭时 inner 保持最后宽度：宽度动画里内容不重排 */
  const [lastWidth, setLastWidth] = useState(0)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  /** 与 dragWidth 同步的最新像素，避免 pointerup 读到尚未提交的 React state */
  const dragWidthRef = useRef<number | null>(null)

  // 可用宽度跟着父容器走（chat-page 去掉侧栏后的真实宽度）
  useEffect(() => {
    const parent = shellRef.current?.parentElement
    if (!parent || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const available = entry.contentRect.width
      setMaxWidth(Math.max(WORKBENCH_WIDTH_MIN, Math.floor(available) - CHAT_MIN_REMAIN))
    })
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])

  const resolved = resolveWidth(preset, customWidth, maxWidth)
  const displayWidth = dragWidth ?? resolved
  const compact = isCompactWidth(displayWidth)
  const inlineInspector = isInspectorInline(displayWidth)
  const resolvedMain =
    typeof main === 'function' ? main({ width: displayWidth, compact }) : main

  useEffect(() => {
    if (displayWidth > 0) setLastWidth(displayWidth)
  }, [displayWidth])

  /** 按指针位移算出夹紧后的工作台宽度 */
  const widthFromPointer = useCallback(
    (clientX: number, startX: number, startW: number): number => {
      // 向左拖 → 变宽（clientX 减小）
      const delta = startX - clientX
      return Math.min(
        Math.max(WORKBENCH_WIDTH_MIN, Math.round(startW + delta)),
        Math.max(WORKBENCH_WIDTH_MIN, maxWidth),
      )
    },
    [maxWidth],
  )

  const onResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!open) return
      event.preventDefault()
      event.currentTarget.setPointerCapture?.(event.pointerId)
      dragRef.current = { startX: event.clientX, startW: displayWidth }
      dragWidthRef.current = displayWidth
      setDragWidth(displayWidth)
    },
    [open, displayWidth],
  )

  const onResizePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      const next = widthFromPointer(event.clientX, drag.startX, drag.startW)
      dragWidthRef.current = next
      setDragWidth(next)
    },
    [widthFromPointer],
  )

  const finishDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // ignore
      }
      setDragWidth(null)

      if (!commit) {
        // pointercancel：系统/触控手势打断，不写 preset（事件里的 clientX=0 不是真实坐标）
        dragWidthRef.current = null
        return
      }
      const finalWidth = widthFromPointer(event.clientX, drag.startX, drag.startW)
      dragWidthRef.current = null
      // 只点一下拖拽条（没有位移）不该把「半」档悄悄改成 custom
      if (Math.abs(finalWidth - drag.startW) < 1) return
      onPresetChange('custom', finalWidth)
    },
    [onPresetChange, widthFromPointer],
  )

  const onResizePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => finishDrag(event, true),
    [finishDrag],
  )
  const onResizePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => finishDrag(event, false),
    [finishDrag],
  )

  // VCS 插件关掉后，持久化里的 view=vcs 会让内容区空白——强制回工作区。
  // 只在「已经打开」时纠正，否则会把用户没打开的工作台强行弹出来。
  useEffect(() => {
    if (open && !vcsEnabled && view === 'vcs') onViewChange('workspace')
  }, [open, vcsEnabled, view, onViewChange])

  const effectiveView: WorkbenchView = !vcsEnabled && view === 'vcs' ? 'workspace' : view

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if (event.key === 'Escape') {
        // 预览打开时，Esc 先交给预览关闭，不整块关掉工作台
        if (selectedPath) return
        if (document.querySelector('[data-file-preview-open]')) return
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === '1') {
        event.preventDefault()
        if (effectiveView !== 'workspace') onViewChange('workspace')
        else onOnlyArtifactsChange(!onlyArtifacts)
      } else if (event.key === '2' && vcsEnabled) {
        event.preventDefault()
        onViewChange('vcs')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    open,
    selectedPath,
    effectiveView,
    onlyArtifacts,
    vcsEnabled,
    onViewChange,
    onOnlyArtifactsChange,
    onClose,
  ])

  const railWidth = railWidthFor(displayWidth)

  return (
    <aside
      ref={shellRef}
      className={clsx(styles.shell, open && styles.shellOpen, dragWidth !== null && styles.shellResizing)}
      style={{ width: open ? displayWidth : 0 }}
      aria-hidden={!open}
      aria-label="工作空间"
      data-workbench-open={open ? 'true' : 'false'}
    >
      <div className={styles.inner} style={{ width: lastWidth || displayWidth }}>
        <div
          className={styles.resizeHandle}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerCancel}
          role="separator"
          aria-orientation="vertical"
          aria-label="拖拽调整工作台宽度"
          title="拖拽调整宽度"
        />

        <header className={styles.header}>
          <nav className={styles.views} aria-label="工作空间分区">
            <button
              type="button"
              className={clsx(styles.tab, effectiveView === 'workspace' && styles.tabActive)}
              onClick={() => onViewChange('workspace')}
              aria-pressed={effectiveView === 'workspace'}
            >
              工作区
            </button>
            {vcsEnabled && (
              <button
                type="button"
                className={clsx(styles.tab, effectiveView === 'vcs' && styles.tabActive)}
                onClick={() => onViewChange('vcs')}
                aria-pressed={effectiveView === 'vcs'}
              >
                版本
                {uncommittedCount > 0 && (
                  <span className={styles.badge}>{uncommittedCount}</span>
                )}
              </button>
            )}
          </nav>

          {effectiveView === 'workspace' && (
            <button
              type="button"
              className={clsx(styles.density, onlyArtifacts && styles.densityOn)}
              onClick={() => onOnlyArtifactsChange(!onlyArtifacts)}
              aria-pressed={onlyArtifacts}
              title="只看产出：隐藏未被识别为产物的文件"
            >
              只看产出
            </button>
          )}

          <div className={styles.presets} role="group" aria-label="工作台宽度">
            {(['half', 'wide', 'full'] as const).map((key) => (
              <button
                key={key}
                type="button"
                className={clsx(styles.preset, preset === key && styles.presetActive)}
                onClick={() => onPresetChange(key)}
                aria-pressed={preset === key}
              >
                {PRESET_LABEL[key]}
              </button>
            ))}
          </div>

          <div className={styles.actions}>
            {/* 窄档没有 inspector 栏位：「信息」按钮把它叫成浮层 */}
            {inspector && !inlineInspector && selectedPath && (
              <button
                type="button"
                className={clsx(styles.iconBtn, inspectorOpen && styles.iconBtnActive, 'mt-press')}
                onClick={() => onInspectorOpenChange?.(!inspectorOpen)}
                aria-pressed={inspectorOpen}
                title="产物信息与版本"
                aria-label="产物信息与版本"
              >
                <Info size={14} strokeWidth={1.8} />
              </button>
            )}
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
            className={clsx(
              styles.workspacePane,
              effectiveView === 'workspace' && styles.paneVisible,
            )}
            hidden={effectiveView !== 'workspace'}
          >
            <div
              className={styles.rail}
              style={
                compact
                  ? { width: '100%', flexBasis: '100%' }
                  : { width: railWidth, flexBasis: railWidth }
              }
              hidden={compact && Boolean(selectedPath)}
            >
              {rail}
            </div>
            <div className={styles.main} hidden={compact && !selectedPath}>
              {selectedPath && (
                <div className={styles.mainHeader}>
                  {compact && (
                    <button
                      type="button"
                      className={styles.backBtn}
                      onClick={() => onBack?.()}
                      title="返回列表"
                    >
                      ‹ 列表
                    </button>
                  )}
                  <span className={styles.crumb} title={selectedPath}>
                    {selectedPath}
                  </span>
                  {onOpenSelectedWindow && (
                    <button
                      type="button"
                      className={styles.openWindowBtn}
                      onClick={onOpenSelectedWindow}
                      title="在独立窗口打开"
                      aria-label="在独立窗口打开"
                    >
                      <AppWindow size={13} strokeWidth={1.8} />
                    </button>
                  )}
                </div>
              )}
              {resolvedMain}
              {/* 窄档放不下第三栏：「信息」按钮把它叫成浮层，盖在预览上 */}
              {inspector && !inlineInspector && inspectorOpen && (
                <div className={styles.inspectorFloat}>{inspector}</div>
              )}
            </div>
            {/* inspector 只在够宽时并排（<900 走上面的浮层），单栏下也不出现 */}
            {inspector && inlineInspector && (
              <div className={styles.inspectorSlot} style={{ width: INSPECTOR_WIDTH }}>
                {inspector}
              </div>
            )}
          </div>

          <div
            className={clsx(styles.vcsPane, effectiveView === 'vcs' && styles.paneVisible)}
            hidden={effectiveView !== 'vcs'}
          >
            {childrenVcs}
          </div>
        </div>
      </div>
    </aside>
  )
}
