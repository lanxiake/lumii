/**
 * `PipelineService` 的实现（list / detail / run / cancel）。
 *
 * **不 import 任何 `apps/windows/src/main/**`**——执行上下文（callTool / 录屏 / 视图回读）
 * 全部由 bridge 注入，本文件只编排纯文件逻辑（store / journal / runner）。
 * 这条边界让 `runner.ts` 与这里都能在 `@vitest-environment node` 下裸跑（计划「模块边界（硬）」）。
 *
 * 流放点：`resolvePipelinesDir()` 是 main 侧的东西，所以以 `pipelinesRoot: () => string` 注入，
 * 不在这里 import。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { listPipelines, createRunDir, readSpec } from './store'
import { runPipeline } from './runner'
import { computeResume, readJournal, readMeta, writeMeta } from './journal'
import type { PipelineService, PipelineDetail, PipelineSummary } from './service-api'
import type { RunnerDeps } from './types'

export interface PipelineServiceDeps {
  readonly callTool: RunnerDeps['callTool']
  readonly screenRecord: RunnerDeps['screenRecord']
  readonly readViewState: RunnerDeps['readViewState']
  /** 全量工具名快照（校验 spec 用）；由 bridge 从 toolRegistry 现取 */
  readonly knownTools: () => ReadonlySet<string>
  /** 哪些工具需要授权（rehearsal 要跳过它们）；由 bridge 从 toolRegistry 现取 */
  readonly needsPermission?: (tool: string) => boolean
  /** 根目录取值（`resolvePipelinesDir`）；注入以免 import main/** */
  readonly pipelinesRoot: () => string
  readonly now?: () => number
  readonly onProgress?: (e: {
    runId: string
    i: number
    total: number
    stepId: string
    label?: string
    status: string
  }) => void
  /** 一次 run 结束（成功或失败），供 UI 收尾卡片 */
  readonly onFinished?: (e: { runId: string; ok: boolean; failedAt?: unknown }) => void
}

export function createPipelineService(deps: PipelineServiceDeps): PipelineService {
  const root = () => deps.pipelinesRoot()
  const running = new Map<string, AbortController>()
  const needsPermission = deps.needsPermission ?? (() => false)

  const detail = async (id: string): Promise<PipelineDetail | null> => {
    const r = readSpec(root(), id, deps.knownTools())
    if ('error' in r) return null
    const runsDir = path.join(root(), id, 'runs')
    const runs = fs.existsSync(runsDir)
      ? fs
          .readdirSync(runsDir)
          .map((n) => readMeta(path.join(runsDir, n)))
          .filter((m): m is NonNullable<typeof m> => !!m)
          .sort((a, b) => b.startedAt - a.startedAt)
      : []
    const last = runs[0]
    return {
      spec: r.spec,
      specHash: r.specHash,
      runs,
      lastJournal: last ? readJournal(path.join(runsDir, last.runId)).lines : undefined,
    }
  }

  return {
    async list(): Promise<PipelineSummary[]> {
      return listPipelines(root(), deps.knownTools())
    },

    detail,

    async run(id, opts) {
      const r = readSpec(root(), id, deps.knownTools())
      if ('error' in r) return { ok: false, runId: '', journalPath: '', steps: [], error: r.error }

      let runDir: string
      let resumeSkip: ReadonlySet<string> | undefined
      const now = deps.now ?? (() => Date.now())
      if (opts.resumeRunId) {
        runDir = path.join(root(), id, 'runs', opts.resumeRunId)
        const res = computeResume(runDir, r.specHash)
        if (!res.ok) {
          return {
            ok: false,
            runId: opts.resumeRunId,
            journalPath: '',
            steps: [],
            error: '续跑被拒：spec 已改动（spec_changed）——否则是在新 spec 上假装旧结果有效',
          }
        }
        resumeSkip = res.skip
      } else {
        runDir = createRunDir(root(), id, r.spec, r.specHash).runDir
        writeMeta(runDir, {
          runId: path.basename(runDir),
          specId: id,
          mode: opts.mode,
          specHash: r.specHash,
          startedAt: now(),
          status: 'running',
        })
      }

      const runId = path.basename(runDir)
      const ac = new AbortController()
      running.set(runId, ac)
      try {
        const out = await runPipeline({
          spec: r.spec,
          specHash: r.specHash,
          mode: opts.mode,
          runDir,
          deps: { ...deps, now },
          isRehearsalBlocked: (tool) => needsPermission(tool),
          resumeSkip,
          signal: ac.signal,
          onProgress: (e) => deps.onProgress?.({ runId, ...e }),
        })
        deps.onFinished?.({ runId, ok: out.ok, failedAt: out.failedAt })
        return { ...out, runId, journalPath: path.join(runDir, 'journal.jsonl') }
      } finally {
        running.delete(runId)
      }
    },

    cancel(runId) {
      running.get(runId)?.abort()
    },
  }
}
