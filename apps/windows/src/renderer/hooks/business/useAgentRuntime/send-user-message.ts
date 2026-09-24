/**
 * 用户消息发送的模块级实现（乐观写入 + 发 `user:send`，返回 runId）。
 *
 * 与组件解耦：调用方只表达"把这个会话的一条消息发出去"。msgId 在这里统一生成——
 * 主进程按它落库并回广播 `conversation:message:new`，渲染层靠 id 命中跳过；
 * 两边对不齐就会出现重复气泡。
 */
import { updateSessionState } from './agent-runtime-store'

export interface SendUserMessageOptions {
  readonly agentId?: string
  readonly modelId?: string
  readonly imageAttachmentPaths?: readonly string[]
}

/** 生成与本地乐观写入同源的稳定消息 id（主进程按此 id 落库，切会话不重复） */
function makeUserMessageId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 发送一条用户消息，返回 runId。
 *
 * @throws 当 IPC 桥不可用或会话未建立时抛出，由调用方决定是否提示用户。
 */
export async function sendUserMessage(
  sessionKey: string,
  content: string,
  options?: SendUserMessageOptions,
): Promise<string> {
  const api = window.electronAPI?.agentRuntime
  if (!api?.sendCommand) {
    throw new Error('Agent Runtime new protocol not available')
  }

  const msgId = makeUserMessageId()

  // 先将用户消息追加到对应会话的 Store（乐观写入，主进程广播会按同 id 去重）
  updateSessionState(sessionKey, (prev) => ({
    ...prev,
    messages: [
      ...prev.messages,
      {
        id: msgId,
        role: 'user' as const,
        content: [{ type: 'text' as const, text: content }],
        parts: [],
        timestamp: Date.now(),
        isStreaming: false,
        toolCalls: [],
      },
    ],
  }))

  const result = (await api.sendCommand({
    type: 'user:send',
    sessionKey,
    content,
    agentId: options?.agentId,
    modelId: options?.modelId,
    msgId,
    imageAttachmentPaths: options?.imageAttachmentPaths,
  })) as { runId: string }

  return result.runId
}
