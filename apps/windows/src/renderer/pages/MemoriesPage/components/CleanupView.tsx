/**
 * CleanupView — 清理建议扫描 + 批量归档/恢复/删除
 *
 * 设计：docs/plans/记忆重构/2026-08-26-wiki-p1-implementation.md Task 8 §10.2
 * 扫描只读不执行，勾选后由用户确认才触发批量操作。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '../../../components/ui/Button/Button'
import type { WikiCleanupSuggestionItem } from '../../../hooks/business/useWikiPage'

const REASON_LABEL: Record<WikiCleanupSuggestionItem['reason'], string> = {
  stale: '长期未用',
  broken_source: '来源失效',
  duplicate_content: '内容重复',
}

interface CleanupViewProps {
  readonly cleanupScan: (staleDays?: number) => Promise<readonly WikiCleanupSuggestionItem[]>
  readonly archiveSources: (sourceIds: readonly string[]) => Promise<number>
  readonly restoreSources: (sourceIds: readonly string[]) => Promise<number>
  readonly deleteSources: (sourceIds: readonly string[]) => Promise<number>
}

export const CleanupView: React.FC<CleanupViewProps> = ({
  cleanupScan,
  archiveSources,
  restoreSources,
  deleteSources,
}) => {
  const [suggestions, setSuggestions] = useState<readonly WikiCleanupSuggestionItem[]>([])
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [scanning, setScanning] = useState(false)

  const runScan = useCallback(async () => {
    setScanning(true)
    try {
      setSuggestions(await cleanupScan())
      setSelected(new Set())
    } finally {
      setScanning(false)
    }
  }, [cleanupScan])

  useEffect(() => {
    void runScan()
  }, [runScan])

  const toggleSelected = (sourceId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sourceId)) next.delete(sourceId)
      else next.add(sourceId)
      return next
    })
  }

  const handleBatchArchive = async () => {
    await archiveSources([...selected])
    void runScan()
  }

  const handleBatchRestore = async () => {
    await restoreSources([...selected])
    void runScan()
  }

  const handleBatchDelete = async () => {
    await deleteSources([...selected])
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
          <div className="wiki-cleanup-actions">
            <Button variant="secondary" size="sm" onClick={() => void handleBatchArchive()} disabled={selected.size === 0}>
              批量归档（{selected.size}）
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void handleBatchRestore()} disabled={selected.size === 0}>
              批量恢复
            </Button>
            <Button variant="danger" size="sm" onClick={() => void handleBatchDelete()} disabled={selected.size === 0}>
              批量删除
            </Button>
          </div>

          {suggestions.map((s) => (
            <label key={s.sourceId} className="wiki-cleanup-item">
              <input
                type="checkbox"
                checked={selected.has(s.sourceId)}
                onChange={() => toggleSelected(s.sourceId)}
              />
              <span className="wiki-cleanup-item-title">{s.title}</span>
              <span className={`wiki-cleanup-item-reason wiki-cleanup-item-reason--${s.reason}`}>
                {REASON_LABEL[s.reason]}
              </span>
            </label>
          ))}
        </>
      )}
    </div>
  )
}

export default CleanupView
