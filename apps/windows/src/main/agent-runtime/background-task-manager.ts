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

import type { AgentRuntimeEvent, BackgroundTaskStatus } from '../../shared/agent-runtime-events'
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
  /** 失败原因 */
  readonly error?: string
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
  private seq = 0

  constructor(private readonly deps: BackgroundTaskManagerDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.maxRetained = normalizeRetained(deps.maxRetained)
    this.summaryMaxLength = deps.summaryMaxLength ?? 200
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

  /** 标记成功，可选带产出摘要 */
  complete(taskId: string, summary?: string): void {
    const rec = this.tasks.get(taskId)
    if (!rec || TERMINAL.has(rec.status)) return
    const next: BackgroundTaskRecord = {
      ...rec,
      status: 'succeeded',
      endedAt: this.now(),
      ...(summary ? { summary: this.truncate(summary) } : {}),
    }
    this.settle(next)
  }

  /** 标记失败 */
  fail(taskId: string, error: string): void {
    const rec = this.tasks.get(taskId)
    if (!rec || TERMINAL.has(rec.status)) return
    this.settle({ ...rec, status: 'failed', endedAt: this.now(), error: this.truncate(error) })
  }

  /** 标记取消 */
  cancel(taskId: string): void {
    const rec = this.tasks.get(taskId)
    if (!rec || TERMINAL.has(rec.status)) return
    this.settle({ ...rec, status: 'cancelled', endedAt: this.now() })
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

  private truncate(text: string): string {
    return text.length > this.summaryMaxLength ? `${text.slice(0, this.summaryMaxLength)}…` : text
  }

  private generateId(toolName: string): string {
    const stem = toolName.replace(/[^A-Za-z0-9_-]+/g, '-').slice(-32) || 'task'
    return `${stem}-${this.now().toString(36)}-${(this.seq++).toString(36)}`
  }
}
