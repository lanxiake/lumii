/**
 * ArtifactCompareView — main 区的并排对比（2–4 项）
 *
 * 用途是「选封面 / 选变体 / 比较两次重跑」：图片看构图，视频看首帧，其它给缩略 + 文件名。
 * 不做画布、不做缩放联动——两侧各自可滚，用户要的是同一屏里放得下。
 * 窄工作台（<860）只放 2 项：再挤每格就看不清了，宁可分两轮比。
 */

import React from 'react'
import { X } from 'lucide-react'
import type { Artifact } from './ledger'
import { extOf, mediaUrl } from './ledger'
import styles from './WorkspaceArtifactsPanel.module.css'

/** 并排上限：宽档 4、窄档 2 */
export const COMPARE_MAX_WIDE = 4
export const COMPARE_MAX_COMPACT = 2
/** 与设计 §7.4 / T5 一致：860 以下只允许两项 */
export const COMPARE_COMPACT_BREAKPOINT = 860

export function compareLimit(workbenchWidth: number): number {
  return workbenchWidth >= COMPARE_COMPACT_BREAKPOINT ? COMPARE_MAX_WIDE : COMPARE_MAX_COMPACT
}

export interface ArtifactCompareViewProps {
  items: readonly Artifact[]
  toAbsolutePath: (relativePath: string) => string
  /** 当前工作台宽度；只用于决定列数与「最多 N 项」提示 */
  width: number
  /** 单点某一格 → 回到普通预览 */
  onPick: (relativePath: string) => void
  onExit: () => void
}

function fileNameOf(filePath: string): string {
  return filePath.split('/').pop() ?? filePath
}

function extLabel(filePath: string): string {
  const ext = extOf(filePath)
  if (!ext) return '·'
  return (ext.length > 4 ? ext.slice(0, 4) : ext).toUpperCase()
}

function specOf(artifact: Artifact): string | undefined {
  const meta = artifact.meta
  if (meta?.width && meta.height) return `${meta.width}×${meta.height}`
  if (meta?.pages !== undefined) return `${meta.pages} 页`
  if (meta?.durationSec !== undefined) return `${Math.round(meta.durationSec)}s`
  if (meta?.model) return meta.model
  return undefined
}

export const ArtifactCompareView: React.FC<ArtifactCompareViewProps> = ({
  items,
  toAbsolutePath,
  width,
  onPick,
  onExit,
}) => {
  const limit = compareLimit(width)
  const shown = items.slice(0, limit)
  const hidden = items.length - shown.length

  return (
    <div className={styles.compare} data-testid="artifact-compare">
      <div className={styles.compareHead}>
        <span className={styles.compareTitle}>对比 {shown.length} 项</span>
        {hidden > 0 && (
          <span className={styles.compareNote}>当前宽度最多并排 {limit} 项，还有 {hidden} 项未显示</span>
        )}
        <button
          type="button"
          className={styles.compareExit}
          onClick={onExit}
          title="退出对比（Esc）"
          aria-label="退出对比"
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>
      <div
        className={styles.compareGrid}
        style={{ gridTemplateColumns: `repeat(${Math.min(shown.length, 2)}, minmax(0, 1fr))` }}
      >
        {shown.map((artifact) => {
          const abs = toAbsolutePath(artifact.path)
          const isImage = artifact.kind === 'image' || artifact.kind === 'image-set'
          const isVideo = artifact.kind === 'video'
          return (
            <button
              key={artifact.path}
              type="button"
              className={styles.compareCell}
              onClick={() => onPick(artifact.path)}
              title={`打开 ${artifact.path}`}
            >
              <span className={styles.compareMedia}>
                {isImage ? (
                  <img src={mediaUrl(abs)} alt="" loading="lazy" decoding="async" />
                ) : isVideo ? (
                  <video src={mediaUrl(abs)} muted preload="metadata" />
                ) : (
                  <span className={styles.thumbExt}>{extLabel(artifact.path)}</span>
                )}
              </span>
              <span className={styles.compareCaption}>
                <span className={styles.compareName}>{fileNameOf(artifact.path)}</span>
                {specOf(artifact) && (
                  <span className={styles.compareSpec}>{specOf(artifact)}</span>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
