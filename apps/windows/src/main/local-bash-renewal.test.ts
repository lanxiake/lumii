/**
 * @vitest-environment node
 */
/**
 * local-bash 超时前续期：假子进程永不 close，用 onApproachingTimeout 控制是否延长 deadline。
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./platform/process-kill', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./platform/process-kill')>()
  return {
    ...actual,
    spawnChildInGroup: vi.fn(),
    killProcessTree: vi.fn(),
  }
})

import { killProcessTree, spawnChildInGroup } from './platform/process-kill'
import { executeLocalCommand } from './agent-runtime/tool-providers/local-bash'

/** 永不 close 的假子进程 */
function makeHangChild(): EventEmitter & {
  pid: number
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
  }
  child.pid = 4242
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}

describe('executeLocalCommand 超时前续期', () => {
  beforeEach(() => {
    vi.mocked(spawnChildInGroup).mockReset()
    vi.mocked(killProcessTree).mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('续期后 deadline 延长，超时发生在原 timeout 之后', async () => {
    const child = makeHangChild()
    vi.mocked(spawnChildInGroup).mockReturnValue(child as never)

    // 只续一次，避免测例里反复 +250 导致永不超时
    let renewed = false
    const onApproachingTimeout = vi.fn(async () => {
      if (renewed) return { extendMs: 0 }
      renewed = true
      return { extendMs: 250 }
    })
    const started = Date.now()
    const res = await executeLocalCommand('sleep-hang', {
      timeoutMs: 200,
      renewalLeadMs: 80,
      onApproachingTimeout,
    })
    const elapsed = Date.now() - started

    expect(onApproachingTimeout).toHaveBeenCalled()
    expect(res.exitCode).toBe(124)
    // 原 timeout 200；约 120ms 时续 250ms → 总约 370ms+
    expect(elapsed).toBeGreaterThanOrEqual(300)
    expect(elapsed).toBeLessThan(5000)
  }, 10_000)

  it('不续期则按原 timeout 终止', async () => {
    const child = makeHangChild()
    vi.mocked(spawnChildInGroup).mockReturnValue(child as never)

    const onApproachingTimeout = vi.fn(async () => ({ extendMs: 0 }))
    const started = Date.now()
    const res = await executeLocalCommand('sleep-hang', {
      timeoutMs: 200,
      renewalLeadMs: 80,
      onApproachingTimeout,
    })
    const elapsed = Date.now() - started

    expect(onApproachingTimeout).toHaveBeenCalled()
    expect(res.exitCode).toBe(124)
    expect(elapsed).toBeGreaterThanOrEqual(180)
    expect(elapsed).toBeLessThan(3000)
  }, 10_000)

  it('timeoutMs ≤ renewalLeadMs 时不询问，直接超时', async () => {
    const child = makeHangChild()
    vi.mocked(spawnChildInGroup).mockReturnValue(child as never)

    const onApproachingTimeout = vi.fn(async () => ({ extendMs: 999_999 }))
    const res = await executeLocalCommand('sleep-hang', {
      // 剩余窗口 ≤ lead → 没有「提前 1 分钟」可问
      timeoutMs: 50,
      renewalLeadMs: 80,
      onApproachingTimeout,
    })

    expect(onApproachingTimeout).not.toHaveBeenCalled()
    expect(res.exitCode).toBe(124)
  }, 10_000)
})
