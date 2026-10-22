/**
 * per-workspace 串行队列（工作区快照与云同步共用）。
 *
 * 从 `vcs-snapshot.ts` 抽出来的原因：云同步是官方外部扩展，bundle 里有本模块的
 * 第二份拷贝。模块级 Map 会让两份代码各自排队——「共享串行队列」静默裂成两条，
 * 云同步的 git 操作与 Turn 快照重新开始并发读写 index/HEAD（正是队列要防的事）。
 * 状态因此挂在 `globalThis` 的 Symbol 槽位上，任何拷贝读写的都是同一份。
 */

const log = {
  info: (...args: unknown[]) => console.log('[WorkspaceVcsSnapshot]', ...args),
  warn: (...args: unknown[]) => console.warn('[WorkspaceVcsSnapshot]', ...args),
  error: (...args: unknown[]) => console.error('[WorkspaceVcsSnapshot]', ...args),
}

interface QueueState {
  /** per-workspace 的串行队列 */
  queues: Map<string, Promise<unknown>>
  /**
   * 正在**执行**的队列任务所属的工作区（不是「正在排队」）。
   *
   * 用于让队列**可重入**：一个队列任务内部再调 `enqueueWorkspace` 时，若
   * 目标工作区正是自己，则直接执行 —— 重新排队会死锁（外层任务要等内层返回，
   * 而内层要等外层 settle；2026-09-19 分析 `completeAutoResolvedMerge` 时发现）。
   */
  executing: Map<string, number>
  /** per-workspace 的队列深度（诊断用：看清「谁堵住了谁」） */
  depths: Map<string, number>
  /**
   * 已经打过「首次使用」日志的队列键。
   *
   * 队列是按 workspaceDir **字符串**分桶的，而调用方各自推导这个字符串：
   * 云同步走 resolveActiveWorkspaceDir()（path.resolve 归一化 + `||` 兜底），
   * Turn 快照走 getCwd()（原样返回 + `??` 兜底）—— 两条路一旦算出不同的串，
   * 「共享串行队列」就静默裂成两条。这条日志让这种分裂在日志里直接可见。
   */
  loggedKeys: Set<string>
}

const QUEUE_STATE_KEY = Symbol.for('lumii.workspace-vcs.queue')

function sharedState(): QueueState {
  const g = globalThis as Record<symbol, unknown>
  return (g[QUEUE_STATE_KEY] ??= {
    queues: new Map<string, Promise<unknown>>(),
    executing: new Map<string, number>(),
    depths: new Map<string, number>(),
    loggedKeys: new Set<string>(),
  }) as QueueState
}

/** 排队超过这个时长才值得记一行（正常情况队列是空的，不该刷屏） */
const QUEUE_SLOW_WAIT_MS = 2_000
/** 单个任务执行超过这个时长记一行 */
const QUEUE_SLOW_RUN_MS = 10_000
/** 看门狗检查节奏 */
const QUEUE_WATCHDOG_MS = 15_000
/** 排队或执行超过这个时长才算「卡住」，按检查节奏持续告警 */
const QUEUE_STUCK_MS = 60_000

/**
 * 把任务塞进对应 workspace 的串行队列。
 *
 * `label` 只用于诊断日志。队列本身是纯 promise 链：**没有任何超时**，
 * 因此只要有任务永不 settle，排在它后面的任务会永久静默等待。
 * 2026-09-17 实测过一次：云同步的「立即同步」按钮卡死 14 分钟、
 * 日志里一条线索都没有 —— 看门狗就是为这种情况加的：不改变行为
 * （不中断、不超时），只保证「谁堵住了队列、堵了多久」一定留痕。
 */
export function enqueue<T>(workspaceDir: string, task: () => Promise<T>, label = 'task'): Promise<T> {
  const { queues, executing, depths, loggedKeys } = sharedState()

  // 可重入：已经在**执行**本工作区的队列任务时，直接执行。
  //
  // 为什么必须有：队列是纯 promise 链（`prev.then(wrapped)`），嵌套入队时内层要等
  // 外层 settle，而外层正在等内层返回 —— 双方永久互等。2026-09-19 分析
  // `completeAutoResolvedMerge`（它外层被 sync 包住、内部又调 importData/exportAndCommit）
  // 时发现这个形状。
  //
  // 「正在执行」用计数器而非布尔：同一次执行里可能有多个嵌套点，且异常路径要能正确退栈。
  if ((executing.get(workspaceDir) ?? 0) > 0) {
    return task()
  }

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
    executing.set(workspaceDir, (executing.get(workspaceDir) ?? 0) + 1)
    try {
      return await task()
    } finally {
      // 先退栈计数再清看门狗：计数归零后，后续的同工作区调用应当重新排队
      const left = (executing.get(workspaceDir) ?? 1) - 1
      if (left <= 0) executing.delete(workspaceDir)
      else executing.set(workspaceDir, left)

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
 *
 * ⚠️ **这个队列的语义是「工作区串行」**，不是「云同步串行」。只该把**真正碰工作区**
 * 的操作放进来（导出读工作区、导入写工作区、对工作区仓库的 commit）。云同步里那些
 * 只操作 sync 仓库的活（fetch / push / gc）放进来会平白占住工作区锁 ——
 * 实测一次 `git gc` 占住 222 秒，期间所有 Turn 快照排队等待。
 * sync 仓库自己的维护请用 enqueueSyncMaintenance。
 */
export function enqueueWorkspace<T>(
  workspaceDir: string,
  task: () => Promise<T>,
  label = 'workspace-task',
): Promise<T> {
  return enqueue(workspaceDir, task, label)
}

/**
 * 只串行 sync 仓库自身维护的队列（与工作区队列**互不相干**）。
 *
 * 目前唯一用户是 `maybePruneObjectStore` 的 `git gc`：它是纯 sync 仓库操作，
 * 不读也不写工作区，却曾与 Turn 快照争同一条队列 —— 实测占住 222 秒，把工作区
 * 快照全部堵在后面。而它当初占用工作区队列的理由（“别让用户看到同步已完成、
 * 队列却被占着”）恰恰是在描述这个 bug 的症状，不是理由。
 *
 * 用独立队列而非「不排队」：gc 之间仍需互斥，否则两次 gc 撞在同一个 objects 目录上
 * 会互相踩（git 自己有锁，但会以失败告终、白跑一遍）。
 *
 * ⚠️ 键必须**不可能**与工作区路径相同，否则会串回工作区队列。用 `::` 分隔的
 * 合成键：Windows 路径不允许 `:` 出现在文件名里，所以真实路径不会长这样。
 *
 * 返回的 promise 会 reject 传播给调用方 —— 调用方应自行 catch（gc 失败不该影响同步）。
 */
export function enqueueSyncMaintenance<T>(
  syncDir: string,
  task: () => Promise<T>,
  label = 'sync-maintenance',
): Promise<T> {
  return enqueue(`${syncDir}::sync-maintenance`, task, label)
}

/**
 * 某工作区队列中尚未完成的任务数（**含正在执行的那个**）。
 *
 * 调用方在入队**之前**读它，得到的就是「前面还有几个任务」。
 * 用途是让「排队等待」这件事可见 —— 2026-09-17 的 P0 里，
 * 云同步排在十几个 Turn 快照后面等了好几分钟，而状态栏一直显示上一次的「同步完成」。
 */
export function getWorkspaceQueueDepth(workspaceDir: string): number {
  return sharedState().depths.get(workspaceDir) ?? 0
}

/**
 * 工作区切换/测试重置时清空队列记录。
 *
 * 注意**不能**在任务还在排队时清掉 `executing` 之外的东西而不顾后果：
 * 这里只服务于 `resetWorkspaceVcs`（用户显式切换工作空间）。
 */
export function resetWorkspaceQueue(workspaceDir?: string): void {
  const { queues, executing, depths, loggedKeys } = sharedState()
  if (workspaceDir) {
    queues.delete(workspaceDir)
    executing.delete(workspaceDir)
    depths.delete(workspaceDir)
    loggedKeys.delete(workspaceDir)
  } else {
    queues.clear()
    executing.clear()
    depths.clear()
    loggedKeys.clear()
  }
}
