/**
 * Conversation (会话) 命令处理器
 *
 * 提取自 agent-runtime-ipc.ts
 */

import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import { parseThinkTagsFromRaw } from '../../agent-runtime/event-converter'
import { isCompactSummaryText } from '../../../shared/compact-summary-text'

const log = {
  info: (...args: unknown[]) => console.log('[AgentRuntime:IPC]', ...args),
  warn: (...args: unknown[]) => console.warn('[AgentRuntime:IPC]', ...args),
  error: (...args: unknown[]) => console.error('[AgentRuntime:IPC]', ...args),
}

const LOCAL_USER_ID = 'local-user'
const CONVERSATION_PAGE_SIZE = 50
/** 会话列表预览：最多回溯多少条消息去找 Agent 的最后一句文本回复 */
const PREVIEW_SCAN_LIMIT = 20
/** 会话列表预览的最大字符数 */
const PREVIEW_MAX_LENGTH = 80

// ============================================================
// 类型定义
// ============================================================

interface ConversationHistoryMessage {
  id: string
  role: string
  content: Array<{ type: 'text'; text: string }>
  contentJson: unknown
  timestamp: number
  isStreaming?: boolean
  contextExcluded?: boolean
  thinkingText?: string
  toolCalls?: Array<{
    id: string
    name: string
    args: Record<string, unknown>
    result?: unknown
    isError?: boolean
    textPositionAtStart?: number
  }>
  sourceAgent?: { instanceId: string; label: string }
  isVoice?: boolean
  audioWavBase64?: string
}

// ============================================================
// 依赖注入接口
// ============================================================

interface ConversationDependencies {
  sessionToInstance: Map<string, string>
  runIdToInstance: Map<string, string>
  instanceToRunIds: Map<string, Set<string>>
  weixinBindingManagerRef: {
    listBindings: () => Array<{ conversationId: string }>
  } | null
  trackRunInstance: (runId: string, instanceId: string) => void
  untrackInstanceRuns: (instanceId: string) => void
  getIpcChannelAdapter: (bridge: AgentRuntimeBridge) => {
    sendPrompt: (
      instanceId: string,
      sessionKey: string,
      prompt: string,
      attachments?: readonly string[],
      msgId?: string,
    ) => Promise<void>
  }
  getInstanceForSession: (
    bridge: AgentRuntimeBridge,
    sessionKey: string,
    agentId?: string,
  ) => Promise<string | undefined>
}

let deps: ConversationDependencies | null = null

export function setConversationDependencies(dependencies: ConversationDependencies): void {
  deps = dependencies
}

// ============================================================
// 命令处理器
// ============================================================

export async function handleConversationCreate(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'conversation:create' }>,
): Promise<{ sessionKey: string; conversationId: string }> {
  const { title, agentId, selectedModelId } = command

  // 1. 持久化到 DB
  const conversation = bridge.conversationRepo.createConversation({
    userId: LOCAL_USER_ID,
    title: title ?? '新对话',
    participants: [
      { type: 'user', id: LOCAL_USER_ID },
      { type: 'agent', id: agentId ?? 'default' },
    ],
  })

  // 2. 使用 conversationId 作为 sessionKey（确定性值，重启后仍有效）
  const sessionKey = conversation.id

  // 2b. 根据 UI 选中模型写入会话级压缩参数（在 createInstance 之前）
  bridge.primeSessionModelCompaction(sessionKey, selectedModelId)

  // 3. 创建 Agent 实例，绑定到 sessionKey 和 conversationId
  const instanceId = agentId
    ? await bridge.createInstanceById(agentId, sessionKey, conversation.id)
    : await bridge.createInstance(undefined, sessionKey, conversation.id)
  deps!.sessionToInstance.set(sessionKey, instanceId)

  log.info(
    `[conversation:create] sessionKey=${sessionKey}, conversationId=${conversation.id}, instanceId=${instanceId}, title="${title ?? '新对话'}"`,
  )

  // 广播给渲染端：CLI / 控制口建的会话不经过前端 createSession，
  // 不发这条事件侧栏就不会出现新会话，得手动刷新或切页面。
  bridge.forwardIpcEvent({
    type: 'conversation:created',
    sessionKey,
    title: title ?? '新对话',
    createdAt: Date.now(),
  })

  return { sessionKey, conversationId: conversation.id }
}

/**
 * 会话存在性校验：不存在时抛错，避免拼错 sessionKey 静默返回「成功但空」，
 * 让调用方无法区分「打错字」和「空会话」。
 */
function assertConversationExists(bridge: AgentRuntimeBridge, sessionKey: string): void {
  if (!bridge.conversationRepo.getConversation(sessionKey)) {
    throw new Error(`not_found: conversation ${sessionKey} does not exist`)
  }
}

export function handleConversationClose(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'conversation:close' }>,
): void {
  const { sessionKey } = command
  const instanceId = deps!.sessionToInstance.get(sessionKey)
  if (instanceId) {
    try {
      bridge.destroy(instanceId)
    } catch (err) {
      log.error(`[conversation:close] failed to destroy instance ${instanceId}:`, err)
    }
    deps!.untrackInstanceRuns(instanceId)
    deps!.sessionToInstance.delete(sessionKey)
  }

  bridge.clearSessionPreferredModel(sessionKey)

  // sessionKey === conversationId，直接关闭对话
  try {
    bridge.conversationRepo.closeConversation(sessionKey)
  } catch (err) {
    log.error(`[conversation:close] failed to close conversation ${sessionKey}:`, err)
  }

  log.info(`[conversation:close] sessionKey=${sessionKey}`)
}

/**
 * 从单条消息的 content_json 中取出可展示的正文文本。
 *
 * assistant 消息以 `{type:'assistant_parts', parts:[...]}` 落库，正文散落在
 * `type:'text'` 的 part 里；旧数据/用户消息则是扁平的 `{type:'text', text}`。
 * 思考内容（thinking）与工具卡片（tool）不参与预览。
 */
export function extractPreviewText(contentJson: string): string {
  try {
    const parsed: unknown = JSON.parse(contentJson)
    if (!parsed || typeof parsed !== 'object') return ''
    const o = parsed as Record<string, unknown>

    if (Array.isArray(o.parts)) {
      return (o.parts as readonly unknown[])
        .filter((p): p is { type: string; text: string } => {
          const part = p as Record<string, unknown> | null
          return part?.type === 'text' && typeof part.text === 'string'
        })
        .map((p) => p.text.trim())
        .filter(Boolean)
        .join(' ')
        .trim()
    }

    if (typeof o.text === 'string') return o.text.trim()
    if (typeof o.content === 'string') return o.content.trim()
    return ''
  } catch {
    return ''
  }
}

/**
 * 从一个会话的最近消息中挑出「Agent 最后一条有文字的回复」作为列表预览。
 *
 * 末条消息常常是 tool_result 或纯工具调用的 assistant 消息（无正文），
 * 因此从后往前回溯，跳过无正文的消息；找不到 assistant 正文时回退到最后一条
 * 用户消息，避免整条会话显示「暂无消息」。
 *
 * @param messages - 该会话的最近消息，按时间正序
 */
export function resolveLastMessagePreview(
  messages: readonly { readonly role: string; readonly content_json: string }[],
): string | undefined {
  let userFallback = ''

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!msg) continue
    const text = extractPreviewText(msg.content_json)
    if (!text) continue
    // 压缩摘要（手动 `[对话摘要]` / 自动 `<conversation_summary>`）在 UI 里折叠成压缩卡片，
    // 不是真实对话内容，不能当预览
    if (isCompactSummaryText(text)) continue
    if (msg.role === 'assistant') return text.slice(0, PREVIEW_MAX_LENGTH)
    if (msg.role === 'user' && !userFallback) userFallback = text
  }

  return userFallback ? userFallback.slice(0, PREVIEW_MAX_LENGTH) : undefined
}

export function handleConversationList(
  bridge: AgentRuntimeBridge,
): readonly {
  id: string
  sessionKey: string
  title: string
  updatedAt: string
  agentId?: string
  lastMessagePreview?: string
  hasRunning?: boolean
  isPinned?: boolean
  wasInterrupted?: boolean
  channel?: string
}[] {
  const conversations = bridge.conversationRepo.listActiveConversations(LOCAL_USER_ID, 50)

  // 构建微信绑定的 conversationId 集合（用于渠道标记）
  const weixinConvIds = new Set<string>()
  if (deps!.weixinBindingManagerRef) {
    for (const binding of deps!.weixinBindingManagerRef.listBindings()) {
      weixinConvIds.add(binding.conversationId)
    }
  }

  // 批量查询所有会话的最近消息，避免 N+1 查询（50 会话 → 1 次 SQL）
  const conversationIds = conversations.map((c) => c.id)
  const lastMessagesMap = bridge.conversationRepo.loadLastMessagesForConversations(
    conversationIds,
    PREVIEW_SCAN_LIMIT,
  )

  return conversations.map((c) => {
    const messages = lastMessagesMap.get(c.id) ?? []
    const lastMessagePreview = resolveLastMessagePreview(messages)
    return {
      ...(lastMessagePreview ? { lastMessagePreview } : {}),
      id: c.id,
      sessionKey: c.id, // sessionKey 直接使用 conversationId，重启后不失效
      title: c.title ?? '新对话',
      updatedAt: c.last_msg_at ?? c.created_at,
      agentId: bridge.conversationRepo.getAgentParticipantId(c.id),
      hasRunning: bridge.hasStreamingMessages(c.id),
      isPinned: c.is_pinned === 1,
      wasInterrupted: bridge.isConversationInterrupted(c.id),
      channel: resolveConversationChannel(c.id, weixinConvIds),
    }
  })
}

export function handleConversationDelete(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'conversation:delete' }>,
): void {
  const { sessionKey } = command
  const instanceId = deps!.sessionToInstance.get(sessionKey)
  if (instanceId) {
    try {
      bridge.destroy(instanceId)
    } catch (err) {
      log.error(`[conversation:delete] failed to destroy instance ${instanceId}:`, err)
    }
    deps!.untrackInstanceRuns(instanceId)
    deps!.sessionToInstance.delete(sessionKey)
  }

  bridge.clearSessionPreferredModel(sessionKey)

  // 软删除该对话关联的所有文件
  try {
    const now = new Date()
    const conversationFiles = bridge.fileRepo.listByConversation(sessionKey)
    for (const f of conversationFiles) {
      bridge.fileRepo.softDelete(f.id, now)
    }
    if (conversationFiles.length > 0) {
      log.info(
        `[conversation:delete] soft-deleted ${conversationFiles.length} files for conversation ${sessionKey}`,
      )
    }
  } catch (err) {
    log.warn('[conversation:delete] failed to soft-delete files:', err)
  }

  // sessionKey === conversationId，直接从数据库删除对话
  // 不捕获异常 —— 让错误向上传播至 handleCommand / IPC handler，
  // 使渲染层能感知删除失败，避免假性成功导致重启后数据复现。
  bridge.conversationRepo.deleteConversation(sessionKey)

  log.info(`[conversation:delete] sessionKey=${sessionKey}`)
}

export function handleConversationRename(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'conversation:rename' }>,
): { success: boolean } {
  bridge.conversationRepo.updateTitle(command.sessionKey, command.newTitle)
  return { success: true }
}

export function handleConversationPinToggle(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'conversation:pin-toggle' }>,
): { isPinned: boolean } {
  const isPinned = bridge.conversationRepo.togglePinned(command.sessionKey)
  return { isPinned }
}

export function handleConversationMessages(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'conversation:messages' }>,
): {
  items: readonly ConversationHistoryMessage[]
  hasMore: boolean
  nextCursor?: { timestamp: string; id: string }
} {
  const { sessionKey, limit, before } = command
  const conversationId = sessionKey
  assertConversationExists(bridge, conversationId)
  bridge.setLastActiveConversation(conversationId)
  const page = bridge.conversationRepo.loadMessagesPage(conversationId, {
    limit: limit ?? CONVERSATION_PAGE_SIZE,
    ...(before ? { before } : {}),
  })

  const items = page.items.map((msg): ConversationHistoryMessage => {
    let contentText = ''
    let thinkingText: string | undefined
    let toolCalls:
      | Array<{
          id: string
          name: string
          args: Record<string, unknown>
          result?: unknown
          isError?: boolean
          textPositionAtStart?: number
        }>
      | undefined
    let sourceAgent: { instanceId: string; label: string } | undefined
    let isVoice: boolean | undefined
    let audioWavBase64: string | undefined
    try {
      const parsed =
        typeof msg.content_json === 'string' ? JSON.parse(msg.content_json) : msg.content_json
      if (parsed && typeof parsed === 'object') {
        if ((parsed as { isVoice?: unknown }).isVoice === true) isVoice = true
        const aw = (parsed as { audioWavBase64?: unknown }).audioWavBase64
        if (typeof aw === 'string' && aw.length > 0) audioWavBase64 = aw
      }
      // 仅工具调用、无正文的 assistant 回合 text 为空，此时不能兜到 JSON.stringify，
      // 否则 null 会渲染成字面量 "null"、tool_result 会渲染成整坨 JSON。
      contentText =
        typeof parsed === 'string'
          ? parsed
          : typeof parsed?.text === 'string'
            ? parsed.text
            : typeof parsed?.content === 'string'
              ? parsed.content
              : ''
      // 读取存库的 thinkingText（新格式）
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as { thinkingText?: unknown }).thinkingText === 'string'
      ) {
        thinkingText = (parsed as { thinkingText: string }).thinkingText || undefined
      }
      // 旧消息兜底：content_json 里没有 thinkingText 但 text 含 </think> 标签时实时解析
      if (!thinkingText && msg.role === 'assistant' && contentText.includes('</think>')) {
        const parsed2 = parseThinkTagsFromRaw(contentText)
        thinkingText = parsed2.thinkingText || undefined
        contentText = parsed2.finalText
      }
      const rawTools =
        parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { toolCalls?: unknown }).toolCalls)
          ? (parsed as { toolCalls: Array<Record<string, unknown>> }).toolCalls
          : undefined
      if (rawTools && rawTools.length > 0) {
        toolCalls = rawTools.map((t) => ({
          id: String(t.id ?? ''),
          name: String(t.name ?? ''),
          args: (t.args && typeof t.args === 'object' ? t.args : {}) as Record<string, unknown>,
          result: t.result,
          isError: Boolean(t.isError),
          textPositionAtStart:
            typeof t.textPositionAtStart === 'number' ? t.textPositionAtStart : undefined,
        }))
      }
      const rawSa =
        parsed && typeof parsed === 'object'
          ? (parsed as { sourceAgent?: unknown }).sourceAgent
          : undefined
      if (rawSa && typeof rawSa === 'object') {
        const sa = rawSa as Record<string, unknown>
        if (typeof sa.instanceId === 'string' && sa.instanceId) {
          sourceAgent = { instanceId: sa.instanceId, label: String(sa.label ?? sa.instanceId) }
        }
      }
    } catch {
      contentText = String(msg.content_json)
    }

    return {
      id: msg.id,
      role: msg.role,
      content: [{ type: 'text' as const, text: contentText }],
      // renderer 使用共享 parser 恢复 assistant_parts，保留旧 content 字段兼容历史消息。
      contentJson: msg.content_json,
      timestamp: new Date(msg.timestamp).getTime(),
      ...(msg.is_streaming === 1 ? { isStreaming: true } : {}),
      ...(msg.compacted_at ? { contextExcluded: true } : {}),
      ...(thinkingText ? { thinkingText } : {}),
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      ...(sourceAgent ? { sourceAgent } : {}),
      ...(isVoice ? { isVoice: true } : {}),
      ...(audioWavBase64 ? { audioWavBase64 } : {}),
    }
  })

  // 游标用 DB 原始 timestamp 字符串，避免 renderer 用毫秒时间戳回推 ISO 时产生偏差
  const oldest = page.items[0]
  return {
    items,
    hasMore: page.hasMore,
    ...(oldest ? { nextCursor: { timestamp: oldest.timestamp, id: oldest.id } } : {}),
  }
}

export function handleConversationContextUsage(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'conversation:context-usage' }>,
): unknown {
  assertConversationExists(bridge, command.sessionKey)
  return bridge.getSessionContextUsage(command.sessionKey)
}

export function handleConversationDismissInterrupt(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'conversation:dismiss-interrupt' }>,
): { ok: boolean } {
  bridge.clearInterruptMarker(command.sessionKey)
  return { ok: true }
}

export async function handleConversationContinueInterrupted(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'conversation:continue-interrupted' }>,
): Promise<{ ok: boolean; error?: string }> {
  const { sessionKey } = command
  bridge.clearInterruptMarker(sessionKey)

  try {
    const instanceId = await deps!.getInstanceForSession(bridge, sessionKey)
    if (!instanceId) {
      return { ok: false, error: 'Failed to get or create agent instance for interrupted session' }
    }

    const CONTINUATION_PROMPT =
      '你的上一次执行被中断了（客户端重启）。' +
      '请查看上面的对话历史，了解你已经完成了什么，然后继续完成剩余的任务。' +
      '注意：已经执行过的操作不要重复执行。'

    // 持久化 continuation prompt 到 DB
    const msgId = `cont-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    try {
      bridge.conversationRepo.saveMessage({
        id: msgId,
        conversationId: sessionKey,
        role: 'user',
        contentJson: { type: 'text', text: CONTINUATION_PROMPT },
      })
    } catch (err) {
      log.error(`[continue-interrupted] failed to save continuation message:`, err)
    }

    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    deps!.trackRunInstance(runId, instanceId)

    // 必须走 SessionManager.sendPrompt（含 beforePrompt 历史恢复），不可直接 bridge.prompt
    deps!
      .getIpcChannelAdapter(bridge)
      .sendPrompt(instanceId, sessionKey, CONTINUATION_PROMPT, undefined, msgId)
      .catch((err) => {
        log.error(`[continue-interrupted] prompt failed:`, err)
      })

    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`[continue-interrupted] error:`, err)
    return { ok: false, error: msg }
  }
}

export async function handleConversationFork(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'conversation:fork' }>,
): Promise<{ success: boolean; sessionKey?: string; error?: string }> {
  const { sourceSessionKey, uptoMessageId, newContent } = command
  try {
    const agentId = bridge.conversationRepo.getAgentParticipantId(sourceSessionKey)
    const newSessionKey = bridge.conversationRepo.forkConversation({
      sourceConversationId: sourceSessionKey,
      uptoMessageId,
      newUserContent: newContent,
      userId: LOCAL_USER_ID,
      agentId,
    })
    log.info(`[conversation:fork] ${sourceSessionKey} → ${newSessionKey}`)
    return { success: true, sessionKey: newSessionKey }
  } catch (err) {
    log.error(`[conversation:fork] failed:`, err)
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 根据会话 ID / 微信绑定推断渠道标记。
 * - wechat：微信绑定会话，或 id 以 weixin: 开头
 * - wecom / feishu：id 前缀
 * - default：其余（含客户端本地新建）
 */
function resolveConversationChannel(
  conversationId: string,
  weixinConvIds: Set<string>,
): 'default' | 'wechat' | 'wecom' | 'feishu' {
  if (weixinConvIds.has(conversationId) || conversationId.startsWith('weixin:')) {
    return 'wechat'
  }
  if (conversationId.startsWith('wecom:')) return 'wecom'
  if (conversationId.startsWith('feishu:')) return 'feishu'
  return 'default'
}
