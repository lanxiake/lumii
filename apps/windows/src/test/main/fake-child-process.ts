/**
 * 子进程崩溃回归测试的公共脚手架。
 *
 * 复现生产故障的最小场景：子进程停止消费 stdin 后死亡，
 * 此时主进程那次写入还挂在管道里，写回调与流都会拿到 `EOF`（消息 "write EOF"）。
 * 未挂 'error' 监听时，这个事件会抛成 uncaughtException，被主进程全局兜底
 * 判定为致命错误并 process.exit(1)——整个客户端跟着退出。
 *
 * 用真实的 node 子进程（真管道）而不是 mock 流，才能拿到真正的 EOF 错误。
 */
import type { ChildProcess, SpawnOptions } from 'node:child_process'

/** 假子进程：同时会说 MCP JSON-RPC 与 sidecar 两种方言 */
const FAKE_CHILD_SOURCE = `
const readline = require('node:readline')
const mode = process.env.FAKE_CHILD_MODE === 'stall' ? 'stall' : 'serve'
const rl = readline.createInterface({ input: process.stdin })
let stalled = false

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n')
}

rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) return

  const isMcp = typeof msg.jsonrpc === 'string'
  const toolName = msg.params && msg.params.name
  const isHandshake =
    msg.method === 'initialize' ||
    (msg.method === 'tools/call' && toolName === 'mempalace_status')

  if (mode === 'serve' || isHandshake) {
    if (isMcp && msg.method === 'tools/call') {
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ total_drawers: 0, wings: {}, palace_path: '' }),
            },
          ],
        },
      })
    } else if (isMcp) {
      write({ jsonrpc: '2.0', id: msg.id, result: { ok: true } })
    } else {
      write({ id: msg.id, ok: true, result: {} })
    }
    return
  }

  if (!stalled) {
    stalled = true
    rl.close()
    process.stdin.pause()
    process.stderr.write('FAKE_CHILD_STALLED\\n')
  }
})

// 保持存活等测试显式 kill：stall 后若让事件循环空转，进程会立刻退出，
// 父进程那笔挂起的写入就变成 ERR_STREAM_DESTROYED（全局白名单已放行），测不到 EOF 这条路径
setTimeout(() => process.exit(0), 20000)
`

/** 测试里用于起假子进程的 spawn（真 spawn；被 mock 的模块请传 importOriginal 拿到的那个） */
export type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess

/**
 * 起一个假子进程。
 *
 * `realSpawn` 由调用方传入，而不是在本模块 import：需要 mock `child_process` 的测试
 * 必须用 `importOriginal()` 拿到的真 spawn，否则会递归回被 mock 的实现。
 *
 * @param mode `stall`：应答握手后，收到第一个业务请求就停读 stdin 并保持存活（等测试 kill）；
 *             `serve`：一直正常应答（用于验证重启后的新进程）。
 */
export function spawnFakeChild(realSpawn: SpawnLike, mode: 'serve' | 'stall'): ChildProcess {
  const options: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, FAKE_CHILD_MODE: mode },
  }
  return realSpawn(process.execPath, ['-e', FAKE_CHILD_SOURCE], options)
}

/** 管道缓冲默认 64KB，写满它才能让写入挂在管道里（而不是被缓冲吞掉） */
const PENDING_WRITE_BYTES = 4 * 1024 * 1024

/** 造一段大到写不完整、必然挂起的 payload */
export function bigPayload(): string {
  return 'x'.repeat(PENDING_WRITE_BYTES)
}

/**
 * 捕获本进程的未捕获异常，供回归断言使用：
 * 挂了 'error' 监听时数组为空；漏挂时 Node 会把流 'error' 抛到这里（或直接终止进程）。
 */
export function trackUncaughtExceptions(): { errors: unknown[]; stop: () => void } {
  const errors: unknown[] = []
  const onUncaught = (err: unknown): void => {
    errors.push(err)
  }
  process.on('uncaughtException', onUncaught)
  return { errors, stop: () => process.off('uncaughtException', onUncaught) }
}

/** 让挂起的事件（error/exit/reject）都跑完再断言 */
export function settle(ms = 200): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 断言用：把「拒绝原因」取出来，避免 unhandled rejection 噪音 */
export async function rejectionOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return '(未拒绝)'
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
