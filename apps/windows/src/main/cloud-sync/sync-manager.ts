/**
 * CloudSyncManager — 云同步主流程。
 *
 * Git 仓库位于 `~/.lumii/sync`（syncDir）；与 Turn 快照通过 enqueueWorkspace 串行，
 * 避免并发操作 index/HEAD。冲突读写/落决必须使用 getSyncGitParams()，禁止落到工作区 .mtbot-vcs。
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import git, { TREE } from 'isomorphic-git'
import type { PromiseFsClient, WalkerEntry } from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { enqueueWorkspace, getWorkspaceQueueDepth } from '../workspace-vcs/vcs-snapshot'
import { SyncLargeQueue, type LargeQueueStats } from './sync-large-queue'
import { scopeRulesFromConfig } from './sync-scope'
import { resolveActiveWorkspaceDir } from '../workspace-paths'
import { resolveWindowsClientDataRoot } from '../client-data-root'
import { createLogger } from '../logger'
import { getProvider } from './git-provider'
import { loadCloudSyncConfig, decryptToken } from './sync-config'
import { appendSyncLog } from './sync-log'
import type { SyncState, SyncStatus, ConflictInfo } from './types'
import { SyncExporter } from './sync-exporter'
import { SyncImporter } from './sync-importer'
import type { FileChangeSet } from './sync-importer'

const logger = createLogger('cloud-sync/manager')
const execFileAsync = promisify(execFile)

/**
 * push 单步超时。
 *
 * 2026-09-17 由 120s 放宽：大仓库下明显不够 —— 落决路径实测 240s 仍超时
 * （落决 commit 含 applyRemoteNonConflictingChanges 带来的大量变更对象）。
 * 超时只中止**等待**，push 本身仍在后台跑，所以宁可给足时间也不要误判失败。
 */
const PUSH_TIMEOUT_MS = 600_000

/** fetch 超时：网络黑洞时让同步失败等下轮，而不是永久占着串行队列 */
const FETCH_TIMEOUT_MS = 300_000

/**
 * 冲突落决对外的超时（**Agent 工具等待上限**，不是任务死亡时间）。
 *
 * 超时只让 Agent 先拿到结果，resolveInner 仍在串行队列里跑完 ——
 * T1.1 的 isResolveInFlight 守卫保证这期间不会重入，因此本值与内部 push 超时
 * 不必构成嵌套（内部已放宽到 600s，比本值长）。
 */
const RESOLVE_TIMEOUT_MS = 300_000

/** 冲突落决路径上的 push 超时（落决 commit 变更量大，实测 240s 不够用） */
const RESOLVE_PUSH_TIMEOUT_MS = 600_000

/** 刷新冲突快照时重新 fetch 的超时 */
const REFRESH_FETCH_TIMEOUT_MS = 300_000

/** 只读远端 tip 查询（cloud_sync_git remote）超时：仅 getRemoteInfo，远短于 fetch */
const REMOTE_INFO_TIMEOUT_MS = 60_000

/** isomorphic-git 每次 fetch 会新增 pack；超过此数量则触发系统 git gc */
const PACK_GC_THRESHOLD = 3

/** 松散对象触发 gc 的数量/体积阈值（isomorphic-git 的提交只写松散对象，不会自动打包） */
const LOOSE_COUNT_THRESHOLD = 1500
const LOOSE_SIZE_KIB_THRESHOLD = 200 * 1024

/** git gc 超时：GB 级对象库重打包在 Windows 上可达数分钟 */
const GC_TIMEOUT_MS = 600_000

/** 分级参数兜底（正常由 DEFAULT_CLOUD_SYNC_CONFIG 提供；旧配置文件缺字段时用） */
const FALLBACK_SMALL_THRESHOLD_BYTES = 5 * 1024 * 1024
const FALLBACK_LARGE_BATCH_BYTES = 50 * 1024 * 1024

/**
 * 落决守卫的最长有效期。
 *
 * resolveInner 理论上不会永久挂起（内部 push 自带 4 分钟超时），但若真出现，
 * 超过此时长视为守卫失效 —— 宁可重新驱动一轮，也不要让守卫变成永久死锁。
 */
const RESOLVE_IN_FLIGHT_MAX_MS = 30 * 60 * 1000

/**
 * 生成物路径判定：DB 导出物（jsonl/json）的数据语义是「按时间戳记录级合并」，
 * 由 import 承载；它们在 git 层的冲突不该进入 Agent 落决。
 * 详见 handleMergeConflict 的注释。
 */
function isGeneratedSyncPath(filepath: string): boolean {
  return (
    filepath.startsWith('wiki/') ||
    filepath.startsWith('memory/') ||
    filepath.startsWith('autonomous/')
  )
}

/**
 * 取 blob 型条目的 oid；目录条目与缺失条目一律返回 null。
 * 用于 git.walk 树差异：目录的 oid 是 tree oid，其内容变化由子条目各自体现。
 */
async function blobOid(entry: WalkerEntry | null): Promise<string | null> {
  if (!entry) return null
  if ((await entry.type()) !== 'blob') return null
  return (await entry.oid()) ?? null
}

type GitParams = { fs: PromiseFsClient; dir: string; gitdir: string }

type AuthFn = () => { username: string; password: string }

type PushOptions = {
  /** true：被拒时抛错（冲突落决必须成功推送，禁止假成功） */
  failOnReject?: boolean
  /** 覆盖默认 PUSH_TIMEOUT_MS */
  timeoutMs?: number
}

/**
 * 给 Promise 加超时；超时后原 Promise 仍可能在后台继续，但调用方立即收到错误。
 */
/**
 * 给 Promise 加墙钟超时。
 *
 * `message` 接受字符串或 Error 实例 —— 传类型化错误（如 PushTimeoutError）让调用方
 * 能用 `instanceof` 判定，而不是去匹配消息文本。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string | Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer)
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(typeof message === 'string' ? new TimeoutError(message) : message),
        ms,
      )
    }),
  ])
}

interface MergeConflictErrorData {
  filepaths: string[]
  bothModified: string[]
  deleteByUs: string[]
  deleteByTheirs: string[]
}

function isMergeConflict(err: unknown): err is { data: MergeConflictErrorData } {
  return (err as { code?: string } | null)?.code === 'MergeConflictError'
}

/**
 * 从 statusMatrix 结果算出 stage 计划。
 *
 * **关键**：`HEAD 有 + 工作区没有` 默认判为删除，但**排除集内的路径例外**。
 * 分级传输下阶段一导出会跳过 >阈值 的大文件 —— 它们不在工作区却存在于 HEAD，
 * 不排除的话每跑一次阶段一就把阶段二刚提交的大文件删一次。
 *
 * 抽成纯函数是为了可单测：真正的误删风险在这段判定里，不在 git 调用上。
 */
export function computeStagePlan(
  status: ReadonlyArray<readonly [string, number, number, number]>,
  isExcluded: (filepath: string) => boolean,
): { hasChanges: boolean; removals: string[] } {
  let hasChanges = false
  const removals: string[] = []
  for (const [filepath, head, workdir, stage] of status) {
    if (isExcluded(filepath)) continue
    if (head !== workdir || workdir !== stage) hasChanges = true
    if (head !== 0 && workdir === 0) removals.push(filepath)
  }
  return { hasChanges, removals }
}

function isMergeNotSupported(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'MergeNotSupportedError'
}

function isRejectedPush(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /\[rejected\]|non-fast-forward|not a simple fast-forward/i.test(msg)
}

/**
 * withTimeout 的墙钟超时。
 *
 * 与内部业务失败必须区分：超时只说明**调用方等不下去了**，被包的任务仍在后台跑；
 * 业务失败才是任务真的结束了。混淆两者正是 2026-09-17 死循环的一环
 * （Agent 收到 isError 后重新决策，而上一轮其实还在跑）。
 */
class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/**
 * 推送整体超时的**类型化**错误。
 *
 * 原先靠 `err.message.includes('git push 超时')` 字符串匹配 —— 任何消息措辞变动都会
 * 静默失效，而这条分支决定「是否走 refreshConflictFromRemote 去复核远端」，
 * 一旦失效，远端其实已接受推送却会被当成普通失败处理。
 *
 * 导出以便测试构造同类型错误（模拟「服务端已接收但客户端等待超时」）。
 */
export class PushTimeoutError extends TimeoutError {
  constructor(readonly timeoutMs: number) {
    super(`git push 超时（${timeoutMs}ms），已中止等待`)
    this.name = 'PushTimeoutError'
  }
}

/** 推送整体超时（服务端可能已经收到全部对象并接受，客户端不知道结果，需要靠 fetch 复核） */
function isPushTimeout(err: unknown): boolean {
  return err instanceof PushTimeoutError
}

/** 「远端没有该分支」与「拉取失败」的区分：前者是首次同步，后者必须报错等下轮 */
function isNotFoundError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'NotFoundError'
}

export class CloudSyncManager extends EventEmitter {
  private state: SyncState = 'idle'
  private status: SyncStatus = { state: 'idle' }
  private conflict: ConflictInfo | undefined
  private onConflictDetected?: (conflict: ConflictInfo) => void

  /** 轻量自动提交进行中（防重入；不改 state，state 归完整同步所有） */
  private localCommitInFlight = false

  /**
   * 被安全阀挡下的批量删除，等待用户显式确认。
   *
   * **2026-09-16 事故的根因与修复**：旧实现是「被挡下 → 置布尔 → 下一次同步自动放行」，
   * 而"下一次同步"由 30 分钟定时器触发 —— 自动化流程里的二次确认等于没有确认。
   * 实测：第二台设备在 60 秒内两次同步，第二次就把远端 896 个文件删掉了。
   *
   * 现在：挡下时只记录待删集合的**指纹**，必须由用户在设置页显式确认
   * （confirmMassDelete）才可能放行；指纹与实际待删集合不一致时确认自动失效。
   */
  private pendingMassDelete:
    | { fingerprint: string; count: number; createdAt: number }
    | undefined
  /** 已被用户显式确认的待删集合指纹（syncInner 开头消费一次） */
  private confirmedMassDeleteFingerprint: string | undefined
  /** 本次完整同步携带的确认指纹（真正放行与否由 sync-copy 用指纹比对决定） */
  private confirmedFingerprintThisSync: string | undefined

  /**
   * 落决任务是否在飞行中（已入队、尚未结束）。
   *
   * resolveConflict 的超时只让**调用方**提前返回，队列里的 resolveInner 不可取消、仍在跑。
   * 心跳（autonomous-tick cron，默认每 10 分钟）会无条件驱动冲突处理，而外层超时是 5 分钟
   * —— 不挡的话每轮都会再排一个落决并让 Agent 重新决策，形成 2026-09-17 实测的死循环。
   */
  private resolveInFlight = false
  private resolveInFlightSince = 0

  /** 不缓存目录，每次惰性取（切工作空间无需重建实例） */
  private get workspaceDir(): string {
    return resolveActiveWorkspaceDir()
  }

  /** sync 目录（新的同步数据目录） */
  private get syncDir(): string {
    const clientRoot = resolveWindowsClientDataRoot()
    return path.join(clientRoot, 'sync')
  }

  /** 数据目录 */
  private get dataDir(): string {
    const clientRoot = resolveWindowsClientDataRoot()
    return path.join(clientRoot, 'data')
  }

  /** 数据库路径 */
  private get dbPath(): string {
    return path.join(this.dataDir, 'agent-runtime.db')
  }

  /** syncDir 仓库的 git 参数（冲突读写/落决必须用此，禁止落到工作区 .mtbot-vcs） */
  private getSyncGitParams(): GitParams {
    return {
      fs,
      dir: this.syncDir,
      gitdir: path.join(this.syncDir, '.git'),
    }
  }

  /** 设置冲突检测回调（由 main/index.ts 注入，用于创建自主目标） */
  setOnConflictDetected(callback: (conflict: ConflictInfo) => void): void {
    this.onConflictDetected = callback
  }

  getStatus(): SyncStatus {
    return this.status
  }

  /** 当前工作区队列中尚未完成的任务数（含正在执行的那个）—— 供工具如实回报排队情况 */
  getQueueDepth(): number {
    return getWorkspaceQueueDepth(this.workspaceDir)
  }

  /**
   * 标记「请求已收下、正在排队」。
   *
   * 刻意**不走 setState**：排队不是一次同步，不能污染 `lastSyncAt`，
   * 也不能让 `state` 离开 `idle`（会打断 watcher 抑制判断与 commitLocalChanges 守卫，
   * 见 SyncStatus.queuedBehind 的注释）。`queuedBehind` 由 setState 在
   * 任何真实状态迁移时统一清除。
   */
  private markQueued(queuedBehind: number): void {
    this.status = {
      ...this.status,
      message: `前面还有 ${queuedBehind} 个任务，尚未开始同步`,
      queuedBehind,
    }
    this.emit('status', this.status)
    logger.info(`[sync] 排队等待中（前面还有 ${queuedBehind} 个任务，尚未开始）`)
  }

  /** 清除排队标记（任务开始执行、或任何真实状态迁移时调用） */
  private clearQueued(): void {
    if (this.status.queuedBehind === undefined) return
    const { queuedBehind: _drop, ...rest } = this.status
    this.status = rest
    this.emit('status', this.status)
  }

  getConflict(): ConflictInfo | undefined {
    return this.conflict
  }

  /** 当前待用户确认的批量删除（供设置页展示；无则 undefined） */
  getPendingMassDelete(): { fingerprint: string; count: number; createdAt: number } | undefined {
    return this.pendingMassDelete
  }

  /**
   * 用户显式确认批量删除（设置页「确认删除」按钮）。
   *
   * 只接受与当前 pendingMassDelete **完全一致**的指纹 —— 集合变了（用户恢复了文件、
   * 或又删了更多）确认即失效，必须重新同步一轮让安全阀重新评估。
   * 确认后需再触发一次同步，删除才会真正执行（指纹在该次同步中比对放行）。
   */
  confirmMassDelete(fingerprint: string): { success: boolean; error?: string } {
    const pending = this.pendingMassDelete
    if (!pending) {
      return { success: false, error: '当前没有待确认的批量删除' }
    }
    if (pending.fingerprint !== fingerprint) {
      return {
        success: false,
        error: '待删集合已变化，确认失效。请重新同步一次以获取最新待删清单。',
      }
    }
    this.confirmedMassDeleteFingerprint = fingerprint
    this.pendingMassDelete = undefined
    logger.warn(
      `[confirmMassDelete] 用户已显式确认批量删除 ${pending.count} 项（fingerprint=${fingerprint}）`,
    )
    return { success: true }
  }

  /** 唯一同步入口，进程内串行；conflict/syncing 期间重入直接返回 */
  async sync(): Promise<{ success: boolean; state: SyncState }> {
    const workspaceDir = this.workspaceDir
    // 入队**之前**读深度 = 前面还有几个任务。这条日志与下面的 markQueued 一起，
    // 让「排队等待」不再无声：此前状态停留在上一次同步留下的「同步完成」，
    // 用户看到的是按钮一直转圈，而界面/CLI 都显示一切正常（2026-09-17 P0）。
    const queuedBehind = getWorkspaceQueueDepth(workspaceDir)
    logger.info(`[sync] 收到同步请求（工作区 ${workspaceDir}，前面还有 ${queuedBehind} 个任务）`)
    if (queuedBehind > 0) this.markQueued(queuedBehind)

    const result = await enqueueWorkspace(
      workspaceDir,
      () => {
        // 任务真正开始 = 排队结束。清在这里而不是只靠 syncInner 的 setState：
        // syncInner 在 conflict/syncing 时会**提前 return 且不调 setState**，
        // 只靠 setState 清的话，那条路径会把「排队中」永远挂在状态栏上
        this.clearQueued()
        return this.syncInner()
      },
      'cloud-sync:sync',
    )
    // 阶段一完成且空闲 → 顺带推动阶段二：大文件后台慢慢传，不阻塞小文件到位
    if (result.success && this.state === 'idle') {
      this.kickLargeQueue()
    }
    return result
  }

  /** 阶段二大文件队列（惰性构造：目录用 getter，切工作空间无需重建） */
  private largeQueue: SyncLargeQueue | null = null

  private getLargeQueue(): SyncLargeQueue {
    if (!this.largeQueue) {
      this.largeQueue = new SyncLargeQueue(
        {
          getGitParams: () => this.getSyncGitParams(),
          push: (localRef) => this.pushBranch(localRef),
          getState: () => this.state,
          enqueue: (fn) => enqueueWorkspace(this.workspaceDir, fn, 'cloud-sync:large-batch'),
          getLimits: () => {
            const cfg = loadCloudSyncConfig()
            return {
              thresholdBytes: cfg.smallFileThresholdBytes ?? FALLBACK_SMALL_THRESHOLD_BYTES,
              batchBytes: cfg.largeFileBatchBytes ?? FALLBACK_LARGE_BATCH_BYTES,
              branch: cfg.branch || 'main',
              rules: scopeRulesFromConfig(cfg),
            }
          },
        },
        () => ({
          workspaceOutputsDir: path.join(this.workspaceDir, 'outputs'),
          syncOutputsDir: path.join(this.syncDir, 'workspace/outputs'),
        }),
      )
    }
    return this.largeQueue
  }

  /** 阶段二进度快照（供 UI）；队列尚未初始化过时返回 undefined */
  getLargeQueueStats(): LargeQueueStats | undefined {
    return this.largeQueue?.getStats()
  }

  /**
   * 按需推送指定路径（相对 outputs）—— 供 Agent 的 `cloud_sync_push` 工具。
   * 不经扫描与阈值，直接作为一批提交推送。
   */
  async pushPaths(paths: readonly string[]): Promise<{ success: boolean; message: string }> {
    return this.getLargeQueue().pushPaths(paths)
  }

  /** 供阶段二队列推送分支（复用内部 push 的认证、超时与脱敏） */
  private async pushBranch(localRef: string): Promise<boolean> {
    const cfg = loadCloudSyncConfig()
    const token = decryptToken(cfg.tokenEnc)
    const auth = (): ReturnType<AuthFn> => getProvider(cfg.provider).auth(token)
    return this.push(this.getSyncGitParams(), cfg.repoUrl.trim(), localRef, auth)
  }

  /**
   * 触发阶段二队列（**不 await**）：它在后台一批批传，每批都是独立队列任务，
   * 批次之间会给高优先级同步让路。
   */
  private kickLargeQueue(): void {
    void this.getLargeQueue()
      .pump()
      .then((r) => {
        if (r.batches > 0) {
          logger.info(
            `[kickLargeQueue] 本轮传完 ${r.batches} 批 / ${r.files} 个文件 / ${(r.bytes / 1048576).toFixed(1)} MB${r.yielded ? '（让路结束，下轮继续）' : ''}`,
          )
        }
      })
      .catch((err) => {
        logger.warn(`[kickLargeQueue] 异常: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  private async syncInner(): Promise<{ success: boolean; state: SyncState }> {
    const cfg = loadCloudSyncConfig()
    if (!cfg.enabled || !cfg.repoUrl || !cfg.tokenEnc) {
      this.setState('idle', '云同步未启用')
      return { success: false, state: 'idle' }
    }
    if (this.state === 'conflict') return { success: false, state: 'conflict' }
    if (this.state === 'syncing') return { success: false, state: 'syncing' }

    // 消费一次已确认的指纹（放在重入守卫之后：被挡回的重入不该消耗掉它）。
    // 是否真正放行由 sync-copy 用指纹比对决定 —— 本次待删集合与用户确认过的那一批
    // 不一致时确认自动失效，绝不存在"被挡下就下次自动放行"的路径。
    this.confirmedFingerprintThisSync = this.confirmedMassDeleteFingerprint
    this.confirmedMassDeleteFingerprint = undefined

    this.setState('syncing', '开始同步')
    try {
      // 确保 sync 目录存在
      if (!fs.existsSync(this.syncDir)) {
        fs.mkdirSync(this.syncDir, { recursive: true })
      }

      // 使用 sync 目录作为 Git 仓库
      const p = this.getSyncGitParams()

      const provider = getProvider(cfg.provider)
      const token = decryptToken(cfg.tokenEnc)
      const auth = (): ReturnType<AuthFn> => provider.auth(token)
      const url = cfg.repoUrl.trim()
      const branch = cfg.branch || 'main'
      const localRef = `refs/heads/${branch}`
      const remoteRef = `refs/remotes/origin/${branch}`

      // 1. 初始化 Git 仓库（如果不存在）
      if (!fs.existsSync(path.join(this.syncDir, '.git'))) {
        await git.init({ ...p, defaultBranch: branch })
        logger.info('[sync] 初始化 Git 仓库')
      }

      // 1.5 写入 .gitignore
      this.ensureSyncGitignore()

      // 2. 确保 remote origin
      try {
        await git.addRemote({ ...p, remote: 'origin', url, force: true })
      } catch (err) {
        // 已存在，忽略
      }

      // ===== 流程：export 本地 → fetch → merge → import → export → push =====
      // 用户文件方向的 export 必须早于 import：export 产生的 commit 就是三方合并的
      // ours（等价于 Unison 的 archive）。反过来先 import，会拿陈旧的 sync 内容覆盖
      // 本地尚未导出的改动。jsonl 那类「数据库生成物」才适用先 import 后 export。

      // 3. 先把本地改动固定成一次 commit（不 push），其 oid 作为本次合并基线
      logger.info('[sync] 1. 导出本地改动...')
      const baselineOid =
        (await this.exportAndCommit(p, { localEditsOnly: true })) ??
        (await git.resolveRef({ ...p, ref: 'HEAD' }).catch(() => null))

      // 4. fetch 远端
      logger.info('[sync] 2. Fetch 远端数据...')
      let remoteOid: string | null
      try {
        // 不要传 singleBranch：该模式下 isomorphic-git 只把「本地分支 tip」作为 have 发出，
        // 而同步流程第 3 步刚产生过未推送的本地提交 → 服务端无法排除任何对象，
        // 每次 fetch 都近全量下载（实测每次 ~490MB pack，对象库滚到 GB 级）。
        // 放开后 refs/remotes/origin/* 也进入 have 列表，恢复增量协商。
        await withTimeout(
          git.fetch({ ...p, http, remote: 'origin', ref: branch, onAuth: auth }),
          FETCH_TIMEOUT_MS,
          `git fetch 超时（${FETCH_TIMEOUT_MS}ms），已中止等待`,
        )
      } catch (err) {
        // 「远端确实没有该分支」（NotFoundError → 首次同步）与「拉取失败」（网络/认证/超时）
        // 必须区分：后者若当作空远端，会错误地走到「首次推送」路径掩盖真实故障
        if (!isNotFoundError(err)) throw err
      }
      remoteOid = await git.resolveRef({ ...p, ref: remoteRef }).catch(() => null)

      const localOid = await git.resolveRef({ ...p, ref: 'HEAD' }).catch(() => null)

      // 5. 首次推送（远端为空）
      if (remoteOid === null) {
        logger.info('[sync] 远端为空，准备首次推送')
        await this.exportAndCommit(p)
        const pushed = await this.push(p, url, localRef, auth)
        return this.finishIdle(pushed ? '首次推送完成' : '远端有更新，已提交本地，下一轮重试')
      }

      // 6. 本地无 commit（全新设备）：只增不删地拉取远端
      if (!localOid) {
        logger.info('[sync] 本地无提交，拉取远端')
        await git.checkout({ ...p, ref: branch, force: true })
        await this.importData(p, null)
        return this.finishIdle('已拉取远程数据')
      }

      // 7. 判断远端和本地的关系
      const baseOids = await git.findMergeBase({ ...p, oids: [localOid, remoteOid] })

      if (baseOids.length === 0) {
        logger.info('[sync] 与远端历史无关，做双亲合并（保留本地）')
        await this.mergeUnrelatedHistory(p, localRef, localOid, remoteOid)
        await this.exportAndCommit(p)
        await this.push(p, url, localRef, auth)
        return this.finishIdle('已合并远端历史')
      }

      const baseOid = baseOids[0]

      // 8. 远端无变化（仅本地新）
      if (baseOid === remoteOid) {
        logger.info('[sync] 仅本地有新提交')
        await this.exportAndCommit(p)
        const pushed = await this.push(p, url, localRef, auth)
        return this.finishIdle(pushed ? '同步完成' : '远端有更新，已提交本地，下一轮重试')
      }

      // 9. 本地无变化（仅远端新）→ 快进
      if (baseOid === localOid) {
        logger.info('[sync] 仅远端有新提交，快进合并')
        await git.writeRef({ ...p, ref: localRef, value: remoteOid, force: true })
        await git.checkout({ ...p, ref: localRef, force: true })
        await this.importData(p, baselineOid)
        return this.finishIdle('已拉取远程变更')
      }

      // 10. 双方都有新提交 → merge → import → export → push
      logger.info('[sync] 双方都有新提交，执行三方合并')

      // 10.1 先尝试 merge（可能产生冲突）
      try {
        await git.merge({
          ...p,
          // 必须传分支名而非 'HEAD'：isomorphic-git 内部用 GitRefManager.writeRef
          // **直接覆盖该 ref 文件**，传 'HEAD' 会把 .git/HEAD 写成裸 oid（detached），
          // 且 refs/heads/<branch> 根本不动。后果是随后的 commit 落到游离提交、
          // push 推的还是旧 main —— 多设备场景下表现为「本地改动推不上去」。
          ours: localRef,
          theirs: remoteRef,
          author: { name: 'Lumii CloudSync', email: 'sync@lumii.local' },
          message: '合并远程变更',
        })
      } catch (err) {
        if (isMergeConflict(err)) {
          return this.handleMergeConflict(p, url, localRef, auth, {
            data: err.data,
            localOid,
            remoteOid,
            baseOid,
            baselineOid,
          })
        }
        if (isMergeNotSupported(err)) {
          this.setState('error', '冲突类型暂不支持自动合并（新增文件/重命名），请手动处理')
          return { success: false, state: 'error' }
        }
        throw err
      }

      // 刷新工作树到合并结果。同样传分支名：传 'HEAD' 会把 HEAD 写成 detached。
      // 不带 force：本地改动已在步骤 3 落成 commit，工作树理应干净；
      // 若仍有未提交修改，宁可报错也不要静默丢弃
      await git.checkout({ ...p, ref: localRef })

      // 10.2 导入：jsonl 走时间戳 merge，用户文件走 git 树差异
      await this.importData(p, baselineOid)

      // 10.3 导出当前状态（本地 + 远端合并后的结果）
      await this.exportAndCommit(p)

      // 10.4 推送
      const finalPushed = await this.push(p, url, localRef, auth)

      return this.finishIdle(finalPushed ? '同步完成' : '远端有更新，已提交本地，下一轮重试')
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const token = decryptToken(cfg.tokenEnc)
      const safeReason = token ? reason.split(token).join('***') : reason
      logger.error(`[sync] 同步失败: ${safeReason}`)
      this.setState('error', safeReason)
      return { success: false, state: 'error' }
    }
  }

  /** 确保 sync 目录有 .gitignore，忽略导出时每次都会重写时间戳的 .sync-manifest.json */
  private ensureSyncGitignore(): void {
    const gitignorePath = path.join(this.syncDir, '.gitignore')
    const ignoreLine = '.sync-manifest.json'
    let content: string
    try {
      content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : ''
    } catch {
      content = ''
    }
    // 已含该规则则跳过，避免覆盖用户自定义内容
    if (content.split(/\r?\n/).some((l) => l.trim() === ignoreLine)) return
    const sep = content && !content.endsWith('\n') ? '\n' : ''
    fs.writeFileSync(gitignorePath, content + sep + ignoreLine + '\n')
    logger.info('[sync] 已写入 .gitignore 忽略同步清单')
  }

  /**
   * isomorphic-git 每次 fetch 都会落一份新 pack，提交又只写松散对象，都不会自动 gc。
   * pack 数或松散对象超过阈值时调用系统 git gc，避免对象库滚到数十 GB 拖死落决。
   * （系统 git 不可用时只按 pack 数判断，gc 失败仅告警，不影响同步。）
   */
  private async maybePruneObjectStore(): Promise<void> {
    const packDir = path.join(this.syncDir, '.git', 'objects', 'pack')
    let packCount = 0
    try {
      packCount = fs
        .readdirSync(packDir)
        .filter((name) => name.endsWith('.pack'))
        .length
    } catch {
      return
    }

    let looseCount = 0
    let looseSizeKib = 0
    try {
      const { stdout } = await execFileAsync('git', ['count-objects', '-v'], {
        cwd: this.syncDir,
        timeout: 30_000,
        windowsHide: true,
      })
      looseCount = Number(/^count:\s*(\d+)/m.exec(stdout)?.[1] ?? 0)
      looseSizeKib = Number(/^size:\s*(\d+)/m.exec(stdout)?.[1] ?? 0)
    } catch {
      // 系统 git 不可用：退化为只看 pack 数
    }

    const needGc =
      packCount > PACK_GC_THRESHOLD ||
      looseCount > LOOSE_COUNT_THRESHOLD ||
      looseSizeKib > LOOSE_SIZE_KIB_THRESHOLD
    if (!needGc) return

    logger.warn(
      `[maybePruneObjectStore] packs=${packCount} loose=${looseCount}(${Math.round(looseSizeKib / 1024)}MB)，执行 git gc…`,
    )
    try {
      await execFileAsync('git', ['gc', '--prune=now'], {
        cwd: this.syncDir,
        timeout: GC_TIMEOUT_MS,
        windowsHide: true,
      })
      logger.info('[maybePruneObjectStore] git gc 完成')
    } catch (err) {
      logger.warn(
        `[maybePruneObjectStore] git gc 失败（可忽略，不影响同步）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  /** 成功收尾：先切回 idle（UI 立即更新），再尝试压缩对象库 */
  /**
   * 收尾：把状态置回 idle。
   *
   * **git gc 必须在 setState 之前** —— 它跑在同一条串行队列里（预算 600s），
   * 先宣告「同步完成」再 gc，会出现「设置页显示已完成、队列其实还被占着」的假象：
   * 此时用户点「立即同步」会一直排队，而状态栏一切正常，无从察觉
   * （2026-09-17 排查实测：一次同步任务在「已宣告完成」之后仍占队列 44s）。
   */
  private async finishIdle(message: string): Promise<{ success: true; state: 'idle' }> {
    await this.maybePruneObjectStore()
    this.setState('idle', message)
    return { success: true, state: 'idle' }
  }

  /**
   * 推送。返回是否推送成功；普通 sync 被拒不外抛、由调用方提示「下一轮重试」，
   * 冲突落决传 failOnReject 让被拒抛出（交由刷新路径处理）。
   * 带超时，避免网络/错误仓库导致 Agent 工具永久挂起。
   */
  private async push(
    p: GitParams,
    _url: string,
    localRef: string,
    auth: AuthFn,
    opts?: PushOptions,
  ): Promise<boolean> {
    const timeoutMs = opts?.timeoutMs ?? PUSH_TIMEOUT_MS
    const pushPromise = git.push({
      ...p,
      http,
      remote: 'origin',
      ref: localRef,
      remoteRef: localRef,
      onAuth: auth,
    })
    try {
      await withTimeout(pushPromise, timeoutMs, new PushTimeoutError(timeoutMs))
      return true
    } catch (err) {
      if (isRejectedPush(err)) {
        if (opts?.failOnReject) throw err
        logger.warn('[sync] 远程有更新，下轮重试')
        return false
      }
      throw err
    }
  }

  /**
   * 三方合并冲突的统一处理入口。
   *
   * 生成物（wiki/、memory/、autonomous/ 下的 DB 导出物）的冲突不进入 Agent：
   * 它们的数据语义是「按时间戳记录级合并」，由 import 承载。落决取远端版本只是让
   * 工作树先拿到远端内容，随后 import 会把远端记录并入本地 DB、export 再从 DB 重建文件
   * —— 本地数据一条不丢（v3 设计 §6.2 的不变量：生成物不参与 git 文字合并）。
   * 只有用户文件（profile/、workspace/）的冲突才需要 Agent 判断取舍。
   */
  private async handleMergeConflict(
    p: GitParams,
    url: string,
    localRef: string,
    auth: AuthFn,
    ctx: {
      data: MergeConflictErrorData
      localOid: string
      remoteOid: string
      baseOid: string
      baselineOid: string | null
    },
  ): Promise<{ success: boolean; state: SyncState }> {
    const all = ctx.data.filepaths ?? []
    const generated = all.filter(isGeneratedSyncPath)
    const agentFiles = all.filter((f) => !isGeneratedSyncPath(f))

    if (generated.length > 0) {
      logger.info(
        `[handleMergeConflict] ${generated.length} 个生成物冲突自动取远端（数据合并交给 import）`,
      )
      await this.checkoutRemoteFiles(p, ctx.remoteOid, generated)
    }

    if (agentFiles.length === 0) {
      return this.completeAutoResolvedMerge(p, url, localRef, auth, {
        localOid: ctx.localOid,
        remoteOid: ctx.remoteOid,
        baseOid: ctx.baseOid,
        baselineOid: ctx.baselineOid,
        conflictFiles: all,
        generatedCount: generated.length,
      })
    }

    return this.enterConflict(
      {
        filepaths: agentFiles,
        bothModified: (ctx.data.bothModified ?? []).filter((f) => !isGeneratedSyncPath(f)),
        deleteByUs: (ctx.data.deleteByUs ?? []).filter((f) => !isGeneratedSyncPath(f)),
        deleteByTheirs: (ctx.data.deleteByTheirs ?? []).filter((f) => !isGeneratedSyncPath(f)),
      },
      ctx.localOid,
      ctx.remoteOid,
      ctx.baseOid,
    )
  }

  /** 把指定文件的工作树/索引内容置为远端版本（生成物冲突的自动落决） */
  private async checkoutRemoteFiles(
    p: GitParams,
    remoteOid: string,
    files: readonly string[],
  ): Promise<void> {
    for (const f of files) {
      try {
        await git.checkout({ ...p, ref: remoteOid, filepaths: [f], force: true, noUpdateHead: true })
        await git.add({ ...p, filepath: f })
      } catch (err) {
        // 删除型冲突（远端已删）在远端树里读不到内容：跳过并留给后续 import/export 收敛
        logger.warn(
          `[checkoutRemoteFiles] 取远端版本失败已跳过: ${f} (${err instanceof Error ? err.message : String(err)})`,
        )
      }
    }
  }

  /**
   * 生成物冲突自动落决后的收尾：补远端非冲突变更 → 合并提交 → import → export → push。
   *
   * 顺序与正常合并流程（steps 10.2-10.4）一致：先把远端记录并入 DB，再从 DB 重建导出物，
   * 推上去的文件是「两边数据的并集」而不是简单取某一侧；这也让冲突在数据层被消化掉。
   */
  private async completeAutoResolvedMerge(
    p: GitParams,
    url: string,
    localRef: string,
    auth: AuthFn,
    ctx: {
      localOid: string
      remoteOid: string
      baseOid: string
      baselineOid: string | null
      conflictFiles: readonly string[]
      generatedCount: number
    },
  ): Promise<{ success: boolean; state: SyncState }> {
    await this.applyRemoteNonConflictingChanges(
      p,
      { baseOid: ctx.baseOid, remoteOid: ctx.remoteOid },
      ctx.conflictFiles,
    )
    await git.commit({
      ...p,
      ref: localRef,
      parent: [ctx.localOid, ctx.remoteOid],
      message: '合并远程变更（生成物冲突自动取远端）',
      author: { name: 'Lumii CloudSync', email: 'sync@lumii.local' },
    })
    await this.attachHeadToBranch(p, localRef)

    await this.importData(p, ctx.baselineOid)
    await this.exportAndCommit(p)
    const pushed = await this.push(p, url, localRef, auth)
    logger.info(`[completeAutoResolvedMerge] 已自动合并 ${ctx.generatedCount} 个生成物冲突`)
    return this.finishIdle(
      pushed ? `已自动合并 ${ctx.generatedCount} 个生成物冲突` : '远端有更新，已提交本地，下一轮重试',
    )
  }

  /**
   * 无关历史（首次同步且两边都有数据）：保留本地历史，与远端做双亲合并。
   *
   * 旧实现（adoptRemote）把分支直接钉到远端 HEAD，本地 git 历史丢失，
   * 本地独有文件只能靠 import 的「只增不删」侥幸留下。现在改为：
   * 远端独有的文件补入本地（**本地优先，同名不覆盖**），再提交一个
   * parent 为 [localOid, remoteOid] 的合并提交，两条历史都保留。
   *
   * 为什么不用 isomorphic-git 的 `merge({ allowUnrelatedHistories: true })`：
   * 它以**空树**作 merge base，于是两边都存在的同名文件一律判定为
   * 「双方各自新增且内容不同」→ 全部冲突。首次同步时同名文件往往几十个，
   * 会把冲突 Agent 拖进一个极重的任务。这里的语义是用户明确选择的
   * 「本地文件优先、远端文件补入」，无冲突且可预期。
   */
  private async mergeUnrelatedHistory(
    p: GitParams,
    localRef: string,
    localOid: string,
    remoteOid: string,
  ): Promise<void> {
    this.backupSyncDir()

    // 1. 远端独有的用户文件补入本地（本地已存在的同名文件一律不覆盖）
    await this.adoptRemoteOnlyFiles(p, localOid, remoteOid)

    // 2. 远端 jsonl 合入数据库（时间戳 merge，只动数据库不动文件）
    await this.importData(p, null)

    // 3. 把合并后的本地状态（本地 ∪ 远端）镜像进工作树
    const exporter = new SyncExporter({
      dbPath: this.dbPath,
      syncDir: this.syncDir,
      workspaceDir: this.workspaceDir,
      dataDir: this.dataDir,
      confirmedMassDeleteFingerprint: this.confirmedFingerprintThisSync,
      outputsMaxBytes: loadCloudSyncConfig().smallFileThresholdBytes,
      scopeRules: scopeRulesFromConfig(loadCloudSyncConfig()),
    })
    const mergeExport = await exporter.export()

    // 4. stage 后提交双亲 commit（不传 tree：commit 会从 index 生成，index 此刻就是本地状态）
    //    排除跳过的大文件：它们在 HEAD 里但不在工作区，不排除会被判成删除
    await this.stageAllChanges(p, mergeExport.skippedLargePaths)
    await git.commit({
      ...p,
      ref: localRef,
      parent: [localOid, remoteOid],
      message: '合并无关历史的远端数据',
      author: { name: 'Lumii CloudSync', email: 'sync@lumii.local' },
    })
    // 挂回分支指针，避免 detached（否则后续 commit 落到游离提交、push 推空）
    await this.attachHeadToBranch(p, localRef)
    logger.info('[mergeUnrelatedHistory] 已提交双亲合并，本地历史保留')
  }

  /**
   * 无关历史合并用：把远端相对本地**新增**的文件复制到本地。
   *
   * - 本地已存在同名文件 → 一律跳过（本地优先）
   * - 远端删除的文件 → 忽略（无关历史时「远端没有」不构成删除信号）
   */
  private async adoptRemoteOnlyFiles(
    p: GitParams,
    localOid: string,
    remoteOid: string,
  ): Promise<void> {
    const changes = await this.computeFileChanges(p, localOid, remoteOid)
    if (!changes || changes === 'all') return

    let adopted = 0
    for (const repoPath of changes.copy) {
      const localPath = this.toLocalPath(repoPath)
      if (!localPath) continue
      if (fs.existsSync(localPath)) continue
      try {
        const { blob } = await git.readBlob({ ...p, oid: remoteOid, filepath: repoPath })
        fs.mkdirSync(path.dirname(localPath), { recursive: true })
        fs.writeFileSync(localPath, Buffer.from(blob))
        adopted += 1
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn(`[adoptRemoteOnlyFiles] 补入失败已跳过: ${repoPath} (${msg})`)
      }
    }
    logger.info(`[adoptRemoteOnlyFiles] 补入远端独有文件 ${adopted} 个（本地同名文件全部保留）`)
  }

  /** 备份 sync 目录（无关历史合并前兜底；失败不阻断同步） */
  private backupSyncDir(): void {
    const backupDir = `${this.syncDir}.lumii-sync-backup-${Date.now()}`
    try {
      fs.cpSync(this.syncDir, backupDir, {
        recursive: true,
        filter: (src) => !src.includes('.git'),
        // Windows 上复制符号链接需要管理员权限，跟随链接而非复制它
        verbatimSymlinks: false,
      })
      logger.warn(`[backupSyncDir] 检测到无关历史，本地已备份到 ${backupDir}`)
    } catch (err) {
      logger.warn(`[backupSyncDir] 备份失败（将继续同步）: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 计算两个提交之间所有路径的增删改。
   *
   * 这是删除传播的唯一依据 —— 不扫描目录做差集：只看两侧状态无法区分
   * 「本地删了」与「远端新增」，扫描式镜像会在首次同步时删空本地独有文件。
   *
   * @returns null 表示无可用基线（首次同步 / 无变化），调用方应退化为只增不删
   */
  private async computeFileChanges(
    p: GitParams,
    baselineOid: string | null,
    headOid: string | null,
  ): Promise<FileChangeSet | null> {
    if (!baselineOid || !headOid || baselineOid === headOid) return null

    const copy: string[] = []
    const deleted: string[] = []

    await git.walk({
      ...p,
      trees: [TREE({ ref: baselineOid }), TREE({ ref: headOid })],
      map: async (filepath, entries) => {
        // 注意：返回 undefined 不会剪枝子树，返回 null 才会 —— 这里必须返回 undefined
        if (filepath === '.') return
        const [before, after] = entries as Array<WalkerEntry | null>
        const beforeOid = await blobOid(before)
        const afterOid = await blobOid(after)
        if (beforeOid === afterOid) return
        if (afterOid === null) deleted.push(filepath)
        else copy.push(filepath)
      },
    })

    logger.info(`[computeFileChanges] 树差异：写入 ${copy.length} 项，删除 ${deleted.length} 项`)
    return { copy, delete: deleted }
  }

/**
 * 从 statusMatrix 结果算出 stage 计划。
 *
 * **关键**：`HEAD 有 + 工作区没有` 默认判为删除，但**排除集内的路径例外**。
 * 分级传输下阶段一导出会跳过 >阈值 的大文件 —— 它们不在工作区却存在于 HEAD，
 * 不排除的话每跑一次阶段一就把阶段二刚提交的大文件删一次。
 *
 * 抽成纯函数是为了可单测：真正的误删风险在这段判定里，不在 git 调用上。
 */
  /**
   * 把工作树的变化 stage 进 index，返回是否有变更。
   *
   * isomorphic-git 的 add 从目录遍历文件，**已删除的文件不在遍历结果里** ——
   * 删除必须显式 git.remove，否则永远进不了 commit（「删了又回来」的根因之一）。
   *
   * @param excludeFromRemoval 这些路径不参与「已删除」判定、也不会被 remove
   *        （用于阶段一跳过的大文件，见 computeStagePlan）
   */
  private async stageAllChanges(
    p: GitParams,
    excludeFromRemoval?: readonly string[],
  ): Promise<boolean> {
    const status = await git.statusMatrix({ ...p })
    const excluded = new Set(excludeFromRemoval ?? [])
    const { hasChanges, removals } = computeStagePlan(status, (f) => excluded.has(f))
    if (!hasChanges) return false

    for (const filepath of removals) {
      await git.remove({ ...p, filepath })
    }
    await git.add({ ...p, filepath: '.' })
    return true
  }

  /**
   * sync 仓库内路径 → 本地绝对路径；不属于「用户文件类」时返回 null。
   * 与 exporter 的导入范围一一对应。
   */
  private toLocalPath(repoPath: string): string | null {
    const mappings: Array<{ prefix: string; base: string }> = [
      { prefix: 'profile/', base: this.dataDir },
      { prefix: 'workspace/files/', base: path.join(this.workspaceDir, 'files') },
      { prefix: 'workspace/outputs/', base: path.join(this.workspaceDir, 'outputs') },
    ]
    for (const { prefix, base } of mappings) {
      if (repoPath.startsWith(prefix)) return path.join(base, repoPath.slice(prefix.length))
    }
    return null
  }

  /**
   * 导出数据并提交（如果有变更）
   *
   * 设计：docs/design/数据同步功能/2026-09-09-轻量云同步设计.md
   * - 在事务中导出，确保一致性快照
   * - 导出后检查 git status，有变更才提交（删除需显式 stage，见 stageAllChanges）
   *
   * @param opts.localEditsOnly 只导出 profile + workspace 用户文件，跳过数据库全量 dump。
   *        用于同步流程第 0 步 —— 把本地改动固定成三方合并的 ours，无需重写整份 jsonl。
   * @returns 新提交的 oid；无变更时返回 null
   */
  private async exportAndCommit(
    p: GitParams,
    opts?: { localEditsOnly?: boolean },
  ): Promise<string | null> {
    logger.info(`[exportAndCommit] 导出数据到 sync/${opts?.localEditsOnly ? '（仅用户文件类）' : ''}...`)
    const exporter = new SyncExporter({
      dbPath: this.dbPath,
      syncDir: this.syncDir,
      workspaceDir: this.workspaceDir,
      dataDir: this.dataDir,
      confirmedMassDeleteFingerprint: this.confirmedFingerprintThisSync,
      outputsMaxBytes: loadCloudSyncConfig().smallFileThresholdBytes,
      scopeRules: scopeRulesFromConfig(loadCloudSyncConfig()),
    })
    const exportResult = opts?.localEditsOnly
      ? await exporter.exportLocalEdits()
      : await exporter.export()
    if (!exportResult.success) {
      logger.warn(`[exportAndCommit] 导出有错误: ${exportResult.errors.join(', ')}`)
    }
    // 被安全阀挡下 → 记录待删集合指纹，等用户在设置页显式确认。
    // **绝不自动放行**：这正是 2026-09-16 远端被清空 896 个文件的根因。
    if (exportResult.deleteAborted && exportResult.abortedFingerprint) {
      this.pendingMassDelete = {
        fingerprint: exportResult.abortedFingerprint,
        count: exportResult.abortedCount ?? 0,
        createdAt: Date.now(),
      }
    } else if (!exportResult.deleteAborted) {
      // 本次没有超阈值删除 → 源侧已恢复正常，先前的待确认作废
      this.pendingMassDelete = undefined
    }

    const hasChanges = await this.stageAllChanges(p, exportResult.skippedLargePaths)
    if (!hasChanges) {
      logger.info('[exportAndCommit] 无变更需要提交')
      return null
    }

    const oid = await git.commit({
      ...p,
      message: `sync: export at ${new Date().toISOString()}`,
      author: { name: 'Lumii CloudSync', email: 'sync@lumii.local' },
    })
    logger.info(`[exportAndCommit] 已提交本地变更 ${oid.slice(0, 8)}`)
    return oid
  }

  /**
   * 文件监听触发的轻量提交：只把本地用户文件类改动导出并提交，不 fetch、不 push。
   *
   * 与 sync() 共用同一串行队列；不改 state —— state 归完整同步所有，
   * 否则会和 watcher 自身的抑制条件（state !== idle 即抑制）互相打架。
   */
  async commitLocalChanges(): Promise<boolean> {
    const cfg = loadCloudSyncConfig()
    if (!cfg.enabled || !cfg.repoUrl) return false

    return enqueueWorkspace(this.workspaceDir, async () => {
      // 队列内重新判定：同步可能已在此期间占用了 state
      if (this.state !== 'idle') return false
      if (this.localCommitInFlight) return false
      // 轻量提交不参与确认放行：它是自动触发的，永远不带确认指纹
      this.confirmedFingerprintThisSync = undefined
      this.localCommitInFlight = true
      try {
        const p = this.getSyncGitParams()
        if (!fs.existsSync(path.join(this.syncDir, '.git'))) return false
        const oid = await this.exportAndCommit(p, { localEditsOnly: true })
        if (oid) logger.info(`[commitLocalChanges] 自动提交 ${oid.slice(0, 8)}`)
        return oid !== null
      } catch (err) {
        // 失败不抛出：变更仍留在本地，下一次完整同步的步骤 0 会兜底
        logger.warn(
          `[commitLocalChanges] 自动提交失败（下次同步兜底）: ${err instanceof Error ? err.message : String(err)}`,
        )
        return false
      } finally {
        this.localCommitInFlight = false
      }
    }, 'cloud-sync:commit-local')
  }

  /**
   * 导入数据（从 sync/ 目录）
   *
   * 设计：docs/design/数据同步功能/2026-09-09-轻量云同步设计.md
   * - jsonl 按时间戳 merge 规则合并到本地数据库，在事务中执行
   * - 用户文件按 git 树差异应用（新增/修改复制、删除删除），**不做目录扫描式镜像**
   *
   * @param baselineOid 本次合并前的本地 HEAD，用于算出「远端带来的用户文件变更」。
   *        传 null 时退化为只增不删（首次同步 / 本地无 commit）。
   */
  private async importData(p: GitParams, baselineOid: string | null): Promise<void> {
    try {
      logger.info('[importData] 导入远程数据...')

      const headOid = await git.resolveRef({ ...p, ref: 'HEAD' }).catch(() => null)
      let fileChanges: FileChangeSet = 'all'
      try {
        fileChanges = (await this.computeFileChanges(p, baselineOid, headOid)) ?? 'all'
      } catch (err) {
        // 树差异算不出时退化为只增不删：宁可删除不传播，也不能用不可信的差异去删本地文件
        logger.warn(
          `[importData] 树差异计算失败，本次退化为只增不删: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      const importer = new SyncImporter({
        dbPath: this.dbPath,
        syncDir: this.syncDir,
        workspaceDir: this.workspaceDir,
        dataDir: this.dataDir,
      })
      const result = await importer.import({ fileChanges })
      if (result.success) {
        logger.info(`[importData] 导入成功: Wiki=${result.stats.wikiRows}, 记忆=${result.stats.memoriesImported}`)
      } else {
        logger.warn(`[importData] 导入有错误: ${result.errors.join(', ')}`)
      }
    } catch (err) {
      logger.error('[importData] 导入失败:', err)
      // 导入失败不应阻止同步流程
    }
  }

  private enterConflict(
    data: MergeConflictErrorData,
    localOid: string,
    remoteOid: string,
    baseOid: string,
  ): { success: false; state: 'conflict' } {
    this.conflict = {
      files: data.filepaths ?? [],
      bothModified: data.bothModified ?? [],
      deleteByUs: data.deleteByUs ?? [],
      deleteByTheirs: data.deleteByTheirs ?? [],
      localOid,
      remoteOid,
      baseOid,
    }
    this.status.conflict = this.conflict
    this.setState('conflict', `检测到 ${this.conflict.files.length} 个冲突文件，等待 Agent 处理`)

    // 触发冲突回调，由外部（main/index.ts）创建自主目标让 Agent 处理
    if (this.onConflictDetected) {
      try {
        this.onConflictDetected(this.conflict)
      } catch (err) {
        logger.warn('[enterConflict] 冲突回调失败:', err instanceof Error ? err.message : String(err))
      }
    }

    return { success: false, state: 'conflict' }
  }

  /**
   * Agent 落决：选侧 checkout → 双亲 commit → push。
   *
   * 串行化：enqueue 的是 resolveInner 本身（而不是加过超时的外层），因此超时后
   * 仍会继续在队列里跑完 —— 下一轮落决/同步/回合快照都排在它后面，
   * 不会出现「后台僵尸与新落决并发改写同一仓库 index/refs」。
   */
  async resolveConflict(
    strategy: 'keep-local' | 'keep-remote' | 'per-file',
    choices?: { path: string; side: 'local' | 'remote' }[],
  ): Promise<{ success: boolean; error?: string; stillRunning?: boolean }> {
    // 上一轮落决未结束前拒绝新请求：队列任务不可取消，重复发起只会堆积；
    // 且每一轮都要先花几分钟让 Agent 重新读三方内容 + 重新决策，纯属重复劳动。
    if (this.isResolveInFlight()) {
      const msg = '上一轮落决仍在后台执行，本次请求已跳过（避免重复排队）'
      logger.warn(`[resolveConflict] ${msg}`)
      return { success: false, error: msg }
    }
    this.resolveInFlight = true
    this.resolveInFlightSince = Date.now()
    // 状态消息透出给设置页：落决在后台跑、冲突尚未清除 —— 避免用户误以为卡住
    if (this.state === 'conflict') {
      this.setState('conflict', '落决后台执行中（补远端变更 → 落决提交 → 推送）…')
    }
    const inner = enqueueWorkspace(
      this.workspaceDir,
      () =>
        this.resolveInner(strategy, choices).finally(() => {
          this.resolveInFlight = false
        }),
      'cloud-sync:resolve',
    )
    return withTimeout(
      inner,
      RESOLVE_TIMEOUT_MS,
      `解决冲突超时（${RESOLVE_TIMEOUT_MS}ms）。落决仍在后台继续，无需手动清理，稍后会自动重试。`,
    ).catch((err) => {
      const reason = err instanceof Error ? err.message : String(err)
      // 超时 ≠ 失败：任务仍在队列里跑（isResolveInFlight 仍为 true）。
      // 必须让调用方（Agent 工具）知道这个区别 —— 收到 isError 会让 Agent
      // 重新读文件、重新决策、再排一轮，而上一轮其实还在跑。
      const stillRunning = err instanceof TimeoutError
      logger.error(
        `[resolveConflict] 解决失败${stillRunning ? '（仍在后台执行）' : ''}: ${reason}`,
      )
      this.recordConflictResolutionFailure(reason)
      return { success: false as const, error: reason, stillRunning }
    })
  }

  /**
   * 落决是否仍在后台队列中执行。
   *
   * 供 bridge 的冲突驱动守卫使用：心跳/调度器驱动新一轮 Agent 前必须先查这里，
   * 否则会在"上一轮还没跑完"时重复排队 —— 2026-09-17 死循环的直接成因。
   */
  isResolveInFlight(): boolean {
    if (!this.resolveInFlight) return false
    if (Date.now() - this.resolveInFlightSince > RESOLVE_IN_FLIGHT_MAX_MS) {
      logger.warn(
        `[resolveConflict] 落决已飞行超过 ${RESOLVE_IN_FLIGHT_MAX_MS / 60_000} 分钟，守卫失效放行（避免永久死锁）`,
      )
      return false
    }
    return true
  }

  /** 标记 Agent 开始处理冲突（仅更新 message + 日志，state 保持 conflict） */
  markConflictProcessing(): void {
    if (this.state !== 'conflict') return
    this.setState('conflict', `Agent 正在处理 ${this.conflict?.files.length ?? 0} 个冲突文件…`)
  }

  /** 记录一次 Agent 处理冲突失败（保留 conflict 状态，记日志） */
  recordConflictResolutionFailure(reason: string): void {
    if (this.state !== 'conflict') return
    const safeReason = reason.length > 200 ? `${reason.slice(0, 200)}…` : reason
    logger.error(`[冲突处理] Agent 处理失败: ${safeReason}`)
    this.setState('conflict', `Agent 处理冲突失败：${safeReason}`)
  }

  /**
   * 将 HEAD 挂回本地分支，不重写整个工作树。
   * 全量 `git.checkout({ force: true })` 在对象库膨胀（多 GB pack）时会卡数十分钟，
   * 导致 resolve_sync_conflict 工具无响应；冲突文件已在落决循环中按需 checkout。
   */
  private async attachHeadToBranch(p: GitParams, localRef: string): Promise<void> {
    const headPath = path.join(p.gitdir, 'HEAD')
    await fs.promises.writeFile(headPath, `ref: ${localRef}\n`, 'utf8')
  }

  /**
   * 落决前把「远端相对 merge base 的非冲突变更」合进 sync 工作树与 index。
   *
   * 为什么必须补这一步：isomorphic-git 的 merge 默认 `abortOnConflict: true`，
   * 冲突时 index 与工作树**完全不动**。于是落决 commit 的 tree 只含本地内容 +
   * 冲突文件的选定侧；而它的 parent 是 [localOid, remoteOid]，相对 remoteOid
   * 而言，远端那次提交里新增/修改的其他文件就成了「被删除」—— push 后远端
   * 一起丢，再传播回所有设备。
   *
   * 同理，jsonl 也要在这里补齐：工作树里仍是本地上次导出的版本，
   * 不补的话 importData 读到的就是它，远端新增的 wiki/记忆记录会整批丢失。
   * （补进去的是远端版本，下一次完整同步的 export 会从合并后的 DB 重新生成。）
   *
   * 为什么不用 `abortOnConflict: false`：那会把 index 留成未合并状态，
   * 落决一旦超时（RESOLVE_TIMEOUT_MS）或失败，后续所有同步都会卡在
   * `GitIndexManager.acquire({ allowUnmerged: false })` 上。
   */
  private async applyRemoteNonConflictingChanges(
    p: GitParams,
    oids: { baseOid: string; remoteOid: string },
    conflictFiles: readonly string[],
  ): Promise<void> {
    const changes = await this.computeFileChanges(p, oids.baseOid, oids.remoteOid)
    if (!changes || changes === 'all') {
      logger.info('[applyRemoteNonConflicting] 无基线或无变更，跳过')
      return
    }

    const conflicts = new Set(conflictFiles)
    let applied = 0

    for (const repoPath of changes.copy) {
      if (conflicts.has(repoPath)) continue // 冲突文件由落决策略选边决定
      try {
        const { blob } = await git.readBlob({ ...p, oid: oids.remoteOid, filepath: repoPath })
        const abs = path.join(this.syncDir, repoPath)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, Buffer.from(blob))
        await git.add({ ...p, filepath: repoPath })
        applied += 1
      } catch (err) {
        logger.warn(
          `[applyRemoteNonConflicting] 应用失败已跳过: ${repoPath} (${err instanceof Error ? err.message : String(err)})`,
        )
      }
    }

    for (const repoPath of changes.delete) {
      if (conflicts.has(repoPath)) continue
      try {
        const abs = path.join(this.syncDir, repoPath)
        if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true })
        await git.remove({ ...p, filepath: repoPath })
        applied += 1
      } catch (err) {
        logger.warn(
          `[applyRemoteNonConflicting] 删除失败已跳过: ${repoPath} (${err instanceof Error ? err.message : String(err)})`,
        )
      }
    }

    logger.info(
      `[applyRemoteNonConflicting] 已补齐远端非冲突变更 ${applied} 项（冲突 ${conflicts.size} 项走选边）`,
    )
  }

  private async resolveInner(
    strategy: 'keep-local' | 'keep-remote' | 'per-file',
    choices?: { path: string; side: 'local' | 'remote' }[],
  ): Promise<{ success: boolean; error?: string }> {
    const c = this.conflict
    // 冲突可能已被并发流程（超时后仍在队列里的上一轮落决 / 刷新路径）解决
    if (!c) return { success: true }

    const cfg = loadCloudSyncConfig()
    const branch = cfg.branch || 'main'
    const localRef = `refs/heads/${branch}`
    const remoteRef = `refs/remotes/origin/${branch}`
    const token = decryptToken(cfg.tokenEnc)
    const auth = (): ReturnType<AuthFn> => getProvider(cfg.provider).auth(token)
    // 必须操作 syncDir，与 syncInner / 冲突文件路径一致（禁止工作区 .mtbot-vcs）
    const p = this.getSyncGitParams()

    try {
      // 冲突快照里已有 remoteOid：即使 tracking ref 丢失也要能落决（历史故障：Could not find refs/remotes/origin/main）
      try {
        await git.writeRef({ ...p, ref: remoteRef, value: c.remoteOid, force: true })
      } catch (err) {
        logger.warn(
          `[resolveConflict] 回写 ${remoteRef} 失败（继续用 oid）:`,
          err instanceof Error ? err.message : String(err),
        )
      }

      // 先把远端相对 base 的非冲突变更合进工作树与 index ——
      // 不做这一步，落决 commit 会把它们（含远端新增的 jsonl 记录）当成删除推给远端
      await this.applyRemoteNonConflictingChanges(
        p,
        { baseOid: c.baseOid, remoteOid: c.remoteOid },
        c.files,
      )

      // 冲突后 HEAD 可能 detached：用冲突记录的 oid 作为两侧内容源（禁止再 resolveRef 远端）
      for (const f of c.files) {
        // 生成物固定取远端：其数据合并由 import 承载，任何策略下都不该在 git 层选本地
        const side = isGeneratedSyncPath(f)
          ? 'remote'
          : strategy === 'per-file'
            ? (choices?.find((x) => x.path === f)?.side ?? 'local')
            : strategy === 'keep-local'
              ? 'local'
              : 'remote'
        const sideOid = side === 'local' ? c.localOid : c.remoteOid
        // checkout 对「选侧不存在的文件」是静默跳过（不抛错），必须先用 readBlob 探测：
        // 存在 → 写入该侧版本；不存在（删除/修改型冲突）→ 取该侧的「删除」语义。
        // 直接无脑 checkout+add 会在删除侧抛 NotFoundError，落决永远失败（历史故障）。
        let fileInSide = true
        try {
          await git.readBlob({ ...p, oid: sideOid, filepath: f })
        } catch {
          fileInSide = false
        }
        if (fileInSide) {
          await git.checkout({
            ...p,
            ref: sideOid,
            filepaths: [f],
            force: true,
            noUpdateHead: true,
          })
          // 清掉 index 冲突 stage，否则双亲 commit 可能失败
          await git.add({ ...p, filepath: f })
        } else {
          fs.rmSync(path.join(this.syncDir, f), { recursive: true, force: true })
          try {
            await git.remove({ ...p, filepath: f })
          } catch (err) {
            // 本地导出镜像可能已把删除 stage 进 index：已删除即目标状态，跳过即可
            logger.warn(
              `[resolveConflict] 保持删除失败已跳过: ${f} (${err instanceof Error ? err.message : String(err)})`,
            )
          }
        }
      }
      await git.commit({
        ...p,
        ref: localRef,
        message: `解决云同步冲突（${strategy}）`,
        parent: [c.localOid, c.remoteOid],
        author: { name: 'Lumii CloudSync', email: 'sync@lumii.local' },
      })
      // 挂回分支指针，避免 detached；禁止全量 force checkout（对象库过大时会挂死工具）
      await this.attachHeadToBranch(p, localRef)
      await this.push(p, cfg.repoUrl.trim(), localRef, auth, {
        failOnReject: true,
        timeoutMs: RESOLVE_PUSH_TIMEOUT_MS,
      })
      // 落决后把 sync 内容导回本地 data/workspace：
      // 以冲突时的本地 oid 为基线，选 keep-remote 的文件会复制回本地，keep-local 的为 no-op
      await this.importData(p, c.localOid)
      this.conflict = undefined
      this.status.conflict = undefined
      this.setState('idle', '冲突已解决')
      await this.maybePruneObjectStore()
      return { success: true }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)

      // 推送被拒/超时 = 远端在冲突期间前进（或服务端可能已接受但客户端没等到回执）。
      // 冲突快照已过期，刷新后由新一轮决策继续，而不是拿旧快照死循环重试。
      if (isRejectedPush(err) || isPushTimeout(err)) {
        const refreshed = await this.refreshConflictFromRemote(p, cfg, branch, localRef, remoteRef, auth)
        if (refreshed === 'resolved') {
          return { success: true }
        }
        if (refreshed === 'refreshed-conflict') {
          // 状态消息已由 refreshConflictFromRemote 设置（「远端已更新，冲突信息已刷新」）
          const msg =
            '远端在落决期间有新提交，冲突信息已刷新（本轮选择未生效）。请重新读取三方内容后再处理一次。'
          logger.warn(`[resolveConflict] ${msg}`)
          return { success: false, error: msg }
        }
      }

      const safeReason = token ? reason.split(token).join('***') : reason
      logger.error(`[resolveConflict] 解决失败: ${safeReason}`)
      this.recordConflictResolutionFailure(safeReason)
      return { success: false, error: safeReason }
    }
  }

  /**
   * 刷新过期的冲突快照（CAS 语义）：落决推送被拒/超时时，远端已前进，
   * 旧快照（localOid/remoteOid/baseOid）不再可信，重新 fetch 并以新远端 tip 重跑三方合并。
   *
   * - 远端没变（或拉取失败）→ 'unchanged'：上层按原错误上报
   * - 重新合并无冲突（含快进）→ 'resolved'：已 import/export/push，状态回 idle
   * - 重新合并又有冲突 → 'refreshed-conflict'：this.conflict 更新为新快照，交给下一轮决策
   */
  private async refreshConflictFromRemote(
    p: GitParams,
    cfg: ReturnType<typeof loadCloudSyncConfig>,
    branch: string,
    localRef: string,
    remoteRef: string,
    auth: AuthFn,
  ): Promise<'unchanged' | 'resolved' | 'refreshed-conflict' | 'failed'> {
    const c = this.conflict
    if (!c) return 'failed'

    let newRemoteOid: string | null = null
    try {
      await withTimeout(
        git.fetch({ ...p, http, remote: 'origin', ref: branch, onAuth: auth }),
        REFRESH_FETCH_TIMEOUT_MS,
        `git fetch 超时（${REFRESH_FETCH_TIMEOUT_MS}ms）`,
      )
      newRemoteOid = await git.resolveRef({ ...p, ref: remoteRef }).catch(() => null)
    } catch (err) {
      logger.warn(
        `[refreshConflict] 重新 fetch 失败，保持原冲突快照: ${err instanceof Error ? err.message : String(err)}`,
      )
      return 'unchanged'
    }
    if (!newRemoteOid || newRemoteOid === c.remoteOid) return 'unchanged'

    logger.warn(
      `[refreshConflict] 远端已前进 ${c.remoteOid.slice(0, 8)} → ${newRemoteOid.slice(0, 8)}，重算冲突快照`,
    )

    // 本地分支拨回本地侧，工作树/索引与之一致，重新做三方合并
    await git.writeRef({ ...p, ref: localRef, value: c.localOid, force: true })
    await this.attachHeadToBranch(p, localRef)
    await git.checkout({ ...p, ref: localRef, force: true })

    const baseOids = await git.findMergeBase({ ...p, oids: [c.localOid, newRemoteOid] })
    if (baseOids.length === 0) {
      // 远端历史被整体重写为无关历史（罕见）：无法三方合并，保持 conflict 交人工/后续处理
      logger.warn('[refreshConflict] 与远端已无共同祖先，放弃刷新（保持原冲突态）')
      return 'failed'
    }
    const baseOid = baseOids[0]

    try {
      await git.merge({
        ...p,
        ours: localRef,
        theirs: remoteRef,
        author: { name: 'Lumii CloudSync', email: 'sync@lumii.local' },
        message: '合并远程变更',
      })
    } catch (err) {
      if (isMergeConflict(err)) {
        const all = err.data.filepaths ?? []
        const generated = all.filter(isGeneratedSyncPath)
        const agentFiles = all.filter((f) => !isGeneratedSyncPath(f))
        if (generated.length > 0) await this.checkoutRemoteFiles(p, newRemoteOid, generated)
        if (agentFiles.length > 0) {
          this.conflict = {
            files: agentFiles,
            bothModified: (err.data.bothModified ?? []).filter((f) => !isGeneratedSyncPath(f)),
            deleteByUs: (err.data.deleteByUs ?? []).filter((f) => !isGeneratedSyncPath(f)),
            deleteByTheirs: (err.data.deleteByTheirs ?? []).filter((f) => !isGeneratedSyncPath(f)),
            localOid: c.localOid,
            remoteOid: newRemoteOid,
            baseOid,
          }
          this.status.conflict = this.conflict
          this.setState(
            'conflict',
            `远端已更新，冲突信息已刷新（${agentFiles.length} 个文件），等待重新处理`,
          )
          return 'refreshed-conflict'
        }
        // 刷新后只剩生成物冲突：直接自动收尾
        const r = await this.completeAutoResolvedMerge(
          p,
          cfg.repoUrl.trim(),
          localRef,
          auth,
          {
            localOid: c.localOid,
            remoteOid: newRemoteOid,
            baseOid,
            baselineOid: c.localOid,
            conflictFiles: all,
            generatedCount: generated.length,
          },
        )
        return r.state === 'idle' ? 'resolved' : 'failed'
      }
      if (isMergeNotSupported(err)) return 'failed'
      logger.warn(
        `[refreshConflict] 重新合并失败: ${err instanceof Error ? err.message : String(err)}`,
      )
      return 'failed'
    }

    // 无冲突合并成功（含快进）：收尾回 idle。
    // 快进时 isomorphic-git 只搬 ref 不更新工作树，force 同步到合并结果
    // （此刻工作树内容全部来自 c.localOid 提交，丢弃是安全的）
    await git.checkout({ ...p, ref: localRef, force: true })
    await this.importData(p, c.localOid)
    await this.exportAndCommit(p)
    const pushed = await this.push(p, cfg.repoUrl.trim(), localRef, auth)
    this.conflict = undefined
    this.status.conflict = undefined
    this.setState('idle', pushed ? '同步完成（冲突随远端更新自动合并）' : '远端有更新，已提交本地，下一轮重试')
    await this.maybePruneObjectStore()
    return 'resolved'
  }

  /** 读三方任一版本内容（syncDir），供 Agent 判断 */
  async readFileAt(side: 'local' | 'remote' | 'base', filepath: string): Promise<string | null> {
    const c = this.conflict
    if (!c) return null
    const p = this.getSyncGitParams()
    try {
      // remote 侧优先用冲突快照里的 remoteOid，避免 tracking ref 丢失时读失败
      const oid = side === 'base' ? c.baseOid : side === 'local' ? c.localOid : c.remoteOid
      const { blob } = await git.readBlob({ ...p, oid, filepath })
      return new TextDecoder().decode(blob)
    } catch {
      return null
    }
  }

  /**
   * 只读 git 状态快照（cloud_sync_git status）——落决超时后供 Agent 核实后台结果。
   * 只读，不走 enqueueWorkspace（不写 index/refs，避免排在仍在后台的落决后面）。
   */
  async gitStatus(): Promise<Record<string, unknown>> {
    const cfg = loadCloudSyncConfig()
    const branch = cfg.branch || 'main'
    const p = this.getSyncGitParams()
    const initialized = fs.existsSync(path.join(this.syncDir, '.git'))
    // 同步状态文案 + 排队深度：Agent 靠这两项区分「请求在排队」与「已经跑完」——
    // 只有 state 的话，排队中（state 仍是 idle）和已完成长得一模一样
    const statusHint = {
      message: this.status.message,
      ...(this.status.queuedBehind ? { queuedBehind: this.status.queuedBehind } : {}),
    }
    if (!initialized) {
      return { initialized: false, state: this.state, branch, conflictFiles: [], ...statusHint }
    }
    try {
      const headOid = await git.resolveRef({ ...p, ref: 'HEAD' }).catch(() => null)
      const status = await git.statusMatrix({ ...p })
      const dirtyFiles = status
        .filter(([, head, workdir, stage]) => head !== workdir || workdir !== stage)
        .map(([filepath]) => filepath)
      return {
        initialized: true,
        state: this.state,
        branch,
        headOid,
        conflictFiles: this.conflict?.files ?? [],
        dirtyFiles,
        ...statusHint,
      }
    } catch (err) {
      return {
        initialized: true,
        state: this.state,
        branch,
        error: err instanceof Error ? err.message : String(err),
        conflictFiles: this.conflict?.files ?? [],
      }
    }
  }

  /**
   * 只读 git 提交历史（cloud_sync_git log）——确认落决 commit 是否已生成。
   * 只读，不走 enqueueWorkspace。
   */
  async gitLog(limit = 20): Promise<Record<string, unknown>> {
    const cfg = loadCloudSyncConfig()
    const branch = cfg.branch || 'main'
    const p = this.getSyncGitParams()
    if (!fs.existsSync(path.join(this.syncDir, '.git'))) {
      return { initialized: false, branch, commits: [] }
    }
    try {
      const commits = await git.log({ ...p, ref: `refs/heads/${branch}`, depth: limit })
      return {
        initialized: true,
        branch,
        commits: commits.slice(0, limit).map((c) => ({
          oid: c.oid,
          message: c.commit.message,
          author: c.commit.author.name,
          timestamp: c.commit.author.timestamp,
        })),
      }
    } catch (err) {
      return {
        initialized: true,
        branch,
        error: err instanceof Error ? err.message : String(err),
        commits: [],
      }
    }
  }

  /**
   * 只读远端 tip 查询（cloud_sync_git remote）——用配置的认证信息真实走网络，
   * 确认落决是否已推上去 / 远端是否前进。带超时，无网络时返回可达性失败。
   * pushed = 远端 tip 与本地分支 tip 一致（落决 commit 已上传）。
   */
  async gitRemote(): Promise<Record<string, unknown>> {
    const cfg = loadCloudSyncConfig()
    if (!cfg.enabled || !cfg.repoUrl) {
      return { enabled: false, reachable: false, error: '云同步未启用或未配置仓库' }
    }
    try {
      const provider = getProvider(cfg.provider)
      const token = decryptToken(cfg.tokenEnc)
      const info = await withTimeout(
        git.getRemoteInfo({
          http,
          url: cfg.repoUrl.trim(),
          onAuth: () => provider.auth(token),
        }),
        REMOTE_INFO_TIMEOUT_MS,
        `git getRemoteInfo 超时（${REMOTE_INFO_TIMEOUT_MS}ms）`,
      )
      const refs = info.refs ?? {}
      const headOid = (refs.HEAD ?? refs[`refs/heads/${cfg.branch || 'main'}`]) as string | undefined
      // 本地分支 tip：与远端 tip 一致即已推送（落决 commit 已上传）
      const p = this.getSyncGitParams()
      const localHead = await git
        .resolveRef({ ...p, ref: `refs/heads/${cfg.branch || 'main'}` })
        .catch(() => null)
      return {
        enabled: true,
        reachable: true,
        headOid: headOid ?? null,
        localHead: localHead ?? null,
        pushed: !!(headOid && localHead && headOid === localHead),
        branch: cfg.branch || 'main',
      }
    } catch (err) {
      const token = decryptToken(cfg.tokenEnc)
      const reason = err instanceof Error ? err.message : String(err)
      const safeReason = token ? reason.split(token).join('***') : reason
      return { enabled: true, reachable: false, error: safeReason }
    }
  }

  private setState(state: SyncState, message: string): void {
    this.state = state
    // 任何真实状态迁移都意味着「排队等待」结束了 —— 统一在这里清掉 queuedBehind，
    // 免得每个 setState 调用点都要记得清（漏一处就会一直显示「排队中」）
    const { queuedBehind: _cleared, ...rest } = this.status
    this.status = {
      ...rest,
      state,
      message,
      lastSyncAt: state === 'idle' ? Date.now() : this.status.lastSyncAt,
      lastError: state === 'error' ? message : undefined,
    }
    this.emit('status', this.status)
    appendSyncLog(state, message)
    logger.info(`[状态变更] ${state}: ${message}`)
  }
}
