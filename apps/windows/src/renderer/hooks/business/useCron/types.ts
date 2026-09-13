/**
 * Cron 定时任务类型定义
 */

/** 调度类型 */
export type CronScheduleType = 'cron' | 'every' | 'at'

/** 任务状态 */
export type CronJobStatus = 'ok' | 'error' | 'idle' | 'running'

/** 运行状态 */
export type CronRunStatus = 'ok' | 'error' | 'running'

/** 来源：系统播种 / Agent 自建（agent-self:*、local-cron-*）/ 用户创建 */
export type CronJobSource = 'system' | 'agent' | 'user'

/** 启停被哪个开关接管；null 表示用户自管 */
export type CronJobManagedBy = 'autonomous' | 'companion'

/** 定时任务 */
export interface CronJob {
  id: string
  userId: string
  agentId: string
  name: string
  description?: string | null
  enabled: boolean
  scheduleType: CronScheduleType
  scheduleExpr: string
  scheduleTz?: string | null
  taskText: string
  status: CronJobStatus
  lastRunAt?: string | null
  nextRunAt?: string | null
  lastError?: string | null
  consecutiveErrors: number
  lastDurationMs?: number | null
  createdAt: string
  updatedAt: string
  /** 生效星期 "0,1,..,6"（0=周日）；空表示每天 */
  activeDays?: string | null
  /** 生效时段 [start, end) 的起止小时；空表示全天 */
  activeHourStart?: number | null
  activeHourEnd?: number | null
  /** 逗号分隔的推送目标：system/news/focus/feishu */
  notifyTargets?: string | null
  source: CronJobSource
  managedBy?: CronJobManagedBy | null
  /** 删除后下次启动会重建（系统种子）；UI 隐藏删除入口 */
  reseeded?: boolean
}

/** 运行记录 */
export interface CronRun {
  id: string
  jobId: string
  userId: string
  status: CronRunStatus
  startedAt: string
  finishedAt?: string | null
  durationMs?: number | null
  summary?: string | null
  error?: string | null
  agentId?: string | null
  model?: string | null
  provider?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
}

/** 创建任务参数 */
export interface CreateCronJobParams {
  agentId: string
  name: string
  description?: string
  scheduleType: CronScheduleType
  scheduleExpr: string
  scheduleTz?: string
  taskText: string
  activeDays?: string
  activeHourStart?: number | null
  activeHourEnd?: number | null
  notifyTargets?: string
}

/** 运行统计 */
export interface CronRunStats {
  totalRuns: number
  okRuns: number
  errorRuns: number
  totalTokens: number
  totalDurationMs: number
}

