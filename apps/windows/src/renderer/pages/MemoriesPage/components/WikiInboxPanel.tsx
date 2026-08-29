import React from 'react'
import { Eye } from 'lucide-react'
import { Button } from '../../../components/ui/Button/Button'
import type { WikiInboxItem, WikiSourceListItem } from '../../../hooks/business/useWikiPage'
import { inboxStatusLabel, formatRelativeTime } from './wikiStatusLabels'
import { isHttpUrl } from './wikiSourcePreview'
import type { WikiSourcePreviewSnapshot } from './WikiSourceDetailDrawer'

interface WikiInboxPanelProps {
  readonly items: readonly WikiInboxItem[]
  /** 已进资料层但主题为空的条目，需要用户补分类 */
  readonly unfiled: readonly WikiSourceListItem[]
  readonly onRetry: (inboxId: string) => void
  readonly onDiscard: (inboxId: string) => void
  readonly onOrganize: (item: WikiInboxItem) => void
  readonly onFileUnfiled: (item: WikiSourceListItem) => void
  readonly onPreviewInbox: (item: WikiInboxItem) => void
  readonly onPreviewSource: (item: WikiSourceListItem) => void
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
 * 将待整理条目转为预览快照（网页资料用标题 + 摘要 + 原文链接）。
 */
export function inboxItemToPreviewSnapshot(item: WikiInboxItem): WikiSourcePreviewSnapshot {
  const sourceUrl = item.sourceUrl ?? (isHttpUrl(item.sourcePath) ? item.sourcePath : null)
  return {
    title: item.title,
    summary: item.contentPreview,
    sourceUrl,
    sourcePath: sourceUrl ? null : item.sourcePath,
    mediaType: item.mediaType,
  }
}

/**
 * 渲染待整理条目、中文状态及失败后的行内操作。
 */
export const WikiInboxPanel: React.FC<WikiInboxPanelProps> = ({
  items,
  unfiled,
  onRetry,
  onDiscard,
  onOrganize,
  onFileUnfiled,
  onPreviewInbox,
  onPreviewSource,
}) => {
  if (items.length === 0 && unfiled.length === 0) {
    return (
      <p className="wiki-empty-hint">
        暂无待整理条目。上传文件、任务产物或网页搜索结果会自动出现在这里。
      </p>
    )
  }

  return (
    <>
    <div className="wiki-inbox-list">
      {items.map((item) => (
        <article key={item.id} className="wiki-inbox-item">
          <div className="wiki-inbox-item-header">
            <span className="wiki-inbox-item-type">{INBOX_TYPE_LABELS[item.itemType] ?? item.itemType}</span>
            <button
              type="button"
              className="wiki-inbox-item-title wiki-inbox-item-title--link"
              onClick={() => onPreviewInbox(item)}
            >
              {item.title}
            </button>
            <span className={`wiki-inbox-item-status wiki-inbox-item-status--${item.status}`}>
              {inboxStatusLabel(item.status)}
            </span>
          </div>
          {item.contentPreview ? <p className="wiki-inbox-item-preview">{item.contentPreview}</p> : null}
          {item.lastError ? (
            item.lastOutcome === 'degraded' ? (
              // AI 拿不准就留待人工，这不是失败，别按失败报（一期约定：拿不准 skip，条目留待整理）
              <p className="wiki-inbox-item-hint">待人工归档: {item.lastError}</p>
            ) : (
              <p className="wiki-inbox-item-error">
                失败原因: {item.lastError}（已重试 {item.attemptCount} 次）
              </p>
            )
          ) : null}
          {canRetryInboxItem(item.status) ? (
            <div className="wiki-inbox-item-actions">
              <Button variant="ghost" size="sm" onClick={() => onPreviewInbox(item)}>
                <Eye size={13} />
                详情
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onOrganize(item)}>归档到…</Button>
              <Button variant="ghost" size="sm" onClick={() => onRetry(item.id)}>重试</Button>
              <Button variant="ghost" size="sm" onClick={() => onDiscard(item.id)}>丢弃</Button>
            </div>
          ) : null}
        </article>
      ))}
    </div>

    {unfiled.length > 0 && (
      <section className="wiki-inbox-unfiled">
        <h4 className="wiki-section-heading">待补分（{unfiled.length}）</h4>
        <div className="wiki-inbox-list">
          {unfiled.map((item) => (
            <article key={item.id} className="wiki-inbox-item">
              <div className="wiki-inbox-item-header">
                <button
                  type="button"
                  className="wiki-inbox-item-title wiki-inbox-item-title--link"
                  onClick={() => onPreviewSource(item)}
                >
                  {item.title}
                </button>
                <span className="wiki-inbox-item-status">{formatRelativeTime(item.updatedAt)}</span>
              </div>
              <div className="wiki-inbox-item-actions">
                <Button variant="ghost" size="sm" onClick={() => onPreviewSource(item)}>
                  <Eye size={13} />
                  详情
                </Button>
                <Button variant="ghost" size="sm" onClick={() => onFileUnfiled(item)}>归档到…</Button>
              </div>
            </article>
          ))}
        </div>
      </section>
    )}
    </>
  )
}

export default WikiInboxPanel
