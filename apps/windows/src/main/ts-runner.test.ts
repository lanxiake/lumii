/**
 * @vitest-environment node
 */
/**
 * TypeScriptRunner.forceKillProcess 的行为规格（与 shell-runner 同构）。
 *
 * 四处 forceKillProcess 已由 T3.1 收敛到 `main/platform/process-kill.ts`。
 * 断言随收敛更新：POSIX 侧信号从 `child.kill` 改为 `process.kill(-pid)`
 * （进程组才能连带孙进程）。参数契约与降级时序未变。
 *
 * **`@vitest-environment node` 是必需的**：仓库默认 jsdom 下
 * `vi.mock('node:child_process')` 对被测模块不生效、会静默假绿（详见 shell-runner.test.ts）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChildProcess } from 'node:child_process'

type SpawnSyncLike = (...args: unknown[]) => {
  pid?: number
  output?: unknown[]
  stdout?: string
  stderr?: string
  status?: number | null
  signal?: unknown
  error?: Error
}

const { spawnSyncSpy, killSpy } = vi.hoisted(() => ({
  spawnSyncSpy: vi.fn<SpawnSyncLike>(() => ({ error: undefined })),
  killSpy: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: spawnSyncSpy }
})

import { TypeScriptRunner } from './ts-runner'

function fakeChild(over: Partial<{ pid: number | undefined; killed: boolean }> = {}) {
  return {
    pid: 4242,
    killed: false,
    kill: vi.fn(),
    ...over,
  } as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> }
}

const ORIGINAL_PLATFORM = process.platform

function withPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('TypeScriptRunner.forceKillProcess', () => {
  let runner: TypeScriptRunner

  const run = (child: ChildProcess): void => {
    ;(runner as unknown as { forceKillProcess(c: ChildProcess): void }).forceKillProcess(child)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(process, 'kill').mockImplementation(killSpy as never)
    runner = new TypeScriptRunner()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
    vi.restoreAllMocks()
  })

  describe('win32 分支', () => {
    beforeEach(() => withPlatform('win32'))

    it('用 taskkill 杀整棵进程树，参数为 /pid <pid> /T /F', () => {
      run(fakeChild({ pid: 4242 }))

      expect(spawnSyncSpy).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '4242', '/T', '/F'],
        expect.objectContaining({ stdio: 'ignore', timeout: 5000, windowsHide: true }),
      )
    })

    it('走通 taskkill 时不补发信号（避免多杀）', () => {
      run(fakeChild())

      vi.advanceTimersByTime(5000)

      expect(killSpy).not.toHaveBeenCalled()
    })

    it('taskkill 不可用时退化为单进程 SIGKILL', () => {
      spawnSyncSpy.mockReturnValueOnce({ error: new Error('ENOENT') })

      run(fakeChild({ pid: 4242 }))

      expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL')
    })
  })

  describe('非 win32 分支', () => {
    beforeEach(() => withPlatform('linux'))

    it('对进程组（负 pid）发 SIGTERM，2s 后降级 SIGKILL', () => {
      run(fakeChild({ pid: 4242 }))

      expect(killSpy).toHaveBeenNthCalledWith(1, -4242, 'SIGTERM')

      vi.advanceTimersByTime(1999)
      expect(killSpy).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1)
      expect(killSpy).toHaveBeenNthCalledWith(2, -4242, 'SIGKILL')
    })
  })

  describe('pid 缺失', () => {
    it('pid 为空时直接对 child 发 SIGKILL', () => {
      const child = fakeChild({ pid: undefined })
      run(child)

      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })
  })
})
