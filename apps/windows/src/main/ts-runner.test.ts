/**
 * @vitest-environment node
 */
/**
 * TypeScriptRunner.forceKillProcess 的行为规格（与 shell-runner 同构）。
 *
 * 四处 forceKillProcess 是逐字重复的实现，T3 会合并到
 * `main/platform/process-kill.ts`。这里锁的是「合并后 Windows 语义不变」。
 *
 * **`@vitest-environment node` 是必需的**：仓库默认 jsdom 下
 * `vi.mock('node:child_process')` 对被测模块不生效，spy 会静默失效（详见
 * shell-runner.test.ts 文件头）。
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

import { TypeScriptRunner } from './ts-runner'

function fakeChild(over: Partial<{ pid: number | undefined; killed: boolean }> = {}) {
  return {
    pid: 4242,
    killed: false,
    kill: vi.fn(),
    ...over,
  } as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> }
}

describe('TypeScriptRunner.forceKillProcess', () => {
  let runner: TypeScriptRunner

  const run = (child: ChildProcess): void => {
    ;(runner as unknown as { forceKillProcess(c: ChildProcess): void }).forceKillProcess(child)
  }

  beforeEach(() => {
    spawnSyncSpy.mockClear()
    runner = new TypeScriptRunner()
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

    it('走通 taskkill 时不补 kill（避免多杀）', () => {
      const child = fakeChild()
      run(child)

      vi.advanceTimersByTime(5000)

      expect(child.kill).not.toHaveBeenCalled()
    })

    it('taskkill 抛异常时回退到 SIGKILL', () => {
      spawnSyncSpy.mockImplementationOnce(() => {
        throw new Error('taskkill 不可用')
      })
      const child = fakeChild()

      run(child)

      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    })
  })

  describe('非 win32 分支', () => {
    beforeEach(() => {
      vi.stubGlobal('process', { ...process, platform: 'linux' })
    })

    it('2s 内未退出则 SIGTERM → SIGKILL', () => {
      const child = fakeChild({ killed: false })
      run(child)

      vi.advanceTimersByTime(1999)
      expect(child.kill).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1)
      expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
      expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    })

    it('已退出则不再补 SIGKILL', () => {
      const child = fakeChild({ killed: true })
      run(child)

      vi.advanceTimersByTime(5000)

      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    })
  })

  describe('pid 缺失', () => {
    it('pid 为空时直接 SIGKILL', () => {
      const child = fakeChild({ pid: undefined })
      run(child)

      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })
  })
})
