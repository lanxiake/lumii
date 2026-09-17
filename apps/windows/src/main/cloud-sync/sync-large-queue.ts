/**
 * 阶段二大文件队列（分级传输）。
 *
 * 阶段一（`syncInner`）只同步 ≤ 阈值的文件，通常几十秒完成；更大的文件在这里
 * 以 `largeFileBatchBytes`（默认 50MB）为一批慢慢传 —— 小文件先到位，大文件不阻塞它们。
 *
 * 四个设计约束：
 *  1. **不落盘**：待传集合每次从「工作区 vs sync 目录」的 size+mtime 差异重建，
 *     天然幂等 —— 重启不丢、重复调用不重传。
 *  2. **批次间让路**：每一批都是独立的 `enqueueWorkspace` 任务，批次之间的延迟
 *     给了高优先级同步插入的机会；批次开始前也检查一次 `state`。
 *  3. **续期**：整轮 pump 用 ProgressFence 的 ceiling 封顶 —— 批次之间没有天然超时点，
 *     靠它防止无限跑（Phase 3 推迟的 fence 用在这里）。
 *  4. **不动 stage 判定**：批次用精确的 `git.add({filepath})`，绝不走 `stageAllChanges`
 *     的 `add '.'` —— 否则会把阶段一尚未提交的变化一并卷进大文件提交。
 */
import fs from 'node:fs'
import path from 'node:path'
import git from 'isomorphic-git'
import type { PromiseFsClient } from 'isomorphic-git'
import { ProgressFence } from '@mtbot/agent-runtime'
import { createLogger } from '../logger'
import { SYNC_MTIME_TOLERANCE_MS, SYNC_SKIP_DIR_NAMES } from './sync-copy'
import { isExcluded, type SyncScopeRules } from './sync-scope'

const logger = createLogger('cloud-sync/large-queue')

/** 一批传完之后到下一批之间的喘息（给高优先级同步让路的机会） */
const BATCH_GAP_MS = 5_000

/** 整轮 pump 的绝对封顶：批次之间没有天然超时点，靠它防止无限跑 */
const PUMP_CEILING_MS = 30 * 60 * 1000

/** 待传的大文件（仓库相对路径 + 绝对路径 + 字节数） */
export interface LargeFileEntry {
  /** sync 仓库内的相对路径，如 `workspace/outputs/x.mp4` */
  repoPath: string
  /** 本地绝对路径 */
  absPath: string
  size: number
}

/**
 * 扫描待传的大文件：工作区中 > `thresholdBytes`、且与 sync 目录副本不一致的。
 *
 * 一致性判据与 `copySyncDirectory` 的 `skipUnchanged` 完全一致（size + mtime）——
 * 阶段二复制后会回写 mtime，所以这个比对在两条路径上是同一套语义。
 *
 * 抽成纯函数以便单测（遍历 + 比对是这里唯一有正确性风险的部分）。
 */
export function scanPendingLargeFiles(opts: {
  workspaceOutputsDir: string
  syncOutputsDir: string
  thresholdBytes: number
  /** 同步范围规则（排除者不参与）；缺省视为空规则 */
  rules?: SyncScopeRules
}): LargeFileEntry[] {
  const { workspaceOutputsDir, syncOutputsDir, thresholdBytes } = opts
  const pending: LargeFileEntry[] = []
  if (!fs.existsSync(workspaceOutputsDir)) return pending

  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      logger.warn(
        `[scanPendingLargeFiles] 无法读取目录: ${dir} (${err instanceof Error ? err.message : String(err)})`,
      )
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SYNC_SKIP_DIR_NAMES.has(entry.name)) continue
        walk(abs)
        continue
      }
      let stat: fs.Stats
      try {
        stat = fs.statSync(abs)
      } catch {
        continue // 竞态删除：跳过，下次扫描再说
      }
      if (stat.size <= thresholdBytes) continue // 小文件归阶段一

      const rel = path.relative(workspaceOutputsDir, abs)
      const relPosix = rel.split(path.sep).join('/')

      // 同步范围排除：与阶段一同一套规则（两处都必须生效，否则被排除的文件会从阶段二漏出去）
      if (opts.rules && isExcluded(relPosix, opts.rules)) continue

      const dstAbs = path.join(syncOutputsDir, rel)
      let same = false
      try {
        const dstStat = fs.statSync(dstAbs)
        // mtime 用容差比较：utimesSync 回写后读回会被舍入到整数 ms，源文件却是
        // 亚毫秒精度 —— 严格相等会让队列反复重传同一个文件（见 SYNC_MTIME_TOLERANCE_MS）
        same =
          dstStat.size === stat.size &&
          Math.abs(dstStat.mtimeMs - stat.mtimeMs) <= SYNC_MTIME_TOLERANCE_MS
      } catch {
        same = false // 目标不存在 → 必须传
      }
      if (same) continue

      pending.push({
        repoPath: 'workspace/outputs/' + relPosix,
        absPath: abs,
        size: stat.size,
      })
    }
  }

  walk(workspaceOutputsDir)
  return pending
}

/**
 * 按累计字节数切批：顺序累加，超过 `batchBytes` 就开新批。
 *
 * 单个文件自身超过 `batchBytes` 时独占一批（不能拆文件）。
 */
export function splitIntoBatches(
  entries: readonly LargeFileEntry[],
  batchBytes: number,
): LargeFileEntry[][] {
  const batches: LargeFileEntry[][] = []
  let current: LargeFileEntry[] = []
  let currentBytes = 0

  for (const entry of entries) {
    if (current.length > 0 && currentBytes + entry.size > batchBytes) {
      batches.push(current)
      current = []
      currentBytes = 0
    }
    current.push(entry)
    currentBytes += entry.size
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/** isomorphic-git 参数（结构与 CloudSyncManager 内部的 GitParams 一致） */
export interface LargeQueueGitParams {
  fs: PromiseFsClient
  dir: string
  gitdir: string
}

/** 队列运行所需的外部能力（由 CloudSyncManager 注入，便于测试替身） */
export interface LargeQueueDeps {
  /** sync 仓库的 git 参数 */
  getGitParams: () => LargeQueueGitParams
  /** 推送本地分支；返回是否成功（远端有更新时 false，下轮重试） */
  push: (localRef: string) => Promise<boolean>
  /** 当前同步状态；非 idle 时让路 */
  getState: () => string
  /** 复用 workspace 串行队列（与阶段一共用，保证 git 仓库不被并发写） */
  enqueue: <T>(fn: () => Promise<T>) => Promise<T>
  /** 分级参数（每次现读配置，便于运行中调整） */
  getLimits: () => {
    thresholdBytes: number
    batchBytes: number
    branch: string
    rules: SyncScopeRules
  }
}

export interface PumpResult {
  batches: number
  files: number
  bytes: number
  /** 因让路而提前结束（下轮继续） */
  yielded: boolean
}

/** 阶段二进度快照（供 UI 展示；来自最近一次扫描，非实时） */
export interface LargeQueueStats {
  /** 最近一次扫描时的待传文件数 */
  pendingFiles: number
  /** 最近一次扫描时的待传字节数 */
  pendingBytes: number
  /** 是否正在 pump */
  pumping: boolean
  /** 统计时间戳；0 表示尚未扫描过 */
  at: number
}

export class SyncLargeQueue {
  private pumping = false
  private lastStats: Omit<LargeQueueStats, 'pumping'> = { pendingFiles: 0, pendingBytes: 0, at: 0 }

  constructor(
    private readonly deps: LargeQueueDeps,
    /** 目录用 getter 现取：用户切换工作空间后无需重建实例 */
    private readonly getDirs: () => { workspaceOutputsDir: string; syncOutputsDir: string },
  ) {}

  isPumping(): boolean {
    return this.pumping
  }

  /**
   * 阶段二进度快照。
   *
   * 刻意返回**上次扫描的缓存值**而非现扫：扫描要遍历整个 outputs 目录，
   * 而 UI 会随状态事件频繁拉取 —— 现扫会把进度查询变成 IO 负担。
   */
  getStats(): LargeQueueStats {
    return { ...this.lastStats, pumping: this.pumping }
  }

  /**
   * 传若干批。每批独立入队，批次之间检查 state 让路。
   *
   * 可重入安全：pumping 期间重复调用直接返回（调用方通常是"阶段一刚完成"，
   * 而阶段一可能被 watcher 高频触发）。
   */
  async pump(): Promise<PumpResult> {
    const result: PumpResult = { batches: 0, files: 0, bytes: 0, yielded: false }
    if (this.pumping) return result
    this.pumping = true

    // idle 预算设成极大：大文件传输天然是"每批都有进展但整体很慢"，
    // 真正的保护来自 ceiling（整轮封顶），idle 在这里没有意义。
    const fence = new ProgressFence(Number.MAX_SAFE_INTEGER, PUMP_CEILING_MS)

    try {
      while (fence.shouldKeepAlive()) {
        if (this.deps.getState() !== 'idle') {
          result.yielded = true
          logger.info('[pump] 同步非 idle，本轮让路')
          break
        }

        const limits = this.deps.getLimits()
        const dirs = this.getDirs()
        const pending = scanPendingLargeFiles({
          workspaceOutputsDir: dirs.workspaceOutputsDir,
          syncOutputsDir: dirs.syncOutputsDir,
          thresholdBytes: limits.thresholdBytes,
          rules: limits.rules,
        })
        this.lastStats = {
          pendingFiles: pending.length,
          pendingBytes: pending.reduce((s, e) => s + e.size, 0),
          at: Date.now(),
        }
        if (pending.length === 0) break

        const batches = splitIntoBatches(pending, limits.batchBytes)
        const batch = batches[0]

        const ok = await this.deps.enqueue(() =>
          this.commitAndPushBatch(batch, limits.branch, dirs),
        )
        if (!ok) {
          // 推送失败（远端前进/网络）—— 已提交的对象留在本地，下轮重扫会重试
          logger.warn('[pump] 批次推送失败，本轮结束（下轮重试）')
          break
        }

        result.batches += 1
        result.files += batch.length
        result.bytes += batch.reduce((sum, e) => sum + e.size, 0)
        fence.touchProgress()
        logger.info(
          `[pump] 批次 ${result.batches} 完成：${batch.length} 个文件 / ${(batch.reduce((s, e) => s + e.size, 0) / 1048576).toFixed(1)} MB`,
        )

        // 批间喘息：给高优先级同步插入的机会（低优先级队列的本分）
        if (fence.shouldKeepAlive()) await new Promise((r) => setTimeout(r, BATCH_GAP_MS))
      }
    } catch (err) {
      logger.error(`[pump] 异常: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.pumping = false
    }

    return result
  }

  /**
   * 按需推送指定路径（相对 outputs）：不经扫描与阈值，直接作为一批提交推送。
   *
   * 这是「我在 A 机器上生成的绘本，想在 B 机器上直接看」的路径 ——
   * 用户/Agent 明确点名的文件不该等阈值判断或队列轮转。
   */
  async pushPaths(paths: readonly string[]): Promise<{ success: boolean; message: string }> {
    const dirs = this.getDirs()
    const limits = this.deps.getLimits()
    const entries: LargeFileEntry[] = []
    const skipped: string[] = []

    for (const raw of paths) {
      const relPosix = raw.replace(/\\/g, '/').replace(/^\/+/, '')
      if (isExcluded(relPosix, limits.rules)) {
        skipped.push(`${raw}（被排除规则挡下）`)
        continue
      }
      const abs = path.join(dirs.workspaceOutputsDir, ...relPosix.split('/'))
      try {
        const st = fs.statSync(abs)
        entries.push({ repoPath: 'workspace/outputs/' + relPosix, absPath: abs, size: st.size })
      } catch {
        skipped.push(`${raw}（不存在）`)
      }
    }

    if (entries.length === 0) {
      return {
        success: false,
        message: `没有可推送的文件：${skipped.join('、') || '路径为空'}`,
      }
    }

    const ok = await this.deps.enqueue(() => this.commitAndPushBatch(entries, limits.branch, dirs))
    const sizeMb = (entries.reduce((s, e) => s + e.size, 0) / 1048576).toFixed(1)
    const skippedNote = skipped.length ? `；跳过：${skipped.join('、')}` : ''
    return ok
      ? { success: true, message: `已推送 ${entries.length} 个文件（${sizeMb} MB）${skippedNote}` }
      : {
          success: false,
          message: `推送失败（远端有更新或网络问题），文件已提交到本地，下轮同步会重试${skippedNote}`,
        }
  }

  /**
   * 提交并推送一批：复制这批文件 → 精确 add → commit → push。
   *
   * **刻意不用 stageAllChanges**：那是全量 `add '.'`，会把阶段一尚未提交的变化
   * 一并卷进大文件提交，两个阶段的边界就没了。
   */
  private async commitAndPushBatch(
    entries: LargeFileEntry[],
    branch: string,
    dirs: { workspaceOutputsDir: string; syncOutputsDir: string },
  ): Promise<boolean> {
    const p = this.deps.getGitParams()

    for (const entry of entries) {
      const dst = path.join(
        dirs.syncOutputsDir,
        path.relative(dirs.workspaceOutputsDir, entry.absPath),
      )
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        const st = fs.statSync(entry.absPath)
        fs.copyFileSync(entry.absPath, dst)
        // 回写 mtime：下一轮扫描靠 size+mtime 判定"已同步"，不回写会永远重传
        fs.utimesSync(dst, st.atime, st.mtime)
      } catch (err) {
        logger.warn(
          `[commitAndPushBatch] 复制失败已跳过: ${entry.repoPath} (${err instanceof Error ? err.message : String(err)})`,
        )
        continue
      }
      await git.add({ ...p, filepath: entry.repoPath })
    }

    const oid = await git.commit({
      ...p,
      message: `sync: 大文件批次（${entries.length} 个文件）`,
      author: { name: 'Lumii CloudSync', email: 'sync@lumii.local' },
    })
    logger.info(`[commitAndPushBatch] 已提交 ${oid.slice(0, 8)}`)

    return this.deps.push(`refs/heads/${branch}`)
  }
}
