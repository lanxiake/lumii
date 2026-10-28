/**
 * 侧车客户端协议层。
 *
 * 只测**异常路径**——happy path 真机跑得到（`pnpm dev` 起一次就验了），而下面这些
 * 是只有出事时才走的分支，也是最容易写成「假成功」的地方：
 *
 *   - `ok:false`（工具内部炸了）必须抛，不能当数据返回；
 *   - 业务失败（帧 `ok:true` + 载荷 `{ok:false}`）必须**原样返回**，不能抛
 *     ——发送路径要读 `error_code` 分档处置；
 *   - 超时 / abort / 子进程退出都必须把挂起的调用 reject 掉，不能永远挂着。
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { WechatSidecarClient } from './wechat-sidecar-client'

/** 假子进程：stdin 可写、stdout/stderr 可 emit、能 exit */
function fakeChild() {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: () => void }
  stdout.setEncoding = () => {}
  const stderr = EventEmitter.prototype
    ? (new EventEmitter() as EventEmitter & { setEncoding: () => void })
    : ({} as never)
  stderr.setEncoding = () => {}
  const written: string[] = []
  const stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write: (s: string) => {
      written.push(s)
      return true
    },
  })
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill: () => {
      child.killed = true
    },
  })
  /** 把一条帧喂给客户端（模拟侧车输出） */
  const reply = (frame: unknown): void => {
    stdout.emit('data', `${JSON.stringify(frame)}\n`)
  }
  return { child: child as unknown as ChildProcessWithoutNullStreams, written, reply, raw: child }
}

/**
 * 造一个客户端：`initialize` 由调用方决定怎么回。
 *
 * `spawn` 被注入成返回假子进程，`resolvePythonExe`/`ensurePackages` 直接跳过
 * （否则会去碰本机的托管 Python 与 pip）。
 */
function makeClient(opts: { initReply?: (reply: (f: unknown) => void) => void } = {}) {
  const fake = fakeChild()
  const spawnFn = vi.fn(() => fake.child)
  const client = new WechatSidecarClient({
    spawn: spawnFn as never,
    resolvePythonExe: async () => 'python.exe',
    ensurePackages: async () => undefined,
    resolveScript: () => 'sidecar.py',
  })
  // 每次有请求写进来，就按 method 回一帧（同步下个微任务，模拟真实异步）
  const onWrite = (chunk: string): void => {
    const req = JSON.parse(chunk) as { id: number; method: string; tool?: string }
    queueMicrotask(() => {
      if (req.method === 'initialize') {
        if (opts.initReply) opts.initReply(fake.reply)
        else fake.reply({ id: req.id, ok: true, data: { tools: [], instructions: '', version: '1' } })
      }
    })
  }
  // stdin.write 在 fakeChild 里是普通函数，这里挂一个监听把请求接出来
  const origWrite = fake.child.stdin.write.bind(fake.child.stdin)
  fake.child.stdin.write = ((s: string) => {
    onWrite(s)
    return origWrite(s)
  }) as never
  return { client, fake, spawnFn }
}

describe('WechatSidecarClient · 协议与异常路径', () => {
  it('initialize 成功后 listTools 返回侧车的清单', async () => {
    const { client } = makeClient({
      initReply: (reply) =>
        reply({
          id: 1,
          ok: true,
          data: { tools: [{ name: 'list_sessions', description: 'x', inputSchema: {} }], instructions: '', version: '0.12.0' },
        }),
    })
    await expect(client.listTools()).resolves.toEqual([
      { name: 'list_sessions', description: 'x', inputSchema: {} },
    ])
  })

  it('工具内部炸了（帧 ok:false）→ callText 抛', async () => {
    const { client, fake } = makeClient()
    const pending = client.callText('boom', {})
    // 等 initialize + call 两帧都写出去
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThanOrEqual(2))
    const callReq = JSON.parse(fake.written[1]!) as { id: number }
    fake.reply({ id: callReq.id, ok: false, content: [{ type: 'text', text: 'ERROR: 炸了' }] })
    await expect(pending).rejects.toThrow('炸了')
  })

  it('业务失败（帧 ok:true + 载荷 {ok:false}）→ 原样返回，不抛', async () => {
    const { client, fake } = makeClient()
    const pending = client.callText('send_text', {})
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThanOrEqual(2))
    const callReq = JSON.parse(fake.written[1]!) as { id: number }
    const payload = JSON.stringify({ ok: false, error_code: 'env_not_ready', detail: '窗口最小化' })
    fake.reply({ id: callReq.id, ok: true, content: [{ type: 'text', text: payload }] })
    // 发送路径要自己读 error_code，所以这里必须拿到原文而不是异常
    await expect(pending).resolves.toBe(payload)
  })

  it('进度帧不结账：只回调，最终仍等真应答', async () => {
    const { client, fake } = makeClient()
    const progress: string[] = []
    const pending = client.call('send_text', {}, { onProgress: (p) => progress.push(p.message) })
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThanOrEqual(2))
    const callReq = JSON.parse(fake.written[1]!) as { id: number }
    fake.reply({ id: callReq.id, type: 'progress', message: '已定位输入框', progress: 1, total: 3 })
    fake.reply({ id: callReq.id, ok: true, content: [{ type: 'text', text: '{}' }] })
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(progress).toEqual(['已定位输入框'])
  })

  it('子进程中途退出 → 挂起的调用立刻 reject（不靠超时兜底）', async () => {
    const { client, fake } = makeClient()
    const pending = client.call('list_sessions', {}, { timeoutMs: 60_000 })
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThanOrEqual(2))
    fake.raw.emit('exit', 1)
    await expect(pending).rejects.toThrow(/已退出/)
  })

  it('abort 立刻 reject，且不必等超时', async () => {
    const { client, fake } = makeClient()
    const ac = new AbortController()
    const pending = client.call('list_sessions', {}, { signal: ac.signal, timeoutMs: 60_000 })
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThanOrEqual(2))
    ac.abort()
    await expect(pending).rejects.toThrow('已取消')
  })

  it('reset 之后 isReady=false，下次调用会重新拉起', async () => {
    const { client, spawnFn } = makeClient()
    await client.ensureStarted()
    expect(client.isReady()).toBe(true)
    client.reset('测试')
    expect(client.isReady()).toBe(false)
    await client.ensureStarted()
    expect(spawnFn).toHaveBeenCalledTimes(2)
  })
})
