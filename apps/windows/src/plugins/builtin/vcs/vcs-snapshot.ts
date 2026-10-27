/**
 * Workspace VCS — 自动快照服务
 *
 * 在 Agent 每轮对话结束（message:end 持久化后）触发工作空间快照。
 * 关键约束：
 *  - per-workspace 串行队列，避免并发 commit 撕裂仓库
 *  - 无文件变更则跳过（WorkspaceVcs.commit 内部已去重，返回 null）
 *  - 任何失败仅记录日志，绝不抛出阻断对话主流程
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { WorkspaceVcs } from './vcs-repo'
import type { VcsCommit } from './types'
// 队列状态与其他拷贝（云同步官方扩展）共享，见 workspace-queue.ts
import { enqueue, resetWorkspaceQueue } from '../../../main/workspace-queue'
// 保持原有公开出口（sync-manager / IPC / 测试都从这里取）
export {
  enqueueSyncMaintenance,
  enqueueWorkspace,
  getWorkspaceQueueDepth,
} from '../../../main/workspace-queue'

const log = {
  info: (...args: unknown[]) => console.log('[WorkspaceVcsSnapshot]', ...args),
  warn: (...args: unknown[]) => console.warn('[WorkspaceVcsSnapshot]', ...args),
  error: (...args: unknown[]) => console.error('[WorkspaceVcsSnapshot]', ...args),
}

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
  /** 被合并进来的请求（每个 messageId 都要写一条 turn-index） */
  messageIds: string[]
  /** 被合并进来的请求数（只为日志，便于观察实际收益） */
  coalesced: number
  promise: Promise<VcsCommit | null>
}

/** 回合→commit 索引；读端见 `shared/turn-index.ts` */
async function appendTurnIndex(
  workspaceDir: string,
  slot: PendingSnapshot,
  commit: VcsCommit | null,
): Promise<void> {
  const messageIds = [...new Set(slot.messageIds)]
  if (messageIds.length === 0) return
  const at = Date.now()
  const lines =
    messageIds
      .map((messageId) =>
        JSON.stringify({
          messageId,
          ...(slot.conversationId ? { conversationId: slot.conversationId } : {}),
          ...(slot.runId ? { runId: slot.runId } : {}),
          oid: commit?.oid ?? null,
          at,
          coalesced: slot.coalesced,
        }),
      )
      .join('\n') + '\n'
  const file = path.join(workspaceDir, '.mtbot-vcs', 'turn-index.jsonl')
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, lines, 'utf8')
  } catch (err) {
    // 索引只影响版本内容可取性，不影响快照本身
    log.warn(
      `[maybeSnapshot] 写入 turn-index 失败（已忽略）: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
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
  readonly messageId?: string
}): Promise<VcsCommit | null> {
  const { workspaceDir, conversationId, runId, messageId } = params
  if (!workspaceDir) return Promise.resolve(null)

  const pending = pendingSnapshots.get(workspaceDir)
  if (pending) {
    pending.conversationId = conversationId
    pending.runId = runId
    if (messageId) pending.messageIds.push(messageId)
    pending.coalesced += 1
    return pending.promise
  }

  const slot: PendingSnapshot = {
    conversationId,
    runId,
    messageIds: messageId ? [messageId] : [],
    coalesced: 0,
    // 占位，紧接在 enqueue 之后赋值；enqueue 的任务体最早也在微任务里跑，
    // 同步代码先执行完，任务体读到的必然是已赋值的 promise
    promise: undefined as unknown as Promise<VcsCommit | null>,
  }

  // 先登记、再入队：`enqueue` 在「本工作区正有任务执行」时会**同步**执行任务体
  // （可重入分支）。任务体开头就摘牌；若把登记放在 enqueue 之后，就会把刚摘掉的
  // 槽位又塞回 map —— 之后所有快照请求都合并进这个永远不执行的死槽并静默丢失
  // （2026-10-27 真机 E2E 抓到：临时工作区首个回合后 turn-index 只剩一行）。
  pendingSnapshots.set(workspaceDir, slot)
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
        // 无变更（commit=null）也记一条，表示「该回合没有产生新快照」；
        // 读端会回退到之前最近的 oid。
        await appendTurnIndex(workspaceDir, slot, commit)
        // 对象库维护与快照同队列：本仓库 gc.auto=0，不在这里做就永远没人做。
        // 内部有 6h 间隔 + 松对象阈值，常态是一次 Map 查询即返回。
        await repo.maybeMaintain()
        return commit
      } catch (err) {
        // 快照失败不影响对话，只记一行摘要，避免整段 git 堆栈刷屏
        const reason = err instanceof Error ? err.message : String(err)
        log.warn(`[maybeSnapshot] 自动快照失败（已忽略，不影响对话）: ${reason}`)
        return null
      }
    },
    'vcs:snapshot',
  )
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
  } else {
    repos.clear()
  }
  resetWorkspaceQueue(workspaceDir)
}
