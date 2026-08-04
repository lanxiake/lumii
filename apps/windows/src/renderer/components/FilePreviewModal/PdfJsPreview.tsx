/**
 * PdfJsPreview — 使用 Mozilla PDF.js（legacy 构建）在 Canvas 上渲染 PDF
 *
 * 必须使用 getDocument({ data }) 传入二进制：Worker 内对 blob: URL 的 fetch 在 Electron 中常返回
 * 「Unexpected server response (0)」，主线程创建的 Blob URL 对 Worker 不可见。
 */

import React, { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import styles from './PdfJsPreview.module.css'

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc

/** 与当前 pdfjs-dist 版本对齐的静态资源根（需 CSP connect-src 允许 unpkg） */
function getPdfJsAssetBase(): string {
  const v = (pdfjs as { version?: string }).version ?? '5.5.207'
  return `https://unpkg.com/pdfjs-dist@${v}/`
}

export interface PdfJsPreviewProps {
  /** PDF 原始字节 */
  bytes: Uint8Array
  fileName: string
}

/**
 * 将 PDF 各页渲染到垂直排列的 canvas；数据以拷贝后的 Uint8Array 传入，避免转入 Worker 后缓冲被 detached
 */
export const PdfJsPreview: React.FC<PdfJsPreviewProps> = ({ bytes, fileName }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    let cancelled = false

    void (async () => {
      setLoading(true)
      setError(null)
      el.innerHTML = ''

      const base = getPdfJsAssetBase()
      const data = new Uint8Array(bytes)

      try {
        const loadingTask = pdfjs.getDocument({
          data,
          cMapUrl: `${base}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${base}standard_fonts/`,
          iccUrl: `${base}iccs/`,
          verbosity: 0,
        })
        const pdf = await loadingTask.promise
        const numPages = pdf.numPages

        for (let i = 1; i <= numPages; i++) {
          if (cancelled) return
          const page = await pdf.getPage(i)
          const scale = 1.35
          const viewport = page.getViewport({ scale })

          // 页面容器：canvas 与透明文字层在此叠放对齐，使 PDF 文字可框选复制
          const pageWrap = document.createElement('div')
          pageWrap.className = styles.pageWrap
          pageWrap.style.width = `${viewport.width}px`
          pageWrap.style.height = `${viewport.height}px`

          const canvas = document.createElement('canvas')
          const ctx = canvas.getContext('2d')
          if (!ctx) throw new Error('无法创建 Canvas 2D 上下文')
          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.className = styles.pageCanvas
          canvas.setAttribute('role', 'img')
          canvas.setAttribute('aria-label', `${fileName} 第 ${i} 页`)
          pageWrap.appendChild(canvas)

          await page.render({ canvasContext: ctx, viewport, canvas }).promise
          if (cancelled) return

          // 透明文字层：把 PDF 文本以真实字形定位覆盖在 canvas 之上，实现选中/复制
          try {
            const textContent = await page.getTextContent()
            if (cancelled) return
            const textLayerDiv = document.createElement('div')
            textLayerDiv.className = styles.textLayer
            // PDF.js 5.x 用 --scale-factor 计算文字层字号
            textLayerDiv.style.setProperty('--scale-factor', String(scale))
            pageWrap.appendChild(textLayerDiv)
            const textLayer = new pdfjs.TextLayer({
              textContentSource: textContent,
              container: textLayerDiv,
              viewport,
            })
            await textLayer.render()
          } catch {
            // 文字层渲染失败不影响 canvas 图像展示，忽略
          }

          if (cancelled) return
          el.appendChild(pageWrap)
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'PDF 渲染失败')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      el.innerHTML = ''
    }
  }, [bytes, fileName])

  return (
    <div className={styles.wrap}>
      {loading && (
        <div className={styles.status}>
          <span className={styles.spinner} />
          <span>正在渲染 PDF…</span>
        </div>
      )}
      {error && (
        <div className={styles.status}>
          <p className={styles.err}>{error}</p>
        </div>
      )}
      <div ref={containerRef} className={styles.pages} />
    </div>
  )
}
