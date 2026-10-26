/**
 * ArtifactFoldRow — 「中间产物 N 个」折叠行
 *
 * 一屏 1107 个同名切片是这个功能存在的理由；折叠行是**默认形态**，
 * 展开才铺网格，并在行尾给清理入口。
 */

import React from 'react'
import clsx from 'clsx'
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import styles from './WorkspaceArtifactsPanel.module.css'

export function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined || bytes <= 0) return undefined
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export interface ArtifactFoldRowProps {
  count: number
  bytes?: number
  expanded: boolean
  onToggle: () => void
  onCleanup?: () => void
}

export const ArtifactFoldRow: React.FC<ArtifactFoldRowProps> = ({
  count,
  bytes,
  expanded,
  onToggle,
  onCleanup,
}) => {
  const size = formatBytes(bytes)
  return (
    <div className={clsx(styles.foldRow, expanded && styles.foldRowExpanded)}>
      <button
        type="button"
        className={styles.foldToggle}
        onClick={onToggle}
        aria-expanded={expanded}
        title={expanded ? '收起过程文件' : '展开过程文件'}
      >
        {expanded ? (
          <ChevronDown size={13} strokeWidth={2} />
        ) : (
          <ChevronRight size={13} strokeWidth={2} />
        )}
        <span>
          中间产物 {count} 个{size ? ` · ${size}` : ''}
        </span>
        <span className={styles.foldHint}>{expanded ? '收起' : '展开'}</span>
      </button>
      {onCleanup && (
        <button
          type="button"
          className={styles.foldCleanup}
          onClick={onCleanup}
          title="清理过程文件（先进回收站）"
        >
          <Trash2 size={13} strokeWidth={1.8} />
          清理…
        </button>
      )}
    </div>
  )
}
