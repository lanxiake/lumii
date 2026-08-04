/**
 * A2UI FilePreview 组件 — 根据 mimeType 分发不同预览方式
 */

import React, { useState } from 'react'
import styles from './A2UIRenderer.module.css'
import type { A2UIFilePreview } from './types'
import { AudioPlayerComponent } from './AudioPlayer'
import { VideoPlayerComponent } from './VideoPlayer'

function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const PdfPreview: React.FC<{ src: string; filename: string }> = ({ src, filename }) => (
  <div className={styles['file-preview-pdf']}>
    <iframe src={src} title={filename} className={styles['file-preview-pdf-frame']} />
  </div>
)

const ImagePreview: React.FC<{ src: string; alt: string }> = ({ src, alt }) => {
  const [zoomed, setZoomed] = useState(false)
  return (
    <>
      <img
        className={styles['file-preview-image']}
        src={src}
        alt={alt}
        loading="lazy"
        onClick={() => setZoomed(true)}
      />
      {zoomed && (
        <div className={styles['file-preview-lightbox']} onClick={() => setZoomed(false)}>
          <img src={src} alt={alt} />
        </div>
      )}
    </>
  )
}

const TextPreview: React.FC<{ src: string }> = ({ src }) => {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    fetch(src)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then((txt) => {
        if (!cancelled) setContent(txt)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [src])

  if (error) return <div className={styles['file-preview-error']}>加载失败：{error}</div>
  if (content === null) return <div className={styles['file-preview-loading']}>加载中…</div>
  return (
    <pre className={styles['file-preview-text']}>
      <code>{content}</code>
    </pre>
  )
}

const GenericPreview: React.FC<{ filename: string; size?: number; src: string }> = ({
  filename,
  size,
  src,
}) => (
  <div className={styles['file-preview-generic']}>
    <div className={styles['file-preview-icon']}>
      <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
    </div>
    <div className={styles['file-preview-info']}>
      <div className={styles['file-preview-name']}>{filename}</div>
      {size !== undefined && <div className={styles['file-preview-size']}>{formatSize(size)}</div>}
    </div>
    <button
      className={styles['file-preview-open-btn']}
      onClick={() => window.open(src, '_blank')}
    >
      打开
    </button>
  </div>
)

/**
 * 根据 MIME 渲染文件预览；对缺失字段做防御，避免 A2UI 片段不完整时拖垮整个聊天页。
 */
/**
 * 当模型未提供 mimeType 时，根据文件名后缀推断常见文本类型，避免 .md 等被当成 octet-stream 只显示「打开」。
 */
function inferMimeFromFilename(name: string): string | null {
  const lower = name.toLowerCase()
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  if (ext === 'md' || ext === 'markdown' || ext === 'txt' || ext === 'log') return 'text/plain'
  if (ext === 'json') return 'application/json'
  if (ext === 'html' || ext === 'htm') return 'text/html'
  return null
}

export const FilePreviewComponent: React.FC<A2UIFilePreview> = ({
  id,
  src,
  filename,
  mimeType,
  size,
}) => {
  /** 模型可能省略 mimeType，避免对 undefined 调用 startsWith 导致整页崩溃 */
  const safeSrc = src ?? ''
  const safeName = filename ?? 'file'
  const trimmedMime = (mimeType ?? '').trim()
  const normalizedMime =
    trimmedMime || inferMimeFromFilename(safeName) || 'application/octet-stream'

  // PDF
  if (normalizedMime === 'application/pdf') {
    return <PdfPreview src={safeSrc} filename={safeName} />
  }

  // 图片
  if (normalizedMime.startsWith('image/')) {
    return <ImagePreview src={safeSrc} alt={safeName} />
  }

  // 音频
  if (normalizedMime.startsWith('audio/')) {
    return (
      <AudioPlayerComponent
        type="AudioPlayer"
        id={`${id}-audio`}
        src={safeSrc}
        title={safeName}
      />
    )
  }

  // 视频
  if (normalizedMime.startsWith('video/')) {
    return (
      <VideoPlayerComponent
        type="VideoPlayer"
        id={`${id}-video`}
        src={safeSrc}
        title={safeName}
      />
    )
  }

  // 文本 / JSON
  if (normalizedMime.startsWith('text/') || normalizedMime === 'application/json') {
    return <TextPreview src={safeSrc} />
  }

  // 其他：显示文件名 + 大小 + 打开按钮
  return <GenericPreview filename={safeName} size={size} src={safeSrc} />
}
