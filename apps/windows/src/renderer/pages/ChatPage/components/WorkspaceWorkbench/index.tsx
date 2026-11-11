/**
 * WorkspaceWorkbench — Chat 右侧工作台壳
 *
 * 真 flex 分栏：拖宽时只有左边缘移动，对话区不重排。
 * 入口是**可关可增的 tab 列表**（不只是视图）：关掉最后一个 = 整列收起；
 * 一个都没有时显示「开始」页，点胶囊或「+」把它叫回来。
 * 宽度三档（半 480 / 宽 860 / 满），与 tab 无关——切 tab 不跳宽。
 * 非单栏时可收起 rail / inspector；专注预览（顶栏或 Ctrl+B）一次收两侧只留 main。
 *
 * 结构：shell（宽度动画）→ inner（固定宽度，避免动画时内容重排）
 *       → header（tab 条）+ body（[rail | main | inspector] 或「开始」页）
 */

import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  X,
  Plus,
  RefreshCw,
  AppWindow,
  Info,
  PanelLeftClose,
  PanelLeftOpen,
  ScanEye,
  Images,
  FolderTree,
  FolderGit2,
  SquareTerminal,
  GitBranch,
  Compass,
} from 'lucide-react'
import {
  CHAT_MIN_REMAIN,
  INSPECTOR_WIDTH,
  PRESET_LABEL,
  TAB_ORDER,
  WORKBENCH_ENTRIES,
  WORKBENCH_WIDTH_MIN,
  clampRailWidth,
  isCompactWidth,
  isInspectorInline,
  isSplitTab,
  railWidthFor,
  resolveWidth,
  tabTitle,
  type WorkbenchEntry,
  type WorkbenchPreset,
  type WorkbenchTabKind,
} from './layout'
import styles from './WorkspaceWorkbench.module.css'
import { markInteractionStart, markInteractionEndOnNextPaint } from '../../../../utils/perf-marks'

export type {
  WorkbenchEntry,
  WorkbenchLayoutMode,
  WorkbenchPreset,
  WorkbenchTabKind,
} from './layout'

/** 传给 main 渲染函数的宽度信息（对比视图据此决定并排上限） */
export interface WorkbenchMetrics {
  /** 工作台当前像素宽度（拖拽中为临时值） */
  width: number
  compact: boolean
}

/** 一个 tab 的内容：双栏 tab 给 rail + main，单栏 tab 只给 main */
export interface WorkbenchPane {
  rail?: ReactNode
  main: ReactNode
}

const ENTRY_ICONS: Record<WorkbenchTabKind, ReactNode> = {
  artifacts: <Images size={22} strokeWidth={1.6} />,
  files: <FolderTree size={22} strokeWidth={1.6} />,
  project: <FolderGit2 size={22} strokeWidth={1.6} />,
  terminal: <SquareTerminal size={22} strokeWidth={1.6} />,
  vcs: <GitBranch size={22} strokeWidth={1.6} />,
}

/** 用户拖出来的 rail 宽度（跨会话记住；空 = 跟随断点默认值） */
const RAIL_WIDTH_KEY = 'lumii.workbench.railWidth'

function loadRailWidth(): number | null {
  try {
    const raw = localStorage.getItem(RAIL_WIDTH_KEY)
    const value = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function saveRailWidth(value: number | null): void {
  try {
    if (value === null) localStorage.removeItem(RAIL_WIDTH_KEY)
    else localStorage.setItem(RAIL_WIDTH_KEY, String(Math.round(value)))
  } catch {
    // 存不了就只在本次会话里生效
  }
}

export interface WorkspaceWorkbenchProps {
  open: boolean
  /** 打开着的 tab，按 TAB_ORDER 排好 */
  tabs: readonly WorkbenchTabKind[]
  activeTab: WorkbenchTabKind | null
  preset: WorkbenchPreset
  customWidth?: number
  /** main 当前打开的产物（工作区相对路径） */
  selectedPath?: string
  onOpenTab: (kind: WorkbenchTabKind) => void
  onCloseTab: (kind: WorkbenchTabKind) => void
  onPresetChange: (preset: WorkbenchPreset, customWidth?: number) => void
  onClose: () => void
  /** 返回列表（单栏断点下取消选中） */
  onBack?: () => void
  /** 在独立窗打开当前选中产物 */
  onOpenSelectedWindow?: () => void
  uncommittedCount: number
  onRefresh?: () => void
  /** 开始页的入口胶囊（插件停用时可被调用方过滤掉） */
  entries?: readonly WorkbenchEntry[]
  /** 每个已打开的 tab 的内容；未打开的 kind 不需要给 */
  renderPane: (kind: WorkbenchTabKind, metrics: WorkbenchMetrics) => WorkbenchPane
  /** inspector：选中产物的规格 + 版本历史；宽度 ≥900 时并排，否则浮在 main 右侧 */
  inspector?: ReactNode
  /** inspector 是否展开（并排与浮层共用；「信息」按钮开关） */
  inspectorOpen?: boolean
  onInspectorOpenChange?: (open: boolean) => void
}

/** 专注预览进入前的两侧快照（会话内，组件挂载期有效） */
interface FocusSnapshot {
  railCollapsed: boolean
  inspectorOpen: boolean
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
  tabs,
  activeTab,
  preset,
  customWidth,
  selectedPath,
  onOpenTab,
  onCloseTab,
  onPresetChange,
  onClose,
  onBack,
  onOpenSelectedWindow,
  uncommittedCount,
  onRefresh,
  entries = WORKBENCH_ENTRIES,
  renderPane,
  inspector,
  inspectorOpen = false,
  onInspectorOpenChange,
}) => {
  const shellRef = useRef<HTMLElement | null>(null)
  /** 父容器真实可用宽度：满档直接吃满，其余档才给对话区留 CHAT_MIN_REMAIN */
  const [availableWidth, setAvailableWidth] = useState(() =>
    typeof window === 'undefined' ? 1280 : window.innerWidth,
  )
  /** 拖拽中的临时宽度；松手才写回 preset */
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  /** 关闭时 inner 保持最后宽度：宽度动画里内容不重排 */
  const [lastWidth, setLastWidth] = useState(0)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  /** 与 dragWidth 同步的最新像素，避免 pointerup 读到尚未提交的 React state */
  const dragWidthRef = useRef<number | null>(null)
  /** 左侧产物路径是否收起（会话内记住，刷新重置） */
  const [railCollapsed, setRailCollapsed] = useState(false)
  /** 是否处于专注预览（两侧收起）；用 state 驱动按钮文案 */
  const [focusActive, setFocusActive] = useState(false)
  const focusSnapshotRef = useRef<FocusSnapshot | null>(null)
  /** 上一帧是否并排 inspector，用于跨入 ≥900 时自动展开一次 */
  const wasInlineInspectorRef = useRef(false)
  /** 「+」打开的临时开始页：选完入口就关，不持久化 */
  const [guideOpen, setGuideOpen] = useState(false)
  /** 用户拖出来的 rail 宽度；null = 用断点默认值（半档 220 / 其余 260） */
  const [railWidthOverride, setRailWidthOverride] = useState<number | null>(loadRailWidth)
  const railDragRef = useRef<{ startX: number; startW: number } | null>(null)
  /** 拖拽期间不写 localStorage：pointermove 每帧一次，写盘太频繁 */
  const pendingRailWidthRef = useRef<number | null>(null)

  // 可用宽度跟着父容器走（chat-page 去掉侧栏后的真实宽度）
  useEffect(() => {
    const parent = shellRef.current?.parentElement
    if (!parent || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setAvailableWidth(Math.max(WORKBENCH_WIDTH_MIN, Math.floor(entry.contentRect.width)))
    })
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])

  /** 半/宽/自定义档的可用上限（满档另算） */
  const maxWidth = Math.max(WORKBENCH_WIDTH_MIN, availableWidth - CHAT_MIN_REMAIN)
  /** 拖拽上限：满档本来就吃满，别再按「给对话留 280」夹它，否则一拖就跳回去 */
  const dragMaxWidth = preset === 'full' ? availableWidth : maxWidth
  const resolved = resolveWidth(preset, customWidth, preset === 'full' ? availableWidth : maxWidth)
  const displayWidth = dragWidth ?? resolved
  const compact = isCompactWidth(displayWidth)
  const inlineInspector = isInspectorInline(displayWidth)
  const metrics: WorkbenchMetrics = { width: displayWidth, compact }

  useEffect(() => {
    if (displayWidth > 0) setLastWidth(displayWidth)
  }, [displayWidth])

  // 没有 tab 时「开始」页就是唯一内容；关掉最后一个 tab 由调用方收起整列
  const guideVisible = tabs.length === 0 || guideOpen
  const viewKind = guideVisible ? null : activeTab
  const split = isSplitTab(viewKind)
  const pane = viewKind ? renderPane(viewKind, metrics) : null

  // 工作台展开/收起（含首帧挂载）的耗时要能被人看到：卡的往往是面板里那棵树
  useEffect(() => {
    if (!open) return
    markInteractionStart('open-workspace-panel')
    markInteractionEndOnNextPaint('open-workspace-panel')
  }, [open])

  /** 按指针位移算出夹紧后的工作台宽度 */
  const widthFromPointer = useCallback(
    (clientX: number, startX: number, startW: number): number => {
      // 向左拖 → 变宽（clientX 减小）
      const delta = startX - clientX
      return Math.min(
        Math.max(WORKBENCH_WIDTH_MIN, Math.round(startW + delta)),
        Math.max(WORKBENCH_WIDTH_MIN, dragMaxWidth),
      )
    },
    [dragMaxWidth],
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

  /** 非单栏才提供两侧收起（单栏本身是 rail/main 互斥） */
  const canCollapseSides = !compact && split
  /** 并排与浮层统一：inspectorOpen 控制是否显示 */
  const showInspector = Boolean(pane?.rail && inspector && selectedPath && inspectorOpen)
  const railWidth = clampRailWidth(
    railWidthOverride ?? railWidthFor(displayWidth),
    displayWidth,
    showInspector && inlineInspector,
  )

  const onRailResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture?.(event.pointerId)
      railDragRef.current = { startX: event.clientX, startW: railWidth }
    },
    [railWidth],
  )

  const onRailResizePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = railDragRef.current
      if (!drag) return
      const next = clampRailWidth(
        drag.startW + (event.clientX - drag.startX),
        displayWidth,
        showInspector && inlineInspector,
      )
      pendingRailWidthRef.current = next
      setRailWidthOverride(next)
    },
    [displayWidth, showInspector, inlineInspector],
  )

  const endRailResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!railDragRef.current) return
    railDragRef.current = null
    const settled = pendingRailWidthRef.current
    pendingRailWidthRef.current = null
    if (settled !== null) saveRailWidth(settled)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // ignore
    }
  }, [])

  /** 双击分隔条 = 回到断点默认宽度 */
  const resetRailWidth = useCallback(() => {
    pendingRailWidthRef.current = null
    saveRailWidth(null)
    setRailWidthOverride(null)
  }, [])

  /** 设置 rail 收起态；手动展开时退出专注标记 */
  const setRailCollapsedSafe = useCallback(
    (collapsed: boolean) => {
      setRailCollapsed(collapsed)
      if (!collapsed && focusActive) {
        focusSnapshotRef.current = null
        setFocusActive(false)
      }
    },
    [focusActive],
  )

  /** 切换 inspector；手动打开时退出专注标记 */
  const toggleInspector = useCallback(() => {
    const next = !inspectorOpen
    if (next && focusActive) {
      focusSnapshotRef.current = null
      setFocusActive(false)
    }
    onInspectorOpenChange?.(next)
  }, [inspectorOpen, focusActive, onInspectorOpenChange])

  /** 专注预览：收起两侧；再按按进入前快照恢复 */
  const toggleFocusPreview = useCallback(() => {
    if (!canCollapseSides) return
    if (focusActive) {
      const snap = focusSnapshotRef.current
      setRailCollapsed(snap?.railCollapsed ?? false)
      onInspectorOpenChange?.(snap?.inspectorOpen ?? true)
      focusSnapshotRef.current = null
      setFocusActive(false)
      return
    }
    focusSnapshotRef.current = { railCollapsed, inspectorOpen }
    setRailCollapsed(true)
    onInspectorOpenChange?.(false)
    setFocusActive(true)
  }, [canCollapseSides, focusActive, railCollapsed, inspectorOpen, onInspectorOpenChange])

  // 宽度跨入并排断点时默认展开 inspector（设计：≥900 有位置）
  useEffect(() => {
    if (!open || !inspector || !selectedPath || !split) {
      wasInlineInspectorRef.current = inlineInspector
      return
    }
    if (inlineInspector && !wasInlineInspectorRef.current && !focusActive) {
      onInspectorOpenChange?.(true)
    }
    wasInlineInspectorRef.current = inlineInspector
  }, [open, inlineInspector, inspector, selectedPath, focusActive, onInspectorOpenChange, split])

  /** 点开始页某个入口：打开它，收起临时开始页 */
  const pickEntry = useCallback(
    (kind: WorkbenchTabKind) => {
      setGuideOpen(false)
      onOpenTab(kind)
    },
    [onOpenTab],
  )

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      // 工作台打开时 Ctrl/Cmd+B = 专注预览（捕获阶段拦住全局侧栏快捷键）
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        if (!canCollapseSides) return
        event.preventDefault()
        event.stopImmediatePropagation()
        toggleFocusPreview()
        return
      }
      if (event.key === 'Escape') {
        // 预览打开时，Esc 先交给预览关闭，不整块关掉工作台
        if (selectedPath) return
        if (document.querySelector('[data-file-preview-open]')) return
        event.preventDefault()
        if (guideOpen) setGuideOpen(false)
        else onClose()
        return
      }
      // 1..N：直接打开/切到对应 tab
      if (/^[1-9]$/.test(event.key)) {
        const kind = TAB_ORDER[Number(event.key) - 1]
        if (!kind) return
        event.preventDefault()
        pickEntry(kind)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, selectedPath, canCollapseSides, toggleFocusPreview, onClose, pickEntry, guideOpen])

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
          <nav className={styles.views} aria-label="工作台页面">
            {tabs.map((kind) => (
              <div
                key={kind}
                className={clsx(styles.chip, !guideVisible && activeTab === kind && styles.chipActive)}
              >
                <button
                  type="button"
                  className={styles.chipLabel}
                  onClick={() => {
                    setGuideOpen(false)
                    onOpenTab(kind)
                  }}
                  aria-pressed={!guideVisible && activeTab === kind}
                >
                  {tabTitle(kind)}
                  {kind === 'vcs' && uncommittedCount > 0 && (
                    <span className={styles.badge}>{uncommittedCount}</span>
                  )}
                </button>
                <button
                  type="button"
                  className={styles.chipClose}
                  onClick={() => onCloseTab(kind)}
                  title={`关闭「${tabTitle(kind)}」`}
                  aria-label={`关闭「${tabTitle(kind)}」`}
                >
                  <X size={11} strokeWidth={2.2} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className={clsx(styles.addTab, guideVisible && styles.addTabActive)}
              onClick={() => setGuideOpen(true)}
              title="打开新页面"
              aria-label="打开新页面"
              aria-pressed={guideVisible}
            >
              <Plus size={13} strokeWidth={2} />
            </button>
          </nav>

          <div className={styles.presets} role="group" aria-label="工作台宽度">
            {(['half', 'wide', 'full'] as const).map((key) => (
              <button
                key={key}
                type="button"
                className={clsx(styles.preset, preset === key && styles.presetActive)}
                onClick={() => onPresetChange(key)}
                aria-pressed={preset === key}
                title={
                  key === 'full'
                    ? '满屏预览（对话区收起；要边聊边看请弹出独立窗口）'
                    : undefined
                }
              >
                {PRESET_LABEL[key]}
              </button>
            ))}
          </div>

          <div className={styles.actions}>
            {canCollapseSides && (
              <button
                type="button"
                className={clsx(styles.iconBtn, focusActive && styles.iconBtnActive, 'mt-press')}
                onClick={toggleFocusPreview}
                aria-pressed={focusActive}
                title={focusActive ? '退出专注预览（Ctrl+B）' : '专注预览：收起两侧（Ctrl+B）'}
                aria-label={focusActive ? '退出专注预览' : '专注预览'}
              >
                <ScanEye size={14} strokeWidth={1.8} />
              </button>
            )}
            {/* 并排与浮层共用「信息」开关 */}
            {showInspector && !compact && (
              <button
                type="button"
                className={clsx(styles.iconBtn, inspectorOpen && styles.iconBtnActive, 'mt-press')}
                onClick={toggleInspector}
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
          {guideVisible ? (
            <div className={styles.guide}>
              <Compass size={56} strokeWidth={1} className={styles.guideGlyph} />
              <div className={styles.guideEntries}>
                {entries.map((entry) => (
                  <button
                    key={entry.kind}
                    type="button"
                    className={styles.guideEntry}
                    onClick={() => pickEntry(entry.kind)}
                  >
                    <span className={styles.guideEntryIcon}>{ENTRY_ICONS[entry.kind]}</span>
                    <span className={styles.guideEntryText}>
                      <span className={styles.guideEntryTitle}>{entry.title}</span>
                      <span className={styles.guideEntryDesc}>{entry.description}</span>
                    </span>
                    <kbd className={styles.guideEntryKey}>{entry.shortcut}</kbd>
                  </button>
                ))}
              </div>
            </div>
          ) : split && pane ? (
            <div className={styles.workspacePane}>
              {canCollapseSides && railCollapsed ? (
                <div className={styles.railStrip}>
                  <button
                    type="button"
                    className={styles.railToggle}
                    onClick={() => setRailCollapsedSafe(false)}
                    title="展开列表"
                    aria-label="展开列表"
                  >
                    <PanelLeftOpen size={14} strokeWidth={1.8} />
                  </button>
                </div>
              ) : (
                <div
                  className={styles.rail}
                  style={
                    compact
                      ? { width: '100%', flexBasis: '100%' }
                      : { width: railWidth, flexBasis: railWidth }
                  }
                  hidden={compact && Boolean(selectedPath)}
                >
                  {canCollapseSides && (
                    <button
                      type="button"
                      className={styles.railCollapseBtn}
                      onClick={() => setRailCollapsedSafe(true)}
                      title="收起列表"
                      aria-label="收起列表"
                    >
                      <PanelLeftClose size={13} strokeWidth={1.8} />
                    </button>
                  )}
                  <div className={styles.railBody}>{pane.rail}</div>
                  {/* 拖宽 rail：长文件名靠省略号截断，拉宽是最直接的读全方式 */}
                  {canCollapseSides && (
                    <div
                      className={styles.railResizeHandle}
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="拖动调整列表宽度"
                      title="拖动调整宽度（双击复位）"
                      onPointerDown={onRailResizePointerDown}
                      onPointerMove={onRailResizePointerMove}
                      onPointerUp={endRailResize}
                      onPointerCancel={endRailResize}
                      onDoubleClick={resetRailWidth}
                    />
                  )}
                </div>
              )}
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
                {pane.main}
                {/* 窄档放不下第三栏：「信息」按钮把它叫成浮层，盖在预览上 */}
                {showInspector && !inlineInspector && (
                  <div className={styles.inspectorFloat}>{inspector}</div>
                )}
              </div>
              {/* inspector 只在够宽且展开时并排（<900 走上面的浮层） */}
              {showInspector && inlineInspector && (
                <div className={styles.inspectorSlot} style={{ width: INSPECTOR_WIDTH }}>
                  {inspector}
                </div>
              )}
            </div>
          ) : (
            <div className={styles.workspacePane}>{pane?.main}</div>
          )}
        </div>
      </div>
    </aside>
  )
}
