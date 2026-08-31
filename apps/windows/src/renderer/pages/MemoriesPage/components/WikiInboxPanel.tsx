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
  /** 已进资料层但主题为空的条目，与队列条目混排在同一收件箱列表 */
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
  readonly onBatchDelete: () => void
  readonly onDeleteUnfiled: (sourceId: string) => void
  readonly onRetryAll: () => void
}

const INBOX_TYPE_LABELS: Record<string, string> = {
  file: '文件',
  upload: '上传',
  task: '任务产物',
  search: '网页资料',
}

type InboxListRow =
  | { readonly kind: 'queue'; readonly item: WikiInboxItem; readonly sortAt: number }
  | { readonly kind: 'unfiled'; readonly item: WikiSourceListItem; readonly sortAt: number }

/**
 * 判断收件箱队列条目是否允许用户重新处理。
 */
function canRetryInboxItem(status: string): boolean {
  return status === 'pending' || status === 'failed'
}

/**
 * 将收件箱队列条目转为预览快照（网页资料用标题 + 摘要 + 原文链接）。
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
 * 按时间倒序合并队列条目与未分类资料，避免用户看到两套概念。
 */
function mergeInboxRows(
  items: readonly WikiInboxItem[],
  unfiled: readonly WikiSourceListItem[],
): readonly InboxListRow[] {
  const rows: InboxListRow[] = [
    ...items.map((item) => ({ kind: 'queue' as const, item, sortAt: item.createdAt })),
    ...unfiled.map((item) => ({ kind: 'unfiled' as const, item, sortAt: item.updatedAt })),
  ]
  return rows.sort((a, b) => b.sortAt - a.sortAt)
}

/**
 * 渲染收件箱列表，支持多选与批量操作工具栏。
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
  onBatchDelete,
  onDeleteUnfiled,
  onRetryAll,
}) => {
  const retryableItems = useMemo(
    () => items.filter((item) => canRetryInboxItem(item.status)),
    [items],
  )

  const rows = useMemo(() => mergeInboxRows(items, unfiled), [items, unfiled])

  const totalSelectable = items.length + unfiled.length
  const totalSelected = selectedInboxIds.size + selectedUnfiledIds.size
  const allSelected = totalSelectable > 0 && totalSelected === totalSelectable

  /** 当前选中是否包含可重试的队列条目 */
  const hasSelectedRetryable = useMemo(
    () => items.some((item) => selectedInboxIds.has(item.id) && canRetryInboxItem(item.status)),
    [items, selectedInboxIds],
  )

  if (totalSelectable === 0) {
    return (
      <p className="wiki-empty-hint">
        暂无收件箱条目。上传文件、任务产物或网页搜索结果会自动出现在这里。
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
            aria-label="全选收件箱条目"
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
            <Tooltip
              content="永久删除所选内容：队列条目会被丢弃，已入库资料会从资料库移除"
              placement="bottom"
            >
              <Button variant="ghost" size="sm" onClick={onBatchDelete}>
                批量删除
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
        {rows.map((row) =>
          row.kind === 'queue' ? (
            <article key={`queue-${row.item.id}`} className="wiki-inbox-item">
              <div className="wiki-inbox-item-row">
                <input
                  type="checkbox"
                  className="wiki-inbox-checkbox"
                  checked={selectedInboxIds.has(row.item.id)}
                  onChange={() => onToggleInboxSelect(row.item.id)}
                  aria-label={`选择 ${row.item.title}`}
                />
                <div className="wiki-inbox-item-main">
                  <div className="wiki-inbox-item-header">
                    <span className="wiki-inbox-item-type">
                      {INBOX_TYPE_LABELS[row.item.itemType] ?? row.item.itemType}
                    </span>
                    <button
                      type="button"
                      className="wiki-inbox-item-title wiki-inbox-item-title--link"
                      onClick={() => onPreviewInbox(row.item)}
                    >
                      {row.item.title}
                    </button>
                    <span className={`wiki-inbox-item-status wiki-inbox-item-status--${row.item.status}`}>
                      {inboxStatusLabel(row.item.status)}
                    </span>
                  </div>
                  {row.item.contentPreview ? (
                    <p className="wiki-inbox-item-preview">{row.item.contentPreview}</p>
                  ) : null}
                  {row.item.lastError ? (
                    row.item.lastOutcome === 'degraded' ? (
                      <p className="wiki-inbox-item-hint">待人工归档: {row.item.lastError}</p>
                    ) : (
                      <p className="wiki-inbox-item-error">
                        失败原因: {row.item.lastError}（已重试 {row.item.attemptCount} 次）
                      </p>
                    )
                  ) : null}
                  <div className="wiki-inbox-item-actions">
                    <Button variant="ghost" size="sm" onClick={() => onPreviewInbox(row.item)}>
                      <Eye size={13} />
                      详情
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onOrganize(row.item)}>
                      归档到…
                    </Button>
                    {canRetryInboxItem(row.item.status) ? (
                      <Button variant="ghost" size="sm" onClick={() => onRetry(row.item.id)}>
                        重试
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="sm" onClick={() => onDiscard(row.item.id)}>
                      删除
                    </Button>
                  </div>
                </div>
              </div>
            </article>
          ) : (
            <article key={`unfiled-${row.item.id}`} className="wiki-inbox-item">
              <div className="wiki-inbox-item-row">
                <input
                  type="checkbox"
                  className="wiki-inbox-checkbox"
                  checked={selectedUnfiledIds.has(row.item.id)}
                  onChange={() => onToggleUnfiledSelect(row.item.id)}
                  aria-label={`选择 ${row.item.title}`}
                />
                <div className="wiki-inbox-item-main">
                  <div className="wiki-inbox-item-header">
                    <button
                      type="button"
                      className="wiki-inbox-item-title wiki-inbox-item-title--link"
                      onClick={() => onPreviewSource(row.item)}
                    >
                      {row.item.title}
                    </button>
                    <span className="wiki-inbox-item-status">{formatRelativeTime(row.item.updatedAt)}</span>
                  </div>
                  <div className="wiki-inbox-item-actions">
                    <Button variant="ghost" size="sm" onClick={() => onPreviewSource(row.item)}>
                      <Eye size={13} />
                      详情
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onFileUnfiled(row.item)}>
                      归档到…
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onDeleteUnfiled(row.item.id)}>
                      删除
                    </Button>
                  </div>
                </div>
              </div>
            </article>
          ),
        )}
      </div>
    </>
  )
}

export default WikiInboxPanel
