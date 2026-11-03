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
import { listPipelines, createRunDir, readSpec, readInputsFile, missingInputs } from './store'
import { runPipeline } from './runner'
import { computeResume, readJournal, readMeta, writeMeta } from './journal'
import type { PipelineService, PipelineDetail, PipelineSummary } from './service-api'
import type { PipelineSpec, RunnerDeps } from './types'

export interface PipelineServiceDeps {
  readonly callTool: RunnerDeps['callTool']
  /** agent 节点执行器；宿主没注入时含 agent 节点的 spec 会在该步明确失败 */
  readonly runAgentStage?: RunnerDeps['runAgentStage']
  readonly screenRecord: RunnerDeps['screenRecord']
  readonly readViewState: RunnerDeps['readViewState']
  /** 全量工具名快照（校验 spec 用）；由 bridge 从 toolRegistry 现取 */
  readonly knownTools: () => ReadonlySet<string>
  /** 已启用的 Agent id 快照（校验 agent 节点用）；同样现取 */
  readonly knownAgents: () => ReadonlySet<string>
  /** 哪些工具需要授权（rehearsal 要跳过它们）；由 bridge 从 toolRegistry 现取 */
  readonly needsPermission?: (tool: string) => boolean
  /** 根目录取值（`resolvePipelinesDir`）；注入以免 import main/** */
  readonly pipelinesRoot: () => string
  /** 工作区根：spec.preview.htmlPath 是工作区相对路径 */
  readonly workspaceRoot: () => string
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

/** `spec.preview.htmlPath` → 存在的绝对路径；不存在就当没有（卡片据此降级成「见 README」） */
function resolvePreviewPath(spec: PipelineSpec, workspaceRoot: string): string | undefined {
  const rel = spec.preview?.htmlPath
  if (!rel) return undefined
  const abs = path.resolve(workspaceRoot, rel)
  return fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : undefined
}

export function createPipelineService(deps: PipelineServiceDeps): PipelineService {
  const root = () => deps.pipelinesRoot()
  const running = new Map<string, AbortController>()
  const needsPermission = deps.needsPermission ?? (() => false)

  const detail = async (id: string): Promise<PipelineDetail | null> => {
    const r = readSpec(root(), id, deps.knownTools(), deps.knownAgents())
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
    const iv = readInputsFile(root(), id)
    const provided = iv.ok ? iv.inputs : {}
    return {
      spec: r.spec,
      specHash: r.specHash,
      runs,
      lastJournal: last ? readJournal(path.join(runsDir, last.runId)).lines : undefined,
      ...(iv.ok ? { inputs: provided } : {}),
      ...(r.spec.inputs?.length ? { missingInputs: missingInputs(r.spec, provided) } : {}),
    }
  }

  return {
    async list(): Promise<PipelineSummary[]> {
      return listPipelines(root(), deps.knownTools(), deps.knownAgents())
    },

    detail,

    async run(id, opts) {
      const r = readSpec(root(), id, deps.knownTools(), deps.knownAgents())
      if ('error' in r) return { ok: false, runId: '', journalPath: '', steps: [], error: r.error }

      // 变量来源：调用方传入优先，缺的从 inputs.json 补。
      // **不检查"齐全"再开跑**——缺变量会在真正用到它的那一步以 bad_reference 失败，
      // 前几步照样跑完。这比在这里一律拒绝更有用：用户能看到"spec 本身对不对"，
      // 而不是因为漏填一个值连第一步都不让跑。
      let inputs: Record<string, string> = {}
      if (r.spec.inputs?.length) {
        const fromFile = readInputsFile(root(), id)
        if (!fromFile.ok) {
          return { ok: false, runId: '', journalPath: '', steps: [], error: fromFile.error }
        }
        inputs = { ...fromFile.inputs, ...(opts.inputs ?? {}) }
      }

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
      // provenance 也能带变量：`{{input.repoUrl}}` 之类的地址补成真值再交给对照视图，
      // 否则左栏会显示一串花括号。解析不出来时原样保留（对照视图至少能显示"这里本该是什么"）。
      const provTarget = (() => {
        const t = r.spec.provenance?.target
        if (!t) return undefined
        return t.replace(/\{\{\s*input\.([A-Za-z0-9_-]+)\s*\}\}/g, (_m, n: string) => inputs[n] ?? `{{input.${n}}}`)
      })()
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
          inputs,
          onProgress: (e) => deps.onProgress?.({ runId, ...e }),
        })
        deps.onFinished?.({ runId, ok: out.ok, failedAt: out.failedAt })
        const previewPath = resolvePreviewPath(r.spec, deps.workspaceRoot())
        return {
          ...out,
          runId,
          journalPath: path.join(runDir, 'journal.jsonl'),
          ...(provTarget ? { provenanceTarget: provTarget } : {}),
          ...(previewPath ? { previewPath } : {}),
        }
      } finally {
        running.delete(runId)
      }
    },

    cancel(runId) {
      running.get(runId)?.abort()
    },
  }
}
