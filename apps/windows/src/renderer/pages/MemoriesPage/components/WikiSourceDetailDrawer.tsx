/**
 * WikiSourceDetailDrawer — 资料详情侧滑：摘要 + 网页/文件预览
 */
import React, { useEffect, useState } from 'react'
import { ExternalLink, X } from 'lucide-react'
import { Button } from '../../../components/ui/Button/Button'
import { Loading } from '../../../components/ui/Loading/Loading'
import { FilePreviewModal } from '../../../components/FilePreviewModal/FilePreviewModal'
import type { WikiSourceDetail } from '../../../hooks/business/useWikiPage'
import { resolvePreviewMode } from './wikiSourcePreview'

/** 侧滑内嵌网页预览（Electron webview 独立进程） */
const WikiWebPreviewFrame: React.FC<{ url: string; title: string }> = ({ url, title }) => (
  // @ts-expect-error webview 为 Electron 专有标签
  <webview src={url} title={title} className="wiki-source-web-preview" />
)

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
 * 渲染资料详情抽屉：资讯类展示摘要与原文链接，下方嵌入网页或文件预览。
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
  const sourceUrl = detail?.sourceUrl ?? snapshot?.sourceUrl ?? null
  const sourcePath = detail?.sourcePath ?? snapshot?.sourcePath ?? null
  const previewMode = resolvePreviewMode(sourcePath, sourceUrl)

  return (
    <div className="wiki-detail-overlay" role="presentation">
      <button type="button" className="wiki-detail-mask" aria-label="关闭资料详情" onClick={onClose} />
      <aside className="wiki-detail-drawer wiki-source-detail-drawer" aria-label="资料详情">
        <header className="wiki-source-detail-header">
          <h2 className="wiki-source-detail-title">{title}</h2>
          <div className="wiki-source-detail-header-actions">
            {detail && onOpenExternal && previewMode === 'file' && (
              <Button variant="ghost" size="sm" onClick={() => onOpenExternal(detail)}>
                <ExternalLink size={14} />
                打开原文件
              </Button>
            )}
            {sourceUrl && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void window.electronAPI?.openExternal?.(sourceUrl)}
              >
                <ExternalLink size={14} />
                在浏览器打开
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
              {summary && (
                <section className="wiki-source-detail-summary" aria-label="摘要">
                  <h3>摘要</h3>
                  <p>{summary}</p>
                </section>
              )}

              {sourceUrl && (
                <section className="wiki-source-detail-link" aria-label="原文链接">
                  <h3>原文链接</h3>
                  <a href={sourceUrl} target="_blank" rel="noreferrer noopener">
                    {sourceUrl}
                  </a>
                </section>
              )}

              <section className="wiki-source-detail-preview" aria-label="预览">
                <h3>预览</h3>
                {previewMode === 'web' && sourceUrl && (
                  <WikiWebPreviewFrame url={sourceUrl} title={title} />
                )}
                {previewMode === 'file' && sourcePath && (
                  <div className="wiki-source-file-preview-host">
                    <FilePreviewModal
                      variant="embedded"
                      filePath={sourcePath}
                      fileName={title}
                      onClose={() => undefined}
                    />
                  </div>
                )}
                {previewMode === 'text-only' && !summary && (
                  <p className="wiki-empty-hint">暂无可预览内容</p>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
    </div>
  )
}

export default WikiSourceDetailDrawer
