/**
 * User (用户交互) 命令处理器
 *
 * 提取自 agent-runtime-ipc.ts
 */

import type { BrowserWindow } from 'electron'
import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import type { AgentRuntimeEvent } from '../../../shared/agent-runtime-events'
import { deriveConversationTitleFromUserText } from '../../../shared/conversation-title'
import { StatefulContextStrategy } from '../../channel/context-strategy/stateful-strategy'
import type { CodingDevBackendId } from '../../coding-dev-backends-stub/contracts.js'
import { DEFAULT_CODING_DEV_BACKEND_ID } from '../../coding-dev-backends-stub/contracts.js'

const log = {
  info: (...args: unknown[]) => console.log('[AgentRuntime:IPC]', ...args),
  warn: (...args: unknown[]) => console.warn('[AgentRuntime:IPC]', ...args),
  error: (...args: unknown[]) => console.error('[AgentRuntime:IPC]', ...args),
}

const LOCAL_USER_ID = 'local-user'

// ============================================================
// 依赖注入接口
// ============================================================

interface UserDependencies {
  ipcMainWindowRef: BrowserWindow | null
  sessionToInstance: Map<string, string>
  runIdToInstance: Map<string, string>
  trackRunInstance: (runId: string, instanceId: string) => void
  untrackRun: (runId: string) => void
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
      imageAttachmentPaths?: readonly string[],
      msgId?: string,
    ) => Promise<void>
    sessionManager: { clearLock: (sessionKey: string) => void }
    getContextStrategy: () => unknown
  }
  getAcpBackendManager: () => {
    getBackendWithFallback: (userId: string, sessionKey: string) => CodingDevBackendId
  }
  getAcpRunController: () => {
    startRun: (params: {
      runId: string
      sessionKey: string
      backendId: CodingDevBackendId
      text: string
      instanceId: string
      bridge: AgentRuntimeBridge
      pushEvent: (event: AgentRuntimeEvent) => void
    }) => Promise<void>
    abortRun: (runId: string, reason: 'user_cancel' | 'timeout') => boolean
    abortSession: (sessionKey: string, reason: 'user_cancel' | 'timeout') => number
  }
  pushEvent: (win: BrowserWindow, event: AgentRuntimeEvent) => void
  resolveAgentIdForMemories: (
    bridge: AgentRuntimeBridge,
    sessionKey?: string,
    explicitAgentId?: string,
  ) => string
}

let deps: UserDependencies | null = null

export function setUserDependencies(dependencies: UserDependencies): void {
  deps = dependencies
}

// ============================================================
// 命令处理器
// ============================================================

export async function handleUserSend(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'user:send' }>,
): Promise<{ runId: string }> {
  const instanceId = await deps!.getInstanceForSession(bridge, command.sessionKey, command.agentId)
  if (!instanceId) {
    throw new Error(
      `No agent instance found for session: ${command.sessionKey}. Create a conversation first.`,
    )
  }

  bridge.setSessionPreferredModel(command.sessionKey, command.modelId)

  log.info(
    `[user:send] sessionKey=${command.sessionKey}, instanceId=${instanceId}, modelId=${command.modelId ?? '(default)'}, content="${command.content.slice(0, 50)}"`,
  )

  // 确保会话存在于数据库（防止前端 createSession IPC 尚未完成时用户就发送了消息）
  const existingConv = bridge.conversationRepo.getConversation(command.sessionKey)
  if (!existingConv) {
    log.warn(`[user:send] 会话 ${command.sessionKey} 不存在，自动创建`)
    const agentId = command.agentId ?? 'assistant'
    // 直接插入数据库，使用前端传入的 sessionKey 作为 conversation.id
    const now = new Date().toISOString()
    bridge.conversationRepo['db']
      .prepare(
        `INSERT INTO conversations (id, user_id, title, is_active, created_at)
             VALUES (?, ?, ?, 1, ?)`,
      )
      .run(command.sessionKey, LOCAL_USER_ID, '新对话', now)
    // 插入参与者（user + agent）
    const insertParticipant = bridge.conversationRepo['db'].prepare(
      `INSERT INTO conversation_participants (conversation_id, participant_type, participant_id, joined_at)
             VALUES (?, ?, ?, ?)`,
    )
    insertParticipant.run(command.sessionKey, 'user', LOCAL_USER_ID, now)
    insertParticipant.run(command.sessionKey, 'agent', agentId, now)
    log.info(`[user:send] 自动创建会话 ${command.sessionKey}, agentId=${agentId}`)
  }

  // 持久化用户消息到 DB（sessionKey === conversationId；语音消息含 WAV 供历史回放）
  try {
    const voice = 'isVoice' in command && command.isVoice === true
    const wav =
      'audioWavBase64' in command &&
      typeof (command as { audioWavBase64?: string }).audioWavBase64 === 'string'
        ? (command as { audioWavBase64: string }).audioWavBase64
        : undefined
    bridge.conversationRepo.saveMessage({
      id: command.msgId,
      conversationId: command.sessionKey,
      role: 'user',
      contentJson: {
        type: 'text',
        text: command.content,
        ...(voice ? { isVoice: true as const } : {}),
        ...(wav ? { audioWavBase64: wav } : {}),
      },
    })
    // 广播用户消息：主窗口与宠物窗口是独立渲染进程，宠物侧 sendMessage 无法更新主窗口 store
    const win = deps!.ipcMainWindowRef
    if (win && !win.isDestroyed() && command.msgId) {
      deps!.pushEvent(win, {
        type: 'conversation:message:new',
        sessionKey: command.sessionKey,
        message: {
          id: command.msgId,
          role: 'user',
          content: [{ type: 'text', text: command.content }],
          timestamp: Date.now(),
          ...(voice ? { isVoice: true as const } : {}),
          ...(wav ? { audioWavBase64: wav } : {}),
        },
      })
    }
    // 首条用户消息时，将默认标题「新对话」更新为与 useChat 一致的智能标题
    const userCount = bridge.conversationRepo.countUserMessages(command.sessionKey)
    if (userCount === 1) {
      const conv = bridge.conversationRepo.getConversation(command.sessionKey)
      const currentTitle = conv?.title?.trim()
      if (!currentTitle || currentTitle === '新对话') {
        const newTitle = deriveConversationTitleFromUserText(command.content)
        bridge.conversationRepo.updateTitle(command.sessionKey, newTitle)
        log.info(
          `[user:send] 首条消息更新会话标题 sessionKey=${command.sessionKey} → "${newTitle}"`,
        )
      }
    }
  } catch (err) {
    log.error(`[user:send] failed to save user message:`, err)
  }

  // 段落总结记忆（灰度，默认 no-op）：观察该 user 轮，驱动分段/总结
  try {
    if (command.msgId) {
      bridge.segmentMemory?.observeUserTurn({
        conversationId: command.sessionKey,
        agentId: deps!.resolveAgentIdForMemories(bridge, command.sessionKey, command.agentId),
        messageId: command.msgId,
        text: command.content,
      })
    }
  } catch (err) {
    log.error(`[user:send] segmentMemory.observeUserTurn 失败:`, err)
  }

  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  deps!.trackRunInstance(runId, instanceId)

  // 检查 ACP 后端：per-peer 优先，回退到 user-global，再回退到默认主代理
  const acpMgr = deps!.getAcpBackendManager()
  const currentBackend = acpMgr.getBackendWithFallback(LOCAL_USER_ID, command.sessionKey)
  if (currentBackend !== DEFAULT_CODING_DEV_BACKEND_ID) {
    log.info(`[user:send] ACP 路径: backendId=${currentBackend} sessionKey=${command.sessionKey}`)
    // Controller 内部负责：turn:start / message:start / delta / tool:start/progress/end /
    // message:end / idle / timeout / abort / DB 持久化。异步执行，不阻塞 IPC 响应。
    const controller = deps!.getAcpRunController()
    void controller.startRun({
      runId,
      sessionKey: command.sessionKey,
      backendId: currentBackend,
      text: command.content,
      instanceId,
      bridge,
      pushEvent: (event) => {
        const win = deps!.ipcMainWindowRef
        if (win && !win.isDestroyed()) deps!.pushEvent(win, event)
      },
    })
    return { runId }
  }

  // 主代理：通过 IpcChannelAdapter → SessionManager 发送（含并发保护 + 增量同步）
  // 不 await，让它在后台运行
  // 图片附件路径透传给 bridge.prompt，由其读盘转 base64 构造多模态 ImageContent 块
  const imageAttachmentPaths = command.imageAttachmentPaths
    ? [...command.imageAttachmentPaths]
    : undefined
  if (imageAttachmentPaths && imageAttachmentPaths.length > 0) {
    log.info(
      `[user:send] 含图片附件 sessionKey=${command.sessionKey} count=${imageAttachmentPaths.length} 首张=${imageAttachmentPaths[0]}`,
    )
  }
  deps!
    .getIpcChannelAdapter(bridge)
    .sendPrompt(instanceId, command.sessionKey, command.content, imageAttachmentPaths, command.msgId)
    .catch((err) => {
      log.error(`[user:send] prompt failed:`, err)
    })

  return { runId }
}

export function handleUserSteer(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'user:steer' }>,
): void {
  log.info(`[user:steer] steerText="${command.steerText.slice(0, 50)}"`)
  const instances = bridge.getInstances()
  const running = instances.find((i) => i.state === 'running')
  if (running) {
    bridge.steer(running.id, command.steerText)
  } else {
    log.info(`[user:steer] no running instance found`)
  }
}

export function handleUserAbort(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'user:abort' }>,
): void {
  // 1. 尝试中止 ACP run（按 runId 精确中止 / 按 sessionKey 全部中止）
  const acpController = deps!.getAcpRunController()
  if (command.runId && acpController.abortRun(command.runId, 'user_cancel')) {
    return
  }
  if (
    command.sessionKey &&
    acpController.abortSession(command.sessionKey, 'user_cancel') > 0
  ) {
    if (command.runId) deps!.untrackRun(command.runId)
    return
  }
  // 2. 现有主代理中止逻辑：清挂起等待 + 级联 abort + 释放会话串行锁
  if (command.sessionKey) {
    const abortedRoots = bridge.abortSession(command.sessionKey)
    // 无论是否找到根实例，都清锁，防止上一轮 prompt Promise 未 settle 卡住后续 send
    deps!.getIpcChannelAdapter(bridge).sessionManager.clearLock(command.sessionKey)
    if (abortedRoots > 0) {
      if (command.runId) deps!.untrackRun(command.runId)
      return
    }
  }

  const targetInstanceId = command.runId ? deps!.runIdToInstance.get(command.runId) : undefined
  const fallbackInstanceId = command.sessionKey
    ? deps!.sessionToInstance.get(command.sessionKey)
    : undefined
  const instanceIdToAbort = targetInstanceId ?? fallbackInstanceId
  if (!instanceIdToAbort) {
    log.info(
      `[user:abort] 未找到可中止实例 runId=${command.runId ?? '(none)'} sessionKey=${command.sessionKey ?? '(none)'}`,
    )
    return
  }
  // 仅中止当前 run 对应实例（及其子 Agent），避免误伤其他会话
  bridge.abortWithChildrenAndPending(instanceIdToAbort)
  if (command.sessionKey) {
    deps!.getIpcChannelAdapter(bridge).sessionManager.clearLock(command.sessionKey)
  }
  if (command.runId) deps!.untrackRun(command.runId)
}

export function handleUserPermissionRespond(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'user:permission:respond' }>,
): void {
  log.info(`[user:permission:respond] requestId=${command.requestId} → ${command.decision}`)
  bridge.resolvePermission(command.requestId, command.decision)
}

export function handleUserAskUserRespond(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'user:ask-user:respond' }>,
): void {
  log.info(
    `[user:ask-user:respond] requestId=${command.requestId} declined=${Boolean(command.declined)}`,
  )
  bridge.resolveAskUserQuestion(command.requestId, {
    answers: command.answers,
    annotations: command.annotations,
    declined: command.declined,
  })
}

export function handleUserAutoApproveSet(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'user:auto-approve:set' }>,
): void {
  log.info(`[user:auto-approve:set] enabled=${command.enabled}`)
  bridge.setAutoApprove(command.enabled)
}

export async function handleUserCompactContext(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'user:compact-context' }>,
): Promise<unknown> {
  const keepTurns = command.keepRecentTurns ?? 6
  log.info(`[user:compact-context] sessionKey=${command.sessionKey}, keepRecentTurns=${keepTurns}`)
  try {
    // 重启后 sessionToInstance 可能为空，通过 getInstanceForSession 恢复实例（含 LLM stream）
    const instanceId = await deps!.getInstanceForSession(bridge, command.sessionKey)
    if (instanceId) {
      const result = await bridge.compactContextAsync(instanceId, command.sessionKey, keepTurns)
      // 压缩后 DB 比内存短，必须强制下次 prompt 以 DB（含摘要）为准重注入
      const adapter = deps!.getIpcChannelAdapter(bridge)
      const strategy = adapter.getContextStrategy()
      if (strategy instanceof StatefulContextStrategy) {
        strategy.markForceResync(command.sessionKey)
      }
      return result
    } else {
      log.warn(
        `[user:compact-context] 无法恢复 instanceId，降级为同步压缩: sessionKey=${command.sessionKey}`,
      )
      const result = bridge.compactContext(command.sessionKey, keepTurns)
      return { ...result, hadSummary: false }
    }
  } catch (err) {
    log.error(`[user:compact-context] 失败:`, err)
    throw err
  }
}

export function handleUserAbortCompactContext(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'user:abort-compact-context' }>,
): { aborted: boolean } {
  const aborted = bridge.abortCompactContext(command.sessionKey)
  log.info(`[user:abort-compact-context] sessionKey=${command.sessionKey}, aborted=${aborted}`)
  return { aborted }
}
