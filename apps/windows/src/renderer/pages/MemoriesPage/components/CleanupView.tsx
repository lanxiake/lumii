/**
 * CleanupView — 清理建议扫描 + 筛选/全选/一键归档 + 批量归档/恢复/删除 + 页面状态候选
 *
 * 设计：docs/plans/记忆重构/2026-08-26-wiki-p1-implementation.md Task 8 §10.2
 *       docs/plans/记忆重构/2026-08-26-wiki-p2-implementation.md Task 4/5
 * 扫描只读不执行，勾选后由用户确认才触发批量操作。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '../../../components/ui/Button/Button'
import { ConfirmModal } from '../../../components/ui/Modal'
import type { WikiCleanupSuggestionItem, WikiStatusCandidateItem } from '../../../hooks/business/useWikiPage'
import { filterCleanupSuggestions, type CleanupReasonFilter } from './cleanupSelection'

const REASON_LABEL: Record<WikiCleanupSuggestionItem['reason'], string> = {
  stale: '长期未用',
  broken_source: '来源失效',
  duplicate_content: '内容重复',
}

const FILTER_CHIPS: readonly { key: CleanupReasonFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'stale', label: '长期未用' },
  { key: 'broken_source', label: '来源失效' },
  { key: 'duplicate_content', label: '内容重复' },
]

const STATUS_REASON_LABEL: Record<string, string> = {
  broken_source: '来源失效 → outdated',
  stale: '长期未用 → archived',
  doubtful_phrase: '否定表述 → doubtful',
}

/**
 * 用两列拼展示用的 `大类 / 小类`；两列都空说明还没归类，显示「待补分」。
 * 临时存放没有小类，只显示大类名。
 */
function cleanupTopicLabel(item: WikiCleanupSuggestionItem): string {
  if (!item.topicCategory) return '待补分'
  return item.topicSubtopic ? `${item.topicCategory} / ${item.topicSubtopic}` : item.topicCategory
}

interface CleanupViewProps {
  readonly cleanupScan: (staleDays?: number) => Promise<readonly WikiCleanupSuggestionItem[]>
  readonly archiveSources: (sourceIds: readonly string[]) => Promise<number>
  readonly restoreSources: (sourceIds: readonly string[]) => Promise<number>
  readonly deleteSources: (sourceIds: readonly string[]) => Promise<number>
  readonly statusScan?: (staleDays?: number) => Promise<readonly WikiStatusCandidateItem[]>
  readonly confirmStatus?: (
    pageId: string,
    action: 'confirm' | 'reject',
    status?: 'outdated' | 'doubtful' | 'archived',
  ) => Promise<boolean>
}

/** 清理与页面状态候选视图 */
export const CleanupView: React.FC<CleanupViewProps> = ({
  cleanupScan,
  archiveSources,
  restoreSources,
  deleteSources,
  statusScan,
  confirmStatus,
}) => {
  const [suggestions, setSuggestions] = useState<readonly WikiCleanupSuggestionItem[]>([])
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [reasonFilter, setReasonFilter] = useState<CleanupReasonFilter>('all')
  const [confirmArchiveAll, setConfirmArchiveAll] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [statusCandidates, setStatusCandidates] = useState<readonly WikiStatusCandidateItem[]>([])

  const visible = filterCleanupSuggestions(suggestions, reasonFilter)
  const allVisibleSelected =
    visible.length > 0 && visible.every((s) => selected.has(s.sourceId))

  const runScan = useCallback(async () => {
    setScanning(true)
    try {
      setSuggestions(await cleanupScan())
      setSelected(new Set())
      if (statusScan) {
        setStatusCandidates(await statusScan())
      }
    } finally {
      setScanning(false)
    }
  }, [cleanupScan, statusScan])

  useEffect(() => {
    void runScan()
  }, [runScan])

  /** 筛选变更时清空勾选，避免半选歧义 */
  useEffect(() => {
    setSelected(new Set())
  }, [reasonFilter])

  const toggleSelected = (sourceId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sourceId)) next.delete(sourceId)
      else next.add(sourceId)
      return next
    })
  }

  /** 全选/取消全选当前可见列表 */
  const handleToggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(visible.map((s) => s.sourceId)))
    }
  }

  const handleBatchArchive = async () => {
    await archiveSources([...selected])
    void runScan()
  }

  const handleBatchRestore = async () => {
    await restoreSources([...selected])
    void runScan()
  }

  /** 确认一键归档全部建议（不受当前筛选影响） */
  const handleConfirmArchiveAll = async () => {
    setConfirmArchiveAll(false)
    await archiveSources(suggestions.map((s) => s.sourceId))
    void runScan()
  }

  /** 确认批量永久删除已选项 */
  const handleConfirmDelete = async () => {
    setConfirmDelete(false)
    await deleteSources([...selected])
    void runScan()
  }

  const handleConfirmStatus = async (c: WikiStatusCandidateItem) => {
    if (!confirmStatus) return
    await confirmStatus(c.pageId, 'confirm', c.suggestedStatus as 'outdated' | 'doubtful' | 'archived')
    void runScan()
  }

  const handleRejectStatus = async (c: WikiStatusCandidateItem) => {
    if (!confirmStatus) return
    await confirmStatus(c.pageId, 'reject')
    void runScan()
  }

  return (
    <div className="wiki-cleanup-view">
      <div className="wiki-cleanup-header">
        <h3>清理建议（{suggestions.length}）</h3>
        <Button variant="ghost" size="sm" onClick={() => void runScan()} disabled={scanning}>
          <RefreshCw size={12} style={{ marginRight: 4 }} />
          重新扫描
        </Button>
      </div>

      {suggestions.length === 0 ? (
        <p className="wiki-empty-hint">
          {scanning ? '扫描中...' : '暂无清理建议。长期未用、来源失效、内容重复的资料会出现在这里。'}
        </p>
      ) : (
        <>
          <div className="wiki-cleanup-filters" role="group" aria-label="按原因筛选">
            {FILTER_CHIPS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className={`wiki-cleanup-filter-chip${reasonFilter === key ? ' wiki-cleanup-filter-chip--active' : ''}`}
                onClick={() => setReasonFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="wiki-cleanup-toolbar">
            <Button variant="ghost" size="sm" onClick={handleToggleSelectAllVisible}>
              {allVisibleSelected ? '取消全选' : '全选当前'}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setConfirmArchiveAll(true)}>
              一键归档全部建议
            </Button>
          </div>

          <div className="wiki-cleanup-actions">
            <Button variant="secondary" size="sm" onClick={() => void handleBatchArchive()} disabled={selected.size === 0}>
              批量归档（{selected.size}）
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void handleBatchRestore()} disabled={selected.size === 0}>
              批量恢复
            </Button>
            <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)} disabled={selected.size === 0}>
              批量删除
            </Button>
          </div>

          {visible.map((s) => (
            <label key={s.sourceId} className="wiki-cleanup-item">
              <input
                type="checkbox"
                checked={selected.has(s.sourceId)}
                onChange={() => toggleSelected(s.sourceId)}
              />
              <span className="wiki-cleanup-item-title">{s.title}</span>
              <span className="wiki-cleanup-item-topic">{cleanupTopicLabel(s)}</span>
              <span className={`wiki-cleanup-item-reason wiki-cleanup-item-reason--${s.reason}`}>
                {REASON_LABEL[s.reason]}
              </span>
            </label>
          ))}
        </>
      )}

      {statusScan && (
        <div className="wiki-status-candidates">
          <h3>页面状态候选（{statusCandidates.length}）</h3>
          <p className="wiki-empty-hint">规则层检测，确认后才更新页面 status；不做语义漂移检测。</p>
          {statusCandidates.length === 0 ? (
            <p className="wiki-empty-hint">{scanning ? '扫描中...' : '暂无状态候选'}</p>
          ) : (
            statusCandidates.map((c) => (
              <div key={c.pageId} className="wiki-cleanup-item">
                <span className="wiki-cleanup-item-title">{c.title}</span>
                <span className="wiki-cleanup-item-reason">
                  {STATUS_REASON_LABEL[c.reason] ?? `${c.reason} → ${c.suggestedStatus}`}
                </span>
                <Button variant="primary" size="sm" onClick={() => void handleConfirmStatus(c)}>确认</Button>
                <Button variant="ghost" size="sm" onClick={() => void handleRejectStatus(c)}>拒绝</Button>
              </div>
            ))
          )}
        </div>
      )}

      <ConfirmModal
        open={confirmArchiveAll}
        title="一键归档全部建议"
        content={`将归档 ${suggestions.length} 条清理建议，确定？`}
        confirmText="确认"
        onConfirm={() => void handleConfirmArchiveAll()}
        onCancel={() => setConfirmArchiveAll(false)}
      />

      <ConfirmModal
        open={confirmDelete}
        title="批量删除"
        content={`将永久删除已选 ${selected.size} 条，不可恢复`}
        confirmText="确认"
        confirmVariant="danger"
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  )
}

export default CleanupView
