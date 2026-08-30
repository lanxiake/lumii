import React, { useMemo } from 'react'
import { Eye } from 'lucide-react'
import { Button } from '../../../components/ui/Button/Button'
import { Tooltip } from '../../../components/ui/Tooltip/Tooltip'
import type { WikiInboxItem, WikiSourceListItem } from '../../../hooks/business/useWikiPage'
import { inboxStatusLabel, formatRelativeTime } from './wikiStatusLabels'
import { isHttpUrl } from './wikiSourcePreview'
import type { WikiSourcePreviewSnapshot } from './WikiSourceDetailDrawer'

interface WikiInboxPanelProps {
  readonly items: readonly WikiInboxItem[]
  /** 已进资料层但主题为空的条目，需要用户补分类 */
  readonly unfiled: readonly WikiSourceListItem[]
  readonly selectedInboxIds: ReadonlySet<string>
  readonly selectedUnfiledIds: ReadonlySet<string>
  readonly onToggleInboxSelect: (inboxId: string) => void
  readonly onToggleUnfiledSelect: (sourceId: string) => void
  readonly onToggleSelectAll: () => void
  readonly onRetry: (inboxId: string) => void
  readonly onDiscard: (inboxId: string) => void
  readonly onOrganize: (item: WikiInboxItem) => void
  readonly onFileUnfiled: (item: WikiSourceListItem) => void
  readonly onPreviewInbox: (item: WikiInboxItem) => void
  readonly onPreviewSource: (item: WikiSourceListItem) => void
  readonly onBatchOrganize: () => void
  readonly onBatchRetry: () => void
  readonly onBatchDiscard: () => void
  readonly onRetryAll: () => void
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
 * 渲染待整理条目，支持多选与批量操作工具栏。
 */
export const WikiInboxPanel: React.FC<WikiInboxPanelProps> = ({
  items,
  unfiled,
  selectedInboxIds,
  selectedUnfiledIds,
  onToggleInboxSelect,
  onToggleUnfiledSelect,
  onToggleSelectAll,
  onRetry,
  onDiscard,
  onOrganize,
  onFileUnfiled,
  onPreviewInbox,
  onPreviewSource,
  onBatchOrganize,
  onBatchRetry,
  onBatchDiscard,
  onRetryAll,
}) => {
  const retryableItems = useMemo(
    () => items.filter((item) => canRetryInboxItem(item.status)),
    [items],
  )

  const totalSelectable = items.length + unfiled.length
  const totalSelected = selectedInboxIds.size + selectedUnfiledIds.size
  const allSelected = totalSelectable > 0 && totalSelected === totalSelectable

  /** 当前选中是否包含可重试的 inbox 条目 */
  const hasSelectedRetryable = useMemo(
    () => items.some((item) => selectedInboxIds.has(item.id) && canRetryInboxItem(item.status)),
    [items, selectedInboxIds],
  )

  if (items.length === 0 && unfiled.length === 0) {
    return (
      <p className="wiki-empty-hint">
        暂无待整理条目。上传文件、任务产物或网页搜索结果会自动出现在这里。
      </p>
    )
  }

  return (
    <>
      <div className="wiki-inbox-toolbar">
        <label className="wiki-inbox-select-all">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={onToggleSelectAll}
            aria-label="全选待整理条目"
          />
          <span>全选</span>
        </label>
        {totalSelected > 0 ? (
          <>
            <span className="wiki-inbox-batch-count">已选 {totalSelected} 项</span>
            <Tooltip content="将所选条目一次性归档到同一分类目录" placement="bottom">
              <Button variant="primary" size="sm" onClick={onBatchOrganize}>
                批量归档到…
              </Button>
            </Tooltip>
            {hasSelectedRetryable && (
              <Tooltip content="重新触发后台处理（抽取正文、尝试自动归档）" placement="bottom">
                <Button variant="ghost" size="sm" onClick={onBatchRetry}>
                  批量重试
                </Button>
              </Tooltip>
            )}
            <Tooltip content="永久丢弃所选队列条目（不可恢复）" placement="bottom">
              <Button variant="ghost" size="sm" onClick={onBatchDiscard}>
                批量丢弃
              </Button>
            </Tooltip>
          </>
        ) : retryableItems.length > 0 ? (
          <Tooltip content="对全部待处理/失败条目重新触发后台处理" placement="bottom">
            <Button variant="secondary" size="sm" onClick={onRetryAll}>
              全部重试（{retryableItems.length}）
            </Button>
          </Tooltip>
        ) : null}
      </div>

      <div className="wiki-inbox-list">
        {items.map((item) => (
          <article key={item.id} className="wiki-inbox-item">
            <div className="wiki-inbox-item-row">
              <input
                type="checkbox"
                className="wiki-inbox-checkbox"
                checked={selectedInboxIds.has(item.id)}
                onChange={() => onToggleInboxSelect(item.id)}
                aria-label={`选择 ${item.title}`}
              />
              <div className="wiki-inbox-item-main">
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
              </div>
            </div>
          </article>
        ))}
      </div>

      {unfiled.length > 0 && (
        <section className="wiki-inbox-unfiled">
          <h4 className="wiki-section-heading">
            待补分（{unfiled.length}）
            <Tooltip
              content="这些文件已入库但尚未指定分类。可勾选后与队列条目一起批量归档。"
              placement="right"
            >
              <span className="wiki-section-heading-hint" aria-hidden>?</span>
            </Tooltip>
          </h4>
          <div className="wiki-inbox-list">
            {unfiled.map((item) => (
              <article key={item.id} className="wiki-inbox-item">
                <div className="wiki-inbox-item-row">
                  <input
                    type="checkbox"
                    className="wiki-inbox-checkbox"
                    checked={selectedUnfiledIds.has(item.id)}
                    onChange={() => onToggleUnfiledSelect(item.id)}
                    aria-label={`选择 ${item.title}`}
                  />
                  <div className="wiki-inbox-item-main">
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
                  </div>
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
