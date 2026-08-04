/**
 * Cron 定时任务类型定义
 */

/** 调度类型 */
export type CronScheduleType = 'cron' | 'every' | 'at'

/** 任务状态 */
export type CronJobStatus = 'ok' | 'error' | 'idle' | 'running'

/** 运行状态 */
export type CronRunStatus = 'ok' | 'error' | 'running'

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

/** Pipeline */
export interface Pipeline {
  id: string
  userId: string
  name: string
  description?: string | null
  enabled: boolean
  edges: PipelineEdge[]
  createdAt: string
  updatedAt: string
}

/** Pipeline 边 */
export interface PipelineEdge {
  id: string
  pipelineId: string
  fromJobId: string
  toJobId: string
  artifact?: string | null
  sortOrder: number
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
}

/** 运行统计 */
export interface CronRunStats {
  totalRuns: number
  okRuns: number
  errorRuns: number
  totalTokens: number
  totalDurationMs: number
}

/** Cron 视图 Tab */
export type CronViewTab = 'overview' | 'schedule' | 'pipelines' | 'history'
