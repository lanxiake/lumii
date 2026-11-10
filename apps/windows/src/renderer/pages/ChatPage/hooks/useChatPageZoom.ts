import { useEffect, useRef, useState } from 'react'

const PAGE_ZOOM_KEY = 'mtbot:chat-page-zoom'
const ZOOM_MIN = 0.6
const ZOOM_MAX = 2
const ZOOM_STEP = 0.1

/**
 * 页面缩放。
 *
 * 走 Electron 原生 `webFrame.setZoomFactor`，**不用 CSS `zoom`**：
 * CSS zoom 按子树比例缩放，内部布局尺寸变成小数；90% 时大多数行高落在 `.5`
 * 边界（14px × 0.9 = 12.6），相邻元素被向不同方向取整，连续重排（流式渲染）
 * 就表现为「组件和字体上下闪动」。实测 90% 下 60/60 个采样元素逐帧跳动，
 * 100% 与 75% 为 0。
 *
 * 原生缩放由 Chromium 在合成阶段做设备像素对齐，布局树仍是整数，不抖。
 */
export function useChatPageZoom() {
  const [pageZoom, setPageZoom] = useState(() => {
    try {
      const value = parseFloat(localStorage.getItem(PAGE_ZOOM_KEY) ?? '')
      return Number.isFinite(value) && value >= ZOOM_MIN && value <= ZOOM_MAX ? value : 1
    } catch {
      return 1
    }
  })
  /** 只用来挂 Ctrl+滚轮监听；缩放本身不再作用于这个容器 */
  const chatPageRef = useRef<HTMLDivElement>(null)

  /** 把比例同时写进渲染进程与 localStorage */
  const applyZoom = (next: number): void => {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100))
    setPageZoom(clamped)
    window.electronAPI?.pageZoom?.apply(clamped)
    try {
      localStorage.setItem(PAGE_ZOOM_KEY, String(clamped))
    } catch {
      /* ignore */
    }
  }

  // 首帧还原上次的比例（必须在页面挂载后立即应用，否则会闪一下 100%）
  useEffect(() => {
    window.electronAPI?.pageZoom?.apply(pageZoom)
    // 只在挂载时应用一次；后续变化由 applyZoom 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const element = chatPageRef.current
    if (!element) return
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      applyZoom(pageZoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP))
    }
    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => element.removeEventListener('wheel', handleWheel)
  }, [pageZoom])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== '0') return
      event.preventDefault()
      applyZoom(1)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  const resetPageZoom = (): void => {
    applyZoom(1)
  }

  return { pageZoom, resetPageZoom, chatPageRef }
}
