/**
 * 回归：语音 sidecar 子进程崩溃，不能把整个客户端带走（与 MemPalace 那处同一类缺陷）。
 *
 * sidecar 的 stdio 管道没有任何 'error' 监听，写入死亡进程的 stdin 会抛
 * uncaughtException → 主进程全局兜底 process.exit(1)。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Qwen3TtsClient } from '../../main/voice/qwen3-tts-client'
import { bigPayload, rejectionOf, settle, spawnFakeChild, trackUncaughtExceptions } from './fake-child-process'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}))

/** 借私有成员注入假子进程（attachChildHandlers 就是生产用的那处挂载） */
interface ClientInternals {
  child: ChildProcess | null
  pending: Map<number, unknown>
  attachChildHandlers: (child: ChildProcessWithoutNullStreams) => void
  call: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>
}

const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children) child.kill()
  children.length = 0
})

describe('Qwen3TtsClient sidecar 崩溃', () => {
  it('写入挂在管道上时 sidecar 死亡：调用被拒绝、无未捕获错误、状态复位', async () => {
    const uncaught = trackUncaughtExceptions()
    try {
      const client = new Qwen3TtsClient()
      const internals = client as unknown as ClientInternals
      const child = spawnFakeChild(spawn, 'stall') as ChildProcessWithoutNullStreams
      children.push(child)
      internals.child = child
      internals.attachChildHandlers(child) // 生产同款挂载

      // #1：让子进程停读 stdin；#2：远超管道缓冲，写入只能挂着
      const first = internals.call('synthesize', { text: 'small' })
      const second = internals.call('synthesize', { text: bigPayload() })
      await settle(150)
      child.kill() // 模拟崩溃

      const reasons = await Promise.all([rejectionOf(first), rejectionOf(second)])
      await settle()

      expect(reasons.some((r) => r.includes('write EOF'))).toBe(true)
      // 回归本体：没有未捕获错误（线上就是它触发 process.exit(1)）
      expect(uncaught.errors).toEqual([])
      // 状态复位：child 置空、挂起表清空
      expect(internals.child).toBeNull()
      expect(internals.pending.size).toBe(0)
      // 复位后的调用快速失败，而不是干等到 120s 超时
      expect(await rejectionOf(internals.call('synthesize', { text: 'x' }))).toBe('sidecar 未运行')
      expect(uncaught.errors).toEqual([])
    } finally {
      uncaught.stop()
    }
  }, 30_000)
})
