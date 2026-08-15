/**
 * PptxPreview — 使用 pptx-preview 将 .pptx 渲染为可交互幻灯片
 *
 * mode=slide：单页展示 + 翻页；点击画面左/右半区翻页。
 * 预览前会 sanitize PPTX，并对 pptx-preview 的 background 崩溃做兜底提示。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
// @ts-ignore — pptx-preview 无类型声明
import { init as initPptxPreviewer } from 'pptx-preview'
import { sanitizePptxForPreview } from './sanitize-pptx'
import styles from './PptxPreview.module.css'

interface PptxPreviewer {
  preview: (data: ArrayBuffer) => Promise<void> | void
  destroy?: () => void
  renderNextSlide?: () => void
  renderPreSlide?: () => void
  slideCount?: number
  currentIndex?: number
}

export interface PptxPreviewProps {
  /** PPTX 原始字节 */
  bytes: Uint8Array
  fileName: string
  /** 预览失败时「用系统应用打开」 */
  onOpenExternal?: () => void
}

/**
 * 将库抛出的技术错误转成用户可读文案
 */
function friendlyPptxError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? 'PPTX 渲染失败')
  if (/background/i.test(msg) || /slideLayout|slideMaster/i.test(msg)) {
    return '该 PPT 结构不完整或版式缺失，应用内预览失败。可尝试用系统应用打开。'
  }
  if (/Cannot read properties of undefined/i.test(msg)) {
    return '该 PPT 含有当前预览引擎无法解析的内容。可尝试用系统应用打开。'
  }
  return msg
}

/**
 * PPTX 幻灯片预览（可点击翻页）
 */
export const PptxPreview: React.FC<PptxPreviewProps> = ({ bytes, fileName, onOpenExternal }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const previewerRef = useRef<PptxPreviewer | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState('点击画面右侧下一页，左侧上一页；也可用两侧按钮')

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    let cancelled = false
    let previewer: PptxPreviewer | null = null

    void (async () => {
      setLoading(true)
      setError(null)
      el.innerHTML = ''
      try {
        const width = el.clientWidth > 0 ? Math.min(el.clientWidth, 960) : 900
        previewer = initPptxPreviewer(el, {
          width,
          height: Math.round((width * 9) / 16),
          mode: 'slide',
        }) as PptxPreviewer
        previewerRef.current = previewer

        const copy = new Uint8Array(bytes)
        const rawBuf = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)
        const sanitized = await sanitizePptxForPreview(rawBuf)
        if (cancelled) return

        await previewer.preview(sanitized)
        if (cancelled) return
        setHint('点击画面右侧下一页，左侧上一页；也可用两侧按钮')
      } catch (e) {
        console.error('[PptxPreview] 渲染失败:', e)
        if (!cancelled) {
          setError(friendlyPptxError(e))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      previewerRef.current = null
      try {
        previewer?.destroy?.()
      } catch {
        // 忽略销毁异常
      }
      el.innerHTML = ''
    }
  }, [bytes, fileName])

  /**
   * 点击幻灯片区域：左半上一页，右半下一页
   */
  const handleSlideClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const previewer = previewerRef.current
    if (!previewer || loading || error) return
    const target = e.target as HTMLElement
    if (target.closest('.pptx-preview-btn, .pptx-prev-btn, .pptx-next-btn, [class*="pptx-prev"], [class*="pptx-next"]')) {
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    if (x < rect.width * 0.4) {
      try {
        previewer.renderPreSlide?.()
      } catch (err) {
        console.warn('[PptxPreview] 上一页失败:', err)
      }
    } else {
      try {
        previewer.renderNextSlide?.()
      } catch (err) {
        console.warn('[PptxPreview] 下一页失败:', err)
      }
    }
  }, [loading, error])

  /**
   * 键盘左右方向键翻页
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const previewer = previewerRef.current
      if (!previewer || loading || error) return
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault()
        try {
          previewer.renderNextSlide?.()
        } catch {
          // ignore
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        try {
          previewer.renderPreSlide?.()
        } catch {
          // ignore
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [loading, error])

  return (
    <div className={styles.wrap}>
      {loading && (
        <div className={styles.status}>
          <span className={styles.spinner} />
          <span>正在渲染 PPT…</span>
        </div>
      )}
      {error && (
        <div className={styles.status}>
          <p className={styles.err}>{error}</p>
          {onOpenExternal && (
            <button type="button" className={styles.openBtn} onClick={onOpenExternal}>
              用系统应用打开
            </button>
          )}
        </div>
      )}
      {!loading && !error && (
        <div className={styles.toolbar}>
          <span className={styles.hint}>{hint}</span>
        </div>
      )}
      <div
        ref={containerRef}
        className={styles.slides}
        onClick={handleSlideClick}
        role="application"
        aria-label={`PPT 预览：${fileName}`}
      />
    </div>
  )
}
