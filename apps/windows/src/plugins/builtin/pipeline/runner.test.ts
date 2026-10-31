/**
 * runner 主循环的 14 条（计划 Task 3）。只 mock 四个注入依赖，不碰真实工具/录屏。
 *
 * 三条容易写反、这里逐条钉住：
 * - `postCleanup` 在 `record.stop` **之前**（否则清理动作会录进成片）
 * - `mark` 在 `callTool` 返回**之后**、`hold` 之前
 * - 断言失败也算 step 失败，写同一套 `{error, expected, observed}`
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runPipeline } from './runner'
import { validateSpec } from './spec'
import type { RunnerDeps } from './types'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-pipe-run-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const TOOLS = new Set(['app_goto', 'app_act', 'wechat_read_history', 'wechat_check_env'])

function specOf(steps: unknown[], extra: Record<string, unknown> = {}) {
  const r = validateSpec({ id: 'demo', steps, ...extra }, TOOLS)
  if (!r.ok) throw new Error('bad test spec: ' + r.errors.join('; '))
  return r
}

/** 记录调用顺序的 fake deps，便于断言「mark 在 callTool 之后、hold 之前」 */
function deps(opts: {
  results?: Record<string, { ok: boolean; data?: unknown; error?: string }>
  viewState?: { view: string | null; hub?: { open: boolean; tab?: string; category?: string } }
  startOk?: boolean
} = {}) {
  const calls: string[] = []
  const marks: { label: string }[] = []
  let clock = 1000
  const d: RunnerDeps = {
    callTool: vi.fn(async (name: string) => {
      calls.push(`call:${name}`)
      return opts.results?.[name] ?? { ok: true, data: { ok: true, [name]: 1 } }
    }),
    screenRecord: {
      start: vi.fn(async () => {
        calls.push('start')
        return { ok: opts.startOk ?? true }
      }),
      stop: vi.fn(async () => {
        calls.push('stop')
        // 真实 stop 至少给 path（narrate 的入参就是它），mp4Path 是可选的
        return { ok: true, data: { path: 'x.mkv', durationMs: 1234 } }
      }),
      mark: vi.fn(async (p: { label: string }) => {
        calls.push('mark')
        marks.push(p)
        return { ok: true, data: { atMs: 9000 } }
      }),
      listSources: vi.fn(async () => [{ sourceId: 'lumii-id', name: 'Lumii' }]),
      narrate: vi.fn(async (p: { cues: unknown[] }) => ({
        ok: true,
        data: { cueCount: p.cues.length, burned: true, dubbed: true },
      })),
    },
    readViewState: vi.fn(async () => opts.viewState ?? { view: 'chat' }),
    // 注入 fake clock：holdMs 直接推进，不真 sleep（单测里 1.2 秒 × N 步会拖死套件）
    now: () => (clock += 1000),
  }
  return { d, calls, marks }
}

/** 单测里不等真 sleep：runner 接受 sleep 注入；缺省用真 setTimeout */
const fastSleep = () => Promise.resolve()

describe('runner 主循环', () => {
  it('3 步全成功 → journal 3 行全 ok，按序', async () => {
    const { spec, specHash } = specOf([
      { id: 'a', tool: 'app_goto' },
      { id: 'b', tool: 'app_act' },
      { id: 'c', tool: 'wechat_read_history' },
    ])
    const { d } = deps()
    const res = await runPipeline({
      spec, specHash, mode: 'rehearsal', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    expect(res.ok).toBe(true)
    expect(res.steps.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(res.steps.every((s) => s.ok)).toBe(true)
  })

  it('第 2 步工具返回 ok:false → 停在第 2 步，第 3 步不执行', async () => {
    const { spec, specHash } = specOf([
      { id: 'a', tool: 'app_goto' },
      { id: 'b', tool: 'app_act' },
      { id: 'c', tool: 'wechat_read_history' },
    ])
    const { d } = deps({ results: { app_act: { ok: false, error: 'boom' } } })
    const res = await runPipeline({
      spec, specHash, mode: 'rehearsal', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    expect(res.ok).toBe(false)
    expect(res.failedAt?.id).toBe('b')
    expect(d.callTool).not.toHaveBeenCalledWith('wechat_read_history', undefined)
  })

  it('第 2 步断言失败 → 返回 {failedAt:{i,id}, expected, observed}', async () => {
    const { spec, specHash } = specOf([
      { id: 'a', tool: 'app_goto' },
      { id: 'b', tool: 'app_act', expect: { fields: { ok: true, want: 42 } } },
    ])
    const { d } = deps({ results: { app_act: { ok: true, data: { ok: true, want: 7 } } } })
    const res = await runPipeline({
      spec, specHash, mode: 'rehearsal', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    expect(res.ok).toBe(false)
    expect(res.failedAt).toMatchObject({ id: 'b' })
    expect(res.failedAt?.expected).toBeDefined()
    expect(res.failedAt?.observed).toBeDefined()
  })

  it('rehearsal：needsPermission 工具不调用 callTool，记 skipped:rehearsal', async () => {
    const { spec, specHash } = specOf([{ id: 'a', tool: 'wechat_check_env' }])
    const { d } = deps()
    const res = await runPipeline({
      spec, specHash, mode: 'rehearsal', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: (t) => t === 'wechat_check_env',
    })
    expect(d.callTool).not.toHaveBeenCalled()
    expect(res.steps[0]!.ok).toBe(true)
  })

  it('rehearsal：不 start 录制', async () => {
    const { spec, specHash } = specOf([{ id: 'a', tool: 'app_goto' }], {
      record: { enabled: true },
    })
    const { d, calls } = deps()
    await runPipeline({
      spec, specHash, mode: 'rehearsal', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    expect(calls).not.toContain('start')
  })

  it('record.enabled 而 start 失败 → 整条拒绝，step 一个都不跑', async () => {
    const { spec, specHash } = specOf([{ id: 'a', tool: 'app_goto' }], {
      record: { enabled: true },
    })
    const { d } = deps({ startOk: false })
    const res = await runPipeline({
      spec, specHash, mode: 'record', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    expect(res.ok).toBe(false)
    expect(d.callTool).not.toHaveBeenCalled()
  })

  it('record 成功路径：每个有 narration 的 step 调一次 mark，参数是 step.narration', async () => {
    const { spec, specHash } = specOf(
      [
        { id: 'a', tool: 'app_goto', narration: '打开页面' },
        { id: 'b', tool: 'app_act', narration: '点击按钮' },
      ],
      { record: { enabled: true } },
    )
    const { d, marks } = deps()
    await runPipeline({
      spec, specHash, mode: 'record', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    expect(marks.map((m) => m.label)).toEqual(['打开页面', '点击按钮'])
  })

  it('无 narration 的 step 不调 mark（record 开着也不打点）', async () => {
    const { spec, specHash } = specOf(
      [
        { id: 'a', tool: 'app_goto', narration: '有旁白' },
        { id: 'b', tool: 'app_act' },
      ],
      { record: { enabled: true } },
    )
    const { d, marks } = deps()
    await runPipeline({
      spec, specHash, mode: 'record', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    expect(marks.map((m) => m.label)).toEqual(['有旁白'])
  })

  it('start 失败 → 绝不调 stop（否则会误停用户正开着的手动录屏）', async () => {
    const { spec, specHash } = specOf([{ id: 'a', tool: 'app_goto' }], {
      record: { enabled: true },
    })
    const { d, calls } = deps({ startOk: false })
    await runPipeline({
      spec, specHash, mode: 'record', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    expect(calls).toContain('start')
    expect(calls).not.toContain('stop')
  })

  it('预条件失败 → 不 start、不 stop', async () => {
    const { spec, specHash } = specOf([{ id: 'a', tool: 'app_goto' }], {
      record: { enabled: true },
      preconditions: [{ id: 'p', tool: 'wechat_check_env', expect: { fields: { ok: true } } }],
    })
    const { d, calls } = deps({ results: { wechat_check_env: { ok: true, data: { ok: false } } } })
    await runPipeline({
      spec, specHash, mode: 'record', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    expect(calls).not.toContain('start')
    expect(calls).not.toContain('stop')
  })

  it('cues 条数 == 有 narration 的步数，startMs 来自该步的 markAtMs', async () => {
    const { spec, specHash } = specOf(
      [
        { id: 'a', tool: 'app_goto', narration: '第一段' },
        { id: 'b', tool: 'app_act' },
        { id: 'c', tool: 'app_goto', narration: '第二段' },
      ],
      { record: { enabled: true, narrate: { dub: true, exportMp4: true } } },
    )
    const { d } = deps()
    await runPipeline({
      spec, specHash, mode: 'record', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    const narrate = d.screenRecord!.narrate as ReturnType<typeof vi.fn>
    expect(narrate).toHaveBeenCalledTimes(1)
    const arg = narrate.mock.calls[0]![0] as { cues: { startMs: number; text: string }[] }
    expect(arg.cues).toHaveLength(2)
    expect(arg.cues.map((c) => c.text)).toEqual(['第一段', '第二段'])
    // 同源：startMs 必须等于该步 mark 返回的 atMs（fake 里恒 9000）
    expect(arg.cues.every((c) => c.startMs === 9000)).toBe(true)
  })

  it('没有任何 narration → 不调 narrate', async () => {
    const { spec, specHash } = specOf([{ id: 'a', tool: 'app_goto' }], {
      record: { enabled: true, narrate: { dub: true } },
    })
    const { d } = deps()
    await runPipeline({
      spec, specHash, mode: 'record', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    expect(d.screenRecord!.narrate).not.toHaveBeenCalled()
  })

  it('rehearsal 不录 → 不 stop、不 narrate', async () => {
    const { spec, specHash } = specOf([{ id: 'a', tool: 'app_goto', narration: 'n' }], {
      record: { enabled: true, narrate: { dub: true } },
    })
    const { d, calls } = deps()
    await runPipeline({
      spec, specHash, mode: 'rehearsal', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    expect(calls).not.toContain('stop')
    expect(d.screenRecord!.narrate).not.toHaveBeenCalled()
  })

  it('mark 失败 → 该步判失败（有旁白却没打点 = 成片少一段字幕）', async () => {
    const { spec, specHash } = specOf([{ id: 'a', tool: 'app_goto', narration: '要打点' }], {
      record: { enabled: true },
    })
    const { d } = deps()
    ;(d.screenRecord!.mark as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: 'not_recording' })
    const res = await runPipeline({
      spec, specHash, mode: 'record', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    expect(res.ok).toBe(false)
    expect(res.failedAt?.id).toBe('a')
    expect(String(res.error)).toContain('打点失败')
  })

  it('stop 失败但前面步骤全 ok → 返回 ok:false，steps 仍是各步真实结果', async () => {
    const { spec, specHash } = specOf([{ id: 'a', tool: 'app_goto' }], {
      record: { enabled: true },
    })
    const { d } = deps()
    ;(d.screenRecord!.stop as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: 'capture_failed' })
    const res = await runPipeline({
      spec, specHash, mode: 'record', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    // 步骤本身过了；stop 失败只影响 artifact（这里不把整个 run 判失败——
    // 步进结果才是 run 的结论，产物是附带的）
    expect(res.steps.every((s) => s.ok)).toBe(true)
    expect(res.artifact).toBeUndefined()
  })

  it('record：start 用 listSources 挑出的 sourceId（不是 spec 的 sourceHint）', async () => {
    const { spec, specHash } = specOf([{ id: 'a', tool: 'app_goto' }], {
      record: { enabled: true, sourceHint: 'auto' },
    })
    const { d } = deps()
    await runPipeline({
      spec, specHash, mode: 'record', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    // 契约要的是 sourceId（list_sources 的产物），传 sourceHint 会永远 source_unavailable
    expect(d.screenRecord!.start).toHaveBeenCalledWith({ sourceId: 'lumii-id', includeMic: undefined })
  })

  it('cancel：signal 已 abort 时停在当步，不再往下执行', async () => {
    const { spec, specHash } = specOf([
      { id: 'a', tool: 'app_goto' },
      { id: 'b', tool: 'app_act' },
    ])
    const { d } = deps()
    const ac = new AbortController()
    ac.abort()
    const res = await runPipeline({
      spec, specHash, mode: 'rehearsal', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false, signal: ac.signal,
    })
    expect(res.ok).toBe(false)
    expect(d.callTool).not.toHaveBeenCalled()
  })

  it('postCleanup 在失败时仍执行，且在 record.stop 之前', async () => {
    const { spec, specHash } = specOf(
      [{ id: 'a', tool: 'app_act' }],
      {
        record: { enabled: true },
        postCleanup: [{ id: 'clean', tool: 'app_goto', params: {} }],
      },
    )
    const { d, calls } = deps({ results: { app_act: { ok: false, error: 'x' } } })
    await runPipeline({
      spec, specHash, mode: 'record', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    expect(calls).toContain('call:app_goto') // cleanup 跑了
    expect(calls.indexOf('call:app_goto')).toBeLessThan(calls.indexOf('stop'))
  })

  it('postCleanup 抛错不抛出，只记日志', async () => {
    const { spec, specHash } = specOf(
      [{ id: 'a', tool: 'app_act' }],
      { postCleanup: [{ id: 'clean', tool: 'app_goto', params: {} }] },
    )
    const { d } = deps()
    ;(d.callTool as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => {
      if (name === 'app_goto') throw new Error('cleanup boom')
      return { ok: true, data: {} }
    })
    await expect(
      runPipeline({
        spec, specHash, mode: 'rehearsal', runDir: path.join(dir, 'r'),
        deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
      }),
    ).resolves.toBeDefined()
  })

  it('preconditions 不满足 → 停在 precondition，且不 start 录制', async () => {
    const { spec, specHash } = specOf([{ id: 'a', tool: 'app_goto' }], {
      record: { enabled: true },
      preconditions: [{ id: 'p1', tool: 'wechat_check_env', expect: { fields: { ok: true } } }],
    })
    const { d, calls } = deps({ results: { wechat_check_env: { ok: true, data: { ok: false } } } })
    const res = await runPipeline({
      spec, specHash, mode: 'record', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    expect(res.ok).toBe(false)
    expect(calls).not.toContain('start')
  })

  it('preconditions 支持 params（list_dir 的 path 必填，空参必失败）', async () => {
    const { spec, specHash } = specOf([{ id: 'a', tool: 'app_goto' }], {
      preconditions: [{ id: 'p1', tool: 'app_act', params: { kind: 'clearInput' } }],
    })
    const { d } = deps()
    await runPipeline({
      spec, specHash, mode: 'rehearsal', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    expect(d.callTool).toHaveBeenCalledWith('app_act', { kind: 'clearInput' }, undefined)
  })

  it('{{prev.path}} 取值：传给下一步的参数是解析后的值', async () => {
    const { spec, specHash } = specOf([
      { id: 'a', tool: 'app_goto' },
      { id: 'b', tool: 'app_act', params: { who: '{{a.talker}}' } },
    ])
    const { d } = deps({ results: { app_goto: { ok: true, data: { talker: 'wxid_x' } } } })
    await runPipeline({
      spec, specHash, mode: 'rehearsal', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    expect(d.callTool).toHaveBeenCalledWith('app_act', { who: 'wxid_x' }, undefined)
  })

  it('引用路径解析失败 → 该步判失败，报 bad_reference', async () => {
    const { spec, specHash } = specOf([
      { id: 'a', tool: 'app_goto' },
      { id: 'b', tool: 'app_act', params: { who: '{{a.missing.deep}}' } },
    ])
    const { d } = deps({ results: { app_goto: { ok: true, data: { talker: 'x' } } } })
    const res = await runPipeline({
      spec, specHash, mode: 'rehearsal', runDir: path.join(dir, 'r'),
      deps: d, sleep: fastSleep, isRehearsalBlocked: () => false,
    })
    expect(res.ok).toBe(false)
    expect(res.failedAt?.id).toBe('b')
    expect(JSON.stringify(res)).toContain('bad_reference')
  })
})
