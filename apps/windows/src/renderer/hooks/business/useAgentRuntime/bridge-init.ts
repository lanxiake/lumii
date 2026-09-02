/**
 * useAgentRuntime 模块级 IPC 事件订阅初始化（独立于 React 组件生命周期）。
 *
 * 将 onEvent 订阅提升至模块级单例，确保即使 ChatPage 卸载
 * （用户切换菜单），事件处理仍持续运行，不会丢失
 * agent:turn:end / agent:error 等终止事件，避免 isStreaming 永久为 true。
 */

import { syncAutoApproveToMainProcess } from '../../../../shared/auto-approve-prefs'
import { handleRuntimeEvent } from './event-handler'
import { runtimeStore } from './agent-runtime-store'
import type { RuntimeMessage } from './agent-runtime-store'
import type { AgentRuntimeEvent } from '../../../../shared/agent-runtime-events'
import {
  parseMessageContentJson,
  type AssistantPart,
  type FileChangeEntry,
} from '@mtbot/agent-runtime/browser'
import type { DbMessage } from './useAgentRuntime.types'

/** 仅在开发环境输出详细日志，避免生产环境噪音 */
export const debugLog = process.env.NODE_ENV === 'development'
  ? (...args: unknown[]) => console.log(...args)
  : () => undefined

/**
 * 将主进程返回的 DB 消息映射为 renderer 消息，并恢复 assistant_parts 时间线。
 */
export function toRuntimeMsg(msg: DbMessage): RuntimeMessage {
  const parsed = msg.contentJson ? parseMessageContentJson(msg.contentJson) : undefined
  const assistantContent = parsed?.type === 'assistant_parts' ? parsed : undefined
  const parts: readonly AssistantPart[] = assistantContent?.parts ?? []
  const fileChanges: readonly FileChangeEntry[] | undefined = assistantContent?.fileChanges
  const content = assistantContent
    ? [{
        type: 'text' as const,
        text: parts
          .filter((part): part is Extract<AssistantPart, { type: 'text' }> => part.type === 'text')
          .map((part) => part.text)
          .join(''),
      }]
    : msg.content

  return {
    id: msg.id,
    role: msg.role,
    content,
    parts,
    timestamp: msg.timestamp,
    isStreaming: msg.isStreaming ?? false,
    toolCalls: (msg.toolCalls ?? []).map((tc) => ({
      ...tc,
      status: (tc.isError ? 'error' : 'completed') as 'error' | 'completed',
      isError: tc.isError ?? false,
      textPositionAtStart: tc.textPositionAtStart,
    })),
    ...(msg.contextExcluded ? { contextExcluded: true } : {}),
    ...(assistantContent?.sourceAgent
      ? { sourceAgent: assistantContent.sourceAgent }
      : msg.sourceAgent
        ? { sourceAgent: msg.sourceAgent }
        : {}),
    ...(fileChanges ? { fileChanges } : {}),
    ...(msg.isVoice ? { isVoice: true } : {}),
    ...(msg.audioWavBase64 ? { audioWavBase64: msg.audioWavBase64 } : {}),
  }
}

/**
 * Promise 延迟（用于 NOT_READY 重试间隔）
 *
 * @param ms - 毫秒
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let _ipcEventUnsubscribe: (() => void) | null = null

/**
 * 全局单例键：防止 HMR / 多模块实例导致 onEvent 重复注册，
 * 出现同一事件被消费多次（文本重复拼接）。
 */
const GLOBAL_ON_EVENT_UNSUB_KEY = '__mtbot_agent_runtime_on_event_unsub__'

/** 补偿 runtime:ping 的定时器重试句柄（主进程 bridge 晚于首次 ping 挂接时需持续探测） */
let _pingRetryTimer: ReturnType<typeof setTimeout> | null = null

/** 每次 ping 间隔（ms）；与主进程 initAgentRuntime 可能耗时数秒相匹配 */
const PING_RETRY_MS = 2000

/** 最多重试次数（约 30s），避免永久轮询 */
const PING_MAX_ATTEMPTS = 15

/** `conversation:list` 在主进程尚未 `setAgentRuntimeBridgeForIpc` 时返回 NOT_READY，与 ping 使用相同间隔重试 */
export const LIST_NOT_READY_RETRY_MS = 2000

/** 会话列表拉取最多等待约 30s（与 PING_MAX_ATTEMPTS 量级一致） */
export const LIST_NOT_READY_MAX_ATTEMPTS = 15

/**
 * 停止 runtime:ping 补偿轮询（HMR 或已成功就绪时调用）
 */
function clearPingRetryTimer(): void {
  if (_pingRetryTimer != null) {
    clearTimeout(_pingRetryTimer)
    _pingRetryTimer = null
  }
}

/**
 * 在 bridge 已挂接且能响应 IPC 时，用合成 runtime:ready 对齐状态。
 * 用于：主进程在渲染进程注册 onEvent 之前已发出 runtime:ready（事件被丢弃）、或首次 ping 返回 NOT_READY。
 */
function applySyntheticRuntimeReadyIfPingOk(result: unknown): boolean {
  if (result && typeof result === 'object' && 'ok' in result && (result as { ok: boolean }).ok) {
    handleRuntimeEvent({ type: 'runtime:ready', timestamp: Date.now() })
    return true
  }
  return false
}

/**
 * 带重试的 bridge 就绪探测：直到 ping 成功、store 已从事件变为 isReady、或超出次数。
 *
 * @param api - preload 暴露的 agentRuntime API
 * @param attempt - 当前尝试序号（从 0 起）
 */
function tryPingBridgeUntilReady(
  api: NonNullable<typeof window.electronAPI>['agentRuntime'],
  attempt: number,
): void {
  if (runtimeStore.getState().isReady) {
    clearPingRetryTimer()
    return
  }
  if (!api.sendCommand) {
    clearPingRetryTimer()
    return
  }
  if (attempt >= PING_MAX_ATTEMPTS) {
    clearPingRetryTimer()
    debugLog('[useAgentRuntime] runtime:ping 已达最大重试次数，仍依赖后续 runtime:ready 事件')
    return
  }

  void api
    .sendCommand({ type: 'runtime:ping' })
    .then((result) => {
      if (runtimeStore.getState().isReady) {
        clearPingRetryTimer()
        return
      }
      if (applySyntheticRuntimeReadyIfPingOk(result)) {
        clearPingRetryTimer()
        return
      }
      _pingRetryTimer = setTimeout(() => {
        _pingRetryTimer = null
        tryPingBridgeUntilReady(api, attempt + 1)
      }, PING_RETRY_MS)
    })
    .catch(() => {
      if (runtimeStore.getState().isReady) {
        clearPingRetryTimer()
        return
      }
      _pingRetryTimer = setTimeout(() => {
        _pingRetryTimer = null
        tryPingBridgeUntilReady(api, attempt + 1)
      }, PING_RETRY_MS)
    })
}

/**
 * 初始化全局 IPC 事件监听器（幂等，多次调用安全）。
 * 由 useAgentRuntimeActions 在首次调用时触发。
 */
export function ensureIpcEventListener(): void {
  const globalObj = globalThis as typeof globalThis & {
    [GLOBAL_ON_EVENT_UNSUB_KEY]?: (() => void) | null
  }

  // 进程级单例：若已注册则直接复用，避免重复监听
  if (globalObj[GLOBAL_ON_EVENT_UNSUB_KEY]) {
    _ipcEventUnsubscribe = globalObj[GLOBAL_ON_EVENT_UNSUB_KEY] ?? null
    return
  }

  if (_ipcEventUnsubscribe) {
    return
  }
  console.log('[useAgentRuntime] ensureIpcEventListener: 首次注册')
  const api = window.electronAPI?.agentRuntime
  if (!api?.onEvent) return

  _ipcEventUnsubscribe = api.onEvent((rawEvent: unknown) => {
    if (
      rawEvent &&
      typeof rawEvent === 'object' &&
      'type' in rawEvent
    ) {
      const evtType = (rawEvent as { type?: string }).type
      if (evtType && !evtType.endsWith(':delta') && !evtType.includes('thinking')) {
        debugLog('[useAgentRuntime] onEvent received type:', evtType)
      }
      handleRuntimeEvent(rawEvent as AgentRuntimeEvent)
    }
  })
  globalObj[GLOBAL_ON_EVENT_UNSUB_KEY] = _ipcEventUnsubscribe

  // 启动即同步自动审批：不依赖 ChatPage mount，纯渠道场景也能跳过 IM 审批推送
  syncAutoApproveToMainProcess(api.sendCommand)

  // 监听器刚建立时，bridge 可能已经就绪（runtime:ready 在监听前发出）。
  // 单次 ping 若遇 ipcBridgeRef 尚未挂接会返回 NOT_READY 且无重试，会导致 isReady 恒为 false、侧边栏历史永不加载。
  // 此处对 ping 做有限次重试，与 ChatPage 中「新建对话」会无条件 refreshLocalSessions 的现象一致（用户操作触发了可工作的 IPC 时序）。
  tryPingBridgeUntilReady(api, 0)
}

/**
 * Vite HMR 热更新时自动清理旧监听器，防止重复注册。
 * 模块级变量 _ipcEventUnsubscribe 在 HMR 后会被重置为 null，
 * 但 ipcRenderer.on 注册的旧监听器仍然存活——需要主动注销。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    const globalObj = globalThis as typeof globalThis & {
      [GLOBAL_ON_EVENT_UNSUB_KEY]?: (() => void) | null
    }
    clearPingRetryTimer()
    if (_ipcEventUnsubscribe) {
      _ipcEventUnsubscribe()
      _ipcEventUnsubscribe = null
    }
    globalObj[GLOBAL_ON_EVENT_UNSUB_KEY] = null
  })
}
