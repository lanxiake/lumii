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
