import React, { useMemo, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { Button } from '../../../components/ui/Button/Button'
import type { WikiReclassifyRunItem } from '../../../hooks/business/useWikiPage'
import { formatTopicDisplay } from './wikiTopicDisplay'

interface WikiReclassifyViewProps {
  run: WikiReclassifyRunItem | null
  onApply: (candidateIds: readonly string[]) => void
  onIgnore: (candidateId: string) => void
  onDiscard: () => void
}

/**
 * 重新编目候选审阅主区。
 *
 * 候选是「建议」不是「已改」：只有点接受才写主题两列。
 * 接受失败（目标小类被删）的条目留在列表里带红字，不静默消失。
 * 进度与结果都在主区展示，不用右下角 toast（设计 §9.4）。
 */
export const WikiReclassifyView: React.FC<WikiReclassifyViewProps> = ({
  run,
  onApply,
  onIgnore,
  onDiscard,
}) => {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

  const allIds = useMemo(() => (run?.candidates ?? []).map((c) => c.id), [run])

  if (!run) {
    return <p className="wiki-reclassify-empty">还没有重新编目记录。从「更多 → 全库重新编目」开始。</p>
  }

  if (run.status === 'running') {
    return (
      <div className="wiki-reclassify">
        <p className="wiki-reclassify-progress">
          正在重新编目 {run.processed} / {run.total}
        </p>
        <p className="wiki-reclassify-hint">
          期间新上传的文件会留在收件箱，不会丢；编目结束后自动归档恢复。
        </p>
      </div>
    )
  }

  if (run.status === 'failed') {
    return (
      <div className="wiki-reclassify">
        <p className="wiki-reclassify-error" role="alert">
          重新编目失败：{run.error ?? '未知原因'}
        </p>
        <Button variant="ghost" size="sm" onClick={onDiscard}>
          清除本次批次
        </Button>
      </div>
    )
  }

  if (run.candidates.length === 0) {
    return (
      <div className="wiki-reclassify">
        <p className="wiki-reclassify-empty">
          已检查 {run.total} 个文件，当前目录都合适，无需调整。
        </p>
        <Button variant="ghost" size="sm" onClick={onDiscard}>
          知道了
        </Button>
      </div>
    )
  }

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="wiki-reclassify">
      <header className="wiki-reclassify-header">
        <span className="wiki-reclassify-count">
          {run.candidates.length} 条建议
          {run.unchanged > 0 && `（另有 ${run.unchanged} 个文件无需调整）`}
        </span>
        <div className="wiki-reclassify-actions">
          <Button
            variant="primary"
            size="sm"
            disabled={selected.size === 0}
            onClick={() => onApply([...selected])}
          >
            接受已选
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onApply(allIds)}>
            全部接受
          </Button>
          <Button variant="ghost" size="sm" onClick={onDiscard}>
            全部忽略
          </Button>
        </div>
      </header>

      <ul className="wiki-reclassify-list">
        {run.candidates.map((c) => (
          <li key={c.id} className="wiki-reclassify-item">
            <input
              type="checkbox"
              aria-label={`选择 ${c.title}`}
              checked={selected.has(c.id)}
              onChange={() => toggle(c.id)}
            />
            <div className="wiki-reclassify-body">
              <p className="wiki-reclassify-title">{c.title}</p>
              <p className="wiki-reclassify-move">
                <span>{formatTopicDisplay(c.fromCategory, c.fromSubtopic)}</span>
                <ArrowRight size={13} />
                <span className="wiki-reclassify-target">
                  {formatTopicDisplay(c.toCategory, c.toSubtopic)}
                </span>
              </p>
              {c.reason && <p className="wiki-reclassify-reason">{c.reason}</p>}
              {c.applyError && (
                <p className="wiki-reclassify-error" role="alert">
                  {c.applyError}
                </p>
              )}
            </div>
            <div className="wiki-reclassify-item-actions">
              <Button variant="ghost" size="sm" onClick={() => onApply([c.id])}>
                接受
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onIgnore(c.id)}>
                忽略
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default WikiReclassifyView
