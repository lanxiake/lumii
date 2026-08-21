import { useEffect, useRef, useState } from 'react'

const PAGE_ZOOM_KEY = 'mtbot:chat-page-zoom'
const ZOOM_MIN = 0.6
const ZOOM_MAX = 2
const ZOOM_STEP = 0.1

export function useChatPageZoom() {
  const [pageZoom, setPageZoom] = useState(() => {
    try {
      const value = parseFloat(localStorage.getItem(PAGE_ZOOM_KEY) ?? '')
      return Number.isFinite(value) && value >= ZOOM_MIN && value <= ZOOM_MAX ? value : 1
    } catch {
      return 1
    }
  })
  const chatPageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = chatPageRef.current
    if (!element) return
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      setPageZoom((previous) => {
        const step = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP
        const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((previous + step) * 100) / 100))
        try { localStorage.setItem(PAGE_ZOOM_KEY, String(next)) } catch { /* ignore */ }
        return next
      })
    }
    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => element.removeEventListener('wheel', handleWheel)
  }, [])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== '0') return
      event.preventDefault()
      setPageZoom(1)
      try { localStorage.setItem(PAGE_ZOOM_KEY, '1') } catch { /* ignore */ }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  const resetPageZoom = () => {
    setPageZoom(1)
    try { localStorage.setItem(PAGE_ZOOM_KEY, '1') } catch { /* ignore */ }
  }

  return { pageZoom, setPageZoom, resetPageZoom, chatPageRef }
}
