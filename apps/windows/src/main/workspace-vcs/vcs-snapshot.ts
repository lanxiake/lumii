/**
 * Workspace VCS — 自动快照服务
 *
 * 在 Agent 每轮对话结束（message:end 持久化后）触发工作空间快照。
 * 关键约束：
 *  - per-workspace 串行队列，避免并发 commit 撕裂仓库
 *  - 无文件变更则跳过（WorkspaceVcs.commit 内部已去重，返回 null）
 *  - 任何失败仅记录日志，绝不抛出阻断对话主流程
 */

import { WorkspaceVcs } from './vcs-repo'
import type { VcsCommit } from './types'

const log = {
  info: (...args: unknown[]) => console.log('[WorkspaceVcsSnapshot]', ...args),
  warn: (...args: unknown[]) => console.warn('[WorkspaceVcsSnapshot]', ...args),
  error: (...args: unknown[]) => console.error('[WorkspaceVcsSnapshot]', ...args),
}

/** per-workspace 的串行执行队列 */
const queues = new Map<string, Promise<unknown>>()

/** per-workspace 的队列深度（诊断用：看清「谁堵住了谁」） */
const depths = new Map<string, number>()

/** 排队超过这个时长才值得记一行（正常情况队列是空的，不该刷屏） */
const QUEUE_SLOW_WAIT_MS = 2_000
/** 单个任务执行超过这个时长记一行 */
const QUEUE_SLOW_RUN_MS = 10_000
/** 看门狗节奏：任务仍在排队或仍在执行时，按这个间隔持续告警 */
const QUEUE_WATCHDOG_MS = 30_000

/** per-workspace 的 WorkspaceVcs 实例缓存（按 workspaceDir 复用） */
const repos = new Map<string, WorkspaceVcs>()

function getRepo(workspaceDir: string): WorkspaceVcs {
  let repo = repos.get(workspaceDir)
  if (!repo) {
    repo = new WorkspaceVcs({ workspaceDir })
    repos.set(workspaceDir, repo)
  }
  return repo
}

/**
 * 把任务塞进对应 workspace 的串行队列。
 *
 * `label` 只用于诊断日志。队列本身是纯 promise 链：**没有任何超时**，
 * 因此只要有任务永不 settle，排在它后面的任务会永久静默等待。
 * 2026-09-17 实测过一次：云同步的「立即同步」按钮卡死 14 分钟、
 * 日志里一条线索都没有 —— 看门狗就是为这种情况加的：不改变行为
 * （不中断、不超时），只保证「谁堵住了队列、堵了多久」一定留痕。
 */
function enqueue<T>(workspaceDir: string, task: () => Promise<T>, label = 'task'): Promise<T> {
  const prev = queues.get(workspaceDir) ?? Promise.resolve()
  const depth = (depths.get(workspaceDir) ?? 0) + 1
  depths.set(workspaceDir, depth)

  const queuedAt = Date.now()
  let startedAt = 0

  const watchdog = setInterval(() => {
    const now = Date.now()
    if (startedAt === 0) {
      log.warn(
        `[queue] ${label} 已排队 ${Math.round((now - queuedAt) / 1000)}s 仍未开始` +
          `（队列深度 ${depths.get(workspaceDir) ?? 0}，工作区 ${workspaceDir}）`,
      )
    } else {
      log.warn(
        `[queue] ${label} 已执行 ${Math.round((now - startedAt) / 1000)}s 未结束` +
          `（工作区 ${workspaceDir}）`,
      )
    }
  }, QUEUE_WATCHDOG_MS)
  watchdog.unref?.()

  const wrapped = async (): Promise<T> => {
    startedAt = Date.now()
    const waited = startedAt - queuedAt
    if (waited > QUEUE_SLOW_WAIT_MS) {
      log.info(`[queue] ${label} 开始执行（排队等待 ${waited}ms）`)
    }
    try {
      return await task()
    } finally {
      const ran = Date.now() - startedAt
      if (ran > QUEUE_SLOW_RUN_MS) {
        log.info(`[queue] ${label} 执行结束（耗时 ${ran}ms）`)
      }
      clearInterval(watchdog)
      depths.set(workspaceDir, Math.max(0, (depths.get(workspaceDir) ?? 1) - 1))
    }
  }

  const next = prev.then(wrapped, wrapped)
  // 记录队列尾（吞掉结果用于串行，不阻塞异常传播给调用方）
  queues.set(
    workspaceDir,
    next.catch(() => undefined),
  )
  return next
}

/**
 * 供云同步复用同一串行队列，避免其 git 操作与 Turn 快照并发读写 index/HEAD
 * 造成提交被静默覆盖丢失。
 *
 * `label` 为诊断用标签（如 `cloud-sync:sync`），会出现在队列告警里。
 */
export function enqueueWorkspace<T>(
  workspaceDir: string,
  task: () => Promise<T>,
  label = 'workspace-task',
): Promise<T> {
  return enqueue(workspaceDir, task, label)
}

/**
 * Agent 轮次结束后触发的自动快照。失败不抛出。
 */
export async function maybeSnapshot(params: {
  readonly workspaceDir: string
  readonly conversationId?: string
  readonly runId?: string
}): Promise<VcsCommit | null> {
  const { workspaceDir, conversationId, runId } = params
  if (!workspaceDir) return null

  return enqueue(
    workspaceDir,
    async () => {
      try {
        const repo = getRepo(workspaceDir)
        const summary = conversationId ? `auto: 对话 ${conversationId.slice(0, 8)}` : 'auto: 自动快照'
        const commit = await repo.commit({
          author: 'agent',
          message: summary,
          conversationId,
          runId,
        })
        if (commit) {
          log.info(`[maybeSnapshot] 已快照 oid=${commit.oid.slice(0, 8)} runId=${runId ?? '无'}`)
        }
        return commit
      } catch (err) {
        // 快照失败不影响对话，只记一行摘要，避免整段 isomorphic-git 堆栈刷屏
        const reason = err instanceof Error ? err.message : String(err)
        log.warn(`[maybeSnapshot] 自动快照失败（已忽略，不影响对话）: ${reason}`)
        return null
      }
    },
    'vcs:snapshot',
  )
}

/**
 * 获取（或创建）某 workspace 的 VCS 实例，供 IPC handler 复用同一缓存。
 */
export function getWorkspaceVcs(workspaceDir: string): WorkspaceVcs {
  return getRepo(workspaceDir)
}

/**
 * workspace 目录切换时清除旧实例缓存（下次按新路径重建）。
 */
export function resetWorkspaceVcs(workspaceDir?: string): void {
  if (workspaceDir) {
    repos.delete(workspaceDir)
    queues.delete(workspaceDir)
  } else {
    repos.clear()
    queues.clear()
  }
}
