/**
 * @vitest-environment node
 */
/**
 * ShellRunner.forceKillProcess 的行为规格。
 *
 * 为什么单独锁这里：Windows 上 SIGTERM 对 cmd.exe/powershell 子进程树无效，
 * 必须用 `taskkill /pid <pid> /T /F` 杀整棵树——否则孙进程占着 stdio 管道，
 * 'close' 事件永不触发、Promise 永久挂起。T3 平台抽象层会把这段搬到
 * `main/platform/process-kill.ts`，这些测试是「Windows 语义不被改坏」的证据：
 * 实现搬运后它们应当原样通过。
 *
 * **`@vitest-environment node` 是必需的**：仓库默认 `environment: 'jsdom'`，
 * 在那里 `vi.mock('node:child_process')` 对被测模块不生效——spy 计数恒为 0，
 * 而模块内跑的是真实 spawnSync，测试会静默假绿。加此指令后 mock 正常命中，
 * 可直接断言 taskkill 的完整参数。同目录的 `local-proxy.test.ts` 也是这个理由。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChildProcess } from 'node:child_process'

/** 真实 spawnSync 的返回形状（子集即可，forceKillProcess 只透传不读字段） */
type SpawnSyncLike = (...args: unknown[]) => {
  pid?: number
  output?: unknown[]
  stdout?: string
  stderr?: string
  status?: number | null
  signal?: unknown
  error?: Error
}

const { spawnSyncSpy } = vi.hoisted(() => ({
  spawnSyncSpy: vi.fn<SpawnSyncLike>(() => ({ error: undefined })),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: spawnSyncSpy }
})

import { ShellRunner } from './shell-runner'

/** 假子进程：只暴露 forceKillProcess 真正用到的两个字段 */
function fakeChild(over: Partial<{ pid: number | undefined; killed: boolean }> = {}) {
  return {
    pid: 4242,
    killed: false,
    kill: vi.fn(),
    ...over,
  } as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> }
}

describe('ShellRunner.forceKillProcess', () => {
  let runner: ShellRunner

  const run = (child: ChildProcess): void => {
    ;(runner as unknown as { forceKillProcess(c: ChildProcess): void }).forceKillProcess(child)
  }

  beforeEach(() => {
    spawnSyncSpy.mockClear()
    runner = new ShellRunner()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  describe('win32 分支', () => {
    beforeEach(() => {
      vi.stubGlobal('process', { ...process, platform: 'win32' })
    })

    it('用 taskkill 杀整棵进程树，参数为 /pid <pid> /T /F', () => {
      run(fakeChild({ pid: 4242 }))

      expect(spawnSyncSpy).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '4242', '/T', '/F'],
        expect.objectContaining({ stdio: 'ignore', timeout: 5000, windowsHide: true }),
      )
    })

    it('参数顺序是 /pid <pid> /T /F——taskkill 不接受乱序', () => {
      run(fakeChild({ pid: 7 }))

      const args = spawnSyncSpy.mock.calls[0]![1] as string[]
      expect(args).toEqual(['/pid', '7', '/T', '/F'])
      expect(args.indexOf('/pid')).toBeLessThan(args.indexOf('/T'))
      expect(args.indexOf('/T')).toBeLessThan(args.indexOf('/F'))
    })

    it('pid 原样传给 /pid', () => {
      run(fakeChild({ pid: 987654 }))

      const args = spawnSyncSpy.mock.calls[0]![1] as string[]
      expect(args[args.indexOf('/pid') + 1]).toBe('987654')
    })

    it('走通 taskkill 时不补 kill（避免多杀）', () => {
      const child = fakeChild()
      run(child)

      vi.advanceTimersByTime(5000)

      expect(child.kill).not.toHaveBeenCalled()
    })

    it('taskkill 抛异常时回退到 child.kill(SIGKILL)', () => {
      spawnSyncSpy.mockImplementationOnce(() => {
        throw new Error('taskkill 不可用')
      })
      const child = fakeChild()

      run(child)

      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    })
  })

  describe('非 win32 分支（Linux 移植后走的就是这条）', () => {
    beforeEach(() => {
      vi.stubGlobal('process', { ...process, platform: 'linux' })
    })

    it('先发 SIGTERM，不调 taskkill', () => {
      const child = fakeChild()
      run(child)

      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })

    it('2s 内未退出则降级到 SIGKILL', () => {
      const child = fakeChild({ killed: false })
      run(child)

      vi.advanceTimersByTime(1999)
      expect(child.kill).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1)
      expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
      expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    })

    it('已退出（killed=true）则不再补 SIGKILL', () => {
      const child = fakeChild({ killed: true })
      run(child)

      vi.advanceTimersByTime(5000)

      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    })
  })

  describe('pid 缺失（先于平台判断）', () => {
    it('pid 为空时直接 SIGKILL，不碰 taskkill', () => {
      const child = fakeChild({ pid: undefined })
      run(child)

      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })

    it('pid 为 0 也按缺失处理', () => {
      const child = fakeChild({ pid: 0 })
      run(child)

      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })
  })
})
