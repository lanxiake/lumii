/**
 * ACP 运行控制器（Windows 客户端主进程）
 *
 * 封装一次 ACP run 的完整生命周期：
 * - 流式进度转发到渲染进程（message/tool/thinking）
 * - 60 分钟可配置超时
 * - 用户中止 / 超时 abort
 * - 完成后持久化 assistant 消息到 DB
 *
 * 设计依据：.qoder/design/coding-dev-acp/2026-07-08-windows-acp-timeout-streaming-optimization.md
 */

import type { AgentRuntimeBridge } from './agent-runtime/bridge'
import type { AgentRuntimeEvent } from '../../shared/agent-runtime-events'
import { runCodingDevAcpPrompt } from './coding-dev-backends-stub/run-coding-dev-acp-prompt.js'
import { resolveAcpTimeoutMs } from './coding-dev-backends-stub/acp-config.js'
import type {
  CodingDevLightweightBackendProgress,
  CodingDevToolProgress,
} from './coding-dev-backends-stub/contracts.js'

const log = {
  info: (...args: unknown[]) => console.log('[AcpRunController]', ...args),
  warn: (...args: unknown[]) => console.warn('[AcpRunController]', ...args),
  error: (...args: unknown[]) => console.error('[AcpRunController]', ...args),
}

export type AcpRunHandle = {
  runId: string
  sessionKey: string
  backendId: string
  instanceId: string
  abortController: AbortController
  timeoutHandle?: ReturnType<typeof setTimeout>
  messageId: string
  startedAt: number
  totalLength: number
  thinkingEmitted: boolean
  toolStartTextPositions: Map<string, number>
  settled: boolean
  abortReason?: 'user_cancel' | 'timeout'
}

export type AcpRunStartOptions = {
  runId: string
  sessionKey: string
  backendId: string
  text: string
  instanceId: string
  bridge: AgentRuntimeBridge
  pushEvent: (event: AgentRuntimeEvent) => void
  accountId?: string
  senderId?: string
}

const DEFAULT_DELTA_FLUSH_MS = 16

export class AcpRunController {
  private readonly runs = new Map<string, AcpRunHandle>()
  private pendingMessageDelta = new Map<string, { messageId: string; text: string }>()
  private deltaFlushTimer: ReturnType<typeof setTimeout> | undefined

  async startRun(opts: AcpRunStartOptions): Promise<void> {
    const { runId, sessionKey, backendId, text, instanceId, bridge, pushEvent } = opts
    const accountId = opts.accountId ?? 'local-user'
    const senderId = opts.senderId ?? accountId
    const messageId = `acp-msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const startedAt = Date.now()

    const abortController = new AbortController()
    const timeoutMs = resolveAcpTimeoutMs()

    const handle: AcpRunHandle = {
      runId,
      sessionKey,
      backendId,
      instanceId,
      abortController,
      messageId,
      startedAt,
      totalLength: 0,
      thinkingEmitted: false,
      toolStartTextPositions: new Map(),
      settled: false,
    }
    this.runs.set(runId, handle)

    if (timeoutMs !== undefined && timeoutMs > 0) {
      handle.timeoutHandle = setTimeout(() => {
        this.abortRun(runId, 'timeout')
      }, timeoutMs)
    }

    pushEvent({
      type: 'agent:turn:start',
      runId,
      sessionKey,
      turnIndex: 0,
      timestamp: startedAt,
    })
    // 预分配 assistant 消息气泡，确保后续 tool 卡片有消息可依附
    pushEvent({
      type: 'agent:message:start',
      runId,
      sessionKey,
      messageId,
      model: `acp:${backendId}`,
      timestamp: startedAt,
    })

    try {
      const output = await runCodingDevAcpPrompt({
        backendId,
        text,
        accountId,
        peerId: sessionKey,
        senderId,
        emitProgress: (progress) => this.handleProgress(progress, handle, pushEvent),
        abortSignal: abortController.signal,
      })

      if (handle.settled) return
      this.clearTimeout(handle)
      this.flushMessageDelta(sessionKey, pushEvent)

      const finalText = output?.text ?? this.pendingMessageDelta.get(sessionKey)?.text ?? ''
      const content = [{ type: 'text' as const, text: finalText }]

      if (finalText) {
        this.persistAssistantMessage(bridge, sessionKey, messageId, finalText)
      }

      handle.settled = true
      this.runs.delete(runId)

      pushEvent({
        type: 'agent:message:end',
        runId,
        sessionKey,
        messageId,
        content,
        usage: { inputTokens: 0, outputTokens: finalText.length },
        stopReason: 'end_turn',
      })
      pushEvent({
        type: 'agent:idle',
        runId,
        sessionKey,
        instanceId,
      })
    } catch (err) {
      if (handle.settled) return
      this.clearTimeout(handle)
      this.flushMessageDelta(sessionKey, pushEvent)
      handle.settled = true
      this.runs.delete(runId)

      const isAbort = abortController.signal.aborted
      const errorMessage = err instanceof Error ? err.message : String(err)

      if (isAbort) {
        const reason = handle.abortReason ?? 'user_cancel'
        const waitedMinutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000))
        const friendlyMessage =
          reason === 'timeout'
            ? `❌ ACP 执行超时（已等待 ${waitedMinutes} 分钟）。任务已中止。若任务较重，可设置 MTBOT_ACP_TIMEOUT_MS=0 取消限制，或拆分任务后重试。`
            : '已取消 ACP 执行。'

        pushEvent({
          type: 'agent:abort',
          runId,
          sessionKey,
          reason,
        })
        pushEvent({
          type: 'conversation:message:new',
          sessionKey,
          message: {
            id: `acp-err-${Date.now()}`,
            role: 'assistant',
            content: [{ type: 'text', text: friendlyMessage }],
            timestamp: Date.now(),
          },
        })
      } else {
        pushEvent({
          type: 'agent:error',
          runId,
          sessionKey,
          errorCode: 'ACP_FAILED',
          errorMessage: `❌ ACP 执行失败：${errorMessage}`,
          isRetryable: false,
        })
        pushEvent({
          type: 'conversation:message:new',
          sessionKey,
          message: {
            id: `acp-err-${Date.now()}`,
            role: 'assistant',
            content: [{ type: 'text', text: `❌ ACP 执行失败：${errorMessage}` }],
            timestamp: Date.now(),
          },
        })
      }

      pushEvent({
        type: 'agent:idle',
        runId,
        sessionKey,
        instanceId,
      })
    }
  }

  abortRun(runId: string, reason: 'user_cancel' | 'timeout'): boolean {
    const handle = this.runs.get(runId)
    if (!handle || handle.settled) return false
    log.info(`[abortRun] runId=${runId} reason=${reason} backendId=${handle.backendId}`)
    handle.abortReason = reason
    handle.abortController.abort()
    return true
  }

  abortSession(sessionKey: string, reason: 'user_cancel' | 'timeout'): number {
    let count = 0
    for (const [runId, handle] of this.runs) {
      if (handle.sessionKey === sessionKey && !handle.settled) {
        log.info(`[abortSession] runId=${runId} sessionKey=${sessionKey} reason=${reason}`)
        handle.abortReason = reason
        handle.abortController.abort()
        count++
      }
    }
    return count
  }

  dispose(): void {
    for (const handle of this.runs.values()) {
      if (!handle.settled) {
        handle.abortController.abort()
      }
      this.clearTimeout(handle)
    }
    this.runs.clear()
    if (this.deltaFlushTimer) {
      clearTimeout(this.deltaFlushTimer)
      this.deltaFlushTimer = undefined
    }
    this.pendingMessageDelta.clear()
  }

  private handleProgress(
    progress: CodingDevLightweightBackendProgress,
    handle: AcpRunHandle,
    pushEvent: (event: AgentRuntimeEvent) => void,
  ): Promise<void> | void {
    const { runId, sessionKey, messageId } = handle

    switch (progress.kind) {
      case 'message': {
        const delta = progress.text
        if (delta.length === 0) return

        const pending = this.pendingMessageDelta.get(sessionKey)
        if (pending) {
          pending.text += delta
        } else {
          this.pendingMessageDelta.set(sessionKey, { messageId, text: delta })
        }
        handle.totalLength += delta.length
        this.scheduleDeltaFlush(sessionKey, pushEvent)
        return
      }
      case 'status': {
        if (progress.text === 'thinking' && !handle.thinkingEmitted) {
          handle.thinkingEmitted = true
          pushEvent({
            type: 'agent:thinking:delta',
            runId,
            sessionKey,
            delta: '',
          })
        }
        return
      }
      case 'plan': {
        // 可选扩展：plan 文本通过 system 消息展示
        return
      }
      case 'tool': {
        if (!progress.tool) return
        this.flushMessageDelta(sessionKey, pushEvent)
        this.handleToolProgress(progress.tool, handle, pushEvent)
        return
      }
      default:
        return
    }
  }

  private handleToolProgress(
    tool: CodingDevToolProgress,
    handle: AcpRunHandle,
    pushEvent: (event: AgentRuntimeEvent) => void,
  ): void {
    const { runId, sessionKey } = handle
    const { toolCallId, toolName, phase, args, result, isError } = tool

    if (phase === 'start') {
      const textPositionAtStart = handle.totalLength
      handle.toolStartTextPositions.set(toolCallId, textPositionAtStart)
      pushEvent({
        type: 'agent:tool:start',
        runId,
        sessionKey,
        toolCallId,
        toolName,
        args: args ?? {},
        timestamp: Date.now(),
        textPositionAtStart,
      })
      return
    }

    if (phase === 'progress') {
      pushEvent({
        type: 'agent:tool:progress',
        runId,
        sessionKey,
        toolCallId,
        toolName,
        progressText: typeof result === 'string' ? result : undefined,
      })
      return
    }

    if (phase === 'end') {
      const startMs = handle.toolStartTextPositions.get(toolCallId) ?? Date.now()
      const durationMs = Math.max(0, Date.now() - startMs)
      handle.toolStartTextPositions.delete(toolCallId)
      pushEvent({
        type: 'agent:tool:end',
        runId,
        sessionKey,
        toolCallId,
        toolName,
        result,
        isError: isError ?? false,
        durationMs,
      })
    }
  }

  private scheduleDeltaFlush(sessionKey: string, pushEvent: (event: AgentRuntimeEvent) => void): void {
    if (this.deltaFlushTimer) return
    this.deltaFlushTimer = setTimeout(() => {
      this.deltaFlushTimer = undefined
      this.flushAllMessageDeltas(pushEvent)
    }, DEFAULT_DELTA_FLUSH_MS)
  }

  private flushMessageDelta(sessionKey: string, pushEvent: (event: AgentRuntimeEvent) => void): void {
    const pending = this.pendingMessageDelta.get(sessionKey)
    if (!pending || pending.text.length === 0) return
    pushEvent({
      type: 'agent:message:delta',
      runId: this.findRunIdBySessionKey(sessionKey) ?? '',
      sessionKey,
      messageId: pending.messageId,
      delta: pending.text,
      totalLength: this.getTotalLengthBySessionKey(sessionKey),
    })
    this.pendingMessageDelta.delete(sessionKey)
    if (this.deltaFlushTimer) {
      clearTimeout(this.deltaFlushTimer)
      this.deltaFlushTimer = undefined
    }
  }

  private flushAllMessageDeltas(pushEvent: (event: AgentRuntimeEvent) => void): void {
    for (const sessionKey of this.pendingMessageDelta.keys()) {
      this.flushMessageDelta(sessionKey, pushEvent)
    }
  }

  private findRunIdBySessionKey(sessionKey: string): string | undefined {
    for (const [runId, handle] of this.runs) {
      if (handle.sessionKey === sessionKey) return runId
    }
    return undefined
  }

  private getTotalLengthBySessionKey(sessionKey: string): number {
    for (const handle of this.runs.values()) {
      if (handle.sessionKey === sessionKey) return handle.totalLength
    }
    return 0
  }

  private clearTimeout(handle: AcpRunHandle): void {
    if (handle.timeoutHandle) {
      clearTimeout(handle.timeoutHandle)
      handle.timeoutHandle = undefined
    }
  }

  private persistAssistantMessage(
    bridge: AgentRuntimeBridge,
    sessionKey: string,
    messageId: string,
    text: string,
  ): void {
    try {
      bridge.conversationRepo.saveMessage({
        id: messageId,
        conversationId: sessionKey,
        role: 'assistant',
        contentJson: { type: 'text', text },
      })
    } catch (err) {
      log.error(`[persistAssistantMessage] failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

let _globalController: AcpRunController | null = null

export function getAcpRunController(): AcpRunController {
  if (!_globalController) {
    _globalController = new AcpRunController()
  }
  return _globalController
}

export function resetAcpRunControllerForTests(): void {
  _globalController?.dispose()
  _globalController = null
}
