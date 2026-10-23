/**
 * BackgroundTaskManager — 长耗时工具后台化后的任务登记与生命周期
 *
 * 长耗时工具（如远程 ComfyUI 视频生成）不再是「阻塞整轮回合直到超时」，
 * 而是立即返回、在后台继续执行。本管理器负责：
 *   1. 登记任务（start）与终结（complete / fail / cancel）；
 *   2. 每次状态变化推一条 `agent:background-task` 事件（UI 据此显示任务卡）；
 *   3. 终态时调用注入的 `deliver`，把结果投递回归属 Agent 实例（唤醒续跑）。
 *
 * 纯状态机 + 依赖注入，不直接持有 AgentRegistry / IPC，便于单测。
 * 任务为内存态：应用重启即丢（长任务本身也随子进程结束而终止）。
 */

import type {
  AgentRuntimeEvent,
  BackgroundTaskOutput,
  BackgroundTaskStatus,
  Milestone,
  MilestoneStatus,
  TaskLog,
  TaskLogLevel,
} from '../../shared/agent-runtime-events'
import { agentRuntimeLog as log } from './bridge-utils'

/** 后台任务记录（对外只读快照） */
export interface BackgroundTaskRecord {
  readonly taskId: string
  readonly instanceId?: string
  readonly sessionKey?: string
  readonly toolName: string
  readonly label: string
  readonly status: BackgroundTaskStatus
  readonly startedAt: number
  readonly endedAt?: number
  /** 终态摘要（成功产出的截断预览） */
  readonly summary?: string
  /** 完整结果文本（按 resultMaxLength 截断）：任务卡展开展示，也是唤醒 Agent 时的结果正文 */
  readonly result?: string
  /** 产出文件清单 */
  readonly outputs?: readonly BackgroundTaskOutput[]
  /** 运行中进度说明 */
  readonly note?: string
  /** 失败原因 */
  readonly error?: string
  /** 0–100。缺省表示尚未上报百分比 */
  readonly progress?: number
  /** 当前步骤描述 */
  readonly currentStep?: string
  /** 内存日志，最多保留最后 1000 条 */
  readonly logs?: readonly TaskLog[]
  /** 任务里程碑 */
  readonly milestones?: readonly Milestone[]
}

/** 单任务内存日志上限。超出后丢弃最早的一条 */
const MAX_TASK_LOGS = 1000

/** complete 的附加产出 */
export interface BackgroundTaskCompleteExtras {
  readonly outputs?: readonly BackgroundTaskOutput[]
}

export interface BackgroundTaskStartInput {
  /** 不传则自动生成 */
  readonly taskId?: string
  readonly instanceId?: string
  readonly sessionKey?: string
  readonly toolName: string
  readonly label: string
}

export interface BackgroundTaskManagerDeps {
  /** 事件推送（主进程 → 渲染进程） */
  readonly emit: (event: AgentRuntimeEvent) => void
  /** 终态时唤醒归属实例：running→followUp / idle→prompt(internal)，由宿主注入 */
  readonly deliver: (task: BackgroundTaskRecord) => Promise<void> | void
  /** 时钟（便于测试） */
  readonly now?: () => number
  /** 保留的已完成任务上限，超出后逐出最旧的终态任务（防内存泄漏） */
  readonly maxRetained?: number
  /** 摘要预览截断长度 */
  readonly summaryMaxLength?: number
  /** 完整结果 / 失败原因的截断长度（防止超长工具输出撑爆事件与唤醒消息） */
  readonly resultMaxLength?: number
}

const TERMINAL: ReadonlySet<BackgroundTaskStatus> = new Set(['succeeded', 'failed', 'cancelled'])

/** 归一化耗时：正有限数取整，否则 undefined */
function normalizeRetained(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 100
}

export class BackgroundTaskManager {
  private readonly tasks = new Map<string, BackgroundTaskRecord>()
  private readonly now: () => number
  private readonly maxRetained: number
  private readonly summaryMaxLength: number
  private readonly resultMaxLength: number
  private seq = 0

  constructor(private readonly deps: BackgroundTaskManagerDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.maxRetained = normalizeRetained(deps.maxRetained)
    this.summaryMaxLength = deps.summaryMaxLength ?? 200
    this.resultMaxLength = deps.resultMaxLength ?? 8000
  }

  /** 登记一个后台任务并推 started（running）事件，返回 taskId */
  start(input: BackgroundTaskStartInput): string {
    const taskId = input.taskId ?? this.generateId(input.toolName)
    const record: BackgroundTaskRecord = {
      taskId,
      ...(input.instanceId ? { instanceId: input.instanceId } : {}),
      ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
      toolName: input.toolName,
      label: input.label,
      status: 'running',
      startedAt: this.now(),
    }
    this.tasks.set(taskId, record)
    log.info(
      `[BackgroundTask] 开始 task=${taskId} tool=${input.toolName} session=${input.sessionKey ?? '-'}`,
    )
    this.push(record)
    return taskId
  }

  /**
   * 运行中更新进度说明（如「ComfyUI 渲染中」）并推事件；终态或说明未变时忽略。
   */
  update(taskId: string, note: string): void {
    const rec = this.tasks.get(taskId)
    if (!rec || TERMINAL.has(rec.status) || rec.note === note) return
    const next: BackgroundTaskRecord = { ...rec, note }
    this.tasks.set(taskId, next)
    this.push(next)
  }

  /** 标记成功：summary 为截断预览，result 保留完整结果（有上限），可附产出文件 */
  complete(taskId: string, summary?: string, extras?: BackgroundTaskCompleteExtras): void {
    const rec = this.tasks.get(taskId)
    if (!rec || TERMINAL.has(rec.status)) return
    const { note: _note, ...rest } = rec
    const next: BackgroundTaskRecord = {
      ...rest,
      status: 'succeeded',
      endedAt: this.now(),
      ...(summary ? { summary: this.truncate(summary, this.summaryMaxLength) } : {}),
      ...(summary ? { result: this.truncate(summary, this.resultMaxLength) } : {}),
      ...(extras?.outputs && extras.outputs.length > 0 ? { outputs: [...extras.outputs] } : {}),
    }
    this.settle(next)
  }

  /** 标记失败 */
  fail(taskId: string, error: string): void {
    const rec = this.tasks.get(taskId)
    if (!rec || TERMINAL.has(rec.status)) return
    const { note: _note, ...rest } = rec
    this.settle({
      ...rest,
      status: 'failed',
      endedAt: this.now(),
      error: this.truncate(error, this.resultMaxLength),
    })
  }

  /** 标记取消 */
  cancel(taskId: string): void {
    const rec = this.tasks.get(taskId)
    if (!rec || TERMINAL.has(rec.status)) return
    const { note: _note, ...rest } = rec
    this.settle({ ...rest, status: 'cancelled', endedAt: this.now() })
  }

  /**
   * 更新进度百分比（钳制到 0–100）和当前步骤。
   * 未知任务、终态、或数值非有限时忽略；值未变不重复推事件。
   */
  updateProgress(taskId: string, progress: number, currentStep?: string): void {
    if (!Number.isFinite(progress)) return
    const clamped = Math.min(100, Math.max(0, progress))
    this.patchRunning(taskId, (rec) => {
      const step = currentStep !== undefined ? currentStep : rec.currentStep
      if (rec.progress === clamped && rec.currentStep === step) return null
      return {
        ...rec,
        progress: clamped,
        ...(step !== undefined ? { currentStep: step } : {}),
      }
    })
  }

  /**
   * 追加一条日志。超过 1000 条时丢掉最早的一条。
   * 未知任务或终态时忽略。
   */
  addLog(
    taskId: string,
    level: TaskLogLevel,
    message: string,
    context?: Record<string, unknown>,
  ): void {
    this.patchRunning(taskId, (rec) => {
      const entry: TaskLog = {
        level,
        message,
        timestamp: this.now(),
        ...(context !== undefined ? { context } : {}),
      }
      const logs = [...(rec.logs ?? []), entry]
      if (logs.length > MAX_TASK_LOGS) logs.splice(0, logs.length - MAX_TASK_LOGS)
      return { ...rec, logs }
    })
  }

  /** 替换里程碑列表。未知任务或终态时忽略 */
  setMilestones(taskId: string, milestones: readonly Milestone[]): void {
    this.patchRunning(taskId, (rec) => ({
      ...rec,
      milestones: milestones.map((milestone) => ({ ...milestone })),
    }))
  }

  /**
   * 按步骤名更新单个里程碑。
   * 进入 in-progress 时补 startTime；首次结束且未给耗时则用 startTime 推算。
   * 已有耗时不会被重算，避免重复上报改写历史。
   */
  updateMilestone(
    taskId: string,
    step: string,
    status: MilestoneStatus,
    duration?: number,
    error?: string,
  ): void {
    this.patchRunning(taskId, (rec) => {
      if (!rec.milestones || rec.milestones.length === 0) return null
      let changed = false
      const milestones = rec.milestones.map((milestone) => {
        if (milestone.step !== step) return milestone
        const startTime = milestone.startTime ?? (status === 'in-progress' ? this.now() : undefined)
        const resolvedDuration = duration !== undefined
          ? duration
          : milestone.duration !== undefined
            ? milestone.duration
            : startTime !== undefined && (status === 'completed' || status === 'failed')
              ? Math.max(0, this.now() - startTime)
              : undefined
        const resolvedError = error !== undefined ? error : milestone.error
        if (
          milestone.status === status
          && milestone.startTime === startTime
          && milestone.duration === resolvedDuration
          && milestone.error === resolvedError
        ) {
          return milestone
        }
        changed = true
        return {
          ...milestone,
          status,
          ...(startTime !== undefined ? { startTime } : {}),
          ...(resolvedDuration !== undefined ? { duration: resolvedDuration } : {}),
          ...(resolvedError !== undefined ? { error: resolvedError } : {}),
        }
      })
      if (!changed) return null
      return { ...rec, milestones }
    })
  }

  get(taskId: string): BackgroundTaskRecord | undefined {
    return this.tasks.get(taskId)
  }

  list(): readonly BackgroundTaskRecord[] {
    return [...this.tasks.values()]
  }

  /** 按会话过滤（供 UI 恢复视图） */
  listBySession(sessionKey: string): readonly BackgroundTaskRecord[] {
    return [...this.tasks.values()].filter((t) => t.sessionKey === sessionKey)
  }

  /** 运行中任务的局部更新。mutate 返回 null 表示无变化，不推事件 */
  private patchRunning(
    taskId: string,
    mutate: (record: BackgroundTaskRecord) => BackgroundTaskRecord | null,
  ): void {
    const rec = this.tasks.get(taskId)
    if (!rec || TERMINAL.has(rec.status)) return
    const next = mutate(rec)
    if (!next) return
    this.tasks.set(taskId, next)
    this.push(next)
  }

  private settle(record: BackgroundTaskRecord): void {
    this.tasks.set(record.taskId, record)
    log.info(
      `[BackgroundTask] 结束 task=${record.taskId} status=${record.status} session=${record.sessionKey ?? '-'}`,
    )
    this.push(record)
    this.prune()
    // 唤醒归属 Agent：终态才投递；失败不影响任务本身
    try {
      void Promise.resolve(this.deps.deliver(record)).catch((err) => {
        log.error(
          `[BackgroundTask] 投递失败 task=${record.taskId}: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    } catch (err) {
      log.error(
        `[BackgroundTask] 投递抛出 task=${record.taskId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private push(record: BackgroundTaskRecord): void {
    this.deps.emit({ type: 'agent:background-task', ...record })
  }

  /** 超过保留上限时，从最旧的终态任务开始逐出 */
  private prune(): void {
    if (this.tasks.size <= this.maxRetained) return
    const terminalOldestFirst = [...this.tasks.values()]
      .filter((t) => TERMINAL.has(t.status))
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))
    let overflow = this.tasks.size - this.maxRetained
    for (const t of terminalOldestFirst) {
      if (overflow <= 0) break
      this.tasks.delete(t.taskId)
      overflow--
    }
  }

  private truncate(text: string, maxLength: number): string {
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
  }

  private generateId(toolName: string): string {
    const stem = toolName.replace(/[^A-Za-z0-9_-]+/g, '-').slice(-32) || 'task'
    return `${stem}-${this.now().toString(36)}-${(this.seq++).toString(36)}`
  }
}
