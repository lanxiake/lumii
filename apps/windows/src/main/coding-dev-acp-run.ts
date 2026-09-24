/**
 * ACP 运行控制器（Windows 客户端主进程）
 *
 * 封装一次 ACP run 的完整生命周期：
 * - 流式进度转发到渲染进程（message/tool/thinking）
 * - 滑动超时：默认 60 分钟无进度才判超时，收到进度即重置窗口
 * - 用户中止 / 超时 abort
 * - 完成后持久化 assistant 消息到 DB
 *
 * 设计依据：.qoder/design/coding-dev-acp/2026-07-08-windows-acp-timeout-streaming-optimization.md
 */

import type { AgentRuntimeBridge } from './agent-runtime/bridge'
import type { AgentRuntimeEvent } from '../shared/agent-runtime-events'
import { runCodingDevAcpPrompt } from './coding-dev-backends-stub/run-coding-dev-acp-prompt.js'
import { resolveAcpTimeoutMs } from './coding-dev-backends-stub/acp-config.js'
import { ACP_CANCELLED_PREFIX, ACP_ERROR_PREFIX } from './coding-dev-acp-messages.js'
import type { AssistantPart, AssistantPartsContent } from '@mtbot/agent-runtime'
import type {
  CodingDevLightweightBackendOutput,
  CodingDevLightweightBackendProgress,
  CodingDevToolProgress,
} from './coding-dev-backends-stub/contracts.js'

const log = {
  info: (...args: unknown[]) => console.log('[AcpRunController]', ...args),
  warn: (...args: unknown[]) => console.warn('[AcpRunController]', ...args),
  error: (...args: unknown[]) => console.error('[AcpRunController]', ...args),
}

/**
 * 本次 run 收集到的一次工具调用。
 *
 * 与内核路径的 `AssistantPart(tool)` 一一对应，收尾时组装成 `assistant_parts` 落库——
 * 此前这些信息只推给渲染层，重启后开发会话里就只剩「提问 + 一段总结」。
 */
export type CollectedToolCall = {
  readonly id: string
  name: string
  args: Record<string, unknown>
  result?: unknown
  isError?: boolean
  status: 'running' | 'done' | 'error'
  /** 开始时刻，用于算耗时（此前误把文本位置当时间戳，工具卡片显示过天文数字） */
  startedAt: number
  /** 开始时已累积的正文长度，渲染层据此定位卡片；将来若要还原交错顺序也靠它 */
  textPositionAtStart: number
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
  /** toolCallId → 工具调用；Map 保持插入顺序，收尾时按序组装成 parts */
  toolCalls: Map<string, CollectedToolCall>
  settled: boolean
  abortReason?: 'user_cancel' | 'timeout'
  userInputText: string
  echoStripped: boolean
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
  /** 本次 run 的工作目录（会话开发上下文解析结果）；缺省走 MTBOT_*_ACP_CWD 全局链 */
  cwd?: string
}

const DEFAULT_DELTA_FLUSH_MS = 16

/** runtime_state 键：CLI 续接会话 id（按后端 + 会话隔离；会话删除时清理） */
export function acpSessionStateKey(backendId: string, sessionKey: string): string {
  return `acp-session:${backendId}:${sessionKey}`
}

/** 读取会话的 CLI 续接 id（runtimeStateRepo 未初始化等场景静默降级） */
function readStoredCliSession(bridge: AgentRuntimeBridge, key: string): string | undefined {
  try {
    return bridge.runtimeStateRepo.get(key)?.trim() || undefined
  } catch {
    return undefined
  }
}

function writeStoredCliSession(bridge: AgentRuntimeBridge, key: string, sessionId: string): void {
  try {
    bridge.runtimeStateRepo.set(key, sessionId)
  } catch {
    /* 忽略：续接是增强能力，不因持久化失败阻断本轮 */
  }
}

function clearStoredCliSession(bridge: AgentRuntimeBridge, key: string): void {
  try {
    bridge.runtimeStateRepo.delete(key)
  } catch {
    /* 忽略 */
  }
}

/**
 * 移除 CLI 输出开头对用户输入的回显。
 *
 * Cursor 等 CLI 会把用户 prompt 原样放进第一条 assistant text 里，
 * 这段回显在 JSON 事件内部，行级解析器（seenJson）拦不住。
 */
export function stripUserEcho(text: string, userInput: string): string {
  const prompt = userInput.trim()
  if (!prompt) return text
  const head = text.trimStart()
  if (!head.startsWith(prompt)) return text
  return head.slice(prompt.length).trimStart()
}

/**
 * 把一次 ACP run 的产出组装成落库形态（与内核路径同格式，渲染层已有共享 parser 解析）。
 *
 * **工具在前、正文在后，不做交错**：正文取自 CLI 的 final_result（`runLocalAcpCli` 里的
 * `finalResult ?? messageTexts`），与流式 message **不同源**——拿流式累积出来的
 * `textPositionAtStart` 去切它必然错位。而 ACP 的输出形态本来就是「边做边说 + 最后一段
 * 总结」，最终答复放末尾也更接近阅读顺序。
 *
 * 即使正文为空也要落库：工具过程本身就是「这一轮干了什么」的全部信息，失败与中止时
 * 它恰恰最有价值——用户能看见卡在哪一步，而不是只有一个错误提示。
 */
export function buildAcpAssistantContent(
  messageId: string,
  text: string,
  toolCalls: Iterable<CollectedToolCall>,
): AssistantPartsContent {
  const parts: AssistantPart[] = []
  for (const call of toolCalls) {
    parts.push({
      type: 'tool',
      id: call.id,
      name: call.name,
      args: call.args,
      ...(call.result !== undefined ? { result: call.result } : {}),
      ...(call.isError ? { isError: true } : {}),
      // 没等到 end 的（中止 / 崩溃）落成 interrupted：它在 AssistantPart 里是**终端态**，
      // 保留 running 会让重启后的卡片显示成「还在跑」。
      status: call.status === 'running' ? 'interrupted' : call.status,
    })
  }
  if (text) {
    parts.push({ type: 'text', id: `${messageId}-text`, text, status: 'done' })
  }
  return { type: 'assistant_parts', parts }
}

export class AcpRunController {
  private readonly runs = new Map<string, AcpRunHandle>()
  private pendingMessageDelta = new Map<string, { messageId: string; text: string }>()
  private deltaFlushTimer: ReturnType<typeof setTimeout> | undefined

  /** 重置单个 run 的超时窗口；进度事件到达时调用，避免长任务被总时长限打死 */
  private touchTimeout(handle: AcpRunHandle): void {
    const timeoutMs = resolveAcpTimeoutMs()
    if (timeoutMs === undefined || timeoutMs <= 0) return
    if (handle.timeoutHandle) clearTimeout(handle.timeoutHandle)
    handle.timeoutHandle = setTimeout(() => {
      this.abortRun(handle.runId, 'timeout')
    }, timeoutMs)
  }

  async startRun(opts: AcpRunStartOptions): Promise<void> {
    const { runId, sessionKey, backendId, text, instanceId, bridge, pushEvent } = opts
    const accountId = opts.accountId ?? 'local-user'
    const senderId = opts.senderId ?? accountId
    const messageId = `acp-msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const startedAt = Date.now()

    const abortController = new AbortController()
    const timeoutMs = resolveAcpTimeoutMs()
    // CLI 续接：同一条 Lumii 会话的多轮消息共享 CLI 上下文（有键则 resume，成功后回写新键）
    const sessionStateKey = acpSessionStateKey(backendId, sessionKey)
    const storedCliSessionId = readStoredCliSession(bridge, sessionStateKey)

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
      toolCalls: new Map(),
      settled: false,
      userInputText: text,
      echoStripped: false,
    }
    this.runs.set(runId, handle)

    if (timeoutMs !== undefined && timeoutMs > 0) {
      handle.timeoutHandle = setTimeout(() => {
        this.abortRun(runId, 'timeout')
      }, timeoutMs)
    }
    log.info(
      `[startRun] runId=${runId} backendId=${backendId} 超时=${timeoutMs === undefined ? '不限制' : `${timeoutMs}ms(滑动)`}`,
    )

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
      let output: CodingDevLightweightBackendOutput | void
      let contextReset = false
      try {
        output = await runCodingDevAcpPrompt({
          backendId,
          text,
          accountId,
          peerId: sessionKey,
          senderId,
          cwd: opts.cwd,
          cliSessionId: storedCliSessionId,
          emitProgress: (progress) => this.handleProgress(progress, handle, pushEvent),
          abortSignal: abortController.signal,
        })
      } catch (firstErr) {
        // 续接失效降级：非中止且本次带了 resume → 清键后全新重跑一次（只重试一次）
        if (abortController.signal.aborted || !storedCliSessionId) throw firstErr
        const message = firstErr instanceof Error ? firstErr.message : String(firstErr)
        log.warn(`[startRun] CLI 续接失败，清键后全新重跑: ${message}`)
        clearStoredCliSession(bridge, sessionStateKey)
        output = await runCodingDevAcpPrompt({
          backendId,
          text,
          accountId,
          peerId: sessionKey,
          senderId,
          cwd: opts.cwd,
          emitProgress: (progress) => this.handleProgress(progress, handle, pushEvent),
          abortSignal: abortController.signal,
        })
        contextReset = true
      }

      if (handle.settled) return
      this.clearTimeout(handle)
      this.flushMessageDelta(sessionKey, pushEvent)

      const rawFinalText = output?.text ?? this.pendingMessageDelta.get(sessionKey)?.text ?? ''
      // output.text 是整段聚合输出，没走过 handleProgress 的逐条剥离，这里再兜一次
      const resetHint = contextReset
        ? '\n\n（CLI 上下文已重置——上一次会话已失效，本轮为全新开始）'
        : ''
      const finalText = stripUserEcho(rawFinalText, text) + resetHint

      // 持久化本轮 CLI 会话 id，供下一轮续接
      const newCliSessionId = output?.cliSessionId?.trim()
      if (newCliSessionId) writeStoredCliSession(bridge, sessionStateKey, newCliSessionId)

      const content = [{ type: 'text' as const, text: finalText }]

      // 渲染进程的 message:end 用流式累积的文本、不用 event.content（见 event-handler
      // 的 finalContent = last.content）。所以从未推过 delta 的 run 必须先补一条，
      // 否则气泡是空的 —— 比如 cursor 未登录时只往 stderr 写错误、stdout 全空。
      if (finalText && handle.totalLength === 0) {
        pushEvent({
          type: 'agent:message:delta',
          runId,
          sessionKey,
          messageId,
          delta: finalText,
          totalLength: finalText.length,
        })
      }

      // 有工具过程就落库——哪怕正文为空（CLI 只调工具不给总结时，过程本身就是全部信息）
      if (finalText || handle.toolCalls.size > 0) {
        this.persistAssistantMessage(
          bridge,
          sessionKey,
          messageId,
          finalText,
          handle.toolCalls.values(),
        )
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

      // 失败/中止也要**落库**（09-P3b）：此前只 pushEvent 给渲染层，进程重启后这条错误就消失了；
      // 而转交完成监听读的是数据库（loadRecentMessages），看不到它 → 只能白等到 90 分钟超时。
      // 复用本轮预分配的 messageId（agent:message:start 已用它建气泡），避免同一轮出现两条消息。
      if (isAbort) {
        const reason = handle.abortReason ?? 'user_cancel'
        const waitedMinutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000))
        const friendlyMessage =
          reason === 'timeout'
            ? `${ACP_ERROR_PREFIX}执行超时（已等待 ${waitedMinutes} 分钟）。任务已中止。若任务较重，可设置 MTBOT_ACP_TIMEOUT_MS=0 取消限制，或拆分任务后重试。`
            : `${ACP_CANCELLED_PREFIX}。`

        pushEvent({
          type: 'agent:abort',
          runId,
          sessionKey,
          reason,
        })
        this.persistAssistantMessage(
          bridge,
          sessionKey,
          messageId,
          friendlyMessage,
          handle.toolCalls.values(),
        )
        pushEvent({
          type: 'conversation:message:new',
          sessionKey,
          message: {
            id: messageId,
            role: 'assistant',
            content: [{ type: 'text', text: friendlyMessage }],
            timestamp: Date.now(),
          },
        })
      } else {
        const failText = `${ACP_ERROR_PREFIX}执行失败：${errorMessage}`
        pushEvent({
          type: 'agent:error',
          runId,
          sessionKey,
          errorCode: 'ACP_FAILED',
          errorMessage: failText,
          isRetryable: false,
        })
        this.persistAssistantMessage(
          bridge,
          sessionKey,
          messageId,
          failText,
          handle.toolCalls.values(),
        )
        pushEvent({
          type: 'conversation:message:new',
          sessionKey,
          message: {
            id: messageId,
            role: 'assistant',
            content: [{ type: 'text', text: failText }],
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

    // 有进度即视为任务存活，滑动刷新超时窗口
    this.touchTimeout(handle)

    switch (progress.kind) {
      case 'message': {
        let delta = progress.text
        if (delta.length === 0) return

        // Cursor 等 CLI 会在输出开头回显用户输入，首次收到消息时检测并移除
        if (!handle.echoStripped) {
          handle.echoStripped = true
          delta = stripUserEcho(delta, handle.userInputText)
        }

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
        // 空文本是纯心跳（进程仍活着），只用于刷新超时窗口，不产生可见事件
        if (progress.text.trim() === '') return
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
      handle.toolCalls.set(toolCallId, {
        id: toolCallId,
        name: toolName,
        args: args ?? {},
        status: 'running',
        startedAt: Date.now(),
        textPositionAtStart,
      })
      pushEvent({
        type: 'agent:tool:start',
        runId,
        // 工具事件类型里没有 sessionKey，渲染进程按 rootSessionKey / runId 映射路由
        rootSessionKey: sessionKey,
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
        rootSessionKey: sessionKey,
        toolCallId,
        toolName,
        progressText: typeof result === 'string' ? result : undefined,
      })
      return
    }

    if (phase === 'end') {
      // 耗时取开始时刻。此前这里读的是 toolStartTextPositions（存的是**文本位置**），
      // 拿 Date.now() 去减它得到的是天文数字——渲染层 formatDuration 又优先采信后端值，
      // 于是工具卡片一直显示着错误的耗时。
      const call = handle.toolCalls.get(toolCallId)
      const durationMs = call ? Math.max(0, Date.now() - call.startedAt) : 0
      if (call) {
        call.status = isError ? 'error' : 'done'
        if (result !== undefined) call.result = result
        if (isError) call.isError = true
      }
      pushEvent({
        type: 'agent:tool:end',
        runId,
        rootSessionKey: sessionKey,
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
    toolCalls: Iterable<CollectedToolCall> = [],
  ): void {
    try {
      bridge.conversationRepo.saveMessage({
        id: messageId,
        conversationId: sessionKey,
        role: 'assistant',
        contentJson: buildAcpAssistantContent(messageId, text, toolCalls),
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
