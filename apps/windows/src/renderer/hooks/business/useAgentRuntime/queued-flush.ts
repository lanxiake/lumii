/**
 * 等待队列的自动发送。
 *
 * 队列是**会话的**，不是输入框的：回合正常结束时无条件尝试发送该会话的队列，
 * 哪怕用户此刻正在看别的会话（产品决策：「后台照常自动发送」）。
 * 触发点在事件层（event-handler 的 `agent:turn:end`），因此与组件挂载无关。
 */
import { takeQueuedMessages, updateSessionState } from './agent-runtime-store'
import { makeUserMessageId, sendUserMessage } from './send-user-message'

/**
 * 把指定会话的等待队列合并为一条消息发出（取出即清空）。
 *
 * 队列为空时是 no-op。合并语义与旧实现一致：多条排队消息拼成一条发送，
 * 避免同一回合里连发多轮。
 */
export function flushQueuedMessages(sessionKey: string): void {
  const items = takeQueuedMessages(sessionKey)
  if (items.length === 0) return

  const merged = items.map((item) => item.text).join('\n')
  // 模型取第一条带值的快照：会话内各条的模型选择一致，而漏传 modelId 会让
  // 主进程把会话偏好清空（见 QueuedMessage.modelId 注释），所以宁可只带一条。
  const modelId = items.find((item) => item.modelId)?.modelId
  const msgId = makeUserMessageId()

  void sendUserMessage(sessionKey, merged, {
    msgId,
    ...(modelId ? { modelId } : {}),
  }).catch((err: unknown) => {
    // 失败回滚：撤掉乐观写入的气泡，把条目放回队首，用户排好的消息不能凭空消失
    const message = err instanceof Error ? err.message : String(err)
    console.error('[queued-flush] 排队消息发送失败:', message)
    updateSessionState(sessionKey, (prev) => ({
      ...prev,
      messages: prev.messages.filter((m) => m.id !== msgId),
      queuedMessages: [...items, ...prev.queuedMessages],
      error: {
        code: 'queued-send-failed',
        message: `排队消息发送失败，已放回等待队列：${message}`,
        retryable: true,
      },
    }))
  })
}
