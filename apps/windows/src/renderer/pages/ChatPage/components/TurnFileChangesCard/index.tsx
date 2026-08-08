/**
 * TurnFileChangesCard — 回合文件变更摘要（Task 7 最小 stub，Task 8 完善样式）
 */

import React from 'react'
import type { FileChangeEntry } from '@mtbot/agent-runtime'

const STATUS_LABEL: Record<FileChangeEntry['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
}

export interface TurnFileChangesCardProps {
  changes: readonly FileChangeEntry[]
  onReview?: () => void
}

/** 渲染本轮助手回复关联的工作区文件变更列表 */
const TurnFileChangesCard: React.FC<TurnFileChangesCardProps> = ({ changes, onReview }) => {
  if (changes.length === 0) return null

  return (
    <div data-testid="turn-file-changes-card">
      <div>{changes.length} 个文件变更</div>
      <ul>
        {changes.map((entry) => (
          <li key={`${entry.status}:${entry.path}`}>
            <span>{entry.path}</span>
            <span>{STATUS_LABEL[entry.status]}</span>
          </li>
        ))}
      </ul>
      {onReview && (
        <button type="button" onClick={onReview}>
          查看变更
        </button>
      )}
    </div>
  )
}

export default TurnFileChangesCard
export { TurnFileChangesCard }
