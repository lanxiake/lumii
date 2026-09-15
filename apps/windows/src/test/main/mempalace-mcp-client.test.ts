/**
 * 回归：MemPalace MCP 子进程崩溃，不能把整个客户端带走。
 *
 * 线上故障（docs/temp/错误日志.log）：Python 子进程 access violation 挂掉后，
 * 主进程那笔写到它 stdin 的请求拿到 "write EOF"；stdin 上没有 'error' 监听，
 * 事件抛成 uncaughtException，被主进程全局兜底判定为致命并 process.exit(1)。
 *
 * 注意不能用 `vi.mock('child_process')` 注入：被 vite externalize 的 builtin
 * 只在测试文件自身的 import 上被 mock，SUT 模块内部的 import 走的是真 spawn。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { MemPalaceMcpBridge } from '../../main/mempalace-mcp-client'
import { bigPayload, rejectionOf, settle, spawnFakeChild, trackUncaughtExceptions } from './fake-child-process'

/** 借私有成员注入假子进程（attachChildHandlers 就是生产用的那处挂载） */
interface BridgeInternals {
  proc: ChildProcess | null
  pendingCalls: Map<number, unknown>
  attachChildHandlers: (proc: ChildProcess) => void
}

const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children) child.kill()
  children.length = 0
})

describe('MemPalaceMcpBridge 子进程崩溃', () => {
  it('写入挂在管道上时子进程死亡：调用被拒绝、无未捕获错误、调度重启', async () => {
    const uncaught = trackUncaughtExceptions()
    const warned: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warned.push(args.map(String).join(' '))
    })
    try {
      const bridge = new MemPalaceMcpBridge('C:/fake/python.exe', 'C:/fake/palace')
      const internals = bridge as unknown as BridgeInternals
      const child = spawnFakeChild(spawn, 'stall')
      children.push(child)
      internals.proc = child
      internals.attachChildHandlers(child) // 生产同款挂载

      // #1：让子进程停读 stdin；#2：远超管道缓冲（64KB），写入只能挂着
      const first = bridge.callTool('mempalace_add_drawer', { content: 'small', wing: 'w', room: 'r' })
      const second = bridge.callTool('mempalace_add_drawer', {
        content: bigPayload(),
        wing: 'w',
        room: 'r',
      })
      await settle(150) // 等子进程读到 #1 并 stall
      child.kill() // 模拟崩溃

      const reasons = await Promise.all([rejectionOf(first), rejectionOf(second)])
      await settle()

      // 关键：这次挂起的写入确实走到了 EOF 那条路径（而不是被管道缓冲吞掉）
      expect(reasons.some((r) => r.includes('write EOF'))).toBe(true)
      // 两个调用都被干净拒绝，而不是悬挂到 30s 超时
      expect(reasons.every((r) => /write EOF|MCP 进程已退出/.test(r))).toBe(true)
      // 回归本体：没有未捕获错误（线上就是它触发 process.exit(1)）
      expect(uncaught.errors).toEqual([])
      // 状态复位 + 已调度重启（重启逻辑即自愈路径）
      expect(internals.proc).toBeNull()
      expect(internals.pendingCalls.size).toBe(0)
      expect(warned.some((w) => w.includes('进程退出'))).toBe(true)
      expect(warned.some((w) => w.includes('后重启'))).toBe(true)
      expect(uncaught.errors).toEqual([])
    } finally {
      warnSpy.mockRestore()
      uncaught.stop()
    }
  }, 30_000)
})

describe('MemPalaceMcpBridge.addDrawer 返回值校验', () => {
  /**
   * mempalace 的写工具用返回值报错，而不是抛异常：写入失败是 `{success:false,error}`，
   * collection 打不开时是裸 `{error}`——两者在 JSON-RPC 层都是成功响应。
   * 调用方不校验 success 就会把失败记成「记忆已写入」：2026-09-15 排查中，
   * 子进程整天在 chroma upsert 上崩溃的同期，日志仍报出 100 次写入成功，
   * 而宫殿里 0 条新数据，故障因此被掩盖。
   *
   * 这里只桩掉传输层：被测对象是「返回值 → 成败」这段判定，
   * 真实子进程的请求/响应链路由上面的崩溃回归覆盖。
   */
  const params = { wing: 'conversations', room: 'conv-1', content: '正文', addedBy: 'mtbot-windows' }

  function bridgeReturning(result: unknown): MemPalaceMcpBridge {
    const bridge = new MemPalaceMcpBridge('C:/fake/python.exe', 'C:/fake/palace')
    vi.spyOn(bridge, 'callTool').mockResolvedValue(result)
    return bridge
  }

  it('success:false 时抛错（Python 侧写入失败的形态）', async () => {
    const bridge = bridgeReturning({
      success: false,
      error: 'Idempotency check failed before write: boom',
    })
    await expect(bridge.addDrawer(params)).rejects.toThrow(/Idempotency check failed/)
  })

  it('裸 error 字典抛错（collection 打不开的形态）', async () => {
    const bridge = bridgeReturning({ error: 'No palace found', hint: 'Run: mempalace init <dir>' })
    await expect(bridge.addDrawer(params)).rejects.toThrow(/No palace found/)
  })

  it('缺少 success 标记时抛错，不当作成功', async () => {
    const bridge = bridgeReturning({ drawer_id: 'drawer_x' })
    await expect(bridge.addDrawer(params)).rejects.toThrow(/未返回 success 标记/)
  })

  it('callTool 没有返回内容时抛错', async () => {
    const bridge = bridgeReturning(null)
    await expect(bridge.addDrawer(params)).rejects.toThrow(/未返回结果/)
  })

  it('success:true 时返回 drawer_id', async () => {
    const bridge = bridgeReturning({
      success: true, drawer_id: 'drawer_ok', wing: 'conversations', room: 'conv-1', chunks: 1,
    })
    await expect(bridge.addDrawer(params)).resolves.toMatchObject({ drawer_id: 'drawer_ok' })
  })

  it('内容已存在（already_exists）同样算成功', async () => {
    const bridge = bridgeReturning({ success: true, reason: 'already_exists', drawer_id: 'drawer_dup' })
    await expect(bridge.addDrawer(params)).resolves.toMatchObject({ drawer_id: 'drawer_dup' })
  })
})
