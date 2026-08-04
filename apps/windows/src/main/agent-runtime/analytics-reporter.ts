/**
 * Windows 客户端 Agent Analytics 上报器
 *
 * 收集工具调用、上下文压缩等分析事件，批量 POST 到 API Server 的
 * /api/internal/agent-analytics/ingest 端点。
 *
 * 设计：
 * - emit 不阻塞调用方（内存缓冲）
 * - 每 5s 或满 200 条触发批量上报
 * - 没有配置 apiUrl/gatewaySecret 时静默丢弃，不影响主流程
 */

import { randomUUID } from 'node:crypto'
import { agentRuntimeLog as log } from './bridge-utils'

/**
 * 上报节流：30s 定时刷盘（原 5s）。配合服务端 event_id 幂等去重，
 * 拉长上报间隔可显著降低请求数与写库压力，分析数据有秒级延迟可接受。
 */
const FLUSH_INTERVAL_MS = 30_000
/** 单批最大事件数：满批立即刷盘（兼顾突发场景下的及时性） */
const MAX_BUFFER_SIZE = 500
/**
 * 缓冲区硬上限：持续上报失败时，超出则丢弃最旧事件，防止内存无限堆积（OOM）。
 * 分析数据可丢，主进程不能崩。
 */
const MAX_BUFFER_RETAIN = 5000
/** HTTP 超时（原 10s）。写库偶发变慢时不轻易判定失败，避免无谓重发。 */
const REQUEST_TIMEOUT_MS = 30_000
const MAX_FIELD_LENGTH = 2000

export interface ToolCallStartPayload {
  runId: string
  agentId?: string
  sessionKey?: string
  toolName: string
  toolParams?: unknown
}

export interface ToolCallEndPayload {
  runId: string
  agentId?: string
  sessionKey?: string
  toolName: string
  toolResult?: unknown
  errorMessage?: string
  durationMs?: number
  success?: boolean
}

export interface ContextCompactionPayload {
  runId: string
  agentId?: string
  sessionKey?: string
  beforeTokens?: number
  afterTokens?: number
  success?: boolean
  errorMessage?: string
  roundNumber?: number
  modelName?: string
  strategy?: string
}

export interface SubagentSpawnPayload {
  runId: string
  agentId?: string
  sessionKey?: string
  parentAgentId?: string
  childAgentId?: string
  childRunId?: string
  task?: string
  modelTier?: string
}

export interface SubagentCompletePayload {
  runId: string
  agentId?: string
  sessionKey?: string
  childRunId?: string
  status: 'success' | 'error' | 'timeout'
  errorMessage?: string
  durationMs?: number
}

export interface MemoryGetPayload {
  runId: string
  agentId?: string
  sessionKey?: string
  hit: boolean
  contentLength?: number
}

export interface MemoryUpdatePayload {
  runId: string
  agentId?: string
  sessionKey?: string
  contentLength?: number
}

type AnalyticsEventType =
  | 'tool_call'
  | 'context_compaction'
  | 'subagent_spawn'
  | 'subagent_complete'
  | 'memory_get'
  | 'memory_update'

interface BaseEvent {
  eventType: AnalyticsEventType
  /** 事件全局唯一 ID：产生时生成，重试上报保持不变，供服务端幂等去重 */
  eventId: string
  timestamp: number
  runId: string
  agentId?: string
  userId?: string
  sessionKey?: string
}

interface ToolCallEvent extends BaseEvent {
  eventType: 'tool_call'
  phase: 'start' | 'end'
  toolName: string
  toolParams?: string | null
  toolResult?: string | null
  errorMessage?: string | null
  durationMs?: number | null
  success?: boolean | null
}

interface ContextCompactionEvent extends BaseEvent {
  eventType: 'context_compaction'
  phase: 'end'
  beforeTokens?: number | null
  afterTokens?: number | null
  success?: boolean | null
  errorMessage?: string | null
  roundNumber?: number | null
  modelName?: string | null
  strategy?: string | null
}

interface SubagentSpawnEvent extends BaseEvent {
  eventType: 'subagent_spawn'
  parentAgentId?: string | null
  childAgentId?: string | null
  childRunId?: string | null
  task?: string | null
  modelTier?: string | null
}

interface SubagentCompleteEvent extends BaseEvent {
  eventType: 'subagent_complete'
  childRunId?: string | null
  status: 'success' | 'error' | 'timeout'
  errorMessage?: string | null
  durationMs?: number | null
}

interface MemoryGetEvent extends BaseEvent {
  eventType: 'memory_get'
  hit: boolean
  contentLength?: number | null
}

interface MemoryUpdateEvent extends BaseEvent {
  eventType: 'memory_update'
  contentLength?: number | null
}

type AnalyticsEvent = ToolCallEvent | ContextCompactionEvent | SubagentSpawnEvent | SubagentCompleteEvent | MemoryGetEvent | MemoryUpdateEvent

/** 分布式条件类型：在保留各联合成员特有字段的前提下，移除 eventId（由 push 统一注入） */
type WithoutEventId<T> = T extends unknown ? Omit<T, 'eventId'> : never
type DraftEvent = WithoutEventId<AnalyticsEvent>

class AnalyticsReporter {
  private buffer: AnalyticsEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private apiUrl = 'http://127.0.0.1:3000'
  private gatewaySecret: string | null = null
  private missingSecretWarned = false
  /** 鉴权失败后停止上报，避免 401 时无限重试刷屏 */
  private authFailed = false
  private authFailedWarned = false

  configure(apiUrl: string, gatewaySecret: string | null): void {
    this.apiUrl = apiUrl
    this.gatewaySecret = gatewaySecret
    this.missingSecretWarned = false
    this.authFailed = false
    this.authFailedWarned = false
    log.info(`[analyticsReporter] 已配置 apiUrl=${apiUrl}, hasSecret=${!!gatewaySecret}`)
    if (!gatewaySecret) {
      log.warn('[analyticsReporter] 未配置 gatewaySecret，事件将不会上报')
    }
  }

  reportToolCallStart(payload: ToolCallStartPayload): void {
    this.push({
      eventType: 'tool_call',
      phase: 'start',
      timestamp: Date.now(),
      runId: payload.runId,
      agentId: payload.agentId,
      sessionKey: payload.sessionKey,
      toolName: payload.toolName,
      toolParams: payload.toolParams
        ? JSON.stringify(payload.toolParams).slice(0, MAX_FIELD_LENGTH)
        : null,
    })
  }

  reportToolCallEnd(payload: ToolCallEndPayload): void {
    this.push({
      eventType: 'tool_call',
      phase: 'end',
      timestamp: Date.now(),
      runId: payload.runId,
      agentId: payload.agentId,
      sessionKey: payload.sessionKey,
      toolName: payload.toolName,
      toolResult: payload.toolResult
        ? JSON.stringify(payload.toolResult).slice(0, MAX_FIELD_LENGTH)
        : null,
      errorMessage: payload.errorMessage?.slice(0, MAX_FIELD_LENGTH) ?? null,
      durationMs: payload.durationMs ?? null,
      success: payload.success ?? null,
    })
  }

  reportContextCompaction(payload: ContextCompactionPayload): void {
    this.push({
      eventType: 'context_compaction',
      phase: 'end',
      timestamp: Date.now(),
      runId: payload.runId,
      agentId: payload.agentId,
      sessionKey: payload.sessionKey,
      beforeTokens: payload.beforeTokens ?? null,
      afterTokens: payload.afterTokens ?? null,
      success: payload.success ?? null,
      errorMessage: payload.errorMessage?.slice(0, MAX_FIELD_LENGTH) ?? null,
      roundNumber: payload.roundNumber ?? null,
      modelName: payload.modelName?.slice(0, 128) ?? null,
      strategy: payload.strategy?.slice(0, 16) ?? null,
    })
  }

  reportSubagentSpawn(payload: SubagentSpawnPayload): void {
    this.push({
      eventType: 'subagent_spawn',
      timestamp: Date.now(),
      runId: payload.runId,
      agentId: payload.agentId,
      sessionKey: payload.sessionKey,
      parentAgentId: payload.parentAgentId ?? null,
      childAgentId: payload.childAgentId ?? null,
      childRunId: payload.childRunId ?? null,
      task: payload.task?.slice(0, 500) ?? null,
      modelTier: payload.modelTier ?? null,
    })
  }

  reportSubagentComplete(payload: SubagentCompletePayload): void {
    this.push({
      eventType: 'subagent_complete',
      timestamp: Date.now(),
      runId: payload.runId,
      agentId: payload.agentId,
      sessionKey: payload.sessionKey,
      childRunId: payload.childRunId ?? null,
      status: payload.status,
      errorMessage: payload.errorMessage?.slice(0, MAX_FIELD_LENGTH) ?? null,
      durationMs: payload.durationMs ?? null,
    })
  }

  reportMemoryGet(payload: MemoryGetPayload): void {
    this.push({
      eventType: 'memory_get',
      timestamp: Date.now(),
      runId: payload.runId,
      agentId: payload.agentId,
      sessionKey: payload.sessionKey,
      hit: payload.hit,
      contentLength: payload.contentLength ?? null,
    })
  }

  reportMemoryUpdate(payload: MemoryUpdatePayload): void {
    this.push({
      eventType: 'memory_update',
      timestamp: Date.now(),
      runId: payload.runId,
      agentId: payload.agentId,
      sessionKey: payload.sessionKey,
      contentLength: payload.contentLength ?? null,
    })
  }

  private push(event: DraftEvent): void {
    if (!this.gatewaySecret || this.authFailed) {
      if (!this.gatewaySecret && !this.missingSecretWarned) {
        this.missingSecretWarned = true
        log.warn('[analyticsReporter] 跳过事件上报：gatewaySecret 为空')
      }
      return
    }

    // 统一注入 eventId：服务端按此键幂等去重，重试上报同一对象时 eventId 不变
    this.buffer.push({ ...event, eventId: randomUUID() } as AnalyticsEvent)

    // 缓冲区硬上限保护：持续上报失败时丢弃最旧事件，防止内存无限堆积导致主进程 OOM
    if (this.buffer.length > MAX_BUFFER_RETAIN) {
      const dropped = this.buffer.length - MAX_BUFFER_RETAIN
      this.buffer.splice(0, dropped)
      log.warn(`[analyticsReporter] 缓冲区超过 ${MAX_BUFFER_RETAIN}，丢弃最旧 ${dropped} 条事件以防 OOM`)
    }

    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      this.scheduleFlush(0)
    } else if (!this.timer) {
      this.scheduleFlush(FLUSH_INTERVAL_MS)
    }
  }

  private scheduleFlush(delay: number): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(() => {
      this.flush().catch((err: Error) => {
        log.warn(`[analyticsReporter] flush 异常: ${err.message}`)
      })
    }, delay)
  }

  /**
   * 失败批次回退到缓冲区头部等待重试，并施加硬上限保护。
   * 因事件已带 eventId（服务端幂等），重发不会造成重复数据；硬上限仅防内存堆积。
   */
  private requeue(batch: AnalyticsEvent[]): void {
    this.buffer.unshift(...batch)
    if (this.buffer.length > MAX_BUFFER_RETAIN) {
      const dropped = this.buffer.length - MAX_BUFFER_RETAIN
      this.buffer.splice(MAX_BUFFER_RETAIN)
      log.warn(`[analyticsReporter] 缓冲区超过 ${MAX_BUFFER_RETAIN}，丢弃最旧 ${dropped} 条事件以防 OOM`)
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.gatewaySecret || this.authFailed) return

    this.timer = null
    const batch = this.buffer.splice(0, MAX_BUFFER_SIZE)

    try {
      const resp = await fetch(`${this.apiUrl}/api/internal/agent-analytics/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Secret': this.gatewaySecret,
        },
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })

      // 2xx 均视为成功（服务端改为 202 立即返回 + 后台幂等写库）
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        if (resp.status === 401) {
          this.authFailed = true
          if (!this.authFailedWarned) {
            this.authFailedWarned = true
            log.warn(
              `[analyticsReporter] 鉴权失败(401)，已停止上报。apiUrl=${this.apiUrl}，` +
                '请确认 Windows 与 API Server 的 API_SERVER_GATEWAY_SECRET 一致；' +
                '若密钥含 # 字符，.env 中须用双引号包裹（否则 dotenv 会截断）',
            )
          }
          return
        }
        log.warn(`[analyticsReporter] 上报失败 status=${resp.status} body=${text.slice(0, 200)}`)
        this.requeue(batch)
      } else {
        log.info(`[analyticsReporter] 成功上报 ${batch.length} 条事件`)
      }
    } catch (err) {
      const e = err as Error
      // 网络异常/超时：事件带 eventId，服务端幂等，可安全重发；但受缓冲区硬上限约束
      log.warn(`[analyticsReporter] 请求异常，回退 ${batch.length} 条: ${e.message}`)
      this.requeue(batch)
    } finally {
      if (this.buffer.length > 0 && !this.timer) {
        this.scheduleFlush(FLUSH_INTERVAL_MS)
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.flush()
    log.info('[analyticsReporter] 已关闭，剩余缓冲 = ' + this.buffer.length)
  }
}

export const analyticsReporter = new AnalyticsReporter()
