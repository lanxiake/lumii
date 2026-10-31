/**
 * 流水线页的数据层（IPC 拉取 + 进度事件订阅）。
 *
 * 三条约定：
 * - 通道随插件卸载一起摘掉，所以每个调用都 `try/catch` 并把失败变成 `{error}`，
 *   而不是让页面崩在渲染里（停用插件时页面本身也会一起消失，但热重载的窗口期存在）。
 * - 进度/结束事件是**增量**的：订阅后不改全量清单，只把当前 run 的进度合进 `running`，
 *   避免每步都重拉一次 list（那会在长流水线里打出几十次 IPC）。
 * - 卸载成对注销订阅（`onProgress`/`onFinished` 返回的是取消函数）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface PipelineSummary {
  id: string
  name?: string
  description?: string
  stepCount: number
  narrationCount: number
  lastRun?: { runId: string; at: number; ok: boolean }
  error?: string
}

export interface JournalLine {
  i: number
  id: string
  tool: string
  startedAt: number
  ms: number
  ok: boolean
  error?: string
  expected?: unknown
  observed?: unknown
  skipped?: 'rehearsal'
}

export interface RunMeta {
  runId: string
  specId: string
  mode: 'record' | 'rehearsal'
  specHash: string
  startedAt: number
  endedAt?: number
  status?: 'running' | 'ok' | 'failed' | 'cancelled'
  artifact?: { mp4Path?: string; burned?: boolean; dubbed?: boolean; durationMs?: number; cueCount?: number }
}

export interface StepView {
  id: string
  label?: string
  narration?: string
  tool: string
  holdMs: number
  expect?: unknown
}

export interface PipelineDetail {
  spec: { id: string; name?: string; description?: string; steps: StepView[] }
  specHash: string
  runs: RunMeta[]
  lastJournal?: JournalLine[]
}

export interface ProgressEvent {
  runId: string
  i: number
  total: number
  stepId: string
  label?: string
  status: string
}

interface PipelineBridge {
  list(): Promise<unknown[]>
  detail(id: string): Promise<unknown | null>
  run(args: { id: string; mode: 'record' | 'rehearsal'; resumeRunId?: string }): Promise<unknown>
  cancel(runId: string): Promise<{ ok: boolean }>
  openDir(args: { target: 'spec' | 'run'; id: string }): Promise<{ ok: boolean; error?: string }>
  onProgress(cb: (e: unknown) => void): () => void
  onFinished(cb: (e: unknown) => void): () => void
}

function bridge(): PipelineBridge | null {
  const api = (window as unknown as { electronAPI?: { pipeline?: PipelineBridge } }).electronAPI
  return api?.pipeline ?? null
}

export function usePipelines() {
  const [items, setItems] = useState<PipelineSummary[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<PipelineDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 正在跑的 runId → 进度 */
  const [progress, setProgress] = useState<Record<string, ProgressEvent>>({})
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId

  const refresh = useCallback(async () => {
    const api = bridge()
    if (!api) {
      setItems([])
      setError('流水线通道不可用（插件未启用）')
      return
    }
    try {
      const list = (await api.list()) as PipelineSummary[]
      setItems(list)
      setError(null)
      // 没选中 / 选中的已被删 → 落到第一条
      const cur = selectedRef.current
      if (!cur || !list.some((p) => p.id === cur)) setSelectedId(list[0]?.id ?? null)
    } catch (err) {
      setItems([])
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const loadDetail = useCallback(async (id: string) => {
    const api = bridge()
    if (!api) return
    try {
      setDetail((await api.detail(id)) as PipelineDetail | null)
    } catch {
      setDetail(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId)
    else setDetail(null)
  }, [selectedId, loadDetail])

  // 进度/结束事件：只改当前 run 的进度，不重拉清单
  useEffect(() => {
    const api = bridge()
    if (!api) return
    const offP = api.onProgress((raw) => {
      const e = raw as ProgressEvent
      setProgress((prev) => ({ ...prev, [e.runId]: e }))
    })
    const offF = api.onFinished((raw) => {
      const e = raw as { runId: string; ok: boolean }
      setProgress((prev) => {
        const next = { ...prev }
        delete next[e.runId]
        return next
      })
      // 结束才重拉：拿到最终 lastRun 与 journal
      void refresh()
      const sel = selectedRef.current
      if (sel) void loadDetail(sel)
    })
    return () => {
      offP()
      offF()
    }
  }, [refresh, loadDetail])

  const run = useCallback(
    async (id: string, mode: 'record' | 'rehearsal', resumeRunId?: string) => {
      const api = bridge()
      if (!api) return { ok: false, error: '通道不可用' }
      return api.run({ id, mode, resumeRunId })
    },
    [],
  )

  return { items, selectedId, select: setSelectedId, detail, error, progress, refresh, run }
}
