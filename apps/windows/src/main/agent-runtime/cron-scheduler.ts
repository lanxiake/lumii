/**
 * CronScheduler — 本地定时任务调度管理
 *
 * 职责：
 * - 启动时从 SQLite 恢复任务定时器
 * - 调度 at/every/cron 类型任务（cron 表达式由本地 croner 解析，时区 Asia/Shanghai）
 * - 执行任务：驱动 Agent 或发送系统通知
 * - 文件清理定时器（30 天软删除硬清理）
 * - CRUD：提供 DB 记录的增删改查接口
 *
 * 从 bridge.ts 提取，通过构造注入依赖，外部 API（CRUD 方法）签名不变
 */

import path from 'node:path'
import fs from 'node:fs'
import { Cron } from 'croner'
import { SELF_CRON_ID_PREFIX, type LocalDatabase, type FileRepo } from '@mtbot/agent-runtime'
import { prependActiveDashboardFeedItem, readDashboardFeedSnapshot, getDashboardFeedWriteVersion } from '../dashboard-feed-store'
import { DEFAULT_AGENT_ID } from '../seed-cron-jobs'
import { formatForTarget, formatDashboardFeedForPush } from './cron-notify-format'
import { shouldSkipCronFocusMemoryWrite } from './cron-focus-memory'
import { dispatchChannelTarget } from './channel-target-dispatch'
import { isNoReplySentinel } from './bridge-agent-instance-events'
import { buildSelfBriefing } from './self-briefing'
import { readLatestMaintenanceReport } from '../maintenance-report-store'

const log = {
  info: (...args: unknown[]) => console.log('[CronScheduler]', ...args),
  warn: (...args: unknown[]) => console.warn('[CronScheduler]', ...args),
  error: (...args: unknown[]) => console.error('[CronScheduler]', ...args),
}

/** 资产体检的归属 Agent。自述里带上期体检结论，只对它有意义 */
const MAINTENANCE_AGENT_ID = 'system-keeper'

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

/**
 * 从单条消息的 content_json 中提取正文文本。
 * 兼容 assistant_parts（当前落库格式）与扁平 text（旧数据）两种结构。
 * 思考内容（thinking）与工具卡片（tool）不参与文本提取。
 */
function extractTextFromContentJson(contentJson: string): string {
  try {
    const parsed: unknown = JSON.parse(contentJson)
    if (!parsed || typeof parsed !== 'object') return ''
    const o = parsed as Record<string, unknown>

    if (Array.isArray(o.parts)) {
      return (o.parts as readonly unknown[])
        .filter((p): p is { type: string; text: string } => {
          const part = p as Record<string, unknown> | null
          return part?.type === 'text' && typeof part.text === 'string'
        })
        .map((p) => p.text.trim())
        .filter(Boolean)
        .join(' ')
        .trim()
    }

    if (typeof o.text === 'string') return o.text.trim()
    if (typeof o.content === 'string') return o.content.trim()
    return ''
  } catch {
    return ''
  }
}

/**
 * 根据通知渠道生成工具调用提示词。
 * 每个渠道对应不同的工具和格式化要求。
 */
function buildNotifyToolsPrompt(notifyTargets: string | null): string {
  if (!notifyTargets?.trim()) return ''

  const targets = notifyTargets.split(',').map((t) => t.trim()).filter(Boolean)
  if (targets.length === 0 || (targets.length === 1 && targets[0] === 'silent')) return ''

  const toolInstructions: string[] = []

  for (const target of targets) {
    const colon = target.indexOf(':')
    const kind = colon > 0 ? target.slice(0, colon) : target

    switch (kind) {
      case 'system':
        toolInstructions.push(
          '- 系统通知：完成任务后，输出简短的标题和正文摘要（控制在 100 字内），' +
          '系统会自动发送桌面通知。不要使用工具，直接输出文本即可。'
        )
        break
      case 'news':
        toolInstructions.push(
          '- 最近资讯：先用 dashboard_feed_read 回读卡片上已有的条目（同一事件的同一篇稿子不要重复推），' +
          '再用 dashboard_feed_write 工具将结果写入概览页资讯卡片。' +
          '每条资讯需包含：标题、正文摘要（2-3 句话）、来源、链接。' +
          '整体综述控制在 120 字内。'
        )
        break
      case 'focus':
        toolInstructions.push(
          '- 近期关注：使用 memory_upsert 工具将重要事项写入工作记忆。' +
          '格式简洁，每条事项包含：具体内容、当前状态或进度、截止时间（如有）。'
        )
        break
      case 'feishu':
        toolInstructions.push(
          '- 飞书：完成任务后，输出手机友好的报告正文（系统会按长度渲染成卡片或消息）。' +
          '要点式、每条一行、带序号；避免表格与代码块；控制在 400 字内。'
        )
        break
      case 'weixin':
        toolInstructions.push(
          '- 微信：输出手机友好的纯文本报告（系统会编译并分段发送）。' +
          '要点式、每条一行、带序号；避免表格与代码块；控制在 400 字内。'
        )
        break
      case 'qbot':
        toolInstructions.push(
          '- QQ：输出手机友好的报告正文（系统会按平台能力渲染 Markdown 或纯文本）。' +
          '要点式、每条一行、带序号；控制在 400 字内。'
        )
        break
      case 'wecom':
        // 企微为 reply_only，主动推送会被跳过，无需给 Agent 输出指导
        break
      case 'silent':
        // silent 不需要额外指导
        break
    }
  }

  if (toolInstructions.length === 0) return ''

  return `\n\n## 通知输出\n\n完成任务后，需要通过以下渠道输出结果：\n\n${toolInstructions.join('\n\n')}`
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
  /** 是否显示系统通知。convId 用于点击通知后跳转到对应会话。 */
  showCronNotification?: (title: string, body: string, convId?: string) => void
  /** 获取当前活跃会话 ID（Cron Agent 实例挂载用） */
  getLastActiveConvId: () => string | null
  /** 按 Agent ID 创建 Agent 实例 */
  createInstanceById: (agentId: string, sessionKey?: string, conversationId?: string) => Promise<string>
  /**
   * 按 Agent ID 创建受限实例（工具白名单护栏）。
   * agent-self:* 自建任务必须走这条路径，防止自主排期任务拿到 assistant 全量工具。
   * 未提供时 agent-self 任务回落普通 createInstanceById（兼容旧装配）。
   */
  createRestrictedInstanceById?: (agentId: string, sessionKey?: string, conversationId?: string) => Promise<string>
  /**
   * bridge 是否已完成初始化（instanceFactory / promptDispatcher 就绪）。
   * 未就绪时不注册任何计时器——过期 every 任务会立即补跑，若此时工厂尚未创建，
   * driveAgent 会抛 "Cannot read properties of undefined (reading 'createInstanceById')"。
   */
  isReady?: () => boolean
  /** 向指定 Agent 实例发送消息 */
  prompt: (instanceId: string, message: string) => Promise<void>
  /** 等待 Agent 实例进入 idle（prompt 返回后事件落库可能仍在进行） */
  waitForInstanceIdle?: (instanceId: string) => Promise<void>
  /** 从实例内存读取最新 assistant 正文（比 DB 回读更及时，destroy 前使用） */
  getAssistantOutputFromInstance?: (instanceId: string) => string | null
  /** 销毁 Agent 实例 */
  destroy: (instanceId: string) => void
  /** 确保对话记录存在（cron 任务用固定 sessionKey，让每个任务在会话列表里有专属可查看的记录） */
  ensureConversationExists: (conversationId: string, title?: string) => boolean
  /**
   * 把定时任务会话归属到执行它的 Agent（写 conversations 的 agent 参与者）。
   *
   * 会话列表按这个归属把记录分到侧栏分组：归属 chronicler 的「早间简报」才能出现在
   * 「记事」分组下，供用户查看与 Agent 回顾。创建会话时参与者写的是 'main'，
   * 必须由执行者覆盖。实现方需保证幂等（相同值不重复写库）。
   */
  setConversationAgent?: (conversationId: string, agentId: string) => void
  /** 通知渲染进程有新的用户消息（不落库，仅推送 UI 展示；不跳转视图，避免打断用户当前操作） */
  notifyIncomingMessage: (sessionKey: string, text: string) => void
  /** 落库一条消息到指定会话。cron 实例不走 UI 流式落库路径，产出只在内存，
   *  必须手动持久化任务指令与 Agent 产出，否则会话历史在重启后为空。
   *  agentId 为任务执行者归属（缺省回落 assistant），用于多 Agent 的产出归属。
   *  timestamp 用于固定任务指令与产出的先后顺序（同毫秒落库时 DB 按随机 id 排序会颠倒两者）。 */
  saveMessage?: (params: {
    conversationId: string
    role: 'user' | 'assistant'
    text: string
    agentId?: string
    timestamp?: string
  }) => void
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
  addMemory?: (content: string, agentId?: string) => void
  /**
   * 将指定定时任务产出持久化到 Wiki（失败由实现方记日志，不抛错）。
   */
  persistCronOutputToWiki?: (
    jobId: string,
    jobName: string,
    output: string,
    finishedAt: number,
  ) => Promise<void>
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
  /** 本次进程内已补跑过的过期 every 任务（防 reloadLocalCronScheduler 重复补跑） */
  private readonly caughtUpEveryJobs = new Set<string>()
  /**
   * stop() 后置位：飞行中的任务在下一个检查点安静退出（不再派发通知、不再记账）。
   *
   * 为什么不能只靠 isOpen：stop() 与 localDb.close() 之间还有窗口，
   * 期间在飞的 tick 继续跑只会把「正在退出」拖成半完成收尾（2026-09-20 退出现场）。
   */
  private stopped = false

  constructor(
    private readonly localDb: LocalDatabase,
    private readonly deps: CronSchedulerDeps,
  ) {}

  /**
   * 启动所有调度器（在 bridge.initialize() 末尾调用）
   */
  start(): void {
    this.stopped = false
    this.startLocalCronScheduler()
    this.startFileCleanupScheduler()
  }

  /**
   * 停止所有定时器（在 bridge.destroyAll() 中调用）
   */
  stop(): void {
    this.stopped = true
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
    // 连带删除运行记录：与 pruneExpiredOneShotJobs 口径一致，避免删除后留下不可见的孤儿 runs
    this.localDb.db.prepare(`DELETE FROM local_cron_runs WHERE job_id = ?`).run(id)
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
        void this.runLocalCronJob(job).finally(() => this.finishOneShotJob(job.id))
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
            this.writeNextRunAt(job.id, Date.now() + intervalMs)
          })
          const intervalHandle = setInterval(() => {
            void this.runLocalCronJob(job).finally(() => {
              this.writeNextRunAt(job.id, Date.now() + intervalMs)
            })
          }, intervalMs)
          this.localCronTimers.set(job.id, intervalHandle)
        }, wait)
        this.localCronTimers.set(job.id, firstHandle)
      } else {
        // next_run_at 已过期（进程重启跨过了调度点）：先补跑一次再进入周期调度。
        // 若直接挂 interval，错过的一次会永远不执行——应用每次重启都把首触发再推迟
        // 一整个周期，长周期任务（12h/24h）在会话时长短于周期时永远轮不到
        // （2026-09-12 EVO 缺陷 #3）。caughtUpEveryJobs 保证每次进程生命周期内
        // 每个任务只补跑一次，reloadLocalCronScheduler 不会重复补跑。
        if (!this.caughtUpEveryJobs.has(job.id)) {
          this.caughtUpEveryJobs.add(job.id)
          log.info(`[scheduleJob] every 任务已过期，补跑一次 jobId=${job.id} next_run_at=${job.next_run_at}`)
          void this.runLocalCronJob(job).finally(() => {
            this.writeNextRunAt(job.id, Date.now() + intervalMs)
          })
        }
        const intervalHandle = setInterval(() => {
          void this.runLocalCronJob(job).finally(() => {
            this.writeNextRunAt(job.id, Date.now() + intervalMs)
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
            if (next) this.writeNextRunAt(job.id, next.getTime())
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
      // 只裁「真正过期」的一次性任务（执行时刻已过）；未来时间的 at 任务
      // 可能只是被开关暂停（如自主进化关闭时挂起的计划），不能当作失效清掉
      const stale = this.localDb.db.prepare<{ id: string }>(
        `SELECT id FROM local_cron_jobs
         WHERE schedule_type = 'at' AND enabled = 0 AND next_run_at <= ?
         ORDER BY last_run_at DESC NULLS LAST
         LIMIT -1 OFFSET ?`
      ).all(Date.now(), CronScheduler.MAX_EXPIRED_ONE_SHOT_JOBS)
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

  /**
   * 退出清场判据：调度器已停（stop()）或库已关闭（finalizeShutdown）。
   * 飞行任务在每个检查点与每处记账写库前用它收手。
   */
  private isShuttingDown(): boolean {
    return this.stopped || !this.localDb.isOpen
  }

  /**
   * 任务状态记账（last_run_at / last_status）。库已关或调度已停时静默跳过。
   *
   * catch 路径也走这里：收尾写库若再抛，整个 promise 变成
   * UnhandledPromiseRejection（2026-09-20 退出实测 ×2），且失败原因被二次错误顶掉。
   */
  private recordJobStatus(jobId: string, status: 'running' | 'ok' | 'error', at: number): void {
    if (this.isShuttingDown()) return
    try {
      this.localDb.db
        .prepare(`UPDATE local_cron_jobs SET last_run_at = ?, last_status = ? WHERE id = ?`)
        .run(at, status, jobId)
    } catch (err) {
      log.warn(`[recordJobStatus] 写入任务状态失败 jobId=${jobId} status=${status}（已忽略）:`, err)
    }
  }

  /** 执行记录记账（local_cron_runs）。守卫理由同 recordJobStatus。 */
  private recordCronRun(run: {
    id: string
    jobId: string
    status: 'ok' | 'error'
    startedAt: number
    finishedAt: number
    summary: string | null
    error: string | null
  }): void {
    if (this.isShuttingDown()) return
    try {
      this.localDb.db
        .prepare(
          `INSERT INTO local_cron_runs (id, job_id, status, started_at, finished_at, duration_ms, summary, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.jobId,
          run.status,
          run.startedAt,
          run.finishedAt,
          run.finishedAt - run.startedAt,
          run.summary,
          run.error,
        )
    } catch (err) {
      log.warn(`[recordCronRun] 写入执行记录失败 jobId=${run.jobId}（已忽略）:`, err)
    }
  }

  /**
   * 落「下次执行时间」。库已关闭（退出清场）或写入异常时静默跳过。
   *
   * 这些调用都来自 `.finally` 回调：没人接住它的异常，一抛就是
   * UnhandledPromiseRejection（2026-09-19 退出时实测，栈指向 index.js 的 .finally）。
   */
  private writeNextRunAt(jobId: string, nextRunAt: number): void {
    if (!this.localDb.isOpen) return
    try {
      this.localDb.db
        .prepare(`UPDATE local_cron_jobs SET next_run_at = ? WHERE id = ?`)
        .run(nextRunAt, jobId)
    } catch (err) {
      log.warn(`[writeNextRunAt] 写入下次执行时间失败 jobId=${jobId}（已忽略）:`, err)
    }
  }

  /**
   * 一次性任务收尾：清计时器 + 置 enabled=0（保留记录与历史）+ 裁剪超额失效任务。
   * 库已关闭时只剩清计时器这一步——退出清场不该再写库。
   */
  private finishOneShotJob(jobId: string): void {
    this.clearLocalCronTimer(jobId)
    if (!this.localDb.isOpen) return
    try {
      this.localDb.db.prepare(`UPDATE local_cron_jobs SET enabled = 0 WHERE id = ?`).run(jobId)
      // 已失效的一次性任务只保留近 20 条，超出的连同运行记录一并清理
      this.pruneExpiredOneShotJobs()
    } catch (err) {
      log.warn(`[finishOneShotJob] 收尾失败 jobId=${jobId}（已忽略）:`, err)
    }
  }

  // ─── 私有方法 ───────────────────────────────────────────────

  /**
   * 启动时从 SQLite 恢复本地定时任务并重新调度。
   */
  private startLocalCronScheduler(): void {
    if (!this.localDb.isOpen) return
    // 桥接层未就绪（initialize 尚未走到末尾）时不注册计时器：
    // 过期任务补跑会立刻驱动 Agent，而实例工厂此时还不存在（见 CronSchedulerDeps.isReady）
    if (this.deps.isReady && !this.deps.isReady()) {
      log.warn('[startLocalCronScheduler] bridge 尚未就绪，跳过本次调度注册')
      return
    }
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
      this.syncConversationAgents()
    } catch (err) {
      log.error('[startLocalCronScheduler] 恢复本地定时任务失败:', err)
    }
  }

  /**
   * 校正历史定时任务会话的 Agent 归属（含已禁用任务的历史记录）。
   *
   * 老库里 `cron:<jobId>` 会话的参与者写的是 'main'，侧栏无法据此归组；
   * 这里按 local_cron_jobs.agent_id 就地改写成真正的执行者。幂等，每次启动跑一遍。
   * 只在会话已存在时更新 —— 不存在的会话等任务下次运行时由 driveAgent 建。
   */
  private syncConversationAgents(): void {
    const setAgent = this.deps.setConversationAgent
    if (!setAgent) return
    try {
      const jobs = this.localDb.db
        .prepare<{ id: string; agent_id: string | null }>(
          `SELECT id, agent_id FROM local_cron_jobs WHERE agent_id IS NOT NULL`
        )
        .all()
      if (jobs.length === 0) return
      const knownConvIds = new Set(
        this.localDb.db
          .prepare<{ id: string }>(`SELECT id FROM conversations WHERE id LIKE 'cron:%'`)
          .all()
          .map((row) => row.id)
      )
      let updated = 0
      for (const job of jobs) {
        const convId = `cron:${job.id}`
        if (!knownConvIds.has(convId)) continue
        setAgent(convId, job.agent_id!)
        updated += 1
      }
      if (updated > 0) {
        log.info(`[syncConversationAgents] 已校正 ${updated} 个定时任务会话的 Agent 归属`)
      }
    } catch (err) {
      log.warn('[syncConversationAgents] 校正历史会话归属失败:', err)
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
      const text = extractTextFromContentJson(row.content_json)
      return text || null
    } catch (err) {
      log.warn('[readLatestAssistantText] 回读失败:', err)
      return null
    }
  }

  /**
   * 本轮运行是否已在会话里留下 assistant 行（正文或工具轨迹）。
   *
   * bridge 的流式落库（agent:start 建占位 → message:end 更新 → agent:end 收尾）
   * 会写整轮回复，cron 再补一条纯文本产出会让同一回复显示两份；
   * 只有流式行不存在（实例未起、会话刚建、非流式降级）时才需要兜底落库。
   */
  private hasAssistantMessageSince(conversationId: string, since: number): boolean {
    try {
      const row = this.localDb.db
        .prepare<{ id: string }>(
          `SELECT id FROM messages
           WHERE conversation_id = ? AND role = 'assistant' AND timestamp >= ?
           LIMIT 1`
        )
        // messages.timestamp 是 ISO 字符串，必须用同类型比较（见 readLatestAssistantText）
        .get(conversationId, new Date(since).toISOString())
      return Boolean(row)
    } catch (err) {
      log.warn('[hasAssistantMessageSince] 查询失败:', err)
      return false
    }
  }

  /**
   * 该会话里**最后一次** assistant 产出（不限时间），带落库时刻。
   *
   * 与 readLatestAssistantText(…, since) 的区别：那个回答「本轮产生了什么」，
   * 这个回答「上一次留下了什么」——自述要的是后者。
   * 调用时机必须在 `prompt()` 之前，否则会读到本轮自己的回复。
   */
  private readPreviousAssistantTurn(
    conversationId: string,
  ): { text: string; at: number } | null {
    try {
      const row = this.localDb.db
        .prepare<{ content_json: string; timestamp: string }>(
          `SELECT content_json, timestamp FROM messages
           WHERE conversation_id = ? AND role = 'assistant'
           ORDER BY timestamp DESC LIMIT 1`
        )
        .get(conversationId)
      if (!row) return null
      const at = Date.parse(row.timestamp)
      return {
        text: extractTextFromContentJson(row.content_json) || '',
        at: Number.isFinite(at) ? at : 0,
      }
    } catch (err) {
      log.warn('[readPreviousAssistantTurn] 回读失败:', err)
      return null
    }
  }

  /**
   * 拼「你上次的情况」段（B4）。
   *
   * cron 执行是全新实例、跑完即销毁，会话里累积的记录 Agent 看不到——
   * 不显式注入，它每轮都从零开始：不知道昨天推过什么、上次体检发现了什么。
   *
   * 维护类任务额外带上期体检结论：那是 `maintenance_report_read` 本来就取得到的信息，
   * 直接给它省一次工具调用，也免得它「忘了看」。
   */
  private buildSelfBriefingFor(convId: string, agentId: string): string {
    const prev = this.readPreviousAssistantTurn(convId)
    // NO_REPLY 是「本轮无话可说」的哨兵，不是产出——拿它当"上次说到哪"只会误导
    const lastOutput = prev?.text && !isNoReplySentinel(prev.text) ? prev.text : null
    const lastOutputAt = prev?.at || null

    let report: ReturnType<typeof readLatestMaintenanceReport> = null
    if (agentId === MAINTENANCE_AGENT_ID) {
      try {
        report = readLatestMaintenanceReport(agentId)
      } catch (err) {
        log.warn('[buildSelfBriefingFor] 读上期体检报告失败（忽略）:', err)
      }
    }

    return buildSelfBriefing({
      lastOutput,
      lastOutputAt,
      lastMaintenanceSummary: report?.summary ?? null,
      lastMaintenanceScope: report?.scope ?? null,
      lastMaintenanceFindingCount: report?.findings.length ?? null,
      now: Date.now(),
    })
  }

  /**
   * 按 notify_targets 派发执行结果。
   *
   * 未配置时回落系统通知 —— 老任务没有这一列，静默不通知会像任务没跑。
   * 单个渠道失败只记日志，不影响其余渠道，也不让整个任务判定为失败。
   * 飞书/微信出站优先走 ChannelOutboundRouter（与 Agent channel_send 同源）。
   */
  private async dispatchNotifications(
    job: { id: string; name: string; task_text: string; agent_id?: string | null },
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

        switch (kind) {
          case 'system':
            this.deps.showCronNotification?.(payload.title ?? '灵栖 定时任务', payload.body, `cron:${job.id}`)
            break
          case 'news':
            await prependActiveDashboardFeedItem(
              {
                id: `cron-${Date.now()}`,
                title: payload.title ?? label,
                summary: payload.body,
                source: '定时任务',
                timestamp: Date.now(),
                kind: 'cron',
              },
              undefined,
              { source: 'cron', conversationId: `cron:${job.id}` },
            )
            break
          case 'focus':
            if (
              shouldSkipCronFocusMemoryWrite({
                jobId: job.id,
                jobName: label,
                taskText: job.task_text,
                output,
              })
            ) {
              log.info(`[dispatchNotifications] 跳过 focus 写工作记忆 jobId=${job.id}`)
              break
            }
            this.deps.addMemory?.(payload.body, job.agent_id ?? DEFAULT_AGENT_ID)
            break
          case 'feishu':
          case 'weixin':
          case 'qbot':
          case 'wecom':
            // 正文以原始 Markdown 交给渠道层编译（飞书卡片 / 企微·QQ markdown / 微信分段），
            // 任务名走 title；wecom 不支持主动推送，由派发层记日志跳过
            await dispatchChannelTarget(target, payload.body, payload.title ?? label, this.deps)
            break
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
   * 轮询收集 Agent 产出：prompt() 返回时 bridge 侧 agent:end 落库可能尚未完成，
   * 且 destroy() 会删掉流式占位行，必须在销毁实例前先拿到正文。
   */
  private async collectAssistantOutput(params: {
    conversationId: string
    instanceId: string
    since: number
    fallback: string
  }): Promise<string> {
    const deadline = Date.now() + 30_000
    const pollIntervalMs = 200

    while (Date.now() < deadline) {
      const output = this.readAssistantOutputCandidate(params)
      if (output) return output
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    const output = this.readAssistantOutputCandidate(params)
    if (output) return output

    log.warn(
      `[collectAssistantOutput] 未回读到 Agent 产出，回落任务指令 conversationId=${params.conversationId}`,
    )
    return params.fallback
  }

  /**
   * 合并内存与 DB 两路回读，跳过与任务指令相同的占位文本。
   */
  private readAssistantOutputCandidate(params: {
    conversationId: string
    instanceId: string
    since: number
    fallback: string
  }): string | null {
    const candidates = [
      this.deps.getAssistantOutputFromInstance?.(params.instanceId) ?? null,
      this.readLatestAssistantText(params.conversationId, params.since),
    ]
    for (const raw of candidates) {
      const text = raw?.trim()
      if (!text || text === params.fallback.trim()) continue
      return text
    }
    return null
  }

  /**
   * 驱动指定 Agent 执行任务，返回用于推送的正文（回读 Agent 最后一条回复）。
   *
   * 固定 sessionKey（而非「上次活跃会话」）：每个任务在会话列表里有专属可查看的记录，
   * 不依赖用户此前是否打开过某个会话，客户端重启后也不受影响。
   */
  private async driveAgent(
    job: { id: string; task_text: string },
    currentRow: { name: string; system_prompt: string | null; notify_targets: string | null },
    agentId: string,
    startedAt: number,
  ): Promise<string> {
    log.info(`[driveAgent] 驱动 Agent agentId=${agentId} 执行任务 jobId=${job.id}`)
    const convId = `cron:${job.id}`
    this.deps.ensureConversationExists(convId, `定时任务 · ${currentRow.name}`)
    // 会话归属执行者：侧栏据此把记录归到对应 Agent 分组（如「早间简报」→「记事」）
    this.deps.setConversationAgent?.(convId, agentId)
    this.deps.notifyIncomingMessage(convId, job.task_text)
    // 硬防线：自主规划的自建任务（agent-self:*）必须走工具白名单受限实例，
    // 不能像预置/用户任务那样拿 assistant 全量工具。
    const isSelfTask = job.id.startsWith(SELF_CRON_ID_PREFIX)
    const instanceId =
      isSelfTask && this.deps.createRestrictedInstanceById
        ? await this.deps.createRestrictedInstanceById(agentId, convId, convId)
        : await this.deps.createInstanceById(agentId, convId, convId)
    try {
      // 构建完整消息：system_prompt + 通知工具指导 + 「自述」+ task_text
      const notifyPrompt = buildNotifyToolsPrompt(currentRow.notify_targets)
      const systemPart = currentRow.system_prompt ? `${currentRow.system_prompt}${notifyPrompt}` : ''
      // 自述必须在 prompt() 之前取——晚一步就会读到本轮自己的回复。
      // 放在任务指令之前：先「上次说到哪」，再「这次要做什么」。
      const selfBriefing = this.buildSelfBriefingFor(convId, agentId)
      log.info(
        selfBriefing
          ? `[driveAgent] 已注入自述 jobId=${job.id} ${selfBriefing.length} 字`
          : `[driveAgent] 无自述可注入（首次执行）jobId=${job.id}`,
      )
      const head = [systemPart, selfBriefing].filter(Boolean).join('\n\n')
      const message = head ? `${head}\n\n---\n\n${job.task_text}` : job.task_text

      await this.deps.prompt(instanceId, message)
      await this.deps.waitForInstanceIdle?.(instanceId)
      const output = await this.collectAssistantOutput({
        conversationId: convId,
        instanceId,
        since: startedAt,
        fallback: job.task_text,
      })
      // 落库任务指令(user)；Agent 产出(assistant)只在流式路径没留下内容时补写 ——
      // cron 实例走的是普通实例路径，bridge 的流式落库（agent:start/message:end）
      // 已经把完整回复（含思考与工具轨迹）写进会话，这里再补一条纯文本产出会让
      // 用户看到两份相同内容；只有流式行没落下来（实例未起、会话刚建）才需要兜底。
      //
      // 指令的时间戳必须用「任务开始时刻」而不是落库时刻：流式回复的 timestamp 取自
      // agent:end 收尾落库（updateMessageContent 会刷新 timestamp），收尾发生在本次
      // driveAgent 落库之前 —— 若指令用落库时刻，它会晚于回复，UI 按时间排序后回复
      // 排到指令上面，会话末尾是「我发的消息」，看起来像 Agent 没有回复。
      const savedAt = Date.now()
      this.deps.saveMessage?.({
        conversationId: convId,
        role: 'user',
        text: job.task_text,
        agentId,
        timestamp: new Date(startedAt).toISOString(),
      })
      // NO_REPLY 是「本轮无话可说」的哨兵，不是产出 —— 落库只会在会话里留一个
      // 用户看不懂的 NO_REPLY 气泡（流式落库侧已按同一判据丢弃）。
      if (isNoReplySentinel(output)) {
        log.info(`[driveAgent] Agent 本轮为 NO_REPLY 哨兵，跳过产出落库 jobId=${job.id}`)
      } else if (this.hasAssistantMessageSince(convId, startedAt)) {
        log.info(`[driveAgent] 本轮回复已由流式落库写入会话，跳过重复产出落库 jobId=${job.id}`)
      } else {
        this.deps.saveMessage?.({
          conversationId: convId,
          role: 'assistant',
          text: output,
          agentId,
          // 晚于指令（startedAt）至少 1ms，保证 UI 里回复排在指令之后
          timestamp: new Date(Math.max(savedAt, startedAt + 1)).toISOString(),
        })
      }
      return output
    } finally {
      this.deps.destroy(instanceId)
    }
  }

  private async runLocalCronJob(
    job: { id: string; task_text: string; agent_id: string | null },
    options: { manual?: boolean } = {},
  ): Promise<void> {
    // 库已关闭 / 调度器已停 = 正在退出清场：计时器可能刚触发或已在飞行中。跳过而不是继续——
    // 下面每一处 localDb.db 都会抛 "Database not initialized"，把整个 tick 炸成失败
    // （2026-09-19 退出时 autonomous-tick 实测）。
    if (this.isShuttingDown()) {
      log.warn(`[runLocalCronJob] 数据库已关闭或调度已停止（退出中），跳过 jobId=${job.id}`)
      return
    }
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
    this.recordJobStatus(job.id, 'running', startedAt)

    try {
      // Companion 魔法指令拦截：优先走本地 companion handler，不创建 Agent 实例
      const companionHandler = this.deps.handleCompanionInstruction
      if (companionHandler && !job.agent_id) {
        const companionResult = await companionHandler(job.task_text, {
          manual: options.manual === true,
        })
        // 检查点：处理期间可能已进入退出清场（心跳要跑几十秒），就此安静收手
        if (this.isShuttingDown()) {
          log.warn(`[runLocalCronJob] 停机中，放弃收尾 jobId=${job.id}`)
          return
        }
        if (companionResult !== null) {
          log.info(`[runLocalCronJob] companion 指令处理完成 jobId=${job.id} result="${companionResult}"`)
          const finishedAt = Date.now()
          this.recordJobStatus(job.id, 'ok', finishedAt)
          this.recordCronRun({
            id: runId,
            jobId: job.id,
            status: 'ok',
            startedAt,
            finishedAt,
            summary: companionResult,
            error: null,
          })
          return
        }
      }

      // 记录执行前的 feed 写版本：资讯类任务的结果落在 feed 里（dashboard_feed_write），
      // 文本回复不是结果。执行后若版本变化，说明本次运行写了 feed，改用 feed 内容作推送正文，
      // 而不是把任务指令原文当结果推出去。
      const feedVersionBefore = getDashboardFeedWriteVersion()
      let output = job.task_text
      if (job.agent_id) {
        output = await this.driveAgent(job, currentRow, job.agent_id, startedAt)
      } else {
        // 未绑定 Agent 且不是 companion 指令：task_text 是写给 Agent 的指令，
        // 不驱动 Agent 就只会把指令原文当通知正文推出去，任务实际从未执行。
        // 默认 Agent 不可用时退回原有的纯通知模式，不让任务整体失败。
        try {
          output = await this.driveAgent(job, currentRow, DEFAULT_AGENT_ID, startedAt)
        } catch (err) {
          log.warn(`[runLocalCronJob] 回落默认 Agent 失败，退回通知模式 jobId=${job.id}:`, err)
        }
      }
      // 检查点：driveAgent 可能跑几十秒，其间进程可能已进入退出清场——
      // 此时不再派发通知（推到一半没有意义）、不再记账（库已关，写了必抛）
      if (this.isShuttingDown()) {
        log.warn(`[runLocalCronJob] 停机中，跳过通知与记账 jobId=${job.id}`)
        return
      }
      let notifyTargets = currentRow.notify_targets
      if (getDashboardFeedWriteVersion() > feedVersionBefore) {
        const snapshot = await readDashboardFeedSnapshot()
        if (snapshot && snapshot.items.length > 0) {
          output = formatDashboardFeedForPush(snapshot)
          // 资讯卡片已由 dashboard_feed_write 直接写入，news 渠道再 prepend 会重复塞一张
          // 「定时任务」来源的脏卡片到顶部。此处把 news 过滤掉，只保留真正的推送渠道。
          const remaining = notifyTargets
            ?.split(',')
            .map((t) => t.trim())
            .filter((t) => t && t !== 'news')
          notifyTargets = remaining?.length ? remaining.join(',') : 'silent'
          log.info(`[runLocalCronJob] 本次运行写入 feed，改用 feed 内容作推送正文 jobId=${job.id} items=${snapshot.items.length} targets=${notifyTargets}`)
        }
      }
      await this.dispatchNotifications(
        { id: job.id, name: currentRow.name, task_text: job.task_text, agent_id: job.agent_id },
        notifyTargets,
        output,
      )

      const finishedAt = Date.now()
      await this.deps.persistCronOutputToWiki?.(job.id, currentRow.name, output, finishedAt)

      // 更新任务状态为 ok + last_run_at
      this.recordJobStatus(job.id, 'ok', finishedAt)
      this.recordCronRun({
        id: runId,
        jobId: job.id,
        status: 'ok',
        startedAt,
        finishedAt,
        summary: output.slice(0, 2000),
        error: null,
      })
      log.info(`[runLocalCronJob] 执行完成 jobId=${job.id} durationMs=${finishedAt - startedAt}`)
    } catch (err) {
      log.error(`[runLocalCronJob] 执行失败 jobId=${job.id}:`, err)
      const finishedAt = Date.now()
      const message = err instanceof Error ? err.message : String(err)
      // 更新任务状态为 error（走守卫助手：退出竞态下记账写库不再抛，catch 绝不外抛）
      this.recordJobStatus(job.id, 'error', finishedAt)
      this.recordCronRun({
        id: runId,
        jobId: job.id,
        status: 'error',
        startedAt,
        finishedAt,
        summary: null,
        error: message,
      })

      // 失败必须外推：成功路径按 notify_targets 派发，失败此前零通知，
      // 命中的任务会静默消失（状态只在定时任务页里可见），用户无从知晓。
      // 退出清场中的「失败」多是关库竞态产物（Database not initialized），不推。
      if (!this.isShuttingDown()) {
        const failLabel = currentRow.name?.trim() || job.task_text.slice(0, 20)
        const failBody = `执行失败：${message}`.slice(0, 120)
        try {
          this.deps.showCronNotification?.(`灵栖 · ${failLabel}`, failBody, `cron:${job.id}`)
        } catch (notifyErr) {
          log.warn(`[runLocalCronJob] 失败通知发送异常 jobId=${job.id}:`, notifyErr)
        }
      }
    } finally {
      this.localCronRunningJobs.delete(job.id)
    }
  }
}
