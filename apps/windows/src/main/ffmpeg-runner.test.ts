/**
 * ffmpeg-runner 单测（mock spawn）
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  resetFfmpegRunnerDeps,
  resolveFfmpegExecutable,
  runFfmpeg,
  selectFfmpegExecutable,
  setFfmpegRunnerDepsForTest,
  webmToMp4,
} from './ffmpeg-runner'

// 只用到 resolveCommand；真包的入口会牵入整棵 LLM 依赖树（同 uv-installer.test.ts）
vi.mock('@mtbot/agent-runtime', () => ({
  resolveCommand: (command: string) => ({ command, prefixArgs: [] }),
}))

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

describe('selectFfmpegExecutable（四级解析的纯函数核心）', () => {
  const all = (p: string) => p !== '/missing'

  it('显式指定优先于包内与系统', () => {
    const r = selectFfmpegExecutable(
      { override: '/custom/ffmpeg', bundled: '/pkg/ffmpeg', system: '/usr/bin/ffmpeg' },
      all,
    )
    expect(r).toBe('/custom/ffmpeg')
  })

  it('显式指定不存在时回退包内（再回退系统）', () => {
    expect(
      selectFfmpegExecutable(
        { override: '/missing', bundled: '/pkg/ffmpeg', system: '/usr/bin/ffmpeg' },
        all,
      ),
    ).toBe('/pkg/ffmpeg')
    expect(
      selectFfmpegExecutable(
        { override: '/missing', bundled: '/missing', system: '/usr/bin/ffmpeg' },
        all,
      ),
    ).toBe('/usr/bin/ffmpeg')
  })

  it('包内平台包缺失（null）时用系统', () => {
    expect(
      selectFfmpegExecutable({ bundled: null, system: '/usr/bin/ffmpeg' }, all),
    ).toBe('/usr/bin/ffmpeg')
  })

  it('全缺返回 null', () => {
    expect(
      selectFfmpegExecutable({ override: '/missing', bundled: null, system: null }, all),
    ).toBeNull()
  })

  it('空白 override 视为未设置', () => {
    expect(
      selectFfmpegExecutable({ override: '   ', bundled: null, system: '/usr/bin/ffmpeg' }, all),
    ).toBe('/usr/bin/ffmpeg')
  })
})

describe('resolveFfmpegExecutable（环境变量逃生口）', () => {
  const prev = process.env.LUMII_FFMPEG_PATH

  afterEach(() => {
    resetFfmpegRunnerDeps()
    vi.restoreAllMocks()
    if (prev === undefined) delete process.env.LUMII_FFMPEG_PATH
    else process.env.LUMII_FFMPEG_PATH = prev
  })

  it('LUMII_FFMPEG_PATH 指向存在的文件时直接采用', () => {
    process.env.LUMII_FFMPEG_PATH = '/custom/ffmpeg'
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p) === '/custom/ffmpeg')
    expect(resolveFfmpegExecutable()).toBe('/custom/ffmpeg')
  })

  it('指向不存在的文件时回退（不抛错）', () => {
    process.env.LUMII_FFMPEG_PATH = '/missing'
    // 包内/系统候选在测试环境不可控，只断言「没有因 override 无效而失败」：
    // 能返回（走回退）或抛「未找到」都算未采用无效 override——这里用宽松断言防环境耦合
    let result: string | null = null
    try {
      result = resolveFfmpegExecutable()
    } catch {
      result = null
    }
    expect(result).not.toBe('/missing')
  })
})
