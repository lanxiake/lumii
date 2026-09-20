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

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ShellRunner, findPwshExecutable } from './shell-runner'

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

/**
 * `describeUnsupported` 的用户可见文案。
 *
 * 一期验收有一条：「.bat/.cmd 技能执行给出『请改用 .sh』的明确报错」。原先的记录说
 * T3.2 时端到端验过一次，但**没留下可复跑的东西**——结论写在文档里、证据在当时的终端里。
 * 这里把它变成断言。
 *
 * 为什么值得锁：文案本身是功能的一部分。收敛前这里报「不支持的脚本类型: .bat」，
 * Linux 用户看到它不知道该换脚本还是换系统——脚本类型没问题，是平台不匹配。
 */
describe('ShellRunner.execute —— 平台不匹配时的报错文案', () => {
  const runner = new ShellRunner()

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
  })

  const run = (entryPath: string) =>
    runner.execute({ entryPath, params: {}, timeoutMs: 5000 })

  describe('非 win32', () => {
    beforeEach(() => withPlatform('linux'))

    it.each(['run.bat', 'run.cmd'])('%s：给出「改用 .sh」的可操作指引', async (name) => {
      const res = await run(`/skills/demo/${name}`)

      expect(res.success).toBe(false)
      expect(res.error).toContain('Windows 批处理脚本')
      expect(res.error).toContain('改用 .sh')
      // 关键：不能退回那句让人无从下手的笼统报错
      expect(res.error).not.toContain('不支持的脚本类型')
    })

    it('.bat 与 .cmd 各自报出自己的扩展名（用户才能对上是哪个文件）', async () => {
      expect((await run('/skills/demo/run.bat')).error).toContain('（.bat）')
      expect((await run('/skills/demo/run.cmd')).error).toContain('（.cmd）')
    })
  })

  it('真的不支持的扩展名仍走笼统报错（两个平台一致）', async () => {
    const res = await run('/skills/demo/run.py')

    expect(res.success).toBe(false)
    expect(res.error).toBe('不支持的脚本类型: .py')
  })

  it('无扩展名时显示占位，不留空', async () => {
    const res = await run('/skills/demo/noext')

    expect(res.error).toBe('不支持的脚本类型: (无扩展名)')
  })
})

/**
 * `.ps1` 的 pwsh 探测。
 *
 * 修的是这样一条死路：`resolveShell()` 对 `.ps1` **无条件**返回 `{ command: 'pwsh' }`，
 * 于是 `describeUnsupported()` 里那句「当前平台需要先安装 pwsh」**永远不会被执行到**。
 * 没装 pwsh 的 Linux 上，用户看到的是 spawn 阶段的 ENOENT，不知道该去装什么。
 *
 * 现在探测放在解析期。探测本身用注入的 `exists` 测，确定性、不依赖本机装没装 pwsh
 * ——否则这台机器哪天装上 pwsh，用例就会莫名其妙地红。
 */
describe('ShellRunner —— .ps1 的 pwsh 探测', () => {
  const runner = new ShellRunner()
  const never = () => false
  const always = () => true

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
  })

  describe('findPwshExecutable', () => {
    it('well-known 目录里有就返回它（覆盖「装了但没进 PATH」）', () => {
      // 只放行 well-known 那一批，PATH 里的全判否
      const before = process.env.PATH
      process.env.PATH = '/nonexistent-dir-for-test'
      try {
        const found = findPwshExecutable((p) => p === '/usr/bin/pwsh')
        expect(found).toBe('/usr/bin/pwsh')
      } finally {
        process.env.PATH = before
      }
    })

    it('PATH 里有就返回 PATH 里的那个', () => {
      const before = process.env.PATH
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwsh-probe-'))
      try {
        process.env.PATH = dir
        const expected = path.join(dir, 'pwsh')
        expect(findPwshExecutable((p) => p === expected)).toBe(expected)
      } finally {
        process.env.PATH = before
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('哪都没有则返回 null', () => {
      expect(findPwshExecutable(never)).toBeNull()
    })
  })

  describe('resolveShell(".ps1")', () => {
    it('非 win32 且**没装** pwsh：返回 null，好让调用方给出「请先安装 pwsh」', () => {
      withPlatform('linux')

      expect(runner.resolveShell('/skills/demo/run.ps1', { exists: never })).toBeNull()
    })

    it('非 win32 且装了 pwsh：照常走 pwsh（别把能用的路径一起挡掉）', () => {
      withPlatform('linux')

      expect(runner.resolveShell('/skills/demo/run.ps1', { exists: always })).toEqual({
        command: 'pwsh',
        args: ['-File', '/skills/demo/run.ps1'],
      })
    })

    it('win32 走 powershell.exe，与 pwsh 探测无关', () => {
      withPlatform('win32')

      expect(runner.resolveShell('/skills/demo/run.ps1', { exists: never })).toEqual({
        command: 'powershell.exe',
        args: ['-ExecutionPolicy', 'Bypass', '-File', '/skills/demo/run.ps1'],
      })
    })
  })

  it('端到端：解析不出 shell 时报出可操作的那句话，而不是底层 ENOENT', async () => {
    withPlatform('linux')
    // 这一条测的是「describeUnsupported 真的会被走到」——即上面那两环的**接线**。
    // 探测逻辑本身由上一条覆盖，这里把 resolveShell 打桩成「什么都没解析出来」。
    vi.spyOn(runner, 'resolveShell').mockReturnValue(null)

    const res = await runner.execute({
      entryPath: '/skills/demo/run.ps1',
      params: {},
      timeoutMs: 5000,
    })

    expect(res.success).toBe(false)
    expect(res.error).toContain('pwsh')
    expect(res.error).toContain('PowerShell Core')
    expect(res.error).not.toContain('不支持的脚本类型')
  })
})
