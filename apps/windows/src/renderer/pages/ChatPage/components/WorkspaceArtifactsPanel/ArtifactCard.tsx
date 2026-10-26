/**
 * ArtifactCard — 产物卡（rail 内）
 *
 * P0 只用图片直读缩略；其它类型给扩展名占位。
 * 真实缩略图（视频首帧 / PPT 首页 / 大图压缩）在 P1 接。
 */

import React from 'react'
import clsx from 'clsx'
import type { FileChangeEntry } from '@mtbot/agent-runtime/browser'
import type { Artifact } from './ledger'
import { extOf, mediaUrl } from './ledger'
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
  const isImage = artifact.kind === 'image'

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
        {isImage ? (
          <img src={mediaUrl(absolutePath)} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className={styles.thumbExt}>{extLabel(artifact.path)}</span>
        )}
        <span
          className={clsx(styles.statusDot, styles[`status--${artifact.status}`])}
          aria-label={STATUS_LABEL[artifact.status]}
        >
          {STATUS_SHORT[artifact.status]}
        </span>
      </span>
      <span className={styles.cardName}>{name}</span>
      <span className={styles.cardMeta}>
        {artifact.sourceTool ?? artifact.kind}
      </span>
    </button>
  )
}
