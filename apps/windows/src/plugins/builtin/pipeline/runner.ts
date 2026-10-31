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
  /** 取消信号：透传给 callTool 与 sleep，让 cancel 能真的中断（而不是跑完剩下的步）。 */
  readonly signal?: AbortSignal
  /** 每步结束回调（UI 进度条用）；失败不阻断执行 */
  readonly onProgress?: (e: {
    i: number
    total: number
    stepId: string
    label?: string
    status: 'ok' | 'failed'
  }) => void
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
  // `mode:'record'` 是**用户的明确意图**（点了「录制运行」/ 模型调 pipeline_run record）。
  // `spec.record.enabled` 只能**否决**它（作者刻意声明「这条永远不录」），不能静默把它变成
  // 一次不录的普通运行 —— 那样 run 会报成功、却没有任何产物，用户拿到的是一句空话。
  const recordRequested = mode === 'record'
  const recordVetoed = spec.record?.enabled === false
  const record = recordRequested && !recordVetoed
  /**
   * 录制**真的起来了**才允许 stop。
   *
   * 不能用 `record` 判：start 失败 / 预条件失败 / 列出录制源失败时 `record` 仍是 true，
   * 那时去 `stop()` 会停掉一个从未启动的会话——若用户此刻正手动录屏，会**误停别人的录制**。
   */
  let recordingStarted = false
  const steps: StepResult[] = []
  const outputs = new Map<string, unknown>()
  /** step id → 打点时刻（来自 mark）；收尾组 cues 用 */
  const markAtById = new Map<string, number>()
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
    if (recordingStarted && deps.screenRecord) {
      const stop = await deps.screenRecord.stop()
      if (stop.ok && stop.data) {
        const data = stop.data as { path?: string; durationMs?: number; mp4Path?: string }
        artifact = { durationMs: data.durationMs, mp4Path: data.mp4Path } as RunMeta['artifact']

        // 旁白：cues 由**每一步的 markAtMs + narration** 组成（设计 §4.6）。
        // 这是「字幕与操作同源」的唯一实现点：mark 是 execute 返回后立刻打的，
        // text 是同一个 step 对象的 narration，二者不可能错位。
        // endMs 交给 narrate 自己算，执行器不重算融合规则。
        const cues = spec.steps
          .filter((s) => s.narration)
          .map((s) => {
            const mark = markAtById.get(s.id)
            return mark != null ? { startMs: mark, text: s.narration! } : null
          })
          .filter((c): c is { startMs: number; text: string } => c !== null)
        const narrateCfg = spec.record?.narrate
        if (cues.length > 0 && data.path && narrateCfg) {
          const runNarrate = (dub: boolean) =>
            deps.screenRecord!.narrate({
              path: data.path!,
              cues,
              dub,
              writeSrt: true,
              subtitleMode: narrateCfg.subtitleMode as 'soft' | 'burn' | undefined,
              exportMp4: narrateCfg.exportMp4,
            })
          try {
            let n = await runNarrate(narrateCfg.dub === true)
            // **配音失败降级重试一次（不要配音）**：TTS 依赖网络（实测 Edge TTS 会回 403），
            // 而录屏本身已经成功。因为一段旁白合成不了就把整条成片判失败，是把
            // 「可选增强」当成了「必需步骤」——用户要的是视频，字幕可以先不带声音。
            if (!n.ok && narrateCfg.dub === true) {
              console.warn(`[pipeline] 配音失败（${n.error ?? 'unknown'}），降级为纯字幕重试`)
              n = await runNarrate(false)
            }
            if (n.ok && n.data) {
              artifact = {
                ...artifact,
                mp4Path: n.data.mp4Path ?? artifact?.mp4Path,
                burned: n.data.burned,
                dubbed: n.data.dubbed,
                cueCount: n.data.cueCount,
              }
            } else {
              console.warn('[pipeline] 旁白合成失败（成片保留）:', n.error)
            }
          } catch (err) {
            // 旁白失败不推翻「步骤全过」的结论——成片已在，用户可以选择不带字幕。
            console.warn('[pipeline] 旁白合成失败（成片保留）:', err instanceof Error ? err.message : err)
          }
        }
      }
    }
    // **闭环兜底**：明确要求录制、步骤也全过了，却没有任何产物 → 这不能算成功。
    // 典型来路：spec 写着 `record.enabled: false`（作者否决）、或录屏服务中途不可用。
    // 不判失败的话，用户在页面上看到「成功」，却找不到视频——比直接报错更糟。
    let finalOk = result.ok
    let finalError = result.error
    if (recordRequested && result.ok && !artifact) {
      finalOk = false
      finalError = recordVetoed
        ? '该 spec 明确禁用了录制（record.enabled=false），本次没有产物。把它改成 true，或用彩排模式。'
        : '要求录制但没有拿到产物（录屏服务不可用或启动后异常退出）。'
    }

    writeMeta(runDir, { ...meta, endedAt: deps.now(), status: finalOk ? 'ok' : 'failed', artifact })
    return { ...result, ok: finalOk, error: finalError, steps, journalPath, artifact }
  }

  // ── preconditions：不满足直接停，且**不 start 录制** ──
  for (const p of spec.preconditions ?? []) {
    // 预条件参数同样走 resolveParams，但**包在 try 里**：spec.ts 已在加载期拒掉坏引用，
    // 这里兜底是为防万一——抛出去会让整条 run reject，而那时 meta 还停在 running。
    let preParams: Record<string, unknown>
    try {
      preParams = (resolveParams(p.params ?? {}, outputs) as Record<string, unknown>) ?? {}
    } catch (err) {
      return finish({
        ok: false,
        failedAt: { i: -1, id: p.id },
        error: `precondition "${p.id}" 参数解析失败: ${err instanceof Error ? err.message : err}`,
      })
    }
    const r = await deps.callTool(p.tool, preParams, opts.signal)
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
    // `start` 要的是 `sourceId`（list_sources 的产物），不是 spec 里的 `sourceHint`（人话）。
    // 先列源、挑「本应用窗口」优先的那个——录教程就是要录自己。
    let sources: readonly { sourceId: string; name?: string; kind?: string }[] = []
    try {
      sources = await deps.screenRecord.listSources()
    } catch (err) {
      return finish({ ok: false, error: `列出录制源失败: ${err instanceof Error ? err.message : err}` })
    }
    const hint = spec.record?.sourceHint ?? 'auto'
    const pick =
      sources.find((s) => s.sourceId === hint) ??
      sources.find((s) => /lumii|本应用|灵栖/i.test(`${s.name ?? ''}${s.sourceId}`)) ??
      sources[0]
    if (!pick) return finish({ ok: false, error: '没有可用的录制源（listSources 返回空）' })
    const started = await deps.screenRecord.start({
      sourceId: pick.sourceId,
      includeMic: spec.record?.includeMic,
    })
    if (!started.ok) {
      return finish({ ok: false, error: `录制启动失败，整条拒绝: ${started.error ?? ''}` })
    }
    recordingStarted = true
  }

  // ── 主循环 ──
  for (let i = 0; i < spec.steps.length; i++) {
    const step = spec.steps[i]!
    // 取消：在每步开头检查一次就够——工具本身接不接 signal 是各宿主的事，
    // 但「不再往下跑」这条必须由 runner 保证（否则 cancel 后还会点/发/写）。
    if (opts.signal?.aborted) {
      return finish({ ok: false, error: '已取消（cancelled）' })
    }
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
      r = await deps.callTool(step.tool, params, opts.signal)
    } catch (err) {
      // 异常 → step 失败（不让它逃逸成工具级 isError，否则模型只看到"工具炸了"）
      r = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    outputs.set(step.id, r.data ?? {})

    // mark：callTool 之后、hold 之前。
    // **mark 失败视为该步失败**：有旁白却没有打点，成片里这一段就没有字幕，
    // 而「字幕与操作同源」正是这个特性的立身之本（设计 §4.6）。
    let markAtMs: number | undefined
    let markError: string | undefined
    if (record && step.narration && deps.screenRecord) {
      const m = await deps.screenRecord.mark({ label: step.narration })
      if (m.ok && m.data) {
        markAtMs = m.data.atMs
        markAtById.set(step.id, markAtMs)
      } else {
        markError = `打点失败: ${m.error ?? 'unknown'}`
      }
    }

    if (step.holdMs > 0) await sleep(step.holdMs)

    const ms = deps.now() - startedAt
    const viewState = await deps.readViewState()
    const a = assertExpect(step.expect, r.data ?? r, viewState)

    const line: JournalLine = {
      i, id: step.id, tool: step.tool, startedAt, ms,
      ok: r.ok && a.ok && !markError,
      markAtMs,
      observed: r.data ?? r,
      assertOk: a.ok,
      holdMs: step.holdMs,
      ...(r.ok ? {} : { error: r.error ?? 'tool returned ok:false' }),
      ...(markError ? { error: markError } : {}),
      ...(a.ok ? {} : { expected: 'expected' in a ? a.expected : undefined, observed: 'observed' in a ? a.observed : undefined }),
    }
    appendJournal(runDir, line)
    steps.push({ id: step.id, ok: line.ok, ms, observed: line.observed })

    opts.onProgress?.({
      i,
      total: spec.steps.length,
      stepId: step.id,
      label: step.label,
      status: line.ok ? 'ok' : 'failed',
    })

    if (!line.ok) {
      return finish({
        ok: false,
        failedAt: {
          i, id: step.id,
          expected: 'expected' in a ? a.expected : step.expect,
          observed: 'observed' in a ? a.observed : r,
        },
        error: markError ?? (r.ok ? `断言失败（expected ${JSON.stringify(step.expect)}）` : r.error),
      })
    }
  }

  return finish({ ok: true })
}
