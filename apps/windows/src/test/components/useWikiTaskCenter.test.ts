import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WikiRunItem } from '../../renderer/hooks/business/useWikiPage/useWikiPage'
import { createWikiTaskCenterStore } from '../../renderer/pages/MemoriesPage/components/useWikiTaskCenter'

afterEach(() => {
  vi.useRealTimers()
})

describe('wiki task center store', () => {
  it('hides pill when idle', () => {
    const store = createWikiTaskCenterStore()
    expect(store.getSnapshot().pillText).toBeNull()
  })

  it('shows determinate progress for running archive', () => {
    const store = createWikiTaskCenterStore()
    const id = store.startTask({
      kind: 'archive',
      title: '处理待整理',
      progress: { done: 3, total: 12 },
    })
    expect(store.getSnapshot().pillText).toBe('归档中 3/12')
    store.completeTask(id)
  })

  it('wrapAsync records failure', async () => {
    const store = createWikiTaskCenterStore()
    await expect(
      store.wrapAsync('rebuild', '重建索引', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(store.getSnapshot().hasUnseenFailure).toBe(true)
    expect(store.getSnapshot().pillTone).toBe('error')
  })

  it('shows the running task count when multiple tasks are active', () => {
    const store = createWikiTaskCenterStore()
    store.startTask({ kind: 'cleanup', title: '扫描清理项' })
    store.startTask({ kind: 'graph', title: '构建图谱' })

    expect(store.getSnapshot().pillText).toBe('2 个任务进行中')
    expect(store.getSnapshot().pillTone).toBe('running')
  })

  it('shows a success tone for about three seconds', () => {
    vi.useFakeTimers()
    const store = createWikiTaskCenterStore()
    const id = store.startTask({ kind: 'synthesis', title: '生成综述' })

    store.completeTask(id)
    expect(store.getSnapshot().pillTone).toBe('success')
    expect(store.getSnapshot().pillText).toBeNull()

    vi.advanceTimersByTime(3_000)
    expect(store.getSnapshot().pillTone).toBe('idle')
  })

  it('marks failures seen and dismisses tasks', () => {
    const store = createWikiTaskCenterStore()
    const id = store.startTask({ kind: 'cleanup', title: '清理来源' })

    store.failTask(id, '无法清理', true)
    expect(store.getSnapshot().tasks[0]).toMatchObject({
      phase: 'failed',
      error: '无法清理',
      retryable: true,
    })

    store.markFailuresSeen()
    expect(store.getSnapshot().hasUnseenFailure).toBe(false)
    store.dismissTask(id)
    expect(store.getSnapshot().tasks).toEqual([])
  })

  it('clears the unseen failure after dismissing the last failed task', () => {
    const store = createWikiTaskCenterStore()
    const id = store.startTask({ kind: 'cleanup', title: '清理来源' })
    store.failTask(id, '无法清理', true)

    store.dismissTask(id)

    expect(store.getSnapshot().hasUnseenFailure).toBe(false)
    expect(store.getSnapshot().pillText).toBeNull()
  })

  it('merges run history once without replacing a local task', () => {
    const store = createWikiTaskCenterStore()
    const localId = store.startTask({ kind: 'archive', title: '本地归档' })
    const runs: WikiRunItem[] = [
      {
        id: localId,
        inboxIds: ['inbox-local'],
        status: 'succeeded',
        resultSummary: '远端同 ID',
        error: null,
        resultDetail: null,
        createdAt: 10,
        finishedAt: 20,
      },
      {
        id: 'run-failed',
        inboxIds: ['inbox-failed'],
        status: 'failed',
        resultSummary: null,
        error: '归档失败',
        resultDetail: null,
        createdAt: 30,
        finishedAt: 40,
      },
      {
        id: 'run-running',
        inboxIds: [],
        status: 'running',
        resultSummary: null,
        error: null,
        resultDetail: null,
        createdAt: 50,
        finishedAt: null,
      },
    ]

    store.mergeRuns(runs)
    store.mergeRuns(runs)

    expect(store.getSnapshot().tasks).toHaveLength(3)
    expect(store.getSnapshot().tasks.find((task) => task.id === localId)?.title).toBe('本地归档')
    expect(store.getSnapshot().tasks.find((task) => task.id === 'run-failed')).toMatchObject({
      kind: 'archive',
      phase: 'failed',
      error: '归档失败',
      runDetail: null,
    })
    expect(store.getSnapshot().tasks.find((task) => task.id === 'run-running')).toMatchObject({
      phase: 'running',
      inboxIds: [],
    })
  })
})
