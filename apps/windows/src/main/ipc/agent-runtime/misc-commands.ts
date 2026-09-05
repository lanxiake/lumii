/**
 * 杂项命令处理器
 *
 * 包括 session:*, message:*, tasks:*, commands:*, image:*
 * 提取自 agent-runtime-ipc.ts
 */

import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import { StatefulContextStrategy } from '../../channel/context-strategy/stateful-strategy'
import { recordFeedbackSignal } from '../../agent-runtime/autonomous-wiring'

const log = {
  info: (...args: unknown[]) => console.log('[AgentRuntime:IPC]', ...args),
  warn: (...args: unknown[]) => console.warn('[AgentRuntime:IPC]', ...args),
  error: (...args: unknown[]) => console.error('[AgentRuntime:IPC]', ...args),
}

// ============================================================
// 常量
// ============================================================

/**
 * 基础斜杠命令列表（前端 /commands 展示；部分由后端拦截实现，部分前端自行处理）
 */
const BASE_SLASH_COMMANDS = [
  // ── 信息查询 ──────────────────────────────────────────────────
  {
    key: 'help',
    name: '/help',
    aliases: [],
    description: '显示所有可用命令',
    usage: '/help',
    category: 'info',
    acceptsArgs: false,
  },
  {
    key: 'status',
    name: '/status',
    aliases: [],
    description: '查看当前 Agent 状态（上下文用量、模型等）',
    usage: '/status',
    category: 'info',
    acceptsArgs: false,
  },
  // ── 会话管理 ──────────────────────────────────────────────────
  {
    key: 'clear',
    name: '/clear',
    aliases: [],
    description: '清空当前会话的所有消息（保留会话）',
    usage: '/clear',
    category: 'session',
    acceptsArgs: false,
  },
]

// ============================================================
// 依赖注入接口
// ============================================================

interface MiscDependencies {
  getInstanceForSession: (
    bridge: AgentRuntimeBridge,
    sessionKey: string,
    agentId?: string,
  ) => Promise<string | undefined>
  getIpcChannelAdapter: (bridge: AgentRuntimeBridge) => {
    sendPrompt: (
      instanceId: string,
      sessionKey: string,
      prompt: string,
      imageAttachmentPaths: string[] | undefined,
      msgId: string,
    ) => Promise<void>
    getContextStrategy: () => unknown
  }
  handleMessageDelete: (
    bridge: AgentRuntimeBridge,
    command: Extract<AgentRuntimeCommand, { type: 'message:delete' }>,
  ) => unknown
  handleMessageEdit: (
    bridge: AgentRuntimeBridge,
    command: Extract<AgentRuntimeCommand, { type: 'message:edit' }>,
  ) => unknown
  handleImageRecognize: (
    bridge: AgentRuntimeBridge,
    command: Extract<AgentRuntimeCommand, { type: 'image:recognize' }>,
  ) => unknown
  handleImageGenerate: (
    bridge: AgentRuntimeBridge,
    command: Extract<AgentRuntimeCommand, { type: 'image:generate' }>,
  ) => unknown
  handleImageProcess: (
    bridge: AgentRuntimeBridge,
    command: Extract<AgentRuntimeCommand, { type: 'image:process' }>,
  ) => unknown
}

let deps: MiscDependencies | null = null

export function setMiscDependencies(dependencies: MiscDependencies): void {
  deps = dependencies
}

// ============================================================
// 命令处理器
// ============================================================

export function handleSessionPreferredModelSet(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'session:preferredModel:set' }>,
): unknown {
  bridge.setSessionPreferredModel(command.sessionKey, command.modelId)
  return bridge.getSessionContextUsage(command.sessionKey)
}

export function handleSessionPreferredModelPrime(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'session:preferredModel:prime' }>,
): unknown {
  bridge.primeSessionModelCompaction(command.sessionKey, command.modelId)
  return bridge.getSessionContextUsage(command.sessionKey)
}

export function handleSessionThinkingPrefsSet(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'session:thinkingPrefs:set' }>,
): unknown {
  return bridge.setSessionThinkingPrefs(command.sessionKey, {
    ...(command.thinkingEnabled !== undefined ? { thinkingEnabled: command.thinkingEnabled } : {}),
    ...(command.reasoningEffort !== undefined ? { reasoningEffort: command.reasoningEffort } : {}),
  })
}

export function handleMessageDelete(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'message:delete' }>,
): unknown {
  return deps!.handleMessageDelete(bridge, command)
}

export function handleMessageEdit(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'message:edit' }>,
): unknown {
  return deps!.handleMessageEdit(bridge, command)
}

export async function handleMessageEditAndResend(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'message:edit-and-resend' }>,
): Promise<{ success: boolean; messagesRemoved?: number; error?: string }> {
  const { sessionKey: convId, messageId, newContent } = command
  log.info(`[message:edit-and-resend] convId=${convId} messageId=${messageId}`)
  // 重发是比单纯编辑更强的否定信号；删改都不留历史，只能在此刻记录
  recordFeedbackSignal(convId, 'resend')
  try {
    // 1. 删除该消息之后的所有消息
    const removed = bridge.conversationRepo.deleteMessagesAfter(messageId, convId)
    log.info(`[message:edit-and-resend] deleted ${removed} messages after ${messageId}`)
    // 2. 更新消息内容
    bridge.conversationRepo.updateMessageContent({
      messageId,
      conversationId: convId,
      contentJson: { type: 'text', text: newContent },
      isStreaming: false,
    })
    // 3. 重新触发 Agent 回复（复用 compact 路径的 getInstanceForSession）
    const instanceId = await deps!.getInstanceForSession(bridge, convId)
    if (instanceId) {
      // 截断重放：DB 已删后续消息，但 Agent 内存仍保留完整历史。
      // 强制下次 beforePrompt 以 DB 为准重注入，否则「内存更完整」启发式会把后续消息一并发给 LLM。
      const adapter = deps!.getIpcChannelAdapter(bridge)
      const strategy = adapter.getContextStrategy()
      if (strategy instanceof StatefulContextStrategy) {
        strategy.markForceResync(convId)
      }
      // 排除已更新的用户消息，避免 restore + prompt 重复注入
      await adapter.sendPrompt(instanceId, convId, newContent, undefined, messageId)
    } else {
      log.warn(`[message:edit-and-resend] 无 instanceId，消息已更新但未自动触发回复`)
    }
    return { success: true, messagesRemoved: removed }
  } catch (err) {
    log.error(`[message:edit-and-resend] failed:`, err)
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function handleTasksList(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'tasks:list' }>,
): unknown {
  const { conversationId } = command
  const rows = bridge.taskRepo.list(conversationId)
  return {
    tasks: rows.map((t) => ({
      id: t.id,
      subject: t.subject,
      description: t.description,
      status: t.status,
      owner: t.owner,
    })),
  }
}

export function handleCommandsList(): unknown {
  return BASE_SLASH_COMMANDS
}

export function handleImageRecognize(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'image:recognize' }>,
): unknown {
  return deps!.handleImageRecognize(bridge, command)
}

export function handleImageGenerate(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'image:generate' }>,
): unknown {
  return deps!.handleImageGenerate(bridge, command)
}

export function handleImageProcess(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'image:process' }>,
): unknown {
  return deps!.handleImageProcess(bridge, command)
}
