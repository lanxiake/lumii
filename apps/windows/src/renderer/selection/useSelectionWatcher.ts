/**
 * useSelectionWatcher.ts - 选区监听
 *
 * 把「什么时候该有快照、什么时候该收起」收在一处，浮条/菜单只管渲染。
 *
 * 事件统一挂 capture 阶段：会话项/菜单里的 stopPropagation 拦不住捕获监听，
 * 挂在冒泡阶段会漏掉一部分 mouseup。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { buildSnapshot, type SelectionSnapshot } from './snapshot'

/** 快照由哪个入口承载 */
type SelectionSurface = 'bar' | 'menu'

interface SelectionView {
  snapshot: SelectionSnapshot
  surface: SelectionSurface
  /** menu 的弹出坐标（指针位置）；bar 不用它，bar 锚在 snapshot.anchorRect */
  point?: { x: number; y: number }
}

export interface UseSelectionWatcherOptions {
  /**
   * 命中此判定的事件一律忽略。浮条/菜单自身的点击走这里放行 ——
   * capture 阶段的 document 监听先于它们自己的处理器执行，靠 stopPropagation 挡不住。
   */
  shouldIgnoreEvent?: (event: MouseEvent) => boolean
  /**
   * 收到这些 window 事件就收起。
   *
   * 鼠标切页 / 切会话不用列在这里 —— 任何 mousedown 都会收起，已经覆盖了。
   * 要列的是**不经过鼠标**的跳转：例如 Agent 收到消息后主动切会话。
   * 那时旧选区所在的 DOM 已卸载，而快照里的 rect 还在，浮条会飘在新页面上。
   *
   * 事件名由调用方给：本模块不知道应用的事件词汇表。
   */
  closeOnEvents?: readonly string[]
}

export interface UseSelectionWatcherResult {
  view: SelectionView | null
  close: () => void
  /**
   * 外部来源直接投一个选区进来（`null` 即收起）。
   *
   * 目前只有一条来源：HTML 预览的 `<webview>` —— 它的文档不在宿主里，
   * 宿主收不到鼠标事件，只能由 guest 的 preload 把选区送过来
   * （见 webview-bridge.ts）。宿主自己划的选区不走这里。
   */
  showView: (view: SelectionView | null) => void
}

export function useSelectionWatcher(
  options: UseSelectionWatcherOptions = {},
): UseSelectionWatcherResult {
  const [view, setView] = useState<SelectionView | null>(null)

  // 用 ref 持有：调用方每次渲染都可能给出新的闭包，不该因此重挂事件
  const shouldIgnoreRef = useRef(options.shouldIgnoreEvent)
  shouldIgnoreRef.current = options.shouldIgnoreEvent

  const close = useCallback(() => setView(null), [])

  useEffect(() => {
    const isIgnored = (e: MouseEvent) => shouldIgnoreRef.current?.(e) ?? false

    /**
     * 任何一次按下都先收起浮条。
     *
     * 「拖拽起手即收起」不需要单独的位移阈值 —— 拖拽必然以 mousedown 起手，
     * 这一条已经覆盖它。点浮条/菜单自身由 isIgnored 放行。
     */
    const handleMouseDown = (e: MouseEvent) => {
      if (isIgnored(e)) return
      setView(null)
    }

    const handleMouseUp = (e: MouseEvent) => {
      // 右键交给 contextmenu 分支，这里只认左键，免得两者同时冒出来
      if (e.button !== 0) return
      if (isIgnored(e)) return
      const snapshot = buildSnapshot(window.getSelection())
      setView(snapshot ? { snapshot, surface: 'bar' } : null)
    }

    /**
     * 右键：有选区就接管，弹自绘的划词菜单。
     *
     * 没选区时**不接管**也不 preventDefault —— 那种情况该由主进程的原生菜单负责
     * （可编辑区的剪切/粘贴）。让位规则的权威实现在
     * `src/main/window/context-menu-policy.ts`，两边口径要一致。
     */
    const handleContextMenu = (e: MouseEvent) => {
      if (isIgnored(e)) return
      const snapshot = buildSnapshot(window.getSelection())
      if (!snapshot) return
      e.preventDefault()
      setView({ snapshot, surface: 'menu', point: { x: e.clientX, y: e.clientY } })
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setView(null)
    }

    /**
     * 滚动/缩放会让快照里的坐标当场失效。窗口化列表里跟着重定位还会乱跳，
     * 直接收起比让它飘着更符合直觉。
     */
    const handleViewportChange = () => setView(null)

    document.addEventListener('mousedown', handleMouseDown, true)
    document.addEventListener('mouseup', handleMouseUp, true)
    document.addEventListener('contextmenu', handleContextMenu, true)
    document.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('scroll', handleViewportChange, true)
    window.addEventListener('resize', handleViewportChange)

    return () => {
      document.removeEventListener('mousedown', handleMouseDown, true)
      document.removeEventListener('mouseup', handleMouseUp, true)
      document.removeEventListener('contextmenu', handleContextMenu, true)
      document.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('scroll', handleViewportChange, true)
      window.removeEventListener('resize', handleViewportChange)
    }
  }, [])

  /**
   * 程序化跳转时收起（见 closeOnEvents 的说明）。
   * 依赖按**内容**算：调用方每次渲染传个新数组也不该重挂监听。
   */
  const closeOnKey = (options.closeOnEvents ?? []).join('\u0000')

  useEffect(() => {
    if (closeOnKey.length === 0) return
    const names = closeOnKey.split('\u0000')
    for (const name of names) window.addEventListener(name, close)
    return () => {
      for (const name of names) window.removeEventListener(name, close)
    }
  }, [closeOnKey, close])

  return { view, close, showView: setView }
}
