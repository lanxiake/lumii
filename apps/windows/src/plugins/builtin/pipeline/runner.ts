/**
 * 执行器主循环（计划 Task 3，本特性最重的一块）。
 *
 * 步序（写死，顺序有讲究）：
 *   preconditions → (record.start) → steps[run → mark(若record) → hold → assert → journal]
 *   → postCleanup → record.stop → narrate
 *
 * **postCleanup 在 stop 之前**：清理动作不能录进成片（设计 §4.4 的注释「这条容易写反」）。
 * **mark 在 callTool 之后、hold 之前**：打点要对应"操作刚做完"那一刻（设计 §4.3）。
 */
import type { JournalLine, PipelineSpec, RunMeta, RunnerDeps } from './types'
import { appendJournal, writeMeta } from './journal'

export interface RunOptions {
  readonly spec: PipelineSpec
  readonly specHash: string
  readonly mode: 'record' | 'rehearsal'
  readonly runDir: string
  readonly deps: RunnerDeps
  /** 注入 sleep 便于单测（缺省真 setTimeout） */
  readonly sleep?: (ms: number) => Promise<void>
  /** rehearsal 下哪些工具该被跳过（needsPermission===true） */
  readonly isRehearsalBlocked: (tool: string) => boolean
  /** 续跑：已 ok 的 step id 直接跳过 */
  readonly resumeSkip?: ReadonlySet<string>
}

export interface StepResult {
  readonly id: string
  readonly ok: boolean
  readonly ms: number
  readonly observed?: unknown
}

export interface RunResult {
  readonly ok: boolean
  readonly journalPath: string
  readonly failedAt?: { i: number; id: string; expected?: unknown; observed?: unknown }
  readonly steps: readonly StepResult[]
  readonly artifact?: RunMeta['artifact']
  readonly error?: string
}

interface Ref {
  stepId: string
  path: string
}

/** 极简 JSONPath：`a.b[0].c` → 值；解析不到返回 `undefined` 并由调用方报 bad_reference */
function deref(root: unknown, path: string): unknown {
  if (!path) return root
  let cur = root
  for (const seg of path.split('.').filter(Boolean)) {
    if (cur == null) return undefined
    const m = seg.match(/^([^[\]]*)((?:\[\d+\])*)$/)
    if (!m) return undefined
    if (m[1]) {
      if (typeof cur !== 'object') return undefined
      cur = (cur as Record<string, unknown>)[m[1]]
    }
    for (const idx of m[2]?.match(/\d+/g) ?? []) {
      if (!Array.isArray(cur)) return undefined
      cur = cur[Number(idx)]
    }
  }
  return cur
}

/** 解析 params 里的 `{{stepId.path}}`；解析失败抛 `bad_reference` */
function resolveParams(value: unknown, outputs: Map<string, unknown>): unknown {
  if (typeof value === 'string') {
    const full = value.match(/^\{\{\s*([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+|\[\d+\])*)\s*\}\}$/)
    if (full) {
      const [, stepId, path] = full as unknown as [string, string, string]
      if (!outputs.has(stepId)) throw new Error(`bad_reference: unknown step "${stepId}"`)
      const got = deref(outputs.get(stepId), path)
      if (got === undefined) throw new Error(`bad_reference: ${stepId}${path} 解析不到`)
      return got
    }
    // 内嵌引用：逐个替换
    return value.replace(/\{\{\s*([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+|\[\d+\])*)\s*\}\}/g, (_m, stepId, path) => {
      if (!outputs.has(stepId)) throw new Error(`bad_reference: unknown step "${stepId}"`)
      const got = deref(outputs.get(stepId), path)
      if (got === undefined) throw new Error(`bad_reference: ${stepId}${path} 解析不到`)
      return typeof got === 'string' ? got : JSON.stringify(got)
    })
  }
  if (Array.isArray(value)) return value.map((v) => resolveParams(v, outputs))
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, resolveParams(v, outputs)]))
  }
  return value
}

/** `fields` 子集匹配（路径寻址）；缺省只要求工具没返回错误 */
function assertExpect(
  expect: PipelineSpec['steps'][number]['expect'],
  data: unknown,
  viewState: unknown,
): { ok: true } | { ok: false; expected: unknown; observed: unknown } {
  if (!expect) return { ok: true }
  if (expect.fields) {
    for (const [key, want] of Object.entries(expect.fields)) {
      const got = deref(data, key)
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        return { ok: false, expected: expect.fields, observed: data }
      }
    }
  }
  if (expect.viewState) {
    // viewState 为**全等**匹配（设计 §4.5）
    for (const [key, want] of Object.entries(expect.viewState)) {
      const got = deref(viewState, key)
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        return { ok: false, expected: expect.viewState, observed: viewState }
      }
    }
  }
  return { ok: true }
}

export async function runPipeline(opts: RunOptions): Promise<RunResult> {
  const { spec, specHash, mode, runDir, deps } = opts
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const record = mode === 'record' && spec.record?.enabled === true
  const steps: StepResult[] = []
  const outputs = new Map<string, unknown>()
  const journalPath = `${runDir}/journal.jsonl`

  const meta: RunMeta = {
    runId: runDir.split(/[\\/]/).pop() ?? 'run',
    specId: spec.id,
    mode,
    specHash,
    startedAt: deps.now(),
    status: 'running',
  }
  writeMeta(runDir, meta)

  /** 收尾统一：postCleanup（尽力）→ stop → 写 meta */
  const finish = async (result: Omit<RunResult, 'steps' | 'journalPath'>): Promise<RunResult> => {
    // postCleanup 无论成败都跑，且**在 stop 之前**（清理动作不能录进成片）
    for (const c of spec.postCleanup ?? []) {
      try {
        await deps.callTool(c.tool, (resolveParams(c.params ?? {}, outputs) as Record<string, unknown>) ?? {})
      } catch (err) {
        console.warn(`[pipeline] postCleanup "${c.id}" 失败（已忽略）:`, err instanceof Error ? err.message : err)
      }
    }
    let artifact: RunMeta['artifact'] | undefined
    if (record && deps.screenRecord) {
      const stop = await deps.screenRecord.stop()
      if (stop.ok && stop.data) artifact = stop.data as RunMeta['artifact']
    }
    writeMeta(runDir, { ...meta, endedAt: deps.now(), status: result.ok ? 'ok' : 'failed', artifact })
    return { ...result, steps, journalPath, artifact }
  }

  // ── preconditions：不满足直接停，且**不 start 录制** ──
  for (const p of spec.preconditions ?? []) {
    // 预条件也走 resolveParams：它们的参数里同样可以有 {{ref}}（虽然引用只能向后、
    // 而预条件在主循环之前，实际只有常量——但传不传参不能靠工具恰好零参来保证）。
    const r = await deps.callTool(p.tool, (resolveParams(p.params ?? {}, outputs) as Record<string, unknown>) ?? {})
    const viewState = await deps.readViewState()
    const a = assertExpect(p.expect, r.data ?? r, viewState)
    if (!r.ok || !a.ok) {
      const observed = 'observed' in a ? a.observed : r
      return finish({
        ok: false,
        failedAt: { i: -1, id: p.id, expected: p.expect, observed },
        error: r.error ?? `precondition "${p.id}" 不满足${p.hint ? `（${p.hint}）` : ''}`,
      })
    }
  }

  // ── 开始录制（失败则整条拒绝，不降级成"不录但继续"）──
  if (record) {
    if (!deps.screenRecord) {
      return finish({ ok: false, error: 'record.enabled 但屏幕录制服务不可用' })
    }
    const started = await deps.screenRecord.start({ sourceHint: spec.record?.sourceHint ?? 'auto' })
    if (!started.ok) {
      return finish({ ok: false, error: `录制启动失败，整条拒绝: ${started.error ?? ''}` })
    }
  }

  // ── 主循环 ──
  for (let i = 0; i < spec.steps.length; i++) {
    const step = spec.steps[i]!
    const startedAt = deps.now()

    if (opts.resumeSkip?.has(step.id)) {
      steps.push({ id: step.id, ok: true, ms: 0 })
      continue
    }

    // rehearsal：needsPermission 工具不执行，记 skipped，造一个空返回供后续 {{}} 引用
    if (mode === 'rehearsal' && opts.isRehearsalBlocked(step.tool)) {
      outputs.set(step.id, {})
      appendJournal(runDir, {
        i, id: step.id, tool: step.tool, startedAt, ms: 0, ok: true, skipped: 'rehearsal',
      })
      steps.push({ id: step.id, ok: true, ms: 0 })
      continue
    }

    let params: Record<string, unknown>
    try {
      params = (resolveParams(step.params ?? {}, outputs) as Record<string, unknown>) ?? {}
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      appendJournal(runDir, { i, id: step.id, tool: step.tool, startedAt, ms: 0, ok: false, error })
      steps.push({ id: step.id, ok: false, ms: 0 })
      return finish({ ok: false, failedAt: { i, id: step.id }, error })
    }

    let r: { ok: boolean; data?: unknown; error?: string }
    try {
      r = await deps.callTool(step.tool, params)
    } catch (err) {
      // 异常 → step 失败（不让它逃逸成工具级 isError，否则模型只看到"工具炸了"）
      r = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    outputs.set(step.id, r.data ?? {})

    // mark：callTool 之后、hold 之前
    let markAtMs: number | undefined
    if (record && step.narration && deps.screenRecord) {
      const m = await deps.screenRecord.mark({ label: step.narration })
      if (m.ok) markAtMs = m.data?.atMs
    }

    if (step.holdMs > 0) await sleep(step.holdMs)

    const ms = deps.now() - startedAt
    const viewState = await deps.readViewState()
    const a = assertExpect(step.expect, r.data ?? r, viewState)

    const line: JournalLine = {
      i, id: step.id, tool: step.tool, startedAt, ms,
      ok: r.ok && a.ok,
      markAtMs,
      observed: r.data ?? r,
      assertOk: a.ok,
      holdMs: step.holdMs,
      ...(r.ok ? {} : { error: r.error ?? 'tool returned ok:false' }),
      ...(a.ok ? {} : { expected: 'expected' in a ? a.expected : undefined, observed: 'observed' in a ? a.observed : undefined }),
    }
    appendJournal(runDir, line)
    steps.push({ id: step.id, ok: line.ok, ms, observed: line.observed })

    if (!line.ok) {
      return finish({
        ok: false,
        failedAt: {
          i, id: step.id,
          expected: 'expected' in a ? a.expected : step.expect,
          observed: 'observed' in a ? a.observed : r,
        },
        error: r.ok ? `断言失败（expected ${JSON.stringify(step.expect)}）` : r.error,
      })
    }
  }

  return finish({ ok: true })
}
