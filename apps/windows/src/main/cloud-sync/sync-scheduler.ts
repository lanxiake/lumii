/**
 * 云同步调度：定时 + Turn 快照后防抖 + 文件监听自动提交 + 冲突 Agent 重试 + 24h 冲突超时升级。
 *
 * 触发源有三条：
 *  - 定时 tick（intervalMinutes）
 *  - Turn 快照后 60s 防抖（onWorkspaceChanged）
 *  - workspace 文件变更（SyncFileWatcher，仅本地自动 commit，不 fetch/push）
 */
import { createLogger } from '../logger'
import { resolveActiveWorkspaceDir } from '../workspace-paths'
import type { CloudSyncManager } from './sync-manager'
import { SyncFileWatcher } from './sync-watcher'
import type { SyncStatus } from './types'

const logger = createLogger('cloud-sync/scheduler')

const CONFLICT_ESCALATE_MS = 24 * 60 * 60 * 1000
/** 冲突 Agent 重试最小间隔（避免每次 tick 都创建实例，LLM 调用成本高） */
const CONFLICT_RETRY_COOLDOWN_MS = 2 * 60 * 1000

export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  /** 冷启动首同步定时器：必须持有句柄，否则 stop() 清不掉 */
  private coldStartTimer: NodeJS.Timeout | null = null
  private conflictSince: number | null = null
  private lastConflictRetryAt = 0
  private onConflictPendingCb?: () => Promise<void>
  private readonly watcher: SyncFileWatcher

  constructor(private manager: CloudSyncManager) {
    // 惰性取工作空间目录：切工作空间无需重建 watcher，ensureBound() 会重绑
    this.watcher = new SyncFileWatcher(manager, resolveActiveWorkspaceDir)
    manager.on('status', (s: SyncStatus) => {
      if (s.state === 'conflict') {
        if (this.conflictSince === null) this.conflictSince = Date.now()
      } else {
        this.conflictSince = null
        this.lastConflictRetryAt = 0
      }
    })
  }

  /** 注入冲突 Agent 处理回调（由 index.ts 在 bridge 就绪后注入） */
  setOnConflictPending(cb: () => Promise<void>): void {
    this.onConflictPendingCb = cb
  }

  start(cfg: { enabled: boolean; intervalMinutes: number }): void {
    this.stop()
    if (!cfg.enabled) return
    const interval = Math.max(1, cfg.intervalMinutes) * 60_000
    this.timer = setInterval(() => void this.tick(), interval)
    // 冷启动 30s 后首同步，避开启动争抢
    this.coldStartTimer = setTimeout(() => void this.tick(), 30_000)
    this.watcher.start()
    logger.info(`[start] 静默同步已启动, interval=${cfg.intervalMinutes}min`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.coldStartTimer) clearTimeout(this.coldStartTimer)
    this.timer = this.debounceTimer = this.coldStartTimer = null
    this.watcher.stop()
  }

  /** Turn 快照后调用：60 秒防抖合并频繁变更 */
  onWorkspaceChanged(): void {
    // 顺带重绑文件监听：切工作空间后不必干等到下一次定时 tick（最长 15 分钟）
    this.watcher.ensureBound()
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => void this.tick(), 60_000)
  }

  private async tick(): Promise<void> {
    try {
      // 切工作空间后重绑文件监听（目录未变时是 no-op）
      this.watcher.ensureBound()
      await this.manager.sync()
      // 冲突 Agent 重试：每次 tick 若仍处于 conflict 且距上次尝试 > 冷却，重新驱动 Agent
      if (
        this.manager.getStatus().state === 'conflict' &&
        this.onConflictPendingCb &&
        Date.now() - this.lastConflictRetryAt > CONFLICT_RETRY_COOLDOWN_MS
      ) {
        this.lastConflictRetryAt = Date.now()
        try {
          await this.onConflictPendingCb()
        } catch (err) {
          logger.error(
            `[tick] 冲突 Agent 重试失败: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      // 24h 超时升级（保留原有语义）
      if (this.conflictSince && Date.now() - this.conflictSince > CONFLICT_ESCALATE_MS) {
        this.manager.emit('escalate', this.manager.getConflict())
      }
    } catch (err) {
      logger.error(`[tick] 同步异常: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
