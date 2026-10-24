/**
 * 中断当前会话的同步 Agent 回合（含进行中的同步工具）。
 *
 * 与 ChatInput「停止」同源：发 user:abort。工具卡行内「中断」复用此入口，
 * 不做插话转发送等 ChatPage 层善后（那仍由输入框停止按钮负责）。
 */

import { runtimeStore, updateSessionState } from '../../../hooks/business/useAgentRuntime/agent-runtime-store'

/** 中断当前会话活跃 run；无会话/无 API 时静默返回 */
export async function abortActiveRun(): Promise<void> {
  const api = window.electronAPI?.agentRuntime
  if (!api?.sendCommand) return

  const globalState = runtimeStore.getState()
  const sessionKey = globalState.currentSessionKey
  if (!sessionKey) return
  const sessionState = globalState.sessions.get(sessionKey)
  const runId = sessionState?.activeRunId ?? null

  // 先本地收敛 UI，避免等 IPC 期间仍显示流式中
  updateSessionState(sessionKey, (prev) => ({
    ...prev,
    isStreaming: false,
    isThinking: false,
    currentTool: null,
    activeRunId: null,
    messages: prev.messages.map((msg) =>
      msg.isStreaming ? { ...msg, isStreaming: false } : msg,
    ),
  }))

  await api.sendCommand({ type: 'user:abort', ...(runId ? { runId } : {}), sessionKey })
}
