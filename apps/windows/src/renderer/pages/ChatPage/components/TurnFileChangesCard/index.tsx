/**
 * TurnFileChangesCard — 回合文件净变更卡片
 * 仅展示本轮工作区的新增/修改/删除，无上传语义、无 +/- 行数；点击「查看」定位首个文件。
 *
 * 只渲染本会话有证据的变更。历史消息里遗留的 unattributed 条目（旧版本写入）
 * 在渲染时过滤掉，避免并发会话的文件继续出现在卡片里。
 */

import React, { useState } from 'react'
import clsx from 'clsx'
import type { FileChangeEntry } from '@mtbot/agent-runtime/browser'
import styles from './TurnFileChangesCard.module.css'

/** 状态 → 中文标签 */
const STATUS_LABEL: Record<FileChangeEntry['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
}

/** 状态 → 左侧短标 */
const STATUS_SHORT: Record<FileChangeEntry['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
}

interface TurnFileChangesCardProps {
  changes: readonly FileChangeEntry[]
  /**
   * 点击某行「查看」：透传相对路径与状态，交由上层打开 Workbench 并定位。
   * deleted 文件已不存在，上层据 status 跳过预览（仅定位）。
   */
  onReview?: (path: string, status: FileChangeEntry['status']) => void
}

/** 从路径末段推断扩展名归类，用于扩展名徽章配色 */
function classifyExt(path: string): { label: string; kind: string } {
  const base = path.split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return { label: '·', kind: 'default' }
  const ext = base.slice(dot + 1).toLowerCase()
  if (ext === 'ts' || ext === 'tsx') return { label: 'TS', kind: 'ts' }
  if (ext === 'js' || ext === 'jsx' || ext === 'cjs' || ext === 'mjs') return { label: 'JS', kind: 'js' }
  if (ext === 'css' || ext === 'scss' || ext === 'less') return { label: 'CSS', kind: 'css' }
  if (ext === 'md' || ext === 'mdx') return { label: 'MD', kind: 'md' }
  if (ext === 'json') return { label: 'JSON', kind: 'json' }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return { label: 'IMG', kind: 'img' }
  return { label: ext.slice(0, 4).toUpperCase(), kind: 'default' }
}

/** 超过此数量的文件默认收起，其余由「展开」按钮释放 */
const COLLAPSED_COUNT = 6

interface ChangeListProps {
  changes: readonly FileChangeEntry[]
  onReview?: (path: string, status: FileChangeEntry['status']) => void
}

/** 一组文件行（自带折叠状态） */
const ChangeList: React.FC<ChangeListProps> = ({ changes, onReview }) => {
  const [expanded, setExpanded] = useState(false)
  const hidden = changes.length - COLLAPSED_COUNT
  const visible = expanded ? changes : changes.slice(0, COLLAPSED_COUNT)

  return (
    <>
      <div className={styles.list}>
        {visible.map((entry) => {
          const ext = classifyExt(entry.path)
          return (
            <button
              key={`${entry.status}:${entry.path}`}
              type="button"
              className={styles.row}
              onClick={() => onReview?.(entry.path, entry.status)}
              title={entry.path}
            >
              <span className={clsx(styles.statusBadge, styles[`statusBadge--${entry.status}`])}>
                {STATUS_SHORT[entry.status]}
              </span>
              <span className={clsx(styles.extBadge, styles[`extBadge--${ext.kind}`])}>
                {ext.label}
              </span>
              <span className={styles.name}>{entry.path}</span>
              <span className={clsx(styles.statusLabel, styles[`statusLabel--${entry.status}`])}>
                {STATUS_LABEL[entry.status]}
              </span>
            </button>
          )
        })}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          className={styles.toggle}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? '收起' : `展开其余 ${hidden} 个文件`}
        </button>
      )}
    </>
  )
}

/** 渲染本轮助手回复关联的工作区文件净变更列表 */
const TurnFileChangesCard: React.FC<TurnFileChangesCardProps> = ({ changes, onReview }) => {
  const visible = changes.filter((entry) => entry.confidence !== 'unattributed')
  if (visible.length === 0) return null
  const first = visible[0]

  return (
    <div className={styles.card} data-testid="turn-file-changes-card">
      <div className={styles.header}>
        <span className={styles.headerTitle}>{visible.length} 个文件变更</span>
        {onReview && first && (
          <button
            type="button"
            className={styles.review}
            onClick={() => onReview(first.path, first.status)}
          >
            查看
          </button>
        )}
      </div>
      <ChangeList changes={visible} onReview={onReview} />
    </div>
  )
}

export { TurnFileChangesCard }
