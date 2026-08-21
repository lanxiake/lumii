/**
 * ffmpeg-runner 单测（mock spawn）
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  resetFfmpegRunnerDeps,
  runFfmpeg,
  setFfmpegRunnerDepsForTest,
  webmToMp4,
} from './ffmpeg-runner'

/** 构造假 ChildProcess：可控制 close/error 与 stderr */
function makeFakeChild(opts: {
  code?: number | null
  stderr?: string
  emitError?: Error
}): EventEmitter & {
  stderr: EventEmitter
} {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
  child.stderr = new EventEmitter()
  queueMicrotask(() => {
    if (opts.stderr) child.stderr.emit('data', opts.stderr)
    if (opts.emitError) {
      child.emit('error', opts.emitError)
      return
    }
    child.emit('close', opts.code ?? 0)
  })
  return child
}

describe('runFfmpeg', () => {
  beforeEach(() => {
    setFfmpegRunnerDepsForTest({
      resolveFfmpegPath: () => 'C:/fake/ffmpeg.exe',
      spawn: vi.fn(() => makeFakeChild({ code: 0 })) as never,
    })
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  })

  afterEach(() => {
    resetFfmpegRunnerDeps()
    vi.restoreAllMocks()
  })

  it('exit 0 返回 ok', async () => {
    const r = await runFfmpeg(['-version'])
    expect(r).toEqual({ ok: true })
  })

  it('非 0 退出返回 message', async () => {
    setFfmpegRunnerDepsForTest({
      resolveFfmpegPath: () => 'C:/fake/ffmpeg.exe',
      spawn: vi.fn(() => makeFakeChild({ code: 1, stderr: 'boom' })) as never,
    })
    const r = await runFfmpeg(['-i', 'x'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('boom')
  })
})

describe('webmToMp4', () => {
  afterEach(() => {
    resetFfmpegRunnerDeps()
    vi.restoreAllMocks()
  })

  it('输入不存在时失败', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    const r = await webmToMp4('E:/missing.webm', 'E:/out.mp4')
    expect(r.ok).toBe(false)
  })

  it('成功时传入 H.264/AAC 参数', async () => {
    // 标注入参：否则 mock.calls 元素为空元组 []，断言 calls[0]![1] 会报 TS2493
    const spawn = vi.fn((_cmd?: unknown, _args?: unknown, _opts?: unknown) =>
      makeFakeChild({ code: 0 }),
    )
    setFfmpegRunnerDepsForTest({
      resolveFfmpegPath: () => 'C:/fake/ffmpeg.exe',
      spawn: spawn as never,
    })
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    const r = await webmToMp4('E:/a.webm', 'E:/a.mp4')
    expect(r).toEqual({ ok: true })
    const args = spawn.mock.calls[0]![1] as string[]
    expect(args).toContain('libx264')
    expect(args).toContain('aac')
    expect(args.at(-1)).toMatch(/a\.mp4$/)
  })
})
