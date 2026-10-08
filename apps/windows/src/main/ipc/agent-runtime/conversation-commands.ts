/**
 * Conversation (会话) 命令处理器
 *
 * 提取自 agent-runtime-ipc.ts
 */

import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import { parseThinkTagsFromRaw } from '../../agent-runtime/event-converter'
import { isCompactSummaryText } from '../../../shared/compact-summary-text'
import { isEvolutionConversationId } from '@mtbot/agent-runtime'
import { resolveChannelIdentity } from '../../channel/channel-identity'
import { acpSessionStateKey } from '../../coding-dev-acp-run.js'
import { normalizeAgentIdForBinding } from '../../coding-dev-env.js'
import { deriveConversationTitleFromUserText } from '../../../shared/conversation-title'

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

/** 启动后是否已跑过一次会话维护（清空会话 + 修旧标题，见 handleConversationList） */
let startupConversationMaintenanceDone = false

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

  // 新会话一出，之前被搁置的空会话（点了「新建对话」却没发消息）就没必要留了。
  purgeEmptyConversations(bridge)

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
function resolveLastMessagePreview(
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

/**
 * 会话列表里的 Agent 归属归一化。
 *
 * `ensureConversationExists` 建的会话（渠道 / 定时任务 / 自主进化）参与者写的是内部标记
 * `'main'`（主 Agent 实例，见 bridge-instance-factory 对 def.id === 'main' 的处理），
 * 不是用户可见的 Agent id。直接透给渲染层，侧栏会据此多出一个名叫「main」的分组，
 * 与「默认」分组重复 —— 语义上 `'main'` 就是系统默认 Agent。
 */
function normalizeConversationAgentId(agentId: string | undefined): string | undefined {
  if (!agentId) return undefined
  return agentId === 'main' ? 'assistant' : agentId
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
  // 启动后第一次拉列表时做一次会话维护（清历史遗留的空会话、修带字面省略号的旧标题）。
  // 只做一次：不能放在每次 list 里，否则会把用户正在输入的空会话也删掉。
  if (!startupConversationMaintenanceDone) {
    startupConversationMaintenanceDone = true
    purgeEmptyConversations(bridge)
    repairTruncatedTitles(bridge)
  }

  // 侧栏按「默认 / 渠道 / 系统」三个 tab 分组展示。这里不能设全局 LIMIT：
  // 否则数量最多的「默认」会话会把「渠道」「系统」会话挤出列表（重启后这些会话的
  // last_msg_at 靠后即从侧栏消失）。预览走 loadLastMessagesForConversations 单次
  // 窗口函数批量查询，全量返回不产生 N+1。
  const conversations = bridge.conversationRepo.listActiveConversations(LOCAL_USER_ID)

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
      agentId: normalizeConversationAgentId(bridge.conversationRepo.getAgentParticipantId(c.id)),
      hasRunning: bridge.hasStreamingMessages(c.id),
      isPinned: c.is_pinned === 1,
      wasInterrupted: bridge.isConversationInterrupted(c.id),
      channel: resolveConversationChannel(c.id, weixinConvIds, c.channel_type),
    }
  })
}

export function handleConversationDelete(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'conversation:delete' }>,
): void {
  const { sessionKey } = command
  if (isEvolutionConversationId(sessionKey)) {
    log.warn(`[conversation:delete] 拒绝删除自主进化会话 sessionKey=${sessionKey}`)
    throw new Error('拒绝删除自主进化会话')
  }
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

  // 清理该会话的 CLI 续接键（4 个 ACP 后端各一条；键由 coding-dev-acp-run 维护）
  for (const backendId of ['claude', 'codex', 'cursor', 'opencode'] as const) {
    try {
      bridge.runtimeStateRepo.delete(acpSessionStateKey(backendId, sessionKey))
    } catch {
      /* runtimeStateRepo 未初始化等场景忽略 */
    }
  }

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

  // 工作记忆分段同样要跟着会话走。
  // messages 有 ON DELETE CASCADE，memory_segments 建表早于该约束、加不上外键，
  // 只能显式清 —— 不清就是孤儿行，且会一直留在库里（SummarizationQueue 扫到后会因
  // 回读不到原文而标 summarised，不算出错，但查会话数与统计时会露馅）。
  // 放在 deleteConversation 之前：删不掉会话时不该先把段删了。
  try {
    bridge.segmentRepo.deleteByConversation(sessionKey)
  } catch (err) {
    log.warn('[conversation:delete] 清理记忆分段失败:', err)
  }

  // sessionKey === conversationId，直接从数据库删除对话
  // 不捕获异常 —— 让错误向上传播至 handleCommand / IPC handler，
  // 使渲染层能感知删除失败，避免假性成功导致重启后数据复现。
  bridge.conversationRepo.deleteConversation(sessionKey)

  log.info(`[conversation:delete] sessionKey=${sessionKey}`)
}

/**
 * 清理「空会话」：用户点了「新建对话」却一条消息都没发过的本地会话，留库没有价值
 * ——侧栏只会堆出一排「新对话」，谁也分不清。
 *
 * 复用单会话删除的清理路径（销毁实例 / 清偏好 / 清 ACP 续接键 / 清记忆分段），
 * 避免只删 conversations 行留下孤儿数据。
 *
 * 只清本地会话；渠道与系统会话由 `listEmptyConversationIds` 排除在外。
 * 自主进化会话即便为空也跳过（归属由进化机制固定）。
 *
 * @returns 实际删除的会话数
 */
export function purgeEmptyConversations(bridge: AgentRuntimeBridge): number {
  // 测试替身与老 Bridge 可能没有这个方法；缺了就静默跳过，不影响主流程。
  const repo = bridge.conversationRepo as {
    listEmptyConversationIds?: (userId: string) => readonly string[]
  }
  if (typeof repo.listEmptyConversationIds !== 'function') return 0

  let ids: readonly string[]
  try {
    ids = repo.listEmptyConversationIds(LOCAL_USER_ID)
  } catch (err) {
    log.warn('[purgeEmptyConversations] 查询空会话失败:', err)
    return 0
  }

  let removed = 0
  for (const id of ids) {
    if (isEvolutionConversationId(id)) continue
    try {
      handleConversationDelete(bridge, { type: 'conversation:delete', sessionKey: id })
      removed++
    } catch (err) {
      log.warn(`[purgeEmptyConversations] 删除空会话失败 id=${id}:`, err)
    }
  }
  if (removed > 0) {
    log.info(`[purgeEmptyConversations] 已清理 ${removed} 个空会话`)
  }
  return removed
}

/**
 * 修「标题里带字面省略号」的历史数据。
 *
 * 旧版把标题砍到 18 字再补「...」，省略号被写进了库。原文没丢——就在首条用户消息里
 * ——按新规则（不截断、不拼接）重算即可。只处理标题确实以「...」结尾的会话；重算结果
 * 为空或仍是占位符时跳过，避免把空会话改成「新对话」。
 *
 * @returns 实际修正的会话数
 */
export function repairTruncatedTitles(bridge: AgentRuntimeBridge): number {
  const repo = bridge.conversationRepo as {
    listTruncatedTitleFirstMessages?: (
      userId: string,
    ) => readonly { id: string; contentJson: string }[]
  }
  if (typeof repo.listTruncatedTitleFirstMessages !== 'function') return 0

  let rows: readonly { id: string; contentJson: string }[]
  try {
    rows = repo.listTruncatedTitleFirstMessages(LOCAL_USER_ID)
  } catch (err) {
    log.warn('[repairTruncatedTitles] 查询带省略号标题失败:', err)
    return 0
  }

  let fixed = 0
  for (const row of rows) {
    const title = deriveConversationTitleFromUserText(extractPreviewText(row.contentJson))
    if (!title || title === '新对话') continue
    try {
      bridge.conversationRepo.updateTitle(row.id, title)
      fixed++
    } catch (err) {
      log.warn(`[repairTruncatedTitles] 更新标题失败 id=${row.id}:`, err)
    }
  }
  if (fixed > 0) {
    log.info(`[repairTruncatedTitles] 已修复 ${fixed} 个带省略号的旧标题`)
  }
  return fixed
}

/** 自动标题：交给模型的用途标签 */
const AUTO_TITLE_PURPOSE = 'conversation_title'
/** 自动标题硬上限（模型被要求 ≤12 字，这里只是护栏，不拼接省略号） */
const AUTO_TITLE_MAX_CHARS = 18

/**
 * 自动标题刷新节奏：首轮命名之后，每积累这么多条用户消息再刷新一次。
 *
 * 会话话题常在开头几轮才浮出水面——「先闲聊、后切正题」的会话若只命名一次，
 * 侧栏会长期挂着泛泛的旧标题。取 4：够密，能跟上话题迁移；又远低于逐轮调用，
 * 不额外烧模型。
 */
const AUTO_TITLE_REFRESH_EVERY = 4

/** 记录「我们自动写过的标题」的 KV 键：{ conversationId: title } */
const AUTO_TITLES_KEY = 'conversation:titles:auto'
/** 记录条数上限，避免 KV 无界增长（超出按写入顺序淘汰最旧的） */
const AUTO_TITLES_MAX = 300
/** 刷新标题时回看的历史用户消息条数 */
const AUTO_TITLE_CONTEXT_MESSAGES = 6

/** 读「自动写过标题」的表；bridge 未初始化 / 结构异常（测试替身）时返回空表 */
function readAutoTitles(bridge: AgentRuntimeBridge): Record<string, string> {
  try {
    return bridge.runtimeStateRepo.getJson<Record<string, string>>(AUTO_TITLES_KEY) ?? {}
  } catch {
    return {}
  }
}

/** 记住某会话的最新自动标题；写失败只记日志，不影响命名本身 */
function rememberAutoTitle(
  bridge: AgentRuntimeBridge,
  conversationId: string,
  title: string,
): void {
  try {
    const map = readAutoTitles(bridge)
    delete map[conversationId]
    map[conversationId] = title
    const keys = Object.keys(map)
    for (const stale of keys.slice(0, Math.max(0, keys.length - AUTO_TITLES_MAX))) {
      delete map[stale]
    }
    bridge.runtimeStateRepo.setJson(AUTO_TITLES_KEY, map)
  } catch (err) {
    log.warn('[rememberAutoTitle] 持久化自动标题失败:', err)
  }
}

/** 系统会话（自主进化 / 定时任务）不参与标题刷新，避免给自动化轮次白烧模型调用 */
function isSystemConversation(conversationId: string): boolean {
  return isEvolutionConversationId(conversationId) || conversationId.startsWith('cron:')
}

/** 取刷新命名的素材：最近若干条用户消息（新 → 旧倒回正序），拼接成一段 */
function collectRecentUserText(
  repo: AgentRuntimeBridge['conversationRepo'],
  conversationId: string,
  fallback: string,
): string {
  if (typeof repo.listRecentUserMessageContentJsons !== 'function') return fallback
  const texts = repo
    .listRecentUserMessageContentJsons(conversationId, AUTO_TITLE_CONTEXT_MESSAGES)
    .map((json) => extractPreviewText(json))
    .filter((text) => text.trim())
  return texts.length > 0 ? texts.reverse().join('\n') : fallback
}

/**
 * 让模型把会话概括成一句短标题，并在会话推进中定期刷新。
 *
 * 标题来源分两类：用户手动改的（神圣不可覆盖）与我们自动写的。为区分两者，
 * 每次自动命名都把结果记进 `runtimeStateRepo`（见 [[rememberAutoTitle]]）——
 * 落库标题既不等于启发式默认值、也不等于我们上次写的值，即视为人工命名。
 *
 * 两条护栏：
 * - **触发点**：首轮（此时标题还是启发式默认值）与之后每满 REFRESH_EVERY 条用户消息；
 * - **人工命名退出**：一旦检测到用户改过名，本会话再不自作主张。
 *
 * 旁路执行，失败只记日志，不影响会话。
 */
export async function maybeGenerateConversationTitle(
  bridge: AgentRuntimeBridge,
  conversationId: string,
  assistantText: string,
): Promise<void> {
  try {
    const repo = bridge.conversationRepo
    const userCount = repo.countUserMessages(conversationId)
    const isFirstTurn = userCount === 1
    const isRefresh = userCount > 1 && userCount % AUTO_TITLE_REFRESH_EVERY === 0
    if (!isFirstTurn && !isRefresh) return
    // 刷新只服务真人会话；自主进化 / 定时任务的轮次不额外命名
    if (isRefresh && isSystemConversation(conversationId)) return

    const conv = repo.getConversation(conversationId)
    if (!conv) return
    const channel = conv.channel_type
    if (channel && channel !== 'ipc') return

    const firstUserContent = repo.getFirstUserMessageContentJson(conversationId)
    const firstUserText = firstUserContent ? extractPreviewText(firstUserContent) : ''
    if (!firstUserText.trim()) return

    // 自动管理判据：仍是占位 / 启发式默认值，或等于我们上次自动写入的值
    const derived = deriveConversationTitleFromUserText(firstUserText)
    const autoTitle = readAutoTitles(bridge)[conversationId]
    const autoManaged =
      isStillAutoTitle(conv.title, derived) || (!!autoTitle && conv.title === autoTitle)
    if (!autoManaged) return

    // 首轮用第一句（此时尚无更多上下文）；刷新时回看最近几条用户消息，跟上话题迁移
    const sourceText = isFirstTurn
      ? firstUserText
      : collectRecentUserText(repo, conversationId, firstUserText)

    const aiTitle = await generateTitleWithLlm(bridge, sourceText, assistantText)
    if (!aiTitle) return

    // 生成期间用户可能改了名 / 又来了新消息，落库前再确认一次
    const latest = repo.getConversation(conversationId)
    if (!latest) return
    const stillAuto =
      isStillAutoTitle(latest.title, derived) || (!!autoTitle && latest.title === autoTitle)
    if (!stillAuto) return
    if (latest.title === aiTitle) return

    repo.updateTitle(conversationId, aiTitle)
    rememberAutoTitle(bridge, conversationId, aiTitle)
    bridge.forwardIpcEvent({
      type: 'conversation:updated',
      sessionKey: conversationId,
      title: aiTitle,
    })
    log.info(
      `[maybeGenerateConversationTitle] conv=${conversationId} userCount=${userCount} 标题 → "${aiTitle}"`,
    )
  } catch (err) {
    log.warn('[maybeGenerateConversationTitle] 生成会话标题失败:', err)
  }
}

/** 标题是否仍处于「自动生成」状态（空 / 占位符 / 等于启发式默认值） */
function isStillAutoTitle(title: string | null | undefined, derived: string): boolean {
  const t = title?.trim()
  return !t || t === '新对话' || t === derived
}

async function generateTitleWithLlm(
  bridge: AgentRuntimeBridge,
  userText: string,
  assistantText: string,
): Promise<string> {
  const prompt =
    '你是会话标题生成器。根据下面这段对话内容，用不超过 12 个字概括会话主题，作为会话标题。\n' +
    '只输出标题本身：不要引号、不要句末标点、不要解释、不要换行。\n\n' +
    `【用户】${userText.slice(0, 500)}\n【助手】${assistantText.slice(0, 500)}`
  const raw = await bridge.callLLM(prompt, undefined, AUTO_TITLE_PURPOSE)
  return sanitizeGeneratedTitle(raw)
}

/** 清洗模型输出：取首个非空行、剥掉包裹的引号/括号与首尾标点、压空白、限长 */
function sanitizeGeneratedTitle(raw: string): string {
  const line = (raw ?? '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean)
    ?.replace(/^[\s"'“”‘’《》【】()（）\[\]]+/, '')
    .replace(/[\s"'“”‘’《》【】()（）\[\]。，、.!?！？:：;；]+$/, '')
  const title = line ? line.replace(/\s+/g, ' ').trim() : ''
  return title.length > AUTO_TITLE_MAX_CHARS ? title.slice(0, AUTO_TITLE_MAX_CHARS) : title
}

/**
 * 切换 Agent = 转移当前会话：更新会话的 Agent 归属，保留历史消息。
 * - 拒绝自主进化会话（归属由进化机制固定）；
 * - 会话回复中拒绝（避免实例切换竞态）；
 * - 销毁旧 Agent 实例并清 CLI 续接键，下条消息由新 Agent 重新建实例。
 * 注：会话级 dev-context（/claude 等）是会话属性，转移时保留。
 */
export function handleConversationTransferAgent(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'conversation:transfer-agent' }>,
): { ok: boolean } {
  const { sessionKey } = command
  if (isEvolutionConversationId(sessionKey)) {
    log.warn(`[conversation:transfer-agent] 拒绝转移自主进化会话 sessionKey=${sessionKey}`)
    throw new Error('拒绝转移自主进化会话')
  }
  if (sessionKey.startsWith('cron:')) {
    log.warn(`[conversation:transfer-agent] 拒绝转移定时任务会话 sessionKey=${sessionKey}`)
    throw new Error('定时任务会话的归属由任务定义决定，无法手动切换 Agent')
  }
  assertConversationExists(bridge, sessionKey)
  if (bridge.hasStreamingMessages(sessionKey)) {
    throw new Error('会话正在回复中，请稍后再切换 Agent')
  }

  const targetAgentId = command.agentId ?? 'default'
  const currentAgentId = bridge.conversationRepo.getAgentParticipantId(sessionKey)
  // 'default' 与 'assistant' 是「系统默认」Agent 的两种存法，归一化后比较避免无谓的实例销毁
  if (
    currentAgentId &&
    normalizeAgentIdForBinding(currentAgentId) === normalizeAgentIdForBinding(targetAgentId)
  ) {
    return { ok: true }
  }

  const instanceId = deps!.sessionToInstance.get(sessionKey)
  if (instanceId) {
    try {
      bridge.destroy(instanceId)
    } catch (err) {
      log.error(`[conversation:transfer-agent] failed to destroy instance ${instanceId}:`, err)
    }
    deps!.untrackInstanceRuns(instanceId)
    deps!.sessionToInstance.delete(sessionKey)
  }

  bridge.clearSessionPreferredModel(sessionKey)

  // 清 CLI 续接键：旧 CLI 会话带着旧 Agent 的上下文，不能给新 Agent 续接
  for (const backendId of ['claude', 'codex', 'cursor', 'opencode'] as const) {
    try {
      bridge.runtimeStateRepo.delete(acpSessionStateKey(backendId, sessionKey))
    } catch {
      /* runtimeStateRepo 未初始化等场景忽略 */
    }
  }

  bridge.conversationRepo.updateAgentParticipant(sessionKey, targetAgentId)

  log.info(
    `[conversation:transfer-agent] sessionKey=${sessionKey} ${currentAgentId ?? '(none)'} → ${targetAgentId}`,
  )
  return { ok: true }
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
    let isSteer: boolean | undefined
    try {
      const parsed =
        typeof msg.content_json === 'string' ? JSON.parse(msg.content_json) : msg.content_json
      if (parsed && typeof parsed === 'object') {
        if ((parsed as { isVoice?: unknown }).isVoice === true) isVoice = true
        // 中途插话：落库时打了标记，重开会话/翻历史要靠它把「插话」徽标还原出来
        if ((parsed as { isSteer?: unknown }).isSteer === true) isSteer = true
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
      ...(isSteer ? { isSteer: true } : {}),
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
 * 根据会话归属 / 微信绑定推断渠道标记。
 *
 * 归属优先读 `conversations.channel_type`（V41 落库，10-S2）——id 前缀只说明会话从哪来，
 * 不说明此刻谁在说话；前缀仅作老库回退。微信 `/link` 绑定是**路由**不是归属，
 * 但它决定了「这条会话最近由微信在用」，故仍覆盖显示（用户按这个认知找会话）。
 *
 * - wechat / wecom / feishu / qbot：渠道会话
 * - cron：定时任务专属会话（cron:<jobId>）
 * - evolution：自主进化内心独白会话（evolution:main）
 * - default：其余（含客户端本地新建）
 *
 * TODO(07-新手指引)：`onboarding:` 向导会话落地后需要自己的归类——归进 `default`
 * 会与用户自己的会话混在同一个 tab（评审 P2-8 的守卫 d 项）。
 */
export function resolveConversationChannel(
  conversationId: string,
  weixinConvIds: Set<string>,
  storedOwnership?: string | null,
): 'default' | 'wechat' | 'wecom' | 'feishu' | 'qbot' | 'pcwechat' | 'cron' | 'evolution' {
  if (weixinConvIds.has(conversationId) || conversationId.startsWith('weixin:')) {
    return 'wechat'
  }
  const { ownership } = resolveChannelIdentity(conversationId, storedOwnership)
  switch (ownership) {
    case 'weixin':
      return 'wechat'
    case 'wecom':
      return 'wecom'
    case 'feishu':
      return 'feishu'
    case 'qbot':
      return 'qbot'
    // 本机微信（盯梢/代聊）：助手在这台电脑上以用户身份跟好友说话，与 weixin 方向相反
    case 'pcwechat':
      return 'pcwechat'
    case 'cron':
      return 'cron'
    case 'evolution':
      return 'evolution'
    default:
      return 'default'
  }
}
