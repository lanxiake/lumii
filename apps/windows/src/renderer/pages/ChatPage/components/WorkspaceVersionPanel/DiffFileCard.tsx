/**
 * DiffFileCard — 单文件堆叠 Diff 卡片
 *
 * 头：路径 / 状态 / ± / 撤销 / 在文件中显示
 * 体：skeleton、截断提示或 hunks；连续 context 行折叠为 unmodified 条
 */

import React, { useMemo, useState } from 'react'
import clsx from 'clsx'
import { Undo2, FolderOpen } from 'lucide-react'
import type {
  VcsDiffHunk,
  VcsDiffItem,
} from '../../../../hooks/business/useWorkspaceVcs'
import styles from './DiffFileCard.module.css'

export interface DiffFileCardProps {
  entry: VcsDiffItem
  hunks?: VcsDiffHunk[]
  loading?: boolean
  truncated?: boolean
  skipReason?: string
  onRevert?: () => void
  onRevealInFiles?: () => void
  id?: string
}

type RenderSeg =
  | { kind: 'line'; line: string; key: string }
  | { kind: 'fold'; count: number; lines: string[]; key: string }

/**
 * 将 hunk 行序列折叠：连续「 」前缀的 context 行收成一条可展开条
 */
function foldHunkLines(hunks: VcsDiffHunk[]): RenderSeg[] {
  const segs: RenderSeg[] = []
  let i = 0
  const all: { line: string; key: string }[] = []
  hunks.forEach((h, hi) => {
    h.lines.forEach((line, li) => {
      all.push({ line, key: `${hi}-${li}` })
    })
  })

  while (i < all.length) {
    const cur = all[i]
    if (cur.line.startsWith(' ')) {
      const start = i
      while (i < all.length && all[i].line.startsWith(' ')) i++
      const block = all.slice(start, i)
      if (block.length >= 4) {
        segs.push({
          kind: 'fold',
          count: block.length,
          lines: block.map((b) => b.line),
          key: `fold-${block[0].key}`,
        })
      } else {
        for (const b of block) segs.push({ kind: 'line', line: b.line, key: b.key })
      }
    } else {
      segs.push({ kind: 'line', line: cur.line, key: cur.key })
      i++
    }
  }
  return segs
}

/** 单行 class */
function lineClass(line: string): string {
  if (line.startsWith('+')) return styles.lineAdd
  if (line.startsWith('-')) return styles.lineDel
  return styles.lineCtx
}

/** 状态文案 */
function statusText(status: VcsDiffItem['status']): string {
  if (status === 'added') return '新增'
  if (status === 'deleted') return '删除'
  return '修改'
}

/**
 * 单文件 Diff 卡片（纯展示 + 回调）
 */
export const DiffFileCard: React.FC<DiffFileCardProps> = ({
  entry,
  hunks,
  loading,
  truncated,
  skipReason,
  onRevert,
  onRevealInFiles,
  id,
}) => {
  const [expandedFolds, setExpandedFolds] = useState<Record<string, boolean>>({})
  const effectiveHunks = hunks ?? entry.hunks
  const segs = useMemo(
    () => (effectiveHunks?.length ? foldHunkLines(effectiveHunks) : []),
    [effectiveHunks],
  )

  return (
    <section className={styles.card} id={id}>
      <header className={styles.head}>
        <span className={clsx(styles.badge, styles[`badge_${entry.status}`])}>
          {statusText(entry.status)}
        </span>
        <span className={styles.path} title={entry.filepath}>
          {entry.filepath}
        </span>
        <span className={styles.stats}>
          <span className={styles.ins}>+{entry.insertions}</span>
          <span className={styles.del}>−{entry.deletions}</span>
        </span>
        <div className={styles.actions}>
          {onRevealInFiles && (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={onRevealInFiles}
              title="在文件中显示"
            >
              <FolderOpen size={14} strokeWidth={1.8} />
            </button>
          )}
          {onRevert && (
            <button
              type="button"
              className={clsx(styles.iconBtn, styles.revertBtn)}
              onClick={onRevert}
              title="撤销此文件"
            >
              <Undo2 size={14} strokeWidth={1.8} />
            </button>
          )}
        </div>
      </header>

      <div className={styles.body}>
        {loading && (
          <div className={styles.skeleton} aria-busy="true">
            <div className={styles.skelRow} />
            <div className={styles.skelRow} />
            <div className={styles.skelRowShort} />
          </div>
        )}

        {!loading && truncated && (
          <p className={styles.notice}>
            {skipReason || '文件过大，已跳过逐行差异'}
          </p>
        )}

        {!loading && !truncated && segs.length === 0 && (
          <p className={styles.notice}>无逐行差异（可能为二进制或仅元数据变更）</p>
        )}

        {!loading && !truncated && segs.length > 0 && (
          <div className={styles.hunks}>
            {segs.map((seg) => {
              if (seg.kind === 'fold') {
                const open = expandedFolds[seg.key]
                if (open) {
                  return (
                    <div key={seg.key}>
                      <button
                        type="button"
                        className={styles.fold}
                        onClick={() =>
                          setExpandedFolds((m) => ({ ...m, [seg.key]: false }))
                        }
                      >
                        收起 {seg.count} unmodified lines
                      </button>
                      {seg.lines.map((line, idx) => (
                        <pre key={`${seg.key}-${idx}`} className={lineClass(line)}>
                          {line}
                        </pre>
                      ))}
                    </div>
                  )
                }
                return (
                  <button
                    key={seg.key}
                    type="button"
                    className={styles.fold}
                    onClick={() =>
                      setExpandedFolds((m) => ({ ...m, [seg.key]: true }))
                    }
                  >
                    {seg.count} unmodified lines
                  </button>
                )
              }
              return (
                <pre key={seg.key} className={lineClass(seg.line)}>
                  {seg.line}
                </pre>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
