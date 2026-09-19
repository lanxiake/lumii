/**
 * @vitest-environment node
 */
/**
 * 进程组终止的**真实进程**验证。
 *
 * 为什么单独一文件：其余测试都用假 child + spy 断言「发了什么信号」，那只能证明
 * 调用形状，证明不了「孙进程真的死了」。而这里正是本次移植的核心收益——
 *
 *   收敛前 `child.kill('SIGTERM')` 只杀直接子进程。若脚本又 fork 了子进程
 *   （`bash -c` 里再起 python 是最常见的），孙进程会活下来占住 stdio 管道，
 *   `'close'` 事件永不触发，调用方的 Promise 永久挂起。
 *   收敛后统一发进程组信号（负 pid），整棵树一起收。
 *
 * 用真实 `sh` + 后台 `sleep` 造出「父-孙」结构，断言孙进程在 kill 后确实消失。
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnChildInGroup, killProcessTree, killPidTree } from './process-kill'

/** 进程是否还活着（signal 0 只做存在性检查，不真的发信号） */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return predicate()
}

describe('进程组终止（真实进程）', () => {
  it('killProcessTree 连带收掉孙进程', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-tree-'))
    const pidFile = path.join(dir, 'grandchild.pid')

    // 父 sh 起一个后台 sleep（孙），把孙 pid 写盘后自己也 sleep 住
    const child = spawnChildInGroup(
      'sh',
      ['-c', `sleep 300 & echo $! > ${pidFile}; sleep 300`],
      { stdio: 'ignore' },
    )

    const wrote = await waitUntil(() => fs.existsSync(pidFile))
    expect(wrote).toBe(true)
    const grandPid = Number(fs.readFileSync(pidFile, 'utf8').trim())

    // 前置断言：孙进程确实活着（否则后面的「死了」说明不了问题）
    expect(isAlive(grandPid)).toBe(true)

    killProcessTree(child)

    const died = await waitUntil(() => !isAlive(grandPid))
    expect(died).toBe(true)

    fs.rmSync(dir, { recursive: true, force: true })
  }, 30_000)

  it('killPidTree 对任意外部 pid 同样连带子树', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-tree-'))
    const pidFile = path.join(dir, 'grandchild.pid')

    const child = spawnChildInGroup(
      'sh',
      ['-c', `sleep 300 & echo $! > ${pidFile}; sleep 300`],
      { stdio: 'ignore' },
    )

    const wrote = await waitUntil(() => fs.existsSync(pidFile))
    expect(wrote).toBe(true)
    const grandPid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    expect(isAlive(grandPid)).toBe(true)

    // 用 pid 版（browser-service / system-service 走的就是这条）
    killPidTree(child.pid!)

    expect(await waitUntil(() => !isAlive(grandPid))).toBe(true)

    fs.rmSync(dir, { recursive: true, force: true })
  }, 30_000)

  it('detached 之后管道 stdio 与 close 事件仍正常（回归）', async () => {
    const child = spawnChildInGroup('sh', ['-c', 'echo ok; exit 0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString()
    })

    const code = await new Promise<number | null>((resolve) => {
      child.on('close', resolve)
      setTimeout(() => resolve(null), 8000)
    })

    expect(out.trim()).toBe('ok')
    expect(code).toBe(0)
  }, 15_000)
})
