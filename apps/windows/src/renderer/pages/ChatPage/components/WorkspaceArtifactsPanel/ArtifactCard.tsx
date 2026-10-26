/**
 * ArtifactCard — 产物卡（rail 内）
 *
 * 缩略图统一走主进程 `artifact:thumb`（图片压到 256 webp、视频首帧、PPT 页数）。
 * 不用 IntersectionObserver：rail 的任务组带 `content-visibility: auto`，
 * 被跳过的子树里 IO 恒报不交叉，卡片会永远停在占位；主进程侧已有并发 2、
 * 同 key 复用与磁盘缓存，直接挂载即请求即可。失败回退原图/扩展名占位。
 * PPT 首页渲染留到 P2。
 */

import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import type { FileChangeEntry } from '@mtbot/agent-runtime/browser'
import type { Artifact } from './ledger'
import { extOf, mediaUrl } from './ledger'
import { requestArtifactThumb } from '../../../../services/artifact-service'
import styles from './WorkspaceArtifactsPanel.module.css'

const STATUS_LABEL: Record<FileChangeEntry['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
}

const STATUS_SHORT: Record<FileChangeEntry['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
}

function fileNameOf(filePath: string): string {
  return filePath.split('/').pop() ?? filePath
}

function extLabel(filePath: string): string {
  const ext = extOf(filePath)
  if (!ext) return '·'
  return (ext.length > 4 ? ext.slice(0, 4) : ext).toUpperCase()
}

/** 卡片副标题：优先给用户能判断「是不是要的那张」的规格 */
function metaLabelOf(artifact: Artifact, thumbMeta?: { pages?: number }): string {
  const meta = artifact.meta
  const pages = meta?.pages ?? thumbMeta?.pages
  if (pages !== undefined) return `${pages} 页`
  if (meta?.width && meta?.height) return `${meta.width}×${meta.height}`
  if (meta?.durationSec !== undefined) return `${Math.round(meta.durationSec)}s`
  if (meta?.model) return meta.model
  return artifact.sourceTool ?? artifact.kind
}

/**
 * 大图走缩略（卡片只需 256px）；小图直接读原图，少一次 IPC 与占位闪烁。
 * 由 fileChanges 派生的产物没有 meta，无从判断尺寸 —— 交给主进程 stat，
 * 反正缩略图本身有磁盘缓存。
 */
function needsImageThumb(artifact: Artifact): boolean {
  const meta = artifact.meta
  if (!meta) return true
  const { width, height, bytes } = meta
  return (width ?? 0) > 2048 || (height ?? 0) > 2048 || (bytes ?? 0) > 1024 * 1024
}

export interface ArtifactCardProps {
  artifact: Artifact
  absolutePath: string
  selected?: boolean
  onSelect: (relativePath: string) => void
  /** 双击：开独立预览窗 */
  onOpenWindow?: (absolutePath: string, fileName: string) => void
}

export const ArtifactCard: React.FC<ArtifactCardProps> = ({
  artifact,
  absolutePath,
  selected = false,
  onSelect,
  onOpenWindow,
}) => {
  const name = fileNameOf(artifact.path)
  const isImage = artifact.kind === 'image' || artifact.kind === 'image-set'
  const wantsThumb =
    artifact.kind === 'video' || artifact.kind === 'slides' || (isImage && needsImageThumb(artifact))
  const [thumb, setThumb] = useState<{
    url?: string
    meta?: { pages?: number; width?: number; height?: number }
    failed?: boolean
  } | null>(null)

  useEffect(() => {
    if (!wantsThumb) return
    let cancelled = false
    setThumb(null) // 新版本别继续挂旧图
    void requestArtifactThumb(artifact.path, artifact.timestamp).then((result) => {
      if (cancelled) return
      setThumb(result.ok ? { url: result.url, meta: result.meta } : { failed: true })
    })
    return () => {
      cancelled = true
    }
    // timestamp 变化 = 同一路径出了新版本，缓存 key 含 mtime，需要重新取
  }, [wantsThumb, artifact.path, artifact.timestamp])

  // 小图（或尺寸未知）先直读原图，缩略图回来再替换 —— 避免占位闪一下；
  // 已知的大图先占位，别让 rail 去解码 4096px。缩略失败一律回退原图。
  const mayLoadOriginal = isImage && (!artifact.meta || !needsImageThumb(artifact))
  const fallbackUrl =
    isImage && (mayLoadOriginal || thumb?.failed) ? mediaUrl(absolutePath) : undefined
  const thumbSrc = thumb?.url ?? fallbackUrl

  return (
    <button
      type="button"
      className={clsx(styles.card, selected && styles.cardSelected)}
      onClick={() => onSelect(artifact.path)}
      onDoubleClick={() => onOpenWindow?.(absolutePath, name)}
      title={artifact.path}
      aria-pressed={selected}
    >
      <span className={styles.thumb}>
        {thumbSrc ? (
          <img src={thumbSrc} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className={styles.thumbExt}>{extLabel(artifact.path)}</span>
        )}
        {artifact.kind === 'video' && <span className={styles.playBadge}>▶</span>}
        <span
          className={clsx(styles.statusDot, styles[`status--${artifact.status}`])}
          aria-label={STATUS_LABEL[artifact.status]}
        >
          {STATUS_SHORT[artifact.status]}
        </span>
      </span>
      <span className={styles.cardName}>{name}</span>
      <span className={styles.cardMeta}>{metaLabelOf(artifact, thumb?.meta)}</span>
    </button>
  )
}
