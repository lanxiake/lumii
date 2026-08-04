/**
 * PptxPreview — 使用 pptx-preview 将 .pptx 渲染为幻灯片 DOM
 *
 * pptx-preview 无类型定义，导出 init(container, options) → 实例 .preview(arrayBuffer)。
 * 渲染出的文本为真实 DOM，可框选复制。
 */

import React, { useEffect, useRef, useState } from 'react'
// @ts-ignore — pptx-preview 无类型声明
import { init as initPptxPreviewer } from 'pptx-preview'
import styles from './PptxPreview.module.css'

interface PptxPreviewer {
  preview: (data: ArrayBuffer) => Promise<void> | void
  destroy?: () => void
}

export interface PptxPreviewProps {
  /** PPTX 原始字节 */
  bytes: Uint8Array
  fileName: string
}

export const PptxPreview: React.FC<PptxPreviewProps> = ({ bytes, fileName }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
        // 宽度按容器自适应，高度按 16:9 估算，pptx-preview 内部会按幻灯片比例排版
        const width = el.clientWidth > 0 ? el.clientWidth : 900
        previewer = initPptxPreviewer(el, {
          width,
          height: Math.round((width * 9) / 16),
        }) as PptxPreviewer
        // 拷贝底层 buffer，避免 detached
        const copy = new Uint8Array(bytes)
        await previewer.preview(copy.buffer)
        if (cancelled) return
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'PPTX 渲染失败')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      try {
        previewer?.destroy?.()
      } catch {
        // 忽略销毁异常
      }
      el.innerHTML = ''
    }
  }, [bytes, fileName])

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
        </div>
      )}
      <div ref={containerRef} className={styles.slides} />
    </div>
  )
}
