/**
 * @vitest-environment node
 */
/**
 * 回归：子进程被 kill 后若 'close' 永不触发，executeLocalCommand 仍必须 settle。
 *
 * 真实故障（2026-11-01）：Git Bash 下 `adb devices` 冷启动 `fork-server --reply-fd`
 * 挂死；超时 taskkill 后 stdio 管道仍被孙子进程占着，'close' 不来 → Promise 永久
 * 挂起 → 会话锁 20+ 分钟。`sleep` 类真实进程测不到这条路径（它们会被干净杀掉并
 * 正常 close），必须用永不 emit close 的假子进程锁住契约。
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./platform/process-kill', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./platform/process-kill')>()
  return {
    ...actual,
    spawnChildInGroup: vi.fn(),
    killProcessTree: vi.fn(),
  }
})

import { killProcessTree, spawnChildInGroup } from './platform/process-kill'
import { executeLocalCommand } from './agent-runtime/tool-providers/local-bash'

/** 构造永不触发 close/error 的假 ChildProcess（只够 local-bash 读写的字段） */
function makeHangChild(): EventEmitter & {
  pid: number
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
  }
  child.pid = 4242
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}

describe('executeLocalCommand：close 永不触发时仍 settle', () => {
  beforeEach(() => {
    vi.mocked(spawnChildInGroup).mockReset()
    vi.mocked(killProcessTree).mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('超时后即使 close 不来，Promise 也在 timeoutMs 内 resolve', async () => {
    const child = makeHangChild()
    vi.mocked(spawnChildInGroup).mockReturnValue(child as never)

    const started = Date.now()
    const res = await executeLocalCommand('adb devices', { timeoutMs: 80 })
    const elapsed = Date.now() - started

    expect(killProcessTree).toHaveBeenCalled()
    expect(res.exitCode).toBe(124)
    expect(res.stderr).toContain('timed out')
    // 远小于默认 120s；给事件循环一点余量
    expect(elapsed).toBeLessThan(3000)
  }, 10_000)

  it('abort 后即使 close 不来，Promise 也立刻 resolve', async () => {
    const child = makeHangChild()
    vi.mocked(spawnChildInGroup).mockReturnValue(child as never)

    const controller = new AbortController()
    const promise = executeLocalCommand('adb devices', {
      signal: controller.signal,
      timeoutMs: 30_000,
    })
    setTimeout(() => controller.abort(), 30)

    const started = Date.now()
    const res = await promise
    const elapsed = Date.now() - started

    expect(killProcessTree).toHaveBeenCalled()
    expect(res.exitCode).toBe(130)
    expect(res.stderr).toContain('aborted')
    expect(elapsed).toBeLessThan(3000)
  }, 10_000)
})
