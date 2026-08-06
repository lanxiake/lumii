/**
 * ChangedFilesRail — 版本面板右侧变更文件导航栏
 *
 * 展示文件级列表（路径 + ±统计），点击后由父组件滚动到对应 Diff 卡片。
 */

import React from 'react'
import clsx from 'clsx'
import type { VcsDiffItem } from '../../../../hooks/business/useWorkspaceVcs'
import styles from './ChangedFilesRail.module.css'

export interface ChangedFilesRailProps {
  files: VcsDiffItem[]
  activePath?: string
  onSelect: (filepath: string) => void
}

/** 状态短标签 */
function statusLabel(status: VcsDiffItem['status']): string {
  if (status === 'added') return 'A'
  if (status === 'deleted') return 'D'
  return 'M'
}

/**
 * 右侧变更文件列表（纯展示）
 */
export const ChangedFilesRail: React.FC<ChangedFilesRailProps> = ({
  files,
  activePath,
  onSelect,
}) => {
  return (
    <aside className={styles.rail} aria-label="变更文件列表">
      <div className={styles.header}>
        <span className={styles.headerLabel}>{files.length} 个文件</span>
      </div>
      <ul className={styles.list}>
        {files.map((f) => {
          const name = f.filepath.includes('/')
            ? f.filepath.slice(f.filepath.lastIndexOf('/') + 1)
            : f.filepath
          return (
            <li key={f.filepath}>
              <button
                type="button"
                className={clsx(
                  styles.item,
                  activePath === f.filepath && styles.itemActive,
                )}
                onClick={() => onSelect(f.filepath)}
                title={f.filepath}
              >
                <span
                  className={clsx(styles.status, styles[`status_${f.status}`])}
                >
                  {statusLabel(f.status)}
                </span>
                <span className={styles.name}>{name}</span>
                <span className={styles.stats}>
                  <span className={styles.ins}>+{f.insertions}</span>
                  <span className={styles.del}>−{f.deletions}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
