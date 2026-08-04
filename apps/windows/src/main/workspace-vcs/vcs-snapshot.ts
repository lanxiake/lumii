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

/** 把任务塞进对应 workspace 的串行队列 */
function enqueue<T>(workspaceDir: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(workspaceDir) ?? Promise.resolve()
  const next = prev.then(task, task)
  // 记录队列尾（吞掉结果用于串行，不阻塞异常传播给调用方）
  queues.set(
    workspaceDir,
    next.catch(() => undefined),
  )
  return next
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

  return enqueue(workspaceDir, async () => {
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
      log.error(`[maybeSnapshot] 自动快照失败（已忽略，不影响对话）:`, err)
      return null
    }
  })
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
