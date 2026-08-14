/**
 * CronScheduler — 本地定时任务调度管理
 *
 * 职责：
 * - 启动时从 SQLite 恢复任务定时器
 * - 调度 at/every 类型任务（cron 类型依赖 Gateway）
 * - 执行任务：驱动 Agent 或发送系统通知
 * - 文件清理定时器（30 天软删除硬清理）
 * - CRUD：提供 DB 记录的增删改查接口
 *
 * 从 bridge.ts 提取，通过构造注入依赖，外部 API（CRUD 方法）签名不变
 */

import path from 'node:path'
import fs from 'node:fs'
import { Cron } from 'croner'
import type { LocalDatabase, FileRepo } from '@mtbot/agent-runtime'
import { prependActiveDashboardFeedItem } from '../dashboard-feed-store'
import { formatForTarget } from './cron-notify-format'

const log = {
  info: (...args: unknown[]) => console.log('[CronScheduler]', ...args),
  warn: (...args: unknown[]) => console.warn('[CronScheduler]', ...args),
  error: (...args: unknown[]) => console.error('[CronScheduler]', ...args),
}

/** 本地 Cron 任务记录（与 SQLite 表字段对应） */
export type LocalCronJobRow = {
  id: string
  name: string
  task_text: string
  agent_id: string | null
  schedule_type: 'at' | 'every' | 'cron'
  schedule_expr: string
  next_run_at: number
  interval_ms: number | null
  enabled: number
  created_at: number
  last_run_at: number | null
  last_status: 'ok' | 'error' | 'running' | null
  /** 生效星期 "0,1,..,6"（0=周日）；NULL/空 表示每天 */
  active_days: string | null
  /** 生效时段 [start, end) 的起止小时；NULL 表示全天 */
  active_hour_start: number | null
  active_hour_end: number | null
  system_prompt: string | null
  /** 逗号分隔的推送目标：system/news/focus/feishu */
  notify_targets: string | null
}

/** LocalCronJobRow 的完整列清单，避免多处 SELECT 漂移 */
const CRON_JOB_COLUMNS = `id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms,
        enabled, created_at, last_run_at, last_status,
        active_days, active_hour_start, active_hour_end, system_prompt, notify_targets`

/** 任务在 at 时刻是否落在生效窗口内。窗口未配置时恒为 true。 */
export function isWithinActiveWindow(
  job: { active_days?: string | null; active_hour_start?: number | null; active_hour_end?: number | null },
  at: Date = new Date(),
): boolean {
  const days = job.active_days?.trim()
  if (days && !days.split(',').includes(String(at.getDay()))) return false

  const start = job.active_hour_start
  const end = job.active_hour_end
  if (start == null || end == null || start === end) return true
  const hour = at.getHours()
  // end < start 视为跨午夜窗口，例如 22 点到次日 6 点
  return end > start ? hour >= start && hour < end : hour >= start || hour < end
}

export interface CronSchedulerDeps {
  /** 是否显示系统通知 */
  showCronNotification?: (title: string, body: string) => void
  /** 获取当前活跃会话 ID（Cron Agent 实例挂载用） */
  getLastActiveConvId: () => string | null
  /** 按 Agent ID 创建 Agent 实例 */
  createInstanceById: (agentId: string, sessionKey?: string, conversationId?: string) => Promise<string>
  /** 向指定 Agent 实例发送消息 */
  prompt: (instanceId: string, message: string) => Promise<void>
  /** 销毁 Agent 实例 */
  destroy: (instanceId: string) => void
  /** 确保对话记录存在（cron 任务用固定 sessionKey，让每个任务在会话列表里有专属可查看的记录） */
  ensureConversationExists: (conversationId: string, title?: string) => boolean
  /** 通知渲染进程有新的用户消息（不落库，仅推送 UI 展示；不跳转视图，避免打断用户当前操作） */
  notifyIncomingMessage: (sessionKey: string, text: string) => void
  /** 获取文件仓储（用于文件清理任务） */
  getFileRepo: () => FileRepo | null
  /** 获取 workspace 根目录（用于文件清理任务） */
  getCwd: () => string
  /** 主动推送文本到飞书（notify_targets 含 feishu 时用；优先走 channelRouter） */
  sendFeishuMessage?: (text: string) => Promise<{ ok: boolean; error?: string }>
  /**
   * 惰性获取渠道出站 Router（feishu / weixin:<peer> 同源发送）。
   */
  getChannelRouter?: () => import('../channel/channel-outbound-router').ChannelOutboundRouter | null | undefined
  /** 写入一条 Agent 记忆（notify_targets 含 focus 时用，概览页「近期关注」读记忆） */
  addMemory?: (content: string) => void
  /**
   * Companion 魔法指令处理器（__companion_tick__ 等）
   * 返回执行结果描述供 cron_runs 记录；返回 null 表示不拦截（走正常 Agent 流程）
   * @param options.manual 来自「立即执行」时为 true，供 companion 绕过软门闩
   */
  handleCompanionInstruction?: (
    instruction: string,
    options?: { manual?: boolean },
  ) => Promise<string | null>
}

export class CronScheduler {
  private readonly localCronTimers = new Map<string, ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>()
  private readonly localCronRunningJobs = new Set<string>()
  private readonly cronInstances = new Map<string, Cron>()

  constructor(
    private readonly localDb: LocalDatabase,
    private readonly deps: CronSchedulerDeps,
  ) {}

  /**
   * 启动所有调度器（在 bridge.initialize() 末尾调用）
   */
  start(): void {
    this.startLocalCronScheduler()
    this.startFileCleanupScheduler()
  }

  /**
   * 停止所有定时器（在 bridge.destroyAll() 中调用）
   */
  stop(): void {
    for (const timer of this.localCronTimers.values()) {
      clearTimeout(timer)
      clearInterval(timer)
    }
    this.localCronTimers.clear()
    this.localCronRunningJobs.clear()
    for (const instance of this.cronInstances.values()) {
      instance.stop()
    }
    this.cronInstances.clear()
  }

  /**
   * 重新加载本地 Cron 调度（用于 IPC 增删改任务后即时生效）。
   */
  reloadLocalCronScheduler(): void {
    for (const timer of this.localCronTimers.values()) {
      clearTimeout(timer)
      clearInterval(timer)
    }
    this.localCronTimers.clear()
    this.localCronRunningJobs.clear()
    for (const instance of this.cronInstances.values()) {
      instance.stop()
    }
    this.cronInstances.clear()
    this.startLocalCronScheduler()
  }

  /**
   * 插入一条本地 Cron 任务记录。
   */
  createLocalCronJobRecord(params: {
    id: string
    name: string
    taskText: string
    agentId?: string
    scheduleType: 'at' | 'every' | 'cron'
    scheduleExpr: string
    nextRunAt: number
    intervalMs?: number
    enabled?: boolean
    createdAt: number
    activeDays?: string | null
    activeHourStart?: number | null
    activeHourEnd?: number | null
    systemPrompt?: string | null
    notifyTargets?: string | null
  }): void {
    this.localDb.db.prepare(
      `INSERT INTO local_cron_jobs
       (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at,
        active_days, active_hour_start, active_hour_end, system_prompt, notify_targets)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      params.id,
      params.name,
      params.taskText,
      params.agentId?.trim() || null,
      params.scheduleType,
      params.scheduleExpr,
      params.nextRunAt,
      params.intervalMs ?? null,
      params.enabled === false ? 0 : 1,
      params.createdAt,
      params.activeDays?.trim() || null,
      params.activeHourStart ?? null,
      params.activeHourEnd ?? null,
      params.systemPrompt?.trim() || null,
      params.notifyTargets?.trim() || null,
    )
  }

  /**
   * 查询本地 Cron 任务列表。
   */
  listLocalCronJobRecords(includeDisabled: boolean): Array<LocalCronJobRow> {
    return this.localDb.db.prepare<LocalCronJobRow>(
      `SELECT ${CRON_JOB_COLUMNS}
       FROM local_cron_jobs
       ${includeDisabled ? '' : 'WHERE enabled = 1'}
       ORDER BY created_at DESC`
    ).all()
  }

  /**
   * 按 ID 查询单条本地 Cron 任务。
   */
  getLocalCronJobRecordById(id: string): LocalCronJobRow | undefined {
    return this.localDb.db.prepare<LocalCronJobRow>(
      `SELECT ${CRON_JOB_COLUMNS}
       FROM local_cron_jobs
       WHERE id = ?`
    ).get(id)
  }

  /**
   * 删除本地 Cron 任务，返回受影响行数。
   */
  deleteLocalCronJobRecord(id: string): number {
    const result = this.localDb.db.prepare(`DELETE FROM local_cron_jobs WHERE id = ?`).run(id)
    return result.changes
  }

  /**
   * 更新本地 Cron 任务基础字段。停用任务时同步清除 last_status='running'，避免已中断任务卡在"运行中"。
   */
  updateLocalCronJobRecord(params: {
    id: string
    name: string
    taskText: string
    agentId?: string
    enabled: boolean
    scheduleType: 'at' | 'every' | 'cron'
    scheduleExpr: string
    nextRunAt: number
    intervalMs?: number
    activeDays?: string | null
    activeHourStart?: number | null
    activeHourEnd?: number | null
    notifyTargets?: string | null
  }): number {
    const result = this.localDb.db.prepare(
      `UPDATE local_cron_jobs
       SET name = ?, task_text = ?, agent_id = ?, enabled = ?, schedule_type = ?, schedule_expr = ?, next_run_at = ?, interval_ms = ?,
           active_days = ?, active_hour_start = ?, active_hour_end = ?, notify_targets = ?
       WHERE id = ?`
    ).run(
      params.name,
      params.taskText,
      params.agentId?.trim() || null,
      params.enabled ? 1 : 0,
      params.scheduleType,
      params.scheduleExpr,
      params.nextRunAt,
      params.intervalMs ?? null,
      params.activeDays?.trim() || null,
      params.activeHourStart ?? null,
      params.activeHourEnd ?? null,
      params.notifyTargets?.trim() || null,
      params.id,
    )
    // 禁用任务时：清理运行集合 + 无条件清除 last_status='running'
    // 不能只看 wasRunning：应用重启后内存集合为空，DB 里可能残留上次中断的 'running'
    if (!params.enabled) {
      const setSize = this.localCronRunningJobs.size
      const wasRunning = this.localCronRunningJobs.has(params.id)
      this.localCronRunningJobs.delete(params.id)
      const afterSize = this.localCronRunningJobs.size
      log.info(`[updateLocalCronJob] 禁用任务 ${params.id}: wasRunning=${wasRunning}, Set size ${setSize} -> ${afterSize}`)
      const result2 = this.localDb.db
        .prepare(`UPDATE local_cron_jobs SET last_status = NULL WHERE id = ? AND last_status = 'running'`)
        .run(params.id)
      log.info(`[updateLocalCronJob] 清除运行状态: id=${params.id}, SQL changes=${result2.changes}`)
    }
    return result.changes
  }

  /**
   * 查询本地 Cron 运行历史。
   */
  listLocalCronRuns(jobId: string, limit: number): Array<{
    id: string
    status: 'ok' | 'error'
    started_at: number
    finished_at: number
    duration_ms: number
    summary: string | null
    error: string | null
  }> {
    return this.localDb.db.prepare<{
      id: string
      status: 'ok' | 'error'
      started_at: number
      finished_at: number
      duration_ms: number
      summary: string | null
      error: string | null
    }>(
      `SELECT id, status, started_at, finished_at, duration_ms, summary, error
       FROM local_cron_runs
       WHERE job_id = ?
       ORDER BY started_at DESC
       LIMIT ?`
    ).all(jobId, Math.max(1, Math.min(limit, 200)))
  }

  /**
   * 公开接口：手动立即执行一次 Cron 任务（与自动触发走同一路径）。
   */
  async runCronJobManually(job: { id: string; task_text: string; agent_id: string | null }): Promise<void> {
    return this.runLocalCronJob(job, { manual: true })
  }

  /**
   * 按任务配置注册本地计时器。
   * 供 registerLocalCronTools 工具实现调用（接收 scheduleLocalCronJob 回调）。
   */
  scheduleJob(job: {
    id: string
    task_text: string
    agent_id: string | null
    schedule_type: 'at' | 'every' | 'cron'
    next_run_at: number
    interval_ms: number | null
    schedule_expr?: string
  }): void {
    this.clearLocalCronTimer(job.id)
    if (job.schedule_type === 'at') {
      const delay = Math.max(0, job.next_run_at - Date.now())
      const handle = setTimeout(() => {
        void this.runLocalCronJob(job).finally(() => {
          this.clearLocalCronTimer(job.id)
          // one-shot 任务执行后仅禁用，保留记录与历史
          this.localDb.db.prepare(`UPDATE local_cron_jobs SET enabled = 0 WHERE id = ?`).run(job.id)
          // 已失效的一次性任务只保留近 20 条，超出的连同运行记录一并清理
          this.pruneExpiredOneShotJobs()
        })
      }, delay)
      this.localCronTimers.set(job.id, handle)
      return
    }
    const intervalMs = job.interval_ms
    if (job.schedule_type === 'every' && intervalMs && intervalMs > 0) {
      const wait = Math.max(0, job.next_run_at - Date.now())
      if (wait > 0) {
        const firstHandle = setTimeout(() => {
          void this.runLocalCronJob(job).finally(() => {
            this.localDb.db
              .prepare(`UPDATE local_cron_jobs SET next_run_at = ? WHERE id = ?`)
              .run(Date.now() + intervalMs, job.id)
          })
          const intervalHandle = setInterval(() => {
            void this.runLocalCronJob(job).finally(() => {
              this.localDb.db
                .prepare(`UPDATE local_cron_jobs SET next_run_at = ? WHERE id = ?`)
                .run(Date.now() + intervalMs, job.id)
            })
          }, intervalMs)
          this.localCronTimers.set(job.id, intervalHandle)
        }, wait)
        this.localCronTimers.set(job.id, firstHandle)
      } else {
        const intervalHandle = setInterval(() => {
          void this.runLocalCronJob(job).finally(() => {
            this.localDb.db
              .prepare(`UPDATE local_cron_jobs SET next_run_at = ? WHERE id = ?`)
              .run(Date.now() + intervalMs, job.id)
          })
        }, intervalMs)
        this.localCronTimers.set(job.id, intervalHandle)
      }
      return
    }
    // cron 类型：使用 croner 解析标准 cron 表达式并定时调度
    if (job.schedule_type === 'cron' && job.schedule_expr) {
      try {
        const cronInstance = new Cron(job.schedule_expr, { timezone: 'Asia/Shanghai' }, () => {
          void this.runLocalCronJob(job).finally(() => {
            const next = cronInstance.nextRun()
            if (next) {
              this.localDb.db
                .prepare(`UPDATE local_cron_jobs SET next_run_at = ? WHERE id = ?`)
                .run(next.getTime(), job.id)
            }
          })
        })
        this.cronInstances.set(job.id, cronInstance)
        log.info(`[scheduleJob] cron 任务已注册 jobId=${job.id} expr="${job.schedule_expr}"`)
      } catch (err) {
        log.error(`[scheduleJob] cron 表达式解析失败 jobId=${job.id} expr="${job.schedule_expr}":`, err)
      }
    }
  }

  /**
   * 清理单个本地定时任务计时器。
   */
  clearLocalCronTimer(jobId: string): void {
    const handle = this.localCronTimers.get(jobId)
    if (!handle) return
    clearTimeout(handle)
    clearInterval(handle)
    this.localCronTimers.delete(jobId)
  }

  /** 已失效一次性任务的保留上限；超出的按最后执行时间从旧到新删除 */
  private static readonly MAX_EXPIRED_ONE_SHOT_JOBS = 20

  /**
   * 裁剪已失效的一次性任务（schedule_type='at' 且 enabled=0），只保留最近 MAX 条。
   * 删除任务本身与其 cron_runs 运行记录；已失效任务无计时器，无需清理定时器。
   * last_run_at 为 NULL（异常未执行）的排最后，优先被清掉。
   */
  private pruneExpiredOneShotJobs(): void {
    try {
      const stale = this.localDb.db.prepare<{ id: string }>(
        `SELECT id FROM local_cron_jobs
         WHERE schedule_type = 'at' AND enabled = 0
         ORDER BY last_run_at DESC NULLS LAST
         LIMIT -1 OFFSET ?`
      ).all(CronScheduler.MAX_EXPIRED_ONE_SHOT_JOBS)
      if (stale.length === 0) return
      const deleteJob = this.localDb.db.prepare(`DELETE FROM local_cron_jobs WHERE id = ?`)
      const deleteRuns = this.localDb.db.prepare(`DELETE FROM local_cron_runs WHERE job_id = ?`)
      for (const { id } of stale) {
        deleteRuns.run(id)
        deleteJob.run(id)
      }
      log.info(`[pruneExpiredOneShotJobs] 清理 ${stale.length} 条超额的已失效一次性任务`)
    } catch (err) {
      log.warn('[pruneExpiredOneShotJobs] 裁剪失败:', err)
    }
  }

  // ─── 私有方法 ───────────────────────────────────────────────

  /**
   * 启动时从 SQLite 恢复本地定时任务并重新调度。
   */
  private startLocalCronScheduler(): void {
    if (!this.localDb.isOpen) return
    type JobRow = {
      id: string
      name: string
      task_text: string
      agent_id: string | null
      schedule_type: 'at' | 'every' | 'cron'
      schedule_expr: string
      next_run_at: number
      interval_ms: number | null
      enabled: number
      created_at: number
    }
    try {
      const jobs = this.localDb.db.prepare<JobRow>(
        `SELECT id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at
         FROM local_cron_jobs
         WHERE enabled = 1`
      ).all()
      for (const job of jobs) {
        this.scheduleJob(job)
      }
      // 启动时清掉上次异常退出遗留的 'running' 状态（正常运行时不会有任务处于 running）
      const stale = this.localDb.db
        .prepare(`UPDATE local_cron_jobs SET last_status = NULL WHERE last_status = 'running'`)
        .run()
      if (stale.changes > 0) {
        log.info(`[startLocalCronScheduler] 清除 ${stale.changes} 条启动时残留的 running 状态`)
      }
      log.info(`[startLocalCronScheduler] 已恢复 ${jobs.length} 个本地定时任务`)
    } catch (err) {
      log.error('[startLocalCronScheduler] 恢复本地定时任务失败:', err)
    }
  }

  /**
   * 定期硬删除 30 天前软删除的文件（物理文件 + DB 记录）。
   * 每 24 小时执行一次，启动时延迟 60 秒首次执行。
   */
  private startFileCleanupScheduler(): void {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
    const run = async (): Promise<void> => {
      const fileRepo = this.deps.getFileRepo()
      if (!fileRepo) return
      try {
        const threshold = new Date(Date.now() - THIRTY_DAYS_MS)
        const rows = fileRepo.listSoftDeletedBefore(threshold)
        if (rows.length === 0) return
        const cwd = this.deps.getCwd()
        let removed = 0
        for (const row of rows) {
          const absPath = path.resolve(cwd, row.localPath)
          try {
            await fs.promises.unlink(absPath)
          } catch (err) {
            // ENOENT — 文件已不存在，静默忽略
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              log.warn(`[fileCleanup] unlink failed for ${absPath}:`, err)
            }
          }
          fileRepo.hardDelete(row.id)
          removed++
        }
        if (removed > 0) {
          log.info(`[fileCleanup] 硬删除 ${removed} 个过期文件`)
        }
      } catch (err) {
        log.error('[fileCleanup] 清理任务出错:', err)
      }
    }

    // 启动后延迟 60 秒首次执行（避免与初始化竞争）
    setTimeout(() => {
      void run()
      setInterval(() => { void run() }, 24 * 60 * 60 * 1000)
    }, 60 * 1000)
  }

  /**
   * 回读会话中 since 之后的最后一条 assistant 文本回复。
   * 取不到（纯工具调用回合、流式未落库等）返回 null，由调用方回落。
   *
   * messages.timestamp 是 ISO 字符串（见 conversation-repo.saveMessage），
   * 必须用同类型比较：SQLite 里整数排在文本之前，传数字会让 since 恒真，
   * 从而把本次运行之前的旧回复当成产出推出去。
   */
  private readLatestAssistantText(conversationId: string, since: number): string | null {
    try {
      const row = this.localDb.db.prepare<{ content_json: string }>(
        `SELECT content_json FROM messages
         WHERE conversation_id = ? AND role = 'assistant' AND timestamp >= ?
         ORDER BY timestamp DESC LIMIT 1`
      ).get(conversationId, new Date(since).toISOString())
      if (!row) return null
      const parsed: unknown = JSON.parse(row.content_json)
      if (!parsed || typeof parsed !== 'object') return null
      const content = parsed as { type?: string; text?: string }
      const text = content.type === 'text' ? (content.text ?? '').trim() : ''
      return text || null
    } catch (err) {
      log.warn('[readLatestAssistantText] 回读失败:', err)
      return null
    }
  }

  /**
   * 按 notify_targets 派发执行结果。
   *
   * 未配置时回落系统通知 —— 老任务没有这一列，静默不通知会像任务没跑。
   * 单个渠道失败只记日志，不影响其余渠道，也不让整个任务判定为失败。
   * 飞书/微信出站优先走 ChannelOutboundRouter（与 Agent channel_send 同源）。
   */
  private async dispatchNotifications(
    job: { name: string; task_text: string },
    notifyTargets: string | null,
    output: string,
  ): Promise<void> {
    const targets = notifyTargets?.trim()
      ? notifyTargets.split(',').map((t) => t.trim()).filter(Boolean)
      : ['system']
    // 'silent'：任务自己已经写好产出（如资讯任务直接调 dashboard_feed_write 写卡片），
    // 不需要再由派发器把 Agent 原始回复当成通知重复推一遍
    if (targets.length === 1 && targets[0] === 'silent') return
    // 任务名缺失时退回任务指令首句，用作各渠道的来源标签
    const label = job.name?.trim() || job.task_text.slice(0, 20)

    for (const target of targets) {
      // 只为命中的渠道取它自己的格式化策略
      const payload = formatForTarget(target, label, output)
      try {
        const colon = target.indexOf(':')
        const kind = colon > 0 ? target.slice(0, colon) : target
        const peerFromTarget = colon > 0 ? target.slice(colon + 1).trim() : ''

        switch (kind) {
          case 'system':
            this.deps.showCronNotification?.(payload.title ?? '灵栖 定时任务', payload.body)
            break
          case 'news':
            await prependActiveDashboardFeedItem({
              id: `cron-${Date.now()}`,
              title: payload.title ?? label,
              summary: payload.body,
              source: '定时任务',
              timestamp: Date.now(),
              kind: 'cron',
            })
            break
          case 'focus':
            this.deps.addMemory?.(payload.body)
            break
          case 'feishu': {
            const router = this.deps.getChannelRouter?.()
            if (router) {
              const snaps = await router.list()
              const feishu = snaps.find((s) => s.channel === 'feishu')
              const to = peerFromTarget || feishu?.peers.find((p) => p.canSend)?.id || feishu?.peers[0]?.id
              if (!to) {
                log.warn('[dispatchNotifications] 飞书无可用 peer，已跳过')
                break
              }
              const res = await router.send({ channel: 'feishu', to, text: payload.body })
              if (!res.ok) {
                log.warn('[dispatchNotifications] 飞书推送失败:', res.errorCode, res.message)
              }
            } else if (this.deps.sendFeishuMessage) {
              const res = await this.deps.sendFeishuMessage(payload.body)
              if (!res.ok) log.warn('[dispatchNotifications] 飞书推送失败:', res.error)
            } else {
              log.warn('[dispatchNotifications] 飞书 Router/sendFeishuMessage 均未注入，已跳过')
            }
            break
          }
          case 'weixin': {
            const router = this.deps.getChannelRouter?.()
            if (!peerFromTarget) {
              log.warn('[dispatchNotifications] weixin 目标缺少 peerId，请使用 weixin:<peerId>，已跳过')
              break
            }
            if (!router) {
              log.warn('[dispatchNotifications] ChannelOutboundRouter 未就绪，weixin 推送已跳过')
              break
            }
            const res = await router.send({
              channel: 'weixin',
              to: peerFromTarget,
              text: payload.body,
            })
            if (!res.ok) {
              log.warn('[dispatchNotifications] 微信推送失败:', res.errorCode, res.message)
            }
            break
          }
          case 'wecom': {
            log.warn('[dispatchNotifications] 企业微信不支持主动推送（reply_only），已跳过')
            break
          }
          case 'silent':
            // 与多渠道混用时的显式空操作（单独 'silent' 已在上方提前返回）
            break
          default:
            log.warn(`[dispatchNotifications] 未知推送目标，已忽略: ${target}`)
        }
      } catch (err) {
        // 单渠道失败不影响其余渠道，也不让整个任务判定为失败
        log.warn(`[dispatchNotifications] 渠道 ${target} 推送失败:`, err)
      }
    }
  }

  /**
   * 执行本地定时任务：推送系统通知，并按需驱动指定 Agent 完成任务。
   */
  private async runLocalCronJob(
    job: { id: string; task_text: string; agent_id: string | null },
    options: { manual?: boolean } = {},
  ): Promise<void> {
    if (this.localCronRunningJobs.has(job.id)) {
      log.info(`[runLocalCronJob] jobId=${job.id} 已在运行中，跳过`)
      return
    }

    // 执行前从 DB 重新校验任务是否仍存在且 enabled=1（防止任务已删除/禁用但 timer 尚未清理时触发）
    const currentRow = this.localDb.db.prepare<{
      name: string
      enabled: number
      active_days: string | null
      active_hour_start: number | null
      active_hour_end: number | null
      system_prompt: string | null
      notify_targets: string | null
    }>(
      `SELECT name, enabled, active_days, active_hour_start, active_hour_end, system_prompt, notify_targets
       FROM local_cron_jobs WHERE id = ?`
    ).get(job.id)
    if (!currentRow) {
      log.warn(`[runLocalCronJob] 任务 jobId=${job.id} 已从 DB 删除，跳过执行`)
      this.clearLocalCronTimer(job.id)
      return
    }
    // 已禁用任务不自动触发；但手动「立即执行/重新执行」是用户明确意图（含已失效的一次性任务），放行
    if (currentRow.enabled === 0 && !options.manual) {
      log.warn(`[runLocalCronJob] 任务 jobId=${job.id} 已禁用，跳过执行`)
      this.clearLocalCronTimer(job.id)
      return
    }
    // 生效窗口过滤：「按间隔」靠 setInterval 触发，无法在调度层限定星期/时段。
    // 不在窗口内就静默跳过，且不写 run 记录 —— 否则执行记录会被跳过项灌满。
    // 手动「立即执行」是用户明确意图，不受窗口约束。
    if (!options.manual && !isWithinActiveWindow(currentRow)) {
      log.info(`[runLocalCronJob] jobId=${job.id} 不在生效窗口内，跳过本次触发`)
      return
    }

    this.localCronRunningJobs.add(job.id)
    const startedAt = Date.now()
    const runId = `local-run-${startedAt}-${Math.random().toString(36).slice(2, 8)}`
    log.info(`[runLocalCronJob] 开始执行 jobId=${job.id} taskText="${job.task_text.slice(0, 60)}" agentId=${job.agent_id ?? 'none'}`)

    // 执行前标记 running 状态
    this.localDb.db.prepare(
      `UPDATE local_cron_jobs SET last_run_at = ?, last_status = 'running' WHERE id = ?`
    ).run(startedAt, job.id)

    try {
      // Companion 魔法指令拦截：优先走本地 companion handler，不创建 Agent 实例
      const companionHandler = this.deps.handleCompanionInstruction
      if (companionHandler && !job.agent_id) {
        const companionResult = await companionHandler(job.task_text, {
          manual: options.manual === true,
        })
        if (companionResult !== null) {
          log.info(`[runLocalCronJob] companion 指令处理完成 jobId=${job.id} result="${companionResult}"`)
          const finishedAt = Date.now()
          this.localDb.db.prepare(
            `UPDATE local_cron_jobs SET last_run_at = ?, last_status = 'ok' WHERE id = ?`
          ).run(finishedAt, job.id)
          this.localDb.db.prepare(
            `INSERT INTO local_cron_runs (id, job_id, status, started_at, finished_at, duration_ms, summary, error)
             VALUES (?, ?, 'ok', ?, ?, ?, ?, NULL)`
          ).run(runId, job.id, startedAt, finishedAt, finishedAt - startedAt, companionResult)
          return
        }
      }

      let output = job.task_text
      if (job.agent_id) {
        // 有指定 Agent：驱动 Agent 执行任务，通知在 Agent 完成后发出
        log.info(`[runLocalCronJob] 驱动 Agent agentId=${job.agent_id} 执行任务`)
        // 固定 sessionKey（而非「上次活跃会话」）：每个任务在会话列表里有专属可查看的记录，
        // 不依赖用户此前是否打开过某个会话，客户端重启后也不受影响
        const convId = `cron:${job.id}`
        const title = `定时任务 · ${currentRow.name}`
        this.deps.ensureConversationExists(convId, title)
        this.deps.notifyIncomingMessage(convId, job.task_text)
        const instanceId = await this.deps.createInstanceById(job.agent_id, convId, convId)
        try {
          // 预置任务带完整系统提示词，拼在任务指令之前
          const message = currentRow.system_prompt
            ? `${currentRow.system_prompt}\n\n---\n\n${job.task_text}`
            : job.task_text
          await this.deps.prompt(instanceId, message)
        } finally {
          this.deps.destroy(instanceId)
        }
        // prompt() 不返回内容，从会话里回读 Agent 的最后一条回复作为推送正文
        output = this.readLatestAssistantText(convId, startedAt) ?? job.task_text
      }
      await this.dispatchNotifications(
        { name: currentRow.name, task_text: job.task_text },
        currentRow.notify_targets,
        output,
      )

      const finishedAt = Date.now()
      // 更新任务状态为 ok + last_run_at
      this.localDb.db.prepare(
        `UPDATE local_cron_jobs SET last_run_at = ?, last_status = 'ok' WHERE id = ?`
      ).run(finishedAt, job.id)
      this.localDb.db.prepare(
        `INSERT INTO local_cron_runs (id, job_id, status, started_at, finished_at, duration_ms, summary, error)
         VALUES (?, ?, 'ok', ?, ?, ?, ?, NULL)`
      ).run(runId, job.id, startedAt, finishedAt, finishedAt - startedAt, output.slice(0, 2000))
      log.info(`[runLocalCronJob] 执行完成 jobId=${job.id} durationMs=${finishedAt - startedAt}`)
    } catch (err) {
      log.error(`[runLocalCronJob] 执行失败 jobId=${job.id}:`, err)
      const finishedAt = Date.now()
      const message = err instanceof Error ? err.message : String(err)
      // 更新任务状态为 error
      this.localDb.db.prepare(
        `UPDATE local_cron_jobs SET last_run_at = ?, last_status = 'error' WHERE id = ?`
      ).run(finishedAt, job.id)
      this.localDb.db.prepare(
        `INSERT INTO local_cron_runs (id, job_id, status, started_at, finished_at, duration_ms, summary, error)
         VALUES (?, ?, 'error', ?, ?, ?, ?, ?)`
      ).run(runId, job.id, startedAt, finishedAt, finishedAt - startedAt, job.task_text, message)
    } finally {
      this.localCronRunningJobs.delete(job.id)
    }
  }
}
