import { useRef, useSyncExternalStore } from 'react'
import type { WikiRunItem } from '../../../hooks/business/useWikiPage/useWikiPage'

export type WikiTaskKind = 'archive' | 'cleanup' | 'synthesis' | 'rebuild' | 'graph' | 'reclassify'
export type WikiTaskPhase = 'running' | 'succeeded' | 'failed'

export interface WikiLocalTask {
  readonly id: string
  readonly kind: WikiTaskKind
  readonly title: string
  readonly phase: WikiTaskPhase
  readonly progress?: { readonly done: number; readonly total: number }
  readonly detail?: string
  readonly error?: string
  readonly createdAt: number
  readonly finishedAt?: number
  readonly retryable?: boolean
  readonly inboxIds?: readonly string[]
  readonly runDetail?: WikiRunItem['resultDetail']
  readonly retry?: () => Promise<unknown>
}

export interface WikiTaskCenterApi {
  readonly tasks: readonly WikiLocalTask[]
  readonly pillText: string | null
  readonly pillTone: 'running' | 'success' | 'error' | 'idle'
  readonly hasUnseenFailure: boolean
  startTask: (input: Omit<WikiLocalTask, 'id' | 'phase' | 'createdAt'> & { phase?: WikiTaskPhase }) => string
  updateTask: (id: string, patch: Partial<WikiLocalTask>) => void
  completeTask: (id: string, patch?: Partial<WikiLocalTask>) => void
  failTask: (id: string, error: string, retryable?: boolean) => void
  dismissTask: (id: string) => void
  markFailuresSeen: () => void
  mergeRuns: (runs: readonly WikiRunItem[]) => void
  wrapAsync: <T>(kind: WikiTaskKind, title: string, fn: () => Promise<T>) => Promise<T>
}

export interface WikiTaskCenterStore {
  startTask: WikiTaskCenterApi['startTask']
  updateTask: WikiTaskCenterApi['updateTask']
  completeTask: WikiTaskCenterApi['completeTask']
  failTask: WikiTaskCenterApi['failTask']
  dismissTask: WikiTaskCenterApi['dismissTask']
  markFailuresSeen: WikiTaskCenterApi['markFailuresSeen']
  mergeRuns: WikiTaskCenterApi['mergeRuns']
  wrapAsync: WikiTaskCenterApi['wrapAsync']
  getSnapshot: () => WikiTaskCenterApi
  subscribe: (listener: () => void) => () => void
}

const TASK_PROGRESS_PREFIX: Record<WikiTaskKind, string> = {
  archive: '归档中',
  cleanup: '清理中',
  synthesis: '综述合成中',
  rebuild: '重建索引…',
  graph: '图谱任务中',
  reclassify: '重新编目中',
}

const SUCCESS_TONE_DURATION_MS = 3_000
let nextTaskSequence = 0

/**
 * 生成仅用于当前渲染进程的本地任务标识。
 */
function createLocalTaskId(): string {
  nextTaskSequence += 1
  return `wiki-task-${Date.now()}-${nextTaskSequence}`
}

/**
 * 将 Wiki run 转换为任务中心可展示的任务项。
 */
function mapRunToTask(run: WikiRunItem): WikiLocalTask {
  const failed = run.status === 'failed'
  return {
    id: run.id,
    kind: 'archive',
    title: run.resultSummary || '归档任务',
    phase: run.status === 'running' ? 'running' : failed ? 'failed' : 'succeeded',
    detail: run.resultSummary ?? undefined,
    error: run.error ?? undefined,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt ?? undefined,
    retryable: failed,
    inboxIds: run.inboxIds,
    runDetail: run.resultDetail,
  }
}

/**
 * 计算当前任务状态对应的顶栏 pill 文案。
 */
function getPillText(
  tasks: readonly WikiLocalTask[],
  hasUnseenFailure: boolean,
  successToneActive: boolean,
): string | null {
  const runningTasks = tasks.filter((task) => task.phase === 'running')
  if (runningTasks.length > 1) return `${runningTasks.length} 个任务进行中`
  if (runningTasks.length === 1) {
    const [task] = runningTasks
    const prefix = TASK_PROGRESS_PREFIX[task.kind]
    return task.progress ? `${prefix} ${task.progress.done}/${task.progress.total}` : prefix
  }
  if (hasUnseenFailure) return '任务失败'
  return successToneActive ? '已完成' : null
}

/**
 * 创建独立、可订阅且可直接单元测试的 Wiki 任务中心 store。
 */
export function createWikiTaskCenterStore(): WikiTaskCenterStore {
  let tasks: readonly WikiLocalTask[] = []
  let hasUnseenFailure = false
  let successToneActive = false
  let successToneTimer: ReturnType<typeof setTimeout> | undefined
  let snapshot: WikiTaskCenterApi
  const listeners = new Set<() => void>()

  /**
   * 根据内部状态构建稳定到下一次变更的快照。
   */
  function buildSnapshot(): WikiTaskCenterApi {
    const running = tasks.some((task) => task.phase === 'running')
    return {
      tasks,
      pillText: getPillText(tasks, hasUnseenFailure, successToneActive),
      pillTone: hasUnseenFailure ? 'error' : running ? 'running' : successToneActive ? 'success' : 'idle',
      hasUnseenFailure,
      startTask,
      updateTask,
      completeTask,
      failTask,
      dismissTask,
      markFailuresSeen,
      mergeRuns,
      wrapAsync,
    }
  }

  /**
   * 发布内部状态变更并刷新所有订阅者。
   */
  function emitChange(): void {
    snapshot = buildSnapshot()
    listeners.forEach((listener) => listener())
  }

  /**
   * 启动约三秒的最近成功状态窗口。
   */
  function showRecentSuccess(): void {
    successToneActive = true
    if (successToneTimer) clearTimeout(successToneTimer)
    successToneTimer = setTimeout(() => {
      successToneActive = false
      successToneTimer = undefined
      emitChange()
    }, SUCCESS_TONE_DURATION_MS)
  }

  /**
   * 新增本地任务并返回任务标识。
   */
  function startTask(
    input: Omit<WikiLocalTask, 'id' | 'phase' | 'createdAt'> & { phase?: WikiTaskPhase },
  ): string {
    const id = createLocalTaskId()
    const phase = input.phase ?? 'running'
    const task: WikiLocalTask = {
      ...input,
      id,
      phase,
      createdAt: Date.now(),
    }
    tasks = [task, ...tasks]
    if (phase === 'failed') hasUnseenFailure = true
    if (phase === 'succeeded') showRecentSuccess()
    emitChange()
    return id
  }

  /**
   * 合并指定任务的局部字段；不存在的任务保持不变。
   */
  function updateTask(id: string, patch: Partial<WikiLocalTask>): void {
    let changed = false
    tasks = tasks.map((task) => {
      if (task.id !== id) return task
      changed = true
      return { ...task, ...patch }
    })
    if (!changed) return
    if (patch.phase === 'failed') hasUnseenFailure = true
    emitChange()
  }

  /**
   * 将指定任务标记为完成并触发短暂成功态。
   */
  function completeTask(id: string, patch: Partial<WikiLocalTask> = {}): void {
    const exists = tasks.some((task) => task.id === id)
    if (!exists) return
    tasks = tasks.map((task) =>
      task.id === id
        ? { ...task, ...patch, id: task.id, phase: 'succeeded', finishedAt: patch.finishedAt ?? Date.now() }
        : task,
    )
    showRecentSuccess()
    emitChange()
  }

  /**
   * 将指定任务标记为失败并记录错误与重试能力。
   */
  function failTask(id: string, error: string, retryable?: boolean): void {
    const exists = tasks.some((task) => task.id === id)
    if (!exists) return
    tasks = tasks.map((task) =>
      task.id === id
        ? { ...task, phase: 'failed', error, retryable, finishedAt: Date.now() }
        : task,
    )
    hasUnseenFailure = true
    emitChange()
  }

  /**
   * 从任务中心移除指定任务。
   */
  function dismissTask(id: string): void {
    const nextTasks = tasks.filter((task) => task.id !== id)
    if (nextTasks.length === tasks.length) return
    tasks = nextTasks
    if (!tasks.some((task) => task.phase === 'failed')) hasUnseenFailure = false
    emitChange()
  }

  /**
   * 清除失败任务的未查看标记。
   */
  function markFailuresSeen(): void {
    if (!hasUnseenFailure) return
    hasUnseenFailure = false
    emitChange()
  }

  /**
   * 合并归档 run，同时保留同 ID 的本地任务。
   */
  function mergeRuns(runs: readonly WikiRunItem[]): void {
    const knownIds = new Set(tasks.map((task) => task.id))
    const newTasks = runs
      .filter((run) => !knownIds.has(run.id))
      .map(mapRunToTask)
    if (newTasks.length === 0) return
    tasks = [...tasks, ...newTasks]
    emitChange()
  }

  /**
   * 执行异步 Wiki 操作，并自动记录其成功或失败结果。
   */
  async function wrapAsync<T>(kind: WikiTaskKind, title: string, fn: () => Promise<T>): Promise<T> {
    const id = startTask({
      kind,
      title,
      retry: () => wrapAsync(kind, title, fn),
    })
    try {
      const result = await fn()
      completeTask(id)
      return result
    } catch (error) {
      failTask(id, error instanceof Error ? error.message : String(error), true)
      throw error
    }
  }

  /**
   * 返回当前不可变快照。
   */
  function getSnapshot(): WikiTaskCenterApi {
    return snapshot
  }

  /**
   * 订阅 store 变更，并返回取消订阅函数。
   */
  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  snapshot = buildSnapshot()
  return {
    startTask,
    updateTask,
    completeTask,
    failTask,
    dismissTask,
    markFailuresSeen,
    mergeRuns,
    wrapAsync,
    getSnapshot,
    subscribe,
  }
}

/**
 * 创建组件生命周期内稳定的任务中心 store，并订阅其快照。
 */
export function useWikiTaskCenter(): WikiTaskCenterApi {
  const storeRef = useRef<WikiTaskCenterStore | null>(null)
  if (!storeRef.current) storeRef.current = createWikiTaskCenterStore()
  const store = storeRef.current
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
