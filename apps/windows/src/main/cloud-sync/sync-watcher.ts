/**
 * 云同步文件监听：workspace 下的用户文件有变更即自动提交。
 *
 * 设计要点（对齐 skill-watcher.ts 的成熟范式）：
 * - fs.watch recursive：Windows 走 ReadDirectoryChangesW，能感知 rename（含 move/删除）
 * - 防抖 3s：合并短时间内的连续编辑为一次提交
 * - 最小提交间隔 30s：防编辑风暴把 sync 仓的 .git 撑爆
 *   （本项目已有 .git 膨胀到数 GB 导致 checkout/push 卡数十分钟的历史）
 * - 抑制窗口：完整同步（state !== idle）期间一律不提交 —— import 会写本地文件，
 *   不抑制就会「import 写一半 → watcher 触发 → export 把半完成状态推入 git
 *   → push 污染远端，再传播回所有设备」
 * - 抑制期间只重排定时器，不丢弃事件；即使真的漏掉也安全 ——
 *   export 是全量幂等的，下一次完整同步的步骤 0 会兜底
 */
import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '../logger'
import type { CloudSyncManager } from './sync-manager'

const logger = createLogger('cloud-sync/watcher')

/** 防抖延迟（ms）：等文件系统操作稳定 */
const DEBOUNCE_MS = 3_000

/** 两次自动提交之间的最小间隔（ms） */
const MIN_COMMIT_INTERVAL_MS = 30_000

/** 被抑制时的重试间隔（ms）：同步结束后尽快补上这次提交 */
const SUPPRESS_RETRY_MS = 10_000

/** 被监听的 workspace 子目录 */
const WATCHED_SUBDIRS = ['files', 'outputs'] as const

export class SyncFileWatcher {
  private watchers: fs.FSWatcher[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private boundWorkspaceDir: string | null = null
  private lastCommitAt = 0

  constructor(
    private readonly manager: CloudSyncManager,
    private readonly getWorkspaceDir: () => string,
  ) {}

  /** 启动监听；重复调用先停掉旧监听 */
  start(): void {
    this.stop()
    this.ensureBound()
  }

  stop(): void {
    this.teardownWatchers()
    this.boundWorkspaceDir = null
    this.clearTimer()
  }

  /**
   * 确保监听绑在当前工作空间目录上。
   * 目录未变时是 no-op，可安全频繁调用（SyncScheduler.tick 每次都会调），
   * 因此切工作空间不需要额外的信号通道。
   */
  ensureBound(): void {
    const dir = this.getWorkspaceDir()
    if (!dir || dir === this.boundWorkspaceDir) return

    this.teardownWatchers()
    this.boundWorkspaceDir = dir

    for (const sub of WATCHED_SUBDIRS) {
      const target = path.join(dir, sub)
      try {
        if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true })
      } catch (err) {
        logger.warn(`[ensureBound] 无法创建监听目录 ${target}: ${this.reason(err)}`)
        continue
      }
      try {
        const watcher = fs.watch(target, { recursive: true, persistent: true }, (_event, filename) => {
          logger.debug(`[watch] ${sub}: ${filename ?? '(unknown)'}`)
          this.schedule()
        })
        watcher.on('error', (err) => logger.warn(`[watch] 监听 ${target} 出错: ${this.reason(err)}`))
        this.watchers.push(watcher)
      } catch (err) {
        logger.warn(`[ensureBound] 无法监听 ${target}: ${this.reason(err)}`)
      }
    }
    logger.info(`[ensureBound] 已监听 ${this.watchers.length} 个目录（${WATCHED_SUBDIRS.join(', ')}）`)
  }

  /** 防抖调度一次自动提交 */
  private schedule(): void {
    this.reschedule(DEBOUNCE_MS)
  }

  private reschedule(delayMs: number): void {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runCommit()
    }, Math.max(1_000, delayMs))
  }

  private async runCommit(): Promise<void> {
    // 完整同步 / 冲突期间不介入；重排定时器等它结束
    if (this.manager.getStatus().state !== 'idle') {
      this.reschedule(SUPPRESS_RETRY_MS)
      return
    }

    // 最小提交间隔：把连续编辑合并成一次提交
    const sinceLast = Date.now() - this.lastCommitAt
    if (sinceLast < MIN_COMMIT_INTERVAL_MS) {
      this.reschedule(MIN_COMMIT_INTERVAL_MS - sinceLast)
      return
    }

    this.lastCommitAt = Date.now()
    await this.manager.commitLocalChanges()
  }

  private teardownWatchers(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close()
      } catch {
        // 关闭失败无碍：句柄随进程回收
      }
    }
    this.watchers = []
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private reason(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }
}
