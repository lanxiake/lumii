/**
 * SynthesisView — 综述合成：多选发起 → 审阅候选 → 接受/拒绝
 *
 * 设计：docs/plans/记忆重构/2026-08-26-wiki-p2-implementation.md Task 5
 * 引用保真依赖来源清单与人工抽查；接受后建 syntheses/ 页。
 */
import React, { useCallback, useEffect, useState } from 'react'
import MDEditor from '@uiw/react-md-editor'
import { Button } from '../../../components/ui/Button/Button'
import type {
  WikiPageListItem,
  WikiSynthesisDetail,
  WikiSynthesisListItem,
} from '../../../hooks/business/useWikiPage'

interface SynthesisViewProps {
  readonly pages: readonly WikiPageListItem[]
  readonly createSynthesis: (params: {
    pageIds?: readonly string[]
    category?: string
    title?: string
  }) => Promise<string | null>
  readonly listSyntheses: (status?: 'candidate' | 'accepted' | 'rejected') => Promise<readonly WikiSynthesisListItem[]>
  readonly getSynthesis: (id: string) => Promise<WikiSynthesisDetail | null>
  readonly acceptSynthesis: (id: string) => Promise<string | null>
  readonly rejectSynthesis: (id: string) => Promise<boolean>
  readonly onOpenPage: (pageId: string) => void
}

export const SynthesisView: React.FC<SynthesisViewProps> = ({
  pages,
  createSynthesis,
  listSyntheses,
  getSynthesis,
  acceptSynthesis,
  rejectSynthesis,
  onOpenPage,
}) => {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [title, setTitle] = useState('')
  const [running, setRunning] = useState(false)
  const [candidates, setCandidates] = useState<readonly WikiSynthesisListItem[]>([])
  const [active, setActive] = useState<WikiSynthesisDetail | null>(null)

  const refresh = useCallback(async () => {
    setCandidates(await listSyntheses())
  }, [listSyntheses])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCreate = async () => {
    if (selected.size === 0) return
    setRunning(true)
    try {
      const id = await createSynthesis({
        pageIds: [...selected],
        title: title.trim() || undefined,
      })
      await refresh()
      if (id) {
        setActive(await getSynthesis(id))
      }
    } finally {
      setRunning(false)
    }
  }

  const handleOpenCandidate = async (id: string) => {
    setActive(await getSynthesis(id))
  }

  const handleAccept = async () => {
    if (!active) return
    const pageId = await acceptSynthesis(active.id)
    await refresh()
    setActive(await getSynthesis(active.id))
    if (pageId) onOpenPage(pageId)
  }

  const handleReject = async () => {
    if (!active) return
    await rejectSynthesis(active.id)
    await refresh()
    setActive(await getSynthesis(active.id))
  }

  const estimChars = pages
    .filter((p) => selected.has(p.id))
    .reduce((sum, p) => sum + (p.title.length + 80), 0)

  return (
    <div className="wiki-synthesis-view">
      <div className="wiki-synthesis-create">
        <h3>发起综述合成</h3>
        <p className="wiki-empty-hint">
          仅用户显式触发。数字/日期需人工对照来源清单抽查（P2 不做自动引用校验）。
        </p>
        <input
          className="wiki-page-title-input"
          placeholder="综述标题（可选）"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="wiki-synthesis-page-pick">
          {pages.map((p) => (
            <label key={p.id} className="wiki-cleanup-item">
              <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
              <span className="wiki-cleanup-item-title">{p.title}</span>
              <span className="wiki-category-count">{p.category}</span>
            </label>
          ))}
        </div>
        <div className="wiki-cleanup-actions">
          <span className="wiki-empty-hint">已选 {selected.size} 页 · 估算输入约 {estimChars} 字</span>
          <Button variant="primary" size="sm" disabled={selected.size === 0 || running} onClick={() => void handleCreate()}>
            {running ? '合成中…' : '开始合成'}
          </Button>
        </div>
      </div>

      <div className="wiki-synthesis-list">
        <h3>候选与历史（{candidates.length}）</h3>
        {candidates.length === 0 ? (
          <p className="wiki-empty-hint">暂无合成记录</p>
        ) : (
          candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`wiki-cleanup-item ${active?.id === c.id ? 'wiki-category-item--active' : ''}`}
              onClick={() => void handleOpenCandidate(c.id)}
            >
              <span className="wiki-cleanup-item-title">{c.title}</span>
              <span className="wiki-cleanup-item-reason">{c.status}</span>
              {c.progress && (
                <span className="wiki-empty-hint">
                  {c.progress.chunk}/{c.progress.total}
                </span>
              )}
            </button>
          ))
        )}
      </div>

      {active && (
        <div className="wiki-synthesis-review">
          <h3>审阅：{active.title}</h3>
          {active.error === 'truncated' && (
            <p className="wiki-empty-hint">正文已超 5000 字并截断（error=truncated）</p>
          )}
          <MDEditor value={active.candidateMd} preview="preview" hideToolbar height={280} />
          <div className="wiki-synthesis-sources">
            <h4>来源清单</h4>
            {active.sourcePages.map((sp) => (
              <button key={sp.id} type="button" className="wiki-runs-entry" onClick={() => onOpenPage(sp.id)}>
                {sp.title} · {sp.path}
              </button>
            ))}
            {active.outputPath && (
              <p className="wiki-empty-hint">完整文档：{active.outputPath}</p>
            )}
          </div>
          {active.status === 'candidate' && (
            <div className="wiki-cleanup-actions">
              <Button variant="primary" size="sm" onClick={() => void handleAccept()}>接受并建页</Button>
              <Button variant="danger" size="sm" onClick={() => void handleReject()}>拒绝</Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default SynthesisView
