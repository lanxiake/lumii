/**
 * @vitest-environment node
 */
/**
 * platform/process-kill 的行为规格。
 *
 * T3.0 已在四个 runner 上锁定了 `forceKillProcess` 的**可观察行为**（那些测试
 * 不改动仍应全绿，是「收敛未改变语义」的凭据）。这里补的是收敛后才存在的部分：
 * `killPidTree` 的外部进程路径、`spawnChildInGroup` 的进程组语义、
 * `killAllTrackedChildren` 的退出兜底。
 *
 * 手法：`@vitest-environment node` + `vi.mock('node:child_process')`。
 * 仓库默认 jsdom 下这个 mock 对被测模块不生效、会静默假绿（见 shell-runner.test.ts）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChildProcess } from 'node:child_process'

type SpawnSyncLike = (...args: unknown[]) => { error?: Error }

const { spawnSyncSpy, spawnSpy, killSpy } = vi.hoisted(() => ({
  spawnSyncSpy: vi.fn<SpawnSyncLike>(() => ({ error: undefined })),
  spawnSpy: vi.fn(),
  killSpy: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: spawnSyncSpy, spawn: spawnSpy }
})

import { EventEmitter } from 'node:events'
import {
  spawnChildInGroup,
  killProcessTree,
  killPidTree,
  killAllTrackedChildren,
  __resetTrackedChildrenForTests,
  __trackedChildCountForTests,
} from './process-kill'

/** 最小可用的假子进程。注意 kill 用**独立**的 spy：
 * 全局的 killSpy 是 `process.kill` 的替身，两者不能混用，否则断言会串。
 *
 * 参数用对象而非默认值：`fakeChild(undefined)` 会命中默认参数拿到 4242，
 * 「pid 缺失」的用例就测不到了（JS 默认参数的经典坑）。 */
function fakeChild(over: { pid?: number | undefined } = {}) {
  const child = new EventEmitter() as unknown as ChildProcess & { pid?: number; kill: () => void }
  Object.assign(child, { pid: 'pid' in over ? over.pid : 4242, kill: vi.fn() })
  return child
}

const ORIGINAL_PLATFORM = process.platform

/** 切平台：直接改 process.platform 属性。
 * 不要用 `vi.stubGlobal('process', {...})`——那会换掉整个 process 对象，
 * 顺带让 `vi.spyOn(process, 'kill')` 装的 spy 失效（模块内读的是新对象的 kill）。 */
function withPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('platform/process-kill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetTrackedChildrenForTests()
    vi.useFakeTimers()
    vi.spyOn(process, 'kill').mockImplementation(killSpy as never)
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
    vi.restoreAllMocks()
  })

  describe('killPidTree — Windows', () => {
    beforeEach(() => {
      withPlatform('win32')
    })

    it('走 taskkill /pid <pid> /T /F', () => {
      killPidTree(4242)

      expect(spawnSyncSpy).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '4242', '/T', '/F'],
        expect.objectContaining({ stdio: 'ignore', timeout: 5000, windowsHide: true }),
      )
    })

    it('taskkill 抛异常时退化为单进程 SIGKILL，不把异常抛给调用方', () => {
      spawnSyncSpy.mockImplementationOnce(() => {
        throw new Error('taskkill 不可用')
      })

      expect(() => killPidTree(4242)).not.toThrow()
      expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL')
    })

    it('非法 pid 直接返回，不做任何事', () => {
      for (const bad of [0, -1, 1.5, NaN]) {
        killPidTree(bad)
      }

      expect(spawnSyncSpy).not.toHaveBeenCalled()
      expect(killSpy).not.toHaveBeenCalled()
    })
  })

  describe('killPidTree — POSIX', () => {
    beforeEach(() => {
      withPlatform('linux')
    })

    it('先对进程组（负 pid）发 SIGTERM', () => {
      killPidTree(4242)

      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM')
    })

    it('2s 后升级到 SIGKILL', () => {
      killPidTree(4242)
      expect(killSpy).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1999)
      expect(killSpy).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1)
      expect(killSpy).toHaveBeenNthCalledWith(1, -4242, 'SIGTERM')
      expect(killSpy).toHaveBeenNthCalledWith(2, -4242, 'SIGKILL')
    })

    it('进程组不可用时退回单进程信号（外部 pid 本就没有组归属）', () => {
      killSpy.mockImplementation((target: number) => {
        if (target < 0) throw new Error('ESRCH')
      })

      killPidTree(4242)

      expect(killSpy).toHaveBeenCalledWith(4242, 'SIGTERM')
    })

    it('进程已退出（单进程也 ESRCH）时不抛异常', () => {
      killSpy.mockImplementation(() => {
        throw new Error('ESRCH')
      })

      expect(() => killPidTree(4242)).not.toThrow()
    })

    it('不调 taskkill（那是 Windows 专属）', () => {
      killPidTree(4242)

      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })
  })

  describe('killProcessTree（四份 forceKillProcess 的收敛目标）', () => {
    it('pid 缺失时直接对 child 发 SIGKILL，不碰进程组', () => {
      const child = fakeChild({ pid: undefined })

      killProcessTree(child)

      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      expect(killSpy).not.toHaveBeenCalled()
    })

    it('有 pid 时委托给 killPidTree', () => {
      withPlatform('linux')
      const child = fakeChild({ pid: 4242 })

      killProcessTree(child)

      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM')
    })
  })

  describe('spawnChildInGroup — POSIX 的进程组前提', () => {
    it('POSIX 下带 detached: true，使子进程自成进程组', () => {
      withPlatform('linux')
      spawnSpy.mockReturnValue(fakeChild({ pid: 1 }))

      spawnChildInGroup('bash', ['-c', 'echo hi'], { stdio: 'ignore' })

      expect(spawnSpy).toHaveBeenCalledWith(
        'bash',
        ['-c', 'echo hi'],
        expect.objectContaining({ detached: true }),
      )
    })

    it('Windows 下不设 detached（会另开控制台窗口，干扰 windowsHide）', () => {
      withPlatform('win32')
      spawnSpy.mockReturnValue(fakeChild({ pid: 1 }))

      spawnChildInGroup('cmd', ['/c', 'echo hi'], { windowsHide: true })

      const opts = spawnSpy.mock.calls[0]![2] as Record<string, unknown>
      expect(opts.detached).toBeUndefined()
      expect(opts.windowsHide).toBe(true)
    })

    it('调用方传入的其它选项原样保留', () => {
      withPlatform('linux')
      spawnSpy.mockReturnValue(fakeChild({ pid: 1 }))

      spawnChildInGroup('bash', [], { cwd: '/tmp', windowsHide: true })

      expect(spawnSpy).toHaveBeenCalledWith(
        'bash',
        [],
        expect.objectContaining({ cwd: '/tmp', windowsHide: true }),
      )
    })
  })

  describe('killAllTrackedChildren — 退出兜底', () => {
    beforeEach(() => {
      withPlatform('linux')
      spawnSpy.mockImplementation(() => fakeChild({ pid: 7777 }))
    })

    it('回收已 spawn 的子进程', () => {
      spawnChildInGroup('bash', [], {})
      expect(__trackedChildCountForTests()).toBe(1)

      const n = killAllTrackedChildren()

      expect(n).toBe(1)
      expect(killSpy).toHaveBeenCalledWith(-7777, 'SIGTERM')
      expect(__trackedChildCountForTests()).toBe(0)
    })

    it('进程已关闭则自动出表，不会被重复回收', () => {
      const child = spawnChildInGroup('bash', [], {})
      child.emit('close')

      expect(__trackedChildCountForTests()).toBe(0)
      expect(killAllTrackedChildren()).toBe(0)
    })

    it('spawn 失败（error 事件）也出表，避免僵尸条目堆积', () => {
      const child = spawnChildInGroup('bash', [], {})
      child.emit('error', new Error('ENOENT'))

      expect(__trackedChildCountForTests()).toBe(0)
    })

    it('没有子进程时返回 0，不报错', () => {
      expect(killAllTrackedChildren()).toBe(0)
    })
  })

  it('平台判定读的是 process.platform（本机 linux 时不该出现 taskkill）', () => {
    expect(ORIGINAL_PLATFORM).toBe('linux')
    killPidTree(4242)

    expect(spawnSyncSpy).not.toHaveBeenCalled()
  })
})
