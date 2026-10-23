/**
 * SyncScheduler 的同步合并行为。
 *
 * 守的是一条实测踩过的坑：`onWorkspaceChanged` 的防抖只有 60 秒，而一次同步实测要
 * 5~10 分钟（导出走一遍整个工作区约 150 秒；提交阶段 isomorphic-git 按内容重算
 * sync 仓库的 blob hash，1.3GB / 1153 文件）。不合并的话，每个 tick 都往共享队列里
 * 再塞一次全量同步 —— 而**排队者出队后不是被丢弃、是真跑一遍**，队列只增不减，
 * 还会把共用同一条串行队列的 `vcs:snapshot` 一起饿死
 * （2026-09-18 实测队列深度 3、`cloud-sync:sync 已执行 627s 未结束`）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// watcher 与本用例无关，且构造它会碰真实文件系统
vi.mock('./sync-watcher', () => ({
  SyncFileWatcher: class {
    start(): void {}
    stop(): void {}
    ensureBound(): void {}
  },
}))

import { SyncScheduler } from './sync-scheduler'
import type { CloudSyncManager } from './sync-manager'

/** 可控的假 manager：sync() 返回一个手动 resolve 的 promise */
function makeManager() {
  let release: (() => void) | null = null
  let running = 0
  let maxConcurrent = 0
  const sync = vi.fn(() => {
    running++
    maxConcurrent = Math.max(maxConcurrent, running)
    return new Promise<{ success: boolean; state: 'idle' }>((resolve) => {
      release = () => {
        running--
        resolve({ success: true, state: 'idle' })
      }
    })
  })
  const manager = {
    sync,
    on: vi.fn(),
    emit: vi.fn(),
    getStatus: () => ({ state: 'idle' as const }),
    getConflict: () => null,
  }
  return {
    manager: manager as unknown as CloudSyncManager,
    sync,
    finish: () => release?.(),
    stats: () => ({ maxConcurrent }),
  }
}

const DEBOUNCE_MS = 60_000

describe('SyncScheduler 合并', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('同步进行中再次触发不会叠加，结束后只补一次', async () => {
    const m = makeManager()
    const s = new SyncScheduler(m.manager)

    // 第一次触发 → 防抖到点 → 开始同步（此后一直挂着不结束）
    s.onWorkspaceChanged()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(m.sync).toHaveBeenCalledTimes(1)

    // 同步仍在跑，期间又来三次变更
    for (let i = 0; i < 3; i++) {
      s.onWorkspaceChanged()
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    }
    // 关键断言：期间一次都没多跑（旧行为会在这里堆到 4 次）
    expect(m.sync).toHaveBeenCalledTimes(1)

    // 放行第一次；只应补跑一次，而不是把期间攒下的三次都跑一遍
    m.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(m.sync).toHaveBeenCalledTimes(2)

    // 再放行，且期间没有新变更 → 不应再跑
    m.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(m.sync).toHaveBeenCalledTimes(2)
  })

  it('任何时刻都不会有两个同步并发', async () => {
    const m = makeManager()
    const s = new SyncScheduler(m.manager)

    for (let i = 0; i < 5; i++) {
      s.onWorkspaceChanged()
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    }
    expect(m.stats().maxConcurrent).toBe(1)

    m.finish()
    await vi.advanceTimersByTimeAsync(0)
    m.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(m.stats().maxConcurrent).toBe(1)
  })

  it('同步失败也不吃掉后续触发（不卡在 running 状态）', async () => {
    const sync = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ success: true, state: 'idle' })
    const manager = {
      sync,
      on: vi.fn(),
      emit: vi.fn(),
      getStatus: () => ({ state: 'idle' as const }),
      getConflict: () => null,
    } as unknown as CloudSyncManager
    const s = new SyncScheduler(manager)

    s.onWorkspaceChanged()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(sync).toHaveBeenCalledTimes(1)

    // 抛异常后 syncRunning 必须已释放，否则此后永远不再同步
    s.onWorkspaceChanged()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(sync).toHaveBeenCalledTimes(2)
  })
})
