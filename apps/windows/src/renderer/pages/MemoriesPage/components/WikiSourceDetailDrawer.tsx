/**
 * WikiSourceDetailDrawer — 资料详情侧滑：摘要 + 内置网页/文件预览
 */
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from '../../../components/ui/Button/Button'
import { Loading } from '../../../components/ui/Loading/Loading'
import { FilePreviewModal } from '../../../components/FilePreviewModal/FilePreviewModal'
import type { WikiSourceDetail } from '../../../hooks/business/useWikiPage'
import { resolveItemSourceUrl, resolvePreviewMode } from './wikiSourcePreview'

/** Electron webview 加载失败事件（非标准 DOM 类型） */
type WebviewFailLoadEvent = Event & {
  readonly errorCode?: number
  readonly errorDescription?: string
}

/**
 * 侧滑内嵌网页预览（Electron webview 独立进程）。
 * webview 对 CSS 百分比高度支持不稳定，用 ResizeObserver 同步宿主像素尺寸。
 */
const WikiWebPreviewFrame: React.FC<{ url: string; title: string }> = ({ url, title }) => {
  const hostRef = useRef<HTMLDivElement>(null)
  const webviewRef = useRef<HTMLElement | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    setLoadError(null)
  }, [url])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    /** 将宿主容器的实际像素尺寸写入 webview，避免只渲染上半部分 */
    const syncWebviewSize = (): void => {
      const webview = webviewRef.current ?? host.querySelector('webview')
      if (!webview) return
      const { clientWidth, clientHeight } = host
      if (clientWidth > 0) webview.style.width = `${clientWidth}px`
      if (clientHeight > 0) webview.style.height = `${clientHeight}px`
    }

    syncWebviewSize()
    const observer = new ResizeObserver(syncWebviewSize)
    observer.observe(host)
    return () => observer.disconnect()
  }, [url, loadError])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return undefined

    /** 监听 webview 加载失败，展示友好降级而非控制台未捕获错误 */
    const handleFailLoad = (event: Event): void => {
      const detail = event as WebviewFailLoadEvent
      // -3 = ERR_ABORTED，通常是切换 URL 时取消上一次导航，忽略即可
      if (detail.errorCode === -3) return
      setLoadError(detail.errorDescription?.trim() || '网页无法在内置浏览器中加载')
    }

    /** 加载成功后清除错误态 */
    const handleFinishLoad = (): void => {
      setLoadError(null)
    }

    webview.addEventListener('did-fail-load', handleFailLoad)
    webview.addEventListener('did-finish-load', handleFinishLoad)
    return () => {
      webview.removeEventListener('did-fail-load', handleFailLoad)
      webview.removeEventListener('did-finish-load', handleFinishLoad)
    }
  }, [url])

  /** 在系统默认浏览器中打开当前 URL */
  const openInSystemBrowser = (): void => {
    void window.electronAPI?.app?.openExternal(url)
  }

  return (
    <div ref={hostRef} className="wiki-source-web-preview-host">
      {loadError ? (
        <div className="wiki-source-web-preview-error" role="alert">
          <p className="wiki-source-web-preview-error-title">{loadError}</p>
          <p className="wiki-source-web-preview-error-hint">
            部分网站禁止内嵌预览，或当前网络无法访问。你仍可在系统浏览器中打开链接。
          </p>
          <Button variant="secondary" size="sm" onClick={openInSystemBrowser}>
            在系统浏览器打开
          </Button>
        </div>
      ) : null}
      {/* @ts-expect-error webview 为 Electron 专有标签 */}
      <webview
        ref={webviewRef as React.RefObject<never>}
        src={url}
        title={title}
        className="wiki-source-web-preview"
        hidden={loadError !== null}
      />
    </div>
  )
}

export interface WikiSourcePreviewSnapshot {
  readonly title: string
  readonly summary: string | null
  readonly sourceUrl: string | null
  readonly sourcePath: string | null
  readonly mediaType?: string
}

interface WikiSourceDetailDrawerProps {
  readonly open: boolean
  readonly sourceId: string | null
  readonly snapshot: WikiSourcePreviewSnapshot | null
  readonly getSource: (sourceId: string) => Promise<WikiSourceDetail | null>
  readonly onClose: () => void
  readonly onOpenExternal?: (detail: WikiSourceDetail) => void
}

/**
 * 渲染资料详情：网页链接用居中弹窗 + 内置 webview，文件类仍用右侧抽屉。
 */
export const WikiSourceDetailDrawer: React.FC<WikiSourceDetailDrawerProps> = ({
  open,
  sourceId,
  snapshot,
  getSource,
  onClose,
  onOpenExternal,
}) => {
  const [detail, setDetail] = useState<WikiSourceDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setDetail(null)
      setError(null)
      return undefined
    }

    /** Escape 关闭抽屉 */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    if (!sourceId) {
      setDetail(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void getSource(sourceId)
      .then((row) => {
        if (cancelled) return
        if (!row) {
          setError('资料不存在或已被删除')
          setDetail(null)
          return
        }
        setDetail(row)
      })
      .catch(() => {
        if (!cancelled) setError('加载资料详情失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, sourceId, getSource])

  if (!open) return null

  const title = detail?.title ?? snapshot?.title ?? '资料详情'
  const summary = detail?.extractedText ?? snapshot?.summary ?? null
  const sourceUrl = resolveItemSourceUrl(
    detail?.sourcePath ?? snapshot?.sourcePath,
    detail?.sourceUrl ?? snapshot?.sourceUrl,
    detail?.originContext,
  )
  const filePath =
    sourceUrl ? null : (detail?.sourcePath ?? snapshot?.sourcePath ?? null)
  const previewMode = resolvePreviewMode(filePath, sourceUrl)
  const isWebPreview = previewMode === 'web'

  const drawer = (
    <div
      className={`wiki-detail-overlay wiki-detail-overlay--fixed${isWebPreview ? ' wiki-detail-overlay--centered' : ''}`}
      role="presentation"
    >
      <button type="button" className="wiki-detail-mask" aria-label="关闭资料详情" onClick={onClose} />
      <div
        className={isWebPreview ? 'wiki-source-detail-modal' : 'wiki-detail-drawer wiki-source-detail-drawer'}
        role="dialog"
        aria-label="资料详情"
        aria-modal="true"
      >
        <header className="wiki-source-detail-header">
          <div className="wiki-source-detail-heading">
            <h2 className="wiki-source-detail-title">{title}</h2>
            {sourceUrl && (
              <a
                className="wiki-source-detail-url"
                href={sourceUrl}
                onClick={(e) => e.preventDefault()}
                title={sourceUrl}
              >
                {sourceUrl}
              </a>
            )}
          </div>
          <div className="wiki-source-detail-header-actions">
            {sourceUrl && isWebPreview && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void window.electronAPI?.app?.openExternal(sourceUrl)}
              >
                在浏览器打开
              </Button>
            )}
            {detail && onOpenExternal && previewMode === 'file' && (
              <Button variant="ghost" size="sm" onClick={() => onOpenExternal(detail)}>
                打开原文件
              </Button>
            )}
            <button type="button" className="wiki-source-detail-close" aria-label="关闭" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="wiki-source-detail-body">
          {loading && (
            <div className="wiki-source-detail-loading">
              <Loading text="加载详情…" />
            </div>
          )}
          {error && <p className="wiki-source-detail-error" role="alert">{error}</p>}

          {!loading && !error && (
            <>
              {summary && previewMode !== 'web' && (
                <section className="wiki-source-detail-summary" aria-label="摘要">
                  <h3>摘要</h3>
                  <p>{summary}</p>
                </section>
              )}

              {previewMode === 'web' && sourceUrl && (
                <WikiWebPreviewFrame url={sourceUrl} title={title} />
              )}
              {previewMode === 'file' && filePath && (
                <div className="wiki-source-file-preview-host">
                  <FilePreviewModal
                    variant="embedded"
                    filePath={filePath}
                    fileName={title}
                    onClose={() => undefined}
                  />
                </div>
              )}
              {previewMode === 'text-only' && summary && (
                <section className="wiki-source-detail-summary" aria-label="正文">
                  <p>{summary}</p>
                </section>
              )}
              {previewMode === 'text-only' && !summary && (
                <p className="wiki-empty-hint">暂无可预览内容</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )

  return createPortal(drawer, document.body)
}

export default WikiSourceDetailDrawer
