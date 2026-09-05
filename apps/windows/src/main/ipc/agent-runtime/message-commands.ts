/**
 * Message 命令处理器（message:*）
 */

import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'
import { recordFeedbackSignal } from '../../agent-runtime/autonomous-wiring'

const log = {
  info: (...args: unknown[]) => console.log('[agent-runtime-ipc/message]', ...args),
  error: (...args: unknown[]) => console.error('[agent-runtime-ipc/message]', ...args),
}

export async function handleMessageDelete(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'message:delete' }>,
): Promise<unknown> {
  const { messageId, sessionKey: convId } = command
  try {
    bridge.conversationRepo.deleteMessage(messageId, convId)
    return { success: true }
  } catch (err) {
    log.error(`[message:delete] failed to delete message ${messageId}:`, err)
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function handleMessageEdit(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'message:edit' }>,
): Promise<unknown> {
  const { messageId, sessionKey: convId, newContent } = command
  try {
    bridge.conversationRepo.updateMessageContent({
      messageId,
      conversationId: convId,
      contentJson: { type: 'text', text: newContent },
      isStreaming: false,
    })
    // 编辑是原地覆盖、无历史，自主进化的反馈信号必须在此刻记录
    recordFeedbackSignal(convId, 'edit')
    return { success: true }
  } catch (err) {
    log.error(`[message:edit] failed to edit message ${messageId}:`, err)
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// message:edit-and-resend 较复杂，暂保留在主文件（依赖 getInstanceForSession、getIpcChannelAdapter、StatefulContextStrategy）
