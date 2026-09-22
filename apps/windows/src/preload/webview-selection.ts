/**
 * webview 划词 guest preload
 *
 * 用途：HTML 文件预览跑在 `<webview>` 的独立渲染进程里，宿主文档收不到那里的鼠标事件，
 * `window.getSelection()` 也只看得到宿主自己的选区 —— 所以在预览里划词、右键都没有反应。
 *
 * 这一层只做**取词**：在 guest 文档里监听，把选区的文本与矩形送回宿主；
 * 浮条/菜单/气泡仍然由宿主的 SelectionLayer 渲染。取词与展示分家，是为了不把
 * 划词子系统的另一半复制进 guest（那会立刻分叉：主题令牌、动作注册表都在宿主）。
 *
 * 通信：`ipcRenderer.sendToHost`（Electron 为 <webview> 提供的 guest→宿主通道）。
 * 宿主侧解析与坐标换算见 `renderer/selection/webview-bridge.ts`。
 *
 * 注意坐标的口径：这里给的 rect 是**guest 视口**坐标，宿主必须加上 webview 元素的
 * 位置才是宿主视口坐标（换算在宿主侧做，guest 不知道自己被摆在哪）。
 */

import { ipcRenderer } from 'electron'

export const WEBVIEW_SELECTION_CHANNEL = 'lumii:webview-selection'

type Rect = { top: number; left: number; width: number; height: number }

function toRect(r: DOMRect | { top: number; left: number; width: number; height: number }): Rect {
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

/** 选区末行的矩形；跳过零面积矩形（末尾换行符会带一个，认了浮条会飘到下一行） */
function lastLineRect(range: Range, fallback: Rect): Rect {
  const rects = range.getClientRects()
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i]
    if (r.width > 0 && r.height > 0) return toRect(r)
  }
  return fallback
}

/**
 * 可编辑区一律不接管：预览里的表单/输入框要靠原生右键菜单做剪切粘贴。
 * contenteditable 是继承的，所以找最近的**显式声明**祖先。
 */
function isInEditableArea(node: Node | null): boolean {
  const el = node instanceof Element ? node : node?.parentElement
  if (!el) return false
  if (el.closest('input, textarea, select')) return true
  const declared = el.closest('[contenteditable]')
  return declared !== null && declared.getAttribute('contenteditable') !== 'false'
}

function send(payload: Record<string, unknown>): void {
  try {
    ipcRenderer.sendToHost(WEBVIEW_SELECTION_CHANNEL, payload)
  } catch {
    // 宿主已销毁（预览窗关掉了）时忽略：这不是错误，只是没人在听
  }
}

function readSelection(event: MouseEvent | null): { text: string; rect: Rect; anchorRect: Rect; point?: { x: number; y: number } } | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const text = selection.toString()
  if (text.trim().length === 0) return null

  const range = selection.getRangeAt(0)
  if (isInEditableArea(range.startContainer)) return null

  const rect = toRect(range.getBoundingClientRect())
  return {
    text,
    rect,
    anchorRect: lastLineRect(range, rect),
    point: event ? { x: event.clientX, y: event.clientY } : undefined,
  }
}

function main(): void {
  document.addEventListener(
    'mouseup',
    (e) => {
      if (e.button !== 0) return
      const payload = readSelection(e)
      send(payload ? { type: 'show', surface: 'bar', ...payload } : { type: 'close' })
    },
    true,
  )

  document.addEventListener(
    'contextmenu',
    (e) => {
      const payload = readSelection(e)
      if (!payload) return // 没选区就不接管：让位给原生菜单
      e.preventDefault()
      send({ type: 'show', surface: 'menu', ...payload })
    },
    true,
  )

  // 滚动与缩放会让送出去的坐标失效，直接让宿主收起
  window.addEventListener('scroll', () => send({ type: 'close' }), true)
  window.addEventListener('resize', () => send({ type: 'close' }))
  document.addEventListener('mousedown', () => send({ type: 'close' }), true)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') send({ type: 'close' })
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main, { once: true })
} else {
  main()
}
