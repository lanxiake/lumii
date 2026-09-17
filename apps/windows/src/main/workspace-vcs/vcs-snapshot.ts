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

/**
 * 已经打过「首次使用」日志的队列键。
 *
 * 队列是按 workspaceDir **字符串**分桶的，而调用方各自推导这个字符串：
 * 云同步走 resolveActiveWorkspaceDir()（path.resolve 归一化 + `||` 兜底），
 * Turn 快照走 getCwd()（原样返回 + `??` 兜底）—— 两条路一旦算出不同的串，
 * 「共享串行队列」就静默裂成两条，互相不再互斥也不再互相阻塞。
 * 这条日志让这种分裂在日志里直接可见（每个键每次进程只打一行）。
 */
const loggedKeys = new Set<string>()

/** 排队超过这个时长才值得记一行（正常情况队列是空的，不该刷屏） */
const QUEUE_SLOW_WAIT_MS = 2_000
/** 单个任务执行超过这个时长记一行 */
const QUEUE_SLOW_RUN_MS = 10_000
/** 看门狗检查节奏 */
const QUEUE_WATCHDOG_MS = 15_000
/** 排队或执行超过这个时长才算「卡住」，按检查节奏持续告警 */
const QUEUE_STUCK_MS = 60_000

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
  if (!loggedKeys.has(workspaceDir)) {
    loggedKeys.add(workspaceDir)
    log.info(`[queue] 首次使用队列键「${workspaceDir}」（来自 ${label}）`)
  }

  const prev = queues.get(workspaceDir) ?? Promise.resolve()
  const depth = (depths.get(workspaceDir) ?? 0) + 1
  depths.set(workspaceDir, depth)

  const queuedAt = Date.now()
  let startedAt = 0

  const watchdog = setInterval(() => {
    const now = Date.now()
    // 从「入队」和「开始」两个时刻**分别**计时：看门狗起算点是入队时刻，
    // 若只按它算，一个排队 30s 刚开跑的任务会被误报成「已执行 30s」。
    const queuedMs = startedAt === 0 ? now - queuedAt : 0
    const runningMs = startedAt === 0 ? 0 : now - startedAt
    if (queuedMs > QUEUE_STUCK_MS) {
      log.warn(
        `[queue] ${label} 已排队 ${Math.round(queuedMs / 1000)}s 仍未开始` +
          `（队列深度 ${depths.get(workspaceDir) ?? 0}，工作区 ${workspaceDir}）`,
      )
    }
    if (runningMs > QUEUE_STUCK_MS) {
      log.warn(
        `[queue] ${label} 已执行 ${Math.round(runningMs / 1000)}s 未结束` +
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
 * 某工作区队列中尚未完成的任务数（**含正在执行的那个**）。
 *
 * 调用方在入队**之前**读它，得到的就是「前面还有几个任务」。
 * 用途是让「排队等待」这件事可见 —— 2026-09-17 的 P0 里，
 * 云同步排在十几个 Turn 快照后面等了好几分钟，而状态栏一直显示上一次的「同步完成」。
 */
export function getWorkspaceQueueDepth(workspaceDir: string): number {
  return depths.get(workspaceDir) ?? 0
}

/**
 * 同一工作区**已排队待执行**的快照请求（合并冗余用）。
 *
 * 快照提交的是「执行那一刻的工作区状态」——同一时刻排在队列里的多个请求
 * 看到的是同一棵树，除了最后一个之外全是冗余。实测多 Agent 并行时队列深度
 * 达到 14，而每个快照要跑 30–80 秒（1977 个文件逐个 `git.add`），把共用同一条
 * 队列的云同步堵到分钟级（2026-09-17 P0）。这里把排队中的请求合并成一个：
 * 后来的调用只把归属信息（谁触发的）更新为最新一次，不再重复排队。
 *
 * 注意是「排队中」才合并：**已在执行**的快照不参与合并 —— 它可能已经读完了树，
 * 此后到达的请求必须排新的，才能捕获本轮之后的变更。
 */
interface PendingSnapshot {
  conversationId?: string
  runId?: string
  /** 被合并进来的请求数（只为日志，便于观察实际收益） */
  coalesced: number
  promise: Promise<VcsCommit | null>
}

const pendingSnapshots = new Map<string, PendingSnapshot>()

/**
 * Agent 轮次结束后触发的自动快照。失败不抛出。
 *
 * 排队中的重复请求会被合并（见 `pendingSnapshots`），因此返回值代表
 * 「合并后那一次快照」的结果 —— 现有唯一调用方是 `void maybeSnapshot(...)`，
 * 不消费返回值。
 */
export function maybeSnapshot(params: {
  readonly workspaceDir: string
  readonly conversationId?: string
  readonly runId?: string
}): Promise<VcsCommit | null> {
  const { workspaceDir, conversationId, runId } = params
  if (!workspaceDir) return Promise.resolve(null)

  const pending = pendingSnapshots.get(workspaceDir)
  if (pending) {
    pending.conversationId = conversationId
    pending.runId = runId
    pending.coalesced += 1
    return pending.promise
  }

  const slot: PendingSnapshot = {
    conversationId,
    runId,
    coalesced: 0,
    // 占位，紧接在 enqueue 之后赋值；enqueue 的任务体最早也在微任务里跑，
    // 同步代码先执行完，任务体读到的必然是已赋值的 promise
    promise: undefined as unknown as Promise<VcsCommit | null>,
  }

  slot.promise = enqueue(
    workspaceDir,
    async () => {
      // 出队即摘牌：此后到达的请求会排一个新的，捕获本轮之后的变更
      pendingSnapshots.delete(workspaceDir)
      if (slot.coalesced > 0) {
        log.info(`[maybeSnapshot] 合并了 ${slot.coalesced} 个排队中的重复快照请求`)
      }
      try {
        const repo = getRepo(workspaceDir)
        const summary = slot.conversationId
          ? `auto: 对话 ${slot.conversationId.slice(0, 8)}`
          : 'auto: 自动快照'
        const commit = await repo.commit({
          author: 'agent',
          message: summary,
          conversationId: slot.conversationId,
          runId: slot.runId,
        })
        if (commit) {
          log.info(`[maybeSnapshot] 已快照 oid=${commit.oid.slice(0, 8)} runId=${slot.runId ?? '无'}`)
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
  pendingSnapshots.set(workspaceDir, slot)
  return slot.promise
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
