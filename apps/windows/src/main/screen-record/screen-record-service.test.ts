/**
 * ScreenRecordService 单测（设计 §9.1）
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  createScreenRecordService,
  type ScreenRecordService,
  type ScreenRecordServiceDeps,
  type ScreenRecordWriteStream,
} from './screen-record-service'
import type { ScreenRecordSource, ScreenRecordStatus } from '../../shared/screen-record'
import { MIN_FREE_DISK_BYTES } from '../../shared/screen-record'

/** 取当前状态；查询失败返回 undefined（避免联合类型多次调用无法收窄） */
function statusOf(svc: ScreenRecordService): ScreenRecordStatus | undefined {
  const r = svc.getStatus()
  return r.ok ? r.status : undefined
}

/** 取当前会话 id；无会话返回空串 */
function sessionIdOf(svc: ScreenRecordService): string {
  const r = svc.getStatus()
  return r.ok ? (r.sessionId ?? '') : ''
}

/** 假源：第 0 个是 Lumii 自身（isLumii=true） */
const FAKE_SOURCES: ScreenRecordSource[] = [
  {
    sourceId: 'lumii-id',
    name: '灵栖 Lumii',
    type: 'window',
    isLumii: true,
    thumbnailDataUrl: '',
  },
  {
    sourceId: 'screen-1',
    name: 'Screen 1',
    type: 'screen',
    isLumii: false,
    thumbnailDataUrl: '',
    displayId: '1',
  },
  {
    sourceId: 'notepad',
    name: '无标题 - 记事本',
    type: 'window',
    isLumii: false,
    thumbnailDataUrl: '',
  },
]

/** 构造成功写流 mock */
function makeWriter(path = 'E:/tmp/recording-20260815-120000.webm'): ScreenRecordWriteStream {
  let bytes = 0
  const chunks: Uint8Array[] = []
  return {
    path,
    write: (buf: Uint8Array) => {
      chunks.push(buf)
      bytes += buf.byteLength
    },
    end: async () => undefined,
    bytesWritten: () => bytes,
    unlinkIfEmpty: async () => {
      if (bytes === 0) return true
      return false
    },
  }
}

/** 构造可注入的假依赖 */
function makeFakeDeps(
  overrides: Partial<ScreenRecordServiceDeps> & {
    enabled?: boolean
    alwaysAllow?: boolean
    includeMicDefault?: boolean
    confirmTimeoutSec?: number
  } = {},
): ScreenRecordServiceDeps {
  const {
    enabled = true,
    alwaysAllow = false,
    includeMicDefault = true,
    confirmTimeoutSec = 120,
    ...rest
  } = overrides

  let clock = 1_000_000
  return {
    getSources: async () => FAKE_SOURCES.slice(),
    readSettings: async () => ({
      enabled,
      alwaysAllow,
      includeMicDefault,
      includeSystemAudioDefault: true,
      exportMp4Default: false,
      narrateOriginalAudioGain: 0.35,
      confirmTimeoutSec,
    }),
    resolveRecordingsDir: () => 'E:/tmp/recordings',
    getFreeDiskBytes: async () => MIN_FREE_DISK_BYTES + 1024,
    notifyRendererStartCapture: vi.fn(),
    notifyRendererStopCapture: vi.fn(),
    notifyRendererPauseCapture: vi.fn(),
    notifyRendererResumeCapture: vi.fn(),
    notifyRendererCancelled: vi.fn(),
    notifyRendererConfirmRequested: vi.fn(),
    emitStatusChanged: vi.fn(),
    createWriteStream: async () => makeWriter(),
    nowMs: () => clock,
    advanceMs: (ms: number) => {
      clock += ms
    },
    persistAlwaysAllow: vi.fn(async () => undefined),
    ...rest,
  }
}

describe('ScreenRecordService — 状态机基础（设计 §9.1）', () => {
  let svc: ScreenRecordService
  let deps: ScreenRecordServiceDeps

  beforeEach(() => {
    vi.useFakeTimers()
    deps = makeFakeDeps()
    svc = createScreenRecordService(deps)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('初始 idle', () => {
    expect(statusOf(svc)).toBe('idle')
  })

  it('idle → recording（Lumii 自身源免确认）', async () => {
    const r = await svc.start({ sourceId: 'lumii-id' })
    expect(r.ok && r.status).toBe('recording')
    expect(statusOf(svc)).toBe('recording')
  })

  it('重复 start 返回 already_recording（幂等不叠态）', async () => {
    await svc.start({ sourceId: 'lumii-id' })
    const r = await svc.start({ sourceId: 'screen-1' })
    expect(!r.ok && r.error).toBe('already_recording')
  })

  it('idle stop → no_active_session（幂等）', async () => {
    const r = await svc.stop()
    expect(!r.ok && r.error).toBe('no_active_session')
  })

  it('pending_confirm → stop 取消确认回 idle', async () => {
    const r1 = await svc.start({ sourceId: 'screen-1' })
    expect(r1.ok && r1.status).toBe('needs_confirmation')
    expect(statusOf(svc)).toBe('pending_confirm')
    const r2 = await svc.stop()
    expect(r2.ok).toBe(true)
    expect(statusOf(svc)).toBe('idle')
  })

  it('非自身源 + alwaysAllow=true → 直接 recording，跳过 pending_confirm', async () => {
    deps = makeFakeDeps({ alwaysAllow: true })
    svc = createScreenRecordService(deps)
    const r = await svc.start({ sourceId: 'screen-1' })
    expect(r.ok && r.status).toBe('recording')
  })

  it('start 时源已消失 → source_unavailable（重验证）', async () => {
    const d = makeFakeDeps()
    d.getSources = async () => FAKE_SOURCES.slice(0, 1)
    svc = createScreenRecordService(d)
    const r = await svc.start({ sourceId: 'notepad' })
    expect(!r.ok && r.error).toBe('source_unavailable')
  })

  it('磁盘 < 500MB → insufficient_disk_space（不开流）', async () => {
    const d = makeFakeDeps()
    d.getFreeDiskBytes = async () => 499 * 1024 * 1024
    svc = createScreenRecordService(d)
    const r = await svc.start({ sourceId: 'lumii-id' })
    expect(!r.ok && r.error).toBe('insufficient_disk_space')
  })

  it('总开关 enabled=false → 四操作均 disabled', async () => {
    const d = makeFakeDeps({ enabled: false })
    svc = createScreenRecordService(d)
    expect((await svc.listSources()).ok).toBe(false)
    const startResult = await svc.start({ sourceId: 'lumii-id' })
    expect(!startResult.ok && startResult.error).toBe('disabled')
    const stopResult = await svc.stop()
    expect(!stopResult.ok && stopResult.error).toBe('disabled')
    const statusResult = svc.getStatus()
    expect(!statusResult.ok && statusResult.error).toBe('disabled')
  })

  it('maxDurationSec > 7200 截断为 7200（不报错）', async () => {
    const d = makeFakeDeps()
    let captured: unknown = null
    d.notifyRendererStartCapture = (_s, _src, _mic, max) => {
      captured = max
    }
    svc = createScreenRecordService(d)
    await svc.start({ sourceId: 'lumii-id', maxDurationSec: 99999 })
    expect(captured).toBe(7200)
  })

  it('两个快速 start 并发保护', async () => {
    const p1 = svc.start({ sourceId: 'lumii-id' })
    const p2 = svc.start({ sourceId: 'screen-1' })
    const [r1, r2] = await Promise.all([p1, p2])
    const oks = [r1, r2].filter((r) => r.ok)
    const errs = [r1, r2].filter((r) => !r.ok)
    expect(oks.length).toBe(1)
    expect(errs.length).toBe(1)
    expect(!errs[0]!.ok && errs[0]!.error).toBe('already_recording')
  })

  it('确认超时后回 idle 且 reason=confirmation_timeout', async () => {
    const d = makeFakeDeps({ confirmTimeoutSec: 2 })
    svc = createScreenRecordService(d)
    const r = await svc.start({ sourceId: 'screen-1' })
    expect(r.ok && r.status).toBe('needs_confirmation')
    await vi.advanceTimersByTimeAsync(2100)
    expect(statusOf(svc)).toBe('idle')
    expect(d.notifyRendererCancelled).toHaveBeenCalledWith(
      expect.any(String),
      'confirmation_timeout',
    )
  })

  it('permission_denied：pending 中拒绝回 idle', async () => {
    const r1 = await svc.start({ sourceId: 'screen-1' })
    expect(r1.ok && r1.status).toBe('needs_confirmation')
    const sessionId = r1.ok && r1.status === 'needs_confirmation' ? r1.sessionId : ''
    await svc.respondConfirm({ sessionId, allow: false })
    expect(statusOf(svc)).toBe('idle')
    expect(deps.notifyRendererCancelled).toHaveBeenCalledWith(sessionId, 'permission_denied')
  })

  it('before-quit flush：recording 态 finalize 后 idle', async () => {
    await svc.start({ sourceId: 'lumii-id' })
    await svc.handleChunk({
      sessionId: sessionIdOf(svc),
      chunkBase64: Buffer.from('webm').toString('base64'),
      index: 0,
      isLast: false,
    })
    await svc.flushBeforeQuit()
    expect(statusOf(svc)).toBe('idle')
  })

  it('handleRendererGone：recording 态标 capture_failed 并 finalize', async () => {
    await svc.start({ sourceId: 'lumii-id' })
    const sessionId = sessionIdOf(svc)
    await svc.handleChunk({
      sessionId,
      chunkBase64: Buffer.from('abcd').toString('base64'),
      index: 0,
      isLast: false,
    })
    await svc.handleRendererGone()
    const stop = await svc.stop()
    // 已 idle，再次 stop 为 no_active_session；崩溃路径在 handleRendererGone 内 finalize
    expect(!stop.ok && stop.error).toBe('no_active_session')
    expect(statusOf(svc)).toBe('idle')
  })

  it('用户允许确认后进入 recording', async () => {
    const r1 = await svc.start({ sourceId: 'screen-1' })
    expect(r1.ok && r1.status).toBe('needs_confirmation')
    const sessionId = r1.ok && r1.status === 'needs_confirmation' ? r1.sessionId : ''
    await svc.respondConfirm({ sessionId, allow: true })
    expect(statusOf(svc)).toBe('recording')
  })

  it('listSources 透传 includeThumbnail', async () => {
    const d = makeFakeDeps()
    let seen: boolean | undefined
    d.getSources = async (includeThumbnail) => {
      seen = includeThumbnail
      return FAKE_SOURCES
    }
    svc = createScreenRecordService(d)
    await svc.listSources()
    expect(seen).toBe(false)
    await svc.listSources(true)
    expect(seen).toBe(true)
  })

  it('recording → paused → resume → recording；暂停墙钟不计 elapsed', async () => {
    await svc.start({ sourceId: 'lumii-id' })
    deps.advanceMs?.(3_000)
    const p1 = await svc.pause()
    expect(p1.ok && p1.status).toBe('paused')
    expect(statusOf(svc)).toBe('paused')
    expect(p1.ok && p1.elapsedMs).toBe(3_000)
    expect(deps.notifyRendererPauseCapture).toHaveBeenCalled()

    deps.advanceMs?.(5_000)
    const st = svc.getStatus()
    expect(st.ok && st.elapsedMs).toBe(3_000)

    const r = await svc.resume()
    expect(r.ok && r.status).toBe('recording')
    expect(deps.notifyRendererResumeCapture).toHaveBeenCalled()
    deps.advanceMs?.(2_000)
    await svc.handleChunk({
      sessionId: sessionIdOf(svc),
      chunkBase64: Buffer.from('x').toString('base64'),
      index: 0,
      isLast: false,
    })
    const stop = await svc.stop()
    expect(stop.ok && stop.durationMs).toBe(5_000)
  })

  it('pause 在 idle → not_recording；resume 在 recording → not_paused', async () => {
    const p = await svc.pause()
    expect(!p.ok && p.error).toBe('not_recording')
    await svc.start({ sourceId: 'lumii-id' })
    const r = await svc.resume()
    expect(!r.ok && r.error).toBe('not_paused')
  })

  it('stop from paused 可 finalize', async () => {
    await svc.start({ sourceId: 'lumii-id' })
    await svc.handleChunk({
      sessionId: sessionIdOf(svc),
      chunkBase64: Buffer.from('webm').toString('base64'),
      index: 0,
      isLast: false,
    })
    await svc.pause()
    const stop = await svc.stop()
    expect(stop.ok).toBe(true)
    expect(statusOf(svc)).toBe('idle')
  })

  it('exportMp4 成功返回 mp4Path；失败 warning=mp4_failed 仍保留 webm', async () => {
    const convertOk = vi.fn(async () => ({ ok: true as const }))
    const depsOk = makeFakeDeps({ convertWebmToMp4: convertOk })
    const svcOk = createScreenRecordService(depsOk)
    await svcOk.start({ sourceId: 'lumii-id' })
    await svcOk.handleChunk({
      sessionId: sessionIdOf(svcOk),
      chunkBase64: Buffer.from('webm').toString('base64'),
      index: 0,
      isLast: false,
    })
    const r1 = await svcOk.stop({ exportMp4: true })
    expect(r1.ok).toBe(true)
    if (r1.ok) {
      expect(r1.mp4Path).toMatch(/\.mp4$/)
      expect(convertOk).toHaveBeenCalled()
    }

    const convertFail = vi.fn(async () => ({ ok: false as const, message: 'boom' }))
    const depsFail = makeFakeDeps({ convertWebmToMp4: convertFail })
    const svcFail = createScreenRecordService(depsFail)
    await svcFail.start({ sourceId: 'lumii-id' })
    await svcFail.handleChunk({
      sessionId: sessionIdOf(svcFail),
      chunkBase64: Buffer.from('webm').toString('base64'),
      index: 0,
      isLast: false,
    })
    const r2 = await svcFail.stop({ exportMp4: true })
    expect(r2.ok).toBe(true)
    if (r2.ok) {
      expect(r2.path).toMatch(/\.webm$/)
      expect(r2.mp4Path).toBeUndefined()
      expect(r2.warning).toBe('mp4_failed')
    }
  })
})
