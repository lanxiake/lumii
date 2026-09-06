/**
 * 云同步调度：定时 + Turn 快照后防抖 + 24h 冲突超时升级。
 * 触发源只有定时与 Turn 快照防抖，不用 fs.watch。
 */
import { createLogger } from '../logger'
import type { CloudSyncManager } from './sync-manager'
import type { SyncStatus } from './types'

const logger = createLogger('cloud-sync/scheduler')

const CONFLICT_ESCALATE_MS = 24 * 60 * 60 * 1000

export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private conflictSince: number | null = null

  constructor(private manager: CloudSyncManager) {
    manager.on('status', (s: SyncStatus) => {
      if (s.state === 'conflict') {
        if (this.conflictSince === null) this.conflictSince = Date.now()
      } else {
        this.conflictSince = null
      }
    })
  }

  start(cfg: { enabled: boolean; intervalMinutes: number }): void {
    this.stop()
    if (!cfg.enabled) return
    const interval = Math.max(1, cfg.intervalMinutes) * 60_000
    this.timer = setInterval(() => void this.tick(), interval)
    // 冷启动 30s 后首同步，避开启动争抢
    setTimeout(() => void this.tick(), 30_000)
    logger.info(`[start] 静默同步已启动, interval=${cfg.intervalMinutes}min`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.timer = this.debounceTimer = null
  }

  /** Turn 快照后调用：60 秒防抖合并频繁变更 */
  onWorkspaceChanged(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => void this.tick(), 60_000)
  }

  private async tick(): Promise<void> {
    try {
      await this.manager.sync()
      if (this.conflictSince && Date.now() - this.conflictSince > CONFLICT_ESCALATE_MS) {
        this.manager.emit('escalate', this.manager.getConflict())
      }
    } catch (err) {
      logger.error(`[tick] 同步异常: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
