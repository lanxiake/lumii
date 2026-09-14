/**
 * SyncFileWatcher 单元测试：防抖合并、抑制窗口、最小提交间隔、切目录重绑。
 *
 * 用 vi.spyOn(fs,'watch') 捕获回调直接投喂事件，避免依赖真实文件系统事件时序
 * （同 skill-watcher-self-write.test.ts 的写法）；配合 fake timers 推进防抖窗口。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SyncFileWatcher } from './sync-watcher'
import type { CloudSyncManager } from './sync-manager'
import type { SyncState } from './types'

let root: string

/** 捕获 fs.watch 注册的回调（files + outputs 各一个） */
function captureWatchListeners(): Array<(eventType: string, filename: string | null) => void> {
  const listeners: Array<(e: string, f: string | null) => void> = []
  vi.spyOn(fs, 'watch').mockImplementation(((_dir: unknown, _opts: unknown, cb: unknown) => {
    listeners.push(cb as (e: string, f: string | null) => void)
    return { close: () => {}, on: () => {} } as unknown as fs.FSWatcher
  }) as unknown as typeof fs.watch)
  return listeners
}

/** 造一个只满足 watcher 依赖面的 manager 替身 */
function makeManager(initialState: SyncState = 'idle') {
  const state = { current: initialState }
  const commitLocalChanges = vi.fn(async () => true)
  const manager = {
    getStatus: () => ({ state: state.current }),
    commitLocalChanges,
  } as unknown as CloudSyncManager
  return { manager, state, commitLocalChanges }
}

describe('SyncFileWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-sync-watcher-'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('同时监听 files 与 outputs 两个目录', () => {
    const listeners = captureWatchListeners()
    const { manager } = makeManager()
    const watcher = new SyncFileWatcher(manager, () => root)

    watcher.start()
    expect(listeners.length).toBe(2)

    watcher.stop()
  })

  it('连续编辑经防抖后只提交一次', async () => {
    const listeners = captureWatchListeners()
    const { manager, commitLocalChanges } = makeManager()
    const watcher = new SyncFileWatcher(manager, () => root)
    watcher.start()

    listeners[0]!('change', 'a.md')
    listeners[0]!('change', 'b.md')
    listeners[1]!('change', 'c.md')
    await vi.advanceTimersByTimeAsync(3_100)

    expect(commitLocalChanges).toHaveBeenCalledTimes(1)
    watcher.stop()
  })

  it('完整同步期间被抑制，回到 idle 后补一次提交', async () => {
    const listeners = captureWatchListeners()
    const { manager, state, commitLocalChanges } = makeManager('syncing')
    const watcher = new SyncFileWatcher(manager, () => root)
    watcher.start()

    listeners[0]!('change', 'a.md')
    await vi.advanceTimersByTimeAsync(3_100)
    // 同步进行中绝不提交：import 正在写本地文件，
    // 此刻 export 会把半完成状态推入 git 再 push，污染远端
    expect(commitLocalChanges).not.toHaveBeenCalled()

    state.current = 'idle'
    await vi.advanceTimersByTimeAsync(10_100)
    expect(commitLocalChanges).toHaveBeenCalledTimes(1)

    watcher.stop()
  })

  it('conflict 期间同样被抑制', async () => {
    const listeners = captureWatchListeners()
    const { manager, commitLocalChanges } = makeManager('conflict')
    const watcher = new SyncFileWatcher(manager, () => root)
    watcher.start()

    listeners[0]!('change', 'a.md')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(commitLocalChanges).not.toHaveBeenCalled()
    watcher.stop()
  })

  it('最小提交间隔内的第二次变更被推迟而非丢弃', async () => {
    const listeners = captureWatchListeners()
    const { manager, commitLocalChanges } = makeManager()
    const watcher = new SyncFileWatcher(manager, () => root)
    watcher.start()

    listeners[0]!('change', 'a.md')
    await vi.advanceTimersByTimeAsync(3_100)
    expect(commitLocalChanges).toHaveBeenCalledTimes(1)

    // 紧接着的第二次变更落在 30s 最小间隔内
    listeners[0]!('change', 'b.md')
    await vi.advanceTimersByTimeAsync(3_100)
    expect(commitLocalChanges).toHaveBeenCalledTimes(1)

    // 越过最小间隔后补上
    await vi.advanceTimersByTimeAsync(30_000)
    expect(commitLocalChanges).toHaveBeenCalledTimes(2)

    watcher.stop()
  })

  it('工作空间目录变化时重绑监听', () => {
    const listeners = captureWatchListeners()
    const { manager } = makeManager()
    let dir = root
    const watcher = new SyncFileWatcher(manager, () => dir)
    watcher.start()
    expect(listeners.length).toBe(2)

    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-sync-watcher2-'))
    dir = root2
    watcher.ensureBound()
    expect(listeners.length).toBe(4)

    // 目录未变时是 no-op，可安全频繁调用
    watcher.ensureBound()
    expect(listeners.length).toBe(4)

    watcher.stop()
    fs.rmSync(root2, { recursive: true, force: true })
  })

  it('stop 后不再提交', async () => {
    const listeners = captureWatchListeners()
    const { manager, commitLocalChanges } = makeManager()
    const watcher = new SyncFileWatcher(manager, () => root)
    watcher.start()

    listeners[0]!('change', 'a.md')
    watcher.stop()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(commitLocalChanges).not.toHaveBeenCalled()
  })
})
