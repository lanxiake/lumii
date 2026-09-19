/**
 * @vitest-environment node
 */
/**
 * ShellRunner.forceKillProcess 的行为规格。
 *
 * 为什么单独锁这里：Windows 上 SIGTERM 对 cmd.exe/powershell 子进程树无效，
 * 必须用 `taskkill /pid <pid> /T /F` 杀整棵树——否则孙进程占着 stdio 管道，
 * 'close' 事件永不触发、Promise 永久挂起。
 *
 * **这组测试在 T3.1 之后改过三处断言**，改的是「信号发给谁」而不是「发什么信号」：
 * 原实现 kill 的是 `child.kill(...)`（单进程），收敛到 `platform/process-kill` 后
 * 改走 `process.kill(-pid, ...)`（**进程组**，才能连带孙进程）。这正是本次移植
 * 要引入的变化，测试随之更新——**若当时只让实现去迁就旧测试，进程组收敛就白做了**。
 * 参数契约（`/pid <pid> /T /F`、`timeout`、`windowsHide`）与降级时序原样未动。
 *
 * **`@vitest-environment node` 是必需的**：仓库默认 `environment: 'jsdom'`，
 * 在那里 `vi.mock('node:child_process')` 对被测模块不生效——spy 计数恒为 0，
 * 而模块内跑的是真实 spawnSync，测试会静默假绿。加此指令后 mock 正常命中。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChildProcess } from 'node:child_process'

/** 真实 spawnSync 的返回形状（子集即可） */
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

const ORIGINAL_PLATFORM = process.platform

/** 切平台：直接改 process.platform 属性。
 * 不要用 `vi.stubGlobal('process', {...})`——那会换掉整个 process 对象，
 * 顺带让 `vi.spyOn(process, 'kill')` 装的 spy 失效。 */
function withPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('ShellRunner.forceKillProcess', () => {
  let runner: ShellRunner

  const run = (child: ChildProcess): void => {
    ;(runner as unknown as { forceKillProcess(c: ChildProcess): void }).forceKillProcess(child)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(process, 'kill').mockImplementation(killSpy as never)
    runner = new ShellRunner()
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

    it('走通 taskkill 时不补发信号（避免多杀）', () => {
      run(fakeChild())

      vi.advanceTimersByTime(5000)

      expect(killSpy).not.toHaveBeenCalled()
    })

    it('taskkill 不可用时退化为单进程 SIGKILL', () => {
      // spawnSync 对「命令不存在」**不抛异常**，返回 { error }——收敛前只用
      // try/catch 兜底，那段回退其实是死代码（T3.1 已改为显式检查 error）。
      spawnSyncSpy.mockReturnValueOnce({ error: new Error('ENOENT') })

      run(fakeChild({ pid: 4242 }))

      expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL')
    })
  })

  describe('非 win32 分支（Linux 移植后走的就是这条）', () => {
    beforeEach(() => withPlatform('linux'))

    it('对**进程组**发 SIGTERM（负 pid），不调 taskkill', () => {
      run(fakeChild({ pid: 4242 }))

      // 用负 pid 才能连带孙进程一起收掉；child.kill 只杀单进程。
      expect(killSpy).toHaveBeenCalledTimes(1)
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM')
      expect(spawnSyncSpy).not.toHaveBeenCalled()
    })

    it('2s 内未退出则降级到 SIGKILL', () => {
      run(fakeChild({ pid: 4242 }))

      vi.advanceTimersByTime(1999)
      expect(killSpy).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1)
      expect(killSpy).toHaveBeenNthCalledWith(1, -4242, 'SIGTERM')
      expect(killSpy).toHaveBeenNthCalledWith(2, -4242, 'SIGKILL')
    })

    it('进程组打不到时退回单进程信号（ESRCH 不冒泡给调用方）', () => {
      killSpy.mockImplementation((target: number) => {
        if (target < 0) throw new Error('ESRCH')
      })

      run(fakeChild({ pid: 4242 }))

      expect(killSpy).toHaveBeenCalledWith(4242, 'SIGTERM')
    })
  })

  describe('pid 缺失（先于平台判断）', () => {
    it('pid 为空时直接对 child 发 SIGKILL，不碰 taskkill', () => {
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
