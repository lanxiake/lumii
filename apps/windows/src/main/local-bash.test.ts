/**
 * @vitest-environment node
 */
/**
 * local-bash.forceKillProcess 通过 executeLocalCommand 的可观察行为验证。
 *
 * 与前三个不同，这份实现是**模块级私有函数**，外部够不到（实例/原型上都拿不到），
 * 只能从调用点（超时 / abort 两条路径）观察。因此这里测的是「命令被终止时发生了什么」
 * ——也就是调用方真正在意的：命令会结束、退出码符合约定、Promise 不会永久挂起。
 *
 * 用真实子进程（`sleep`）而非 mock：既验证了「子进程真的能被打死」这个原始故障，
 * 也保证断言的是端到端行为。win32 的 taskkill 分支由 shell-runner / ts-runner /
 * python-runner 三处的同构实现覆盖——四处实现逐字相同，T3.1 会合并成一份。
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { executeLocalCommand } from './agent-runtime/tool-providers/local-bash'

describe('executeLocalCommand 的进程终止路径', () => {
  it('超时后命令结束且不挂起（promise 必然 settle）', async () => {
    const res = await executeLocalCommand('sleep 30', { timeoutMs: 300 })

    // 关键断言是「这个 await 返回了」——若进程没被杀干净，Promise 会一直挂着。
    expect(res).toBeDefined()
    expect(typeof res.exitCode).toBe('number')
  }, 15_000)

  it('超时终止时退出码非零，而不是静默成功', async () => {
    const res = await executeLocalCommand('sleep 30', { timeoutMs: 300 })

    expect(res.exitCode).not.toBe(0)
  }, 15_000)

  it('abort 信号提前中断：不启动子进程，直接返回 130', async () => {
    const controller = new AbortController()
    controller.abort()

    const res = await executeLocalCommand('sleep 30', { signal: controller.signal })

    expect(res.exitCode).toBe(130)
    expect(res.stderr).toContain('aborted')
    expect(res.stdout).toBe('')
  }, 15_000)

  it('运行中 abort：命令被终止并返回', async () => {
    const controller = new AbortController()
    const promise = executeLocalCommand('sleep 30', { signal: controller.signal, timeoutMs: 10_000 })

    setTimeout(() => controller.abort(), 200)
    const res = await promise

    expect(res.exitCode).not.toBe(0)
  }, 15_000)

  it('正常结束的命令不受影响（确认上面测的是终止路径而非普遍失败）', async () => {
    const res = await executeLocalCommand('echo hello', { timeoutMs: 5000 })

    expect(res.exitCode).toBe(0)
    expect(res.stdout.trim()).toBe('hello')
  }, 15_000)

  it('cwd 生效：命令在指定目录里执行', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-local-bash-'))
    try {
      const res = await executeLocalCommand('pwd', { cwd: dir, timeoutMs: 5000 })

      // macOS 的 /tmp 是符号链接，用 realpath 比较避免平台差异
      expect(fs.realpathSync(res.stdout.trim())).toBe(fs.realpathSync(dir))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
