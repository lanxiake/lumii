import React from 'react'
import { Button } from '../../../components/ui/Button/Button'
import type { WikiInboxItem } from '../../../hooks/business/useWikiPage'
import { inboxStatusLabel } from './wikiStatusLabels'

interface WikiInboxPanelProps {
  readonly items: readonly WikiInboxItem[]
  readonly onRetry: (inboxId: string) => void
  readonly onDiscard: (inboxId: string) => void
}

const INBOX_TYPE_LABELS: Record<string, string> = {
  file: '文件',
  upload: '上传',
  task: '任务产物',
  search: '网页资料',
}

/**
 * 判断待整理条目是否允许用户重新处理。
 */
function canRetryInboxItem(status: string): boolean {
  return status === 'pending' || status === 'failed'
}

/**
 * 渲染待整理条目、中文状态及失败后的行内操作。
 */
export const WikiInboxPanel: React.FC<WikiInboxPanelProps> = ({
  items,
  onRetry,
  onDiscard,
}) => {
  if (items.length === 0) {
    return (
      <p className="wiki-empty-hint">
        暂无待整理条目。上传文件、任务产物或网页搜索结果会自动出现在这里。
      </p>
    )
  }

  return (
    <div className="wiki-inbox-list">
      {items.map((item) => (
        <article key={item.id} className="wiki-inbox-item">
          <div className="wiki-inbox-item-header">
            <span className="wiki-inbox-item-type">{INBOX_TYPE_LABELS[item.itemType] ?? item.itemType}</span>
            <span className="wiki-inbox-item-title">{item.title}</span>
            <span className={`wiki-inbox-item-status wiki-inbox-item-status--${item.status}`}>
              {inboxStatusLabel(item.status)}
            </span>
          </div>
          {item.contentPreview ? <p className="wiki-inbox-item-preview">{item.contentPreview}</p> : null}
          {item.lastError ? (
            <p className="wiki-inbox-item-error">
              失败原因: {item.lastError}（已重试 {item.attemptCount} 次）
            </p>
          ) : null}
          {canRetryInboxItem(item.status) ? (
            <div className="wiki-inbox-item-actions">
              <Button variant="ghost" size="sm" onClick={() => onRetry(item.id)}>重试</Button>
              <Button variant="ghost" size="sm" onClick={() => onDiscard(item.id)}>丢弃</Button>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  )
}

export default WikiInboxPanel
