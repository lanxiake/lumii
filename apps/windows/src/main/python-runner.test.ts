/**
 * @vitest-environment node
 */
/**
 * PythonRunner 的进程终止行为。
 *
 * 这里多一层意义：python 脚本常自己再 fork 子进程，孙进程占住 stdio 管道会让
 * 'close' 永不触发、Promise 永久挂起——forceKillProcess 的注释写的就是这个故障。
 *
 * 与前三个不同，`forceKillProcess` 在 python-runner 里是**模块级私有函数**，
 * 实例上够不到，只能从调用点（超时路径）观察。因此这里测的是「脚本被终止时
 * 发生了什么」：promise 必然 settle、退出码非零、不会挂死。等 T3 把它提到
 * `main/platform/process-kill.ts` 后，可直接复用 shell-runner.test.ts 的断言。
 *
 * win32 的 taskkill 参数契约由 shell-runner / ts-runner 两处的同构实现覆盖——
 * 四处实现逐字相同，T3.1 会合并成一份。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PythonRunner } from './python-runner'

describe('PythonRunner 超时终止', () => {
  let dir: string
  let script: string

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-py-runner-'))
    script = path.join(dir, 'sleep.py')
    // 睡够长，确保超时先到；print 后 flush 免得被缓冲吞掉
    fs.writeFileSync(script, 'import time\nprint("started", flush=True)\ntime.sleep(60)\n')
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('超时后 execute 返回且不挂起——这是孙进程没能杀掉时的原始故障', async () => {
    const runner = new PythonRunner()
    const res = await runner.execute({
      entryPath: script,
      params: {},
      timeoutMs: 800,
      cwd: dir,
    })

    // 关键断言是「这个 await 返回了」。若进程树没被杀干净，Promise 会永远挂着，
    // 测试会以 30s 超时失败（globals 里的 testTimeout）。
    expect(res).toBeDefined()
    expect(res.success).toBe(false)
  }, 20_000)

  it('超时算失败而不是成功——不能把被杀的脚本当正常结束', async () => {
    const runner = new PythonRunner()
    const res = await runner.execute({
      entryPath: script,
      params: {},
      timeoutMs: 800,
      cwd: dir,
    })

    expect(res.success).toBe(false)
    expect(res.exitCode === 0).toBe(false)
  }, 20_000)

  it('被终止前已产生的输出仍带回来（便于排查卡在哪一步）', async () => {
    const runner = new PythonRunner()
    const res = await runner.execute({
      entryPath: script,
      params: {},
      timeoutMs: 1500,
      cwd: dir,
    })

    expect(res.stdout).toContain('started')
  }, 20_000)

  it('脚本正常结束时返回成功（确认上面测的是超时路径而非普遍失败）', async () => {
    const ok = path.join(dir, 'ok.py')
    fs.writeFileSync(ok, 'print("__SKILL_RESULT__:" + \'{"ok":true}\')\n')

    const runner = new PythonRunner()
    const res = await runner.execute({ entryPath: ok, params: {}, timeoutMs: 10_000, cwd: dir })

    expect(res.success).toBe(true)
  }, 20_000)
})
