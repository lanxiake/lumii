/**
 * 用户消息发送的模块级实现。
 *
 * 抽成模块函数是因为有两条调用路径，且必须行为一致：
 * 1. 输入框直接发送（`useAgentRuntime.sendMessage`，组件内）；
 * 2. 等待队列的自动发送（回合正常结束时由事件层触发，**与组件是否挂载无关**——
 *    用户切到别的会话甚至别的页面，队列照样要发出去）。
 *
 * 两条路若各写一份，msgId / 乐观写入 / 落库 id 对不齐就会出现重复气泡：
 * 主进程按 msgId 落库并回广播 `conversation:message:new`，渲染层靠 id 命中跳过。
 */
import { updateSessionState } from './agent-runtime-store'

export interface SendUserMessageOptions {
  readonly agentId?: string
  readonly modelId?: string
  readonly imageAttachmentPaths?: readonly string[]
  /**
   * 由调用方预先生成的消息 id。
   * 自动发送路径需要它来「失败回滚」——失败时按这个 id 撤掉乐观写入的气泡。
   */
  readonly msgId?: string
}

/** 生成与本地乐观写入同源的稳定消息 id（主进程按此 id 落库，切会话不重复） */
export function makeUserMessageId(): string {
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

  const msgId = options?.msgId ?? makeUserMessageId()

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
