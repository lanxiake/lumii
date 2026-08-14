import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Loading } from '../../../../components/ui/Loading/Loading'
import { ChatMessage } from '../ChatMessage'
import { ApprovalCard } from '../ApprovalCard'
import { PlanApprovalCard } from '../PlanApprovalCard'
import { TypingIndicator } from '../TypingIndicator'
import { EmptyState } from '../EmptyState'
import { CompactionCard } from '../CompactionCard'
import { TodoPanel } from '../TodoPanel'
import type { ChatSession, ChatMessage as ChatMessageType, AgentWorkflowItem, ToolCall } from '../../../../hooks/business/useChat'
import type { AssistantPart, FileChangeEntry } from '@mtbot/agent-runtime/browser'
import { mergeAssistantParts, mergeFileChanges } from './mergeAssistantParts'
import type { ExecApprovalRequest, ExecApprovalDecision } from '../../../../types/exec-approvals'
import type { PlanApprovalRequest } from '../../../../types/plan-approval'
import type { RuntimeFileEvent, RuntimeCompactionEvent } from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'
import { isCompactSummaryText, unwrapCompactSummaryText } from '../../../../../shared/compact-summary-text'
import styles from './ChatContainer.module.css'

interface ApprovalItem {
  id: string
  itemType: 'approval'
  approval: ExecApprovalRequest
  decision?: ExecApprovalDecision
  resolvedBy?: string
  timestamp: Date
  /** 关联的会话 Key（serverKey 或本地 sessionId），用于会话隔离过滤 */
  sessionKey?: string
}

interface PlanApprovalItem {
  id: string
  itemType: 'plan-approval'
  request: PlanApprovalRequest
  decision?: 'approved' | 'rejected'
  timestamp: Date
  /** 关联的会话 Key（serverKey 或本地 sessionId），用于会话隔离过滤 */
  sessionKey?: string
}

interface MessageItem {
  itemType: 'message'
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  isStreaming?: boolean
  isAborted?: boolean
  error?: string
  /** 关联的 runId，用于查找对应工具调用 */
  runId?: string
  /** 消息内嵌工具调用（本地 Runtime 模式下填充） */
  toolCalls?: readonly ToolCall[]
  /** Token 用量 */
  usage?: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number }
  /** 思考过程文字 */
  thinkingText?: string
  streamMetrics?: { durationMs: number; tokensPerSecond: number }
  llmError?: { code: string; message: string; retryable: boolean }
  /** 本地 Runtime：本轮回复使用的热记忆 */
  injectedMemories?: readonly { id: string; content: string; category: string }[]
  /** 本地 Runtime：子 Agent 嵌套气泡 */
  sourceAgent?: { instanceId: string; label: string }
  /** ACP 后端标识（Cursor / Claude Code 等） */
  acpBackendLabel?: string
  /** 是否为语音识别消息 */
  isVoice?: boolean
  /** 原始录音 WAV base64，用于气泡点击回放 */
  audioWavBase64?: string
  /** 助手消息结构化时间线 */
  parts?: readonly AssistantPart[]
  /** 本轮助手回复关联的文件变更 */
  fileChanges?: readonly FileChangeEntry[]
}

interface CompactionItem {
  itemType: 'compaction'
  id: string
  timestamp: Date
  tokensBefore: number
  tokensAfter: number
  messagesRemoved: number
  messagesBefore?: number
  messagesAfter?: number
  summaryText?: string
}

type ChatItem = MessageItem | ApprovalItem | PlanApprovalItem | CompactionItem

interface ChatContainerProps {
  session: ChatSession | null
  approvalItems: ApprovalItem[]
  planApprovalItems?: PlanApprovalItem[]
  workflowItems: AgentWorkflowItem[]
  isLoading: boolean
  isStreaming: boolean
  isSending: boolean
  resolvingIds: Set<string>
  planResolvingIds?: Set<string>
  formatTime: (date: Date) => string
  onApprovalDecision: (id: string, decision: ExecApprovalDecision) => void
  onPlanApprove?: (requestId: string) => void
  onPlanReject?: (requestId: string, feedback?: string) => void
  onCopyMessage?: (content: string) => void
  onEditMessage?: (messageId: string, newContent: string) => void
  onDeleteMessage?: (messageId: string) => void
  onRegenerateMessage?: (messageId: string) => void
  onSuggestionClick?: (suggestion: string) => void
  /**
   * 本地 Agent Runtime：当前轮次流式思考文本（与最后一条 assistant 气泡同步展示）
   */
  streamingThinkingText?: string
  /** Agent 在本次会话内生成的文件事件列表，按 messageId 与消息关联 */
  fileEvents?: readonly RuntimeFileEvent[]
  /** 本次会话的上下文压缩事件，按 timestamp 插入对话流，渲染为压缩卡片 */
  compactionEvents?: readonly RuntimeCompactionEvent[]
  /** 当前登录用户 ID，用于文件 IPC 操作 */
  userId?: string
  /** 从指定消息开始回放对话 */
  onReplayFromMessage?: (messageId: string) => void
  /** 当前正在回放的消息 ID（用于高亮显示） */
  replayMessageId?: string | null
  /** 当前会话 todo 工具调用（渲染为对话流内轻量任务卡） */
  todoCalls?: readonly {
    id: string
    name: string
    status: 'running' | 'completed' | 'failed' | 'error'
    result?: unknown
    output?: unknown
  }[]
  /** 点击回合文件变更卡「查看」：透传文件相对路径与状态，交由上层打开 Workbench 并定位 */
  onReviewFileChanges?: (path: string, status: 'added' | 'modified' | 'deleted') => void
}

/**
 * 从对话消息抽出压缩摘要正文；命中则这条消息应折叠进压缩卡片，不再当普通气泡。
 */
function extractCompactSummaryFromMessage(item: MessageItem): string | null {
  const texts: string[] = []
  if (item.content) texts.push(item.content)
  for (const part of item.parts ?? []) {
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
  }
  for (const text of texts) {
    if (isCompactSummaryText(text)) return unwrapCompactSummaryText(text)
  }
  return null
}

const ChatContainer: React.FC<ChatContainerProps> = ({
  session,
  approvalItems,
  planApprovalItems = [],
  workflowItems,
  isLoading,
  isStreaming,
  isSending,
  resolvingIds,
  planResolvingIds = new Set(),
  formatTime,
  onApprovalDecision,
  onPlanApprove,
  onPlanReject,
  onCopyMessage,
  onEditMessage,
  onDeleteMessage,
  onRegenerateMessage,
  onSuggestionClick,
  streamingThinkingText,
  fileEvents,
  compactionEvents,
  userId,
  onReplayFromMessage,
  replayMessageId,
  todoCalls = [],
  onReviewFileChanges,
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  // 用户是否"粘在底部"：true=自动跟随滚动；false=用户往上滚了，暂停自动滚
  const stickToBottomRef = useRef<boolean>(true)
  // 提示"回到最新消息"按钮是否展示
  const [showScrollToLatest, setShowScrollToLatest] = useState<boolean>(false)

  // 会话切换检测：记录 id 变化的时间戳，在切换后 300ms 内的所有 render
  // 都禁用消息弹跳动画。
  // 原因：switchSession 触发一次 runtimeStore.setState，但 ChatPage 有两个
  // 独立的 useSyncExternalStore 订阅（currentSessionKey + messages），
  // React 可能将它们拆成两次 render：第一次 id 已变但 messages 还是旧的，
  // 第二次 messages 才换成新会话的——若只在 id 变化的那帧禁用动画，
  // 第二帧新消息 mount 时动画又重新播放，造成二次弹出。
  // 用时间窗口（而非单帧）覆盖两次 render，彻底消除闪动。
  const switchTimestampRef = useRef<number>(0)
  const prevSessionIdRef = useRef<string | undefined>(undefined)
  if (prevSessionIdRef.current !== session?.id) {
    prevSessionIdRef.current = session?.id
    switchTimestampRef.current = Date.now()
  }
  const noEnterMessages = Date.now() - switchTimestampRef.current < 300

  /** 滚动到最底部（内部方法：不检查 stick 状态） */
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior })
  }, [])

  /**
   * 检测滚动容器当前是否接近底部（阈值 40px）
   * 在底部附近则视为"粘底"，会继续自动跟随最新消息。
   */
  const isNearBottom = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return true
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    return distanceFromBottom < 40
  }, [])

  /** 用户滚动时更新 stick 状态：一旦离开底部就暂停自动跟随 */
  const handleScroll = useCallback(() => {
    const near = isNearBottom()
    stickToBottomRef.current = near
    setShowScrollToLatest(!near)
  }, [isNearBottom])

  // 切换会话或首次挂载时，若已有消息则静默滚动到底部（并重置 stick 为 true）
  useEffect(() => {
    if (session?.messages && session.messages.length > 0) {
      stickToBottomRef.current = true
      setShowScrollToLatest(false)
      scrollToBottom('auto')
    }
  }, [session?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // 新消息/流式更新时：仅当用户仍"粘底"时才自动滚动，
  // 避免用户向上查看历史时被强制拉回底部（问题5）
  useEffect(() => {
    if (stickToBottomRef.current) {
      scrollToBottom()
    }
  }, [session?.messages, approvalItems, planApprovalItems, workflowItems, scrollToBottom])

  // 按 messageId 分组文件事件，用于关联到对应的 assistant 消息
  const filesByMessageId = useMemo(() => {
    const map = new Map<string, RuntimeFileEvent[]>()
    if (!fileEvents) return map
    for (const f of fileEvents) {
      if (!f.messageId) continue
      const existing = map.get(f.messageId) ?? []
      existing.push(f)
      map.set(f.messageId, existing)
    }
    return map
  }, [fileEvents])

  // 按 runId 分组 workflow items，用于关联到对应的 assistant 消息
  const workflowByRunId = useMemo(() => {
    const map = new Map<string, AgentWorkflowItem[]>()
    for (const item of workflowItems) {
      if (!item.runId) continue
      const existing = map.get(item.runId) || []
      existing.push(item)
      map.set(item.runId, existing)
    }
    return map
  }, [workflowItems])

  // Convert session messages to ChatItem format
  const messages: MessageItem[] = useMemo(() => {
    return (session?.messages || [])
      .filter((msg) => !(msg as { hidden?: boolean }).hidden)
      .map((msg) => ({
        itemType: 'message' as const,
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: new Date(msg.timestamp),
        isStreaming: msg.isStreaming,
        isAborted: msg.isAborted,
        error: msg.error,
        runId: msg.runId,
        toolCalls: msg.toolCalls,
        usage: (msg as { usage?: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number } }).usage,
        thinkingText: (msg as { thinkingText?: string }).thinkingText,
        streamMetrics: (msg as { streamMetrics?: { durationMs: number; tokensPerSecond: number } }).streamMetrics,
        llmError: (msg as { llmError?: { code: string; message: string; retryable: boolean } }).llmError,
        injectedMemories: (msg as { injectedMemories?: MessageItem['injectedMemories'] }).injectedMemories,
        sourceAgent: (msg as { sourceAgent?: MessageItem['sourceAgent'] }).sourceAgent,
        acpBackendLabel: (msg as { acpBackendLabel?: string }).acpBackendLabel,
        isVoice: (msg as { isVoice?: boolean }).isVoice,
        audioWavBase64: (msg as { audioWavBase64?: string }).audioWavBase64,
        parts: (msg as { parts?: readonly AssistantPart[] }).parts,
        fileChanges: (msg as { fileChanges?: readonly FileChangeEntry[] }).fileChanges,
      }))
  }, [session?.messages])

  // Find the latest assistant message for regenerate functionality
  const latestAssistantMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && !extractCompactSummaryFromMessage(messages[i])) {
        return messages[i].id
      }
    }
    return null
  }, [messages])

  /**
   * 压缩事件 → 卡片；落库的摘要气泡折叠进卡片（刷新后无事件时用摘要消息合成卡片）。
   */
  const compactionItems: CompactionItem[] = useMemo(() => {
    const cards: CompactionItem[] = (compactionEvents ?? []).map((e) => ({
      itemType: 'compaction' as const,
      id: e.id,
      timestamp: new Date(e.timestamp),
      tokensBefore: e.tokensBefore,
      tokensAfter: e.tokensAfter,
      messagesRemoved: e.messagesRemoved,
      messagesBefore: e.messagesBefore,
      messagesAfter: e.messagesAfter,
      ...(e.summaryText ? { summaryText: e.summaryText } : {}),
    }))

    const leftovers: Array<{ timestamp: Date; text: string }> = []
    for (const msg of messages) {
      const text = extractCompactSummaryFromMessage(msg)
      if (text) leftovers.push({ timestamp: msg.timestamp, text })
    }

    for (const leftover of leftovers) {
      let best: CompactionItem | undefined
      let bestDist = Number.POSITIVE_INFINITY
      for (const card of cards) {
        if (card.summaryText) continue
        const dist = Math.abs(card.timestamp.getTime() - leftover.timestamp.getTime())
        if (dist < bestDist) {
          best = card
          bestDist = dist
        }
      }
      if (best && bestDist <= 60_000) {
        best.summaryText = leftover.text
      } else if (!cards.some((c) => c.summaryText === leftover.text)) {
        cards.push({
          itemType: 'compaction',
          id: `summary-${leftover.timestamp.getTime()}`,
          timestamp: leftover.timestamp,
          tokensBefore: 0,
          tokensAfter: 0,
          messagesRemoved: 0,
          summaryText: leftover.text,
        })
      }
    }

    return cards
  }, [compactionEvents, messages])

  const chatItems: ChatItem[] = useMemo(() => {
    const sorted: ChatItem[] = [...messages, ...approvalItems, ...planApprovalItems, ...compactionItems]
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())

    const result: ChatItem[] = []
    for (const item of sorted) {
      if ((item as MessageItem).itemType === 'message' && extractCompactSummaryFromMessage(item as MessageItem)) {
        continue
      }
      const msgItem = item as MessageItem
      const srcAgent = msgItem.sourceAgent

      if (srcAgent?.instanceId && msgItem.itemType === 'message') {
        // 找前一条主 Agent 消息（无 sourceAgent 的 assistant 消息）
        let parentIdx = -1
        for (let i = result.length - 1; i >= 0; i--) {
          const prev = result[i] as MessageItem
          if (prev.itemType === 'message' && prev.role === 'assistant' && !prev.sourceAgent) {
            parentIdx = i
            break
          }
        }
        if (parentIdx >= 0) {
          const parent = result[parentIdx] as MessageItem
          result[parentIdx] = {
            ...parent,
            parts: mergeAssistantParts(parent.parts, msgItem.parts),
            fileChanges: mergeFileChanges(parent.fileChanges, msgItem.fileChanges),
            isStreaming: msgItem.isStreaming ? true : parent.isStreaming,
          }
        }
        continue
      }

      result.push(item)
    }
    return result
  }, [messages, approvalItems, planApprovalItems, compactionItems])

  // Check if we need to show typing indicator (sending state OR streaming with last message from user)
  const showTypingIndicator = (isSending || isStreaming) && messages.length > 0 && messages[messages.length - 1].role === 'user'

  if (isLoading && chatItems.length === 0) {
    return (
      <div className={styles['chat-container']}>
        <Loading text="加载对话..." />
      </div>
    )
  }

  if (chatItems.length === 0) {
    return (
      <div className={styles['chat-container']}>
        <EmptyState onSuggestionClick={onSuggestionClick} />
      </div>
    )
  }

  return (
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      className={styles['chat-container']}
    >
      <div className={clsx(styles['messages-list'], noEnterMessages && styles['messages-list--switching'])}>
        {chatItems.map((item, index) => {
          if (item.itemType === 'approval') {
            const isResolving = resolvingIds.has(item.id)
            return (
              <ApprovalCard
                key={`approval-${item.id}-${index}`}
                approval={item.approval}
                decision={item.decision}
                resolvedBy={item.resolvedBy}
                isResolving={isResolving}
                onDecision={(decision) => onApprovalDecision(item.id, decision)}
              />
            )
          }

          if (item.itemType === 'plan-approval') {
            const isResolving = planResolvingIds.has(item.id)
            return (
              <PlanApprovalCard
                key={`plan-approval-${item.id}-${index}`}
                request={item.request}
                decision={item.decision}
                isResolving={isResolving}
                onApprove={() => onPlanApprove?.(item.id)}
                onReject={(feedback) => onPlanReject?.(item.id, feedback)}
              />
            )
          }

          if (item.itemType === 'compaction') {
            return (
              <CompactionCard
                key={`compaction-${item.id}-${index}`}
                tokensBefore={item.tokensBefore}
                tokensAfter={item.tokensAfter}
                messagesRemoved={item.messagesRemoved}
                messagesBefore={item.messagesBefore}
                messagesAfter={item.messagesAfter}
                summaryText={item.summaryText}
              />
            )
          }

          const message: ChatMessageType = {
            id: item.id,
            role: item.role,
            content: item.content,
            timestamp: item.timestamp,
            isStreaming: item.isStreaming,
            isAborted: item.isAborted,
            error: item.error,
            toolCalls: item.toolCalls as ChatMessageType['toolCalls'],
            usage: item.usage,
            thinkingText: item.thinkingText,
            streamMetrics: item.streamMetrics,
            llmError: item.llmError,
            injectedMemories: item.injectedMemories,
            sourceAgent: item.sourceAgent,
            acpBackendLabel: item.acpBackendLabel,
            isVoice: item.isVoice,
            parts: item.parts,
            fileChanges: item.fileChanges,
          }

          const isLatestAssistant = item.id === latestAssistantMessageId
          const hasPartsTimeline = (item.parts?.length ?? 0) > 0

          // Gateway 模式仍走 workflowItems；本地 Runtime 有 parts 时由时间线渲染工具
          const workflowToolItems = !hasPartsTimeline && item.role === 'assistant' && item.runId
            ? (workflowByRunId.get(item.runId) || [])
            : []

          const toolItems: AgentWorkflowItem[] = workflowToolItems.length > 0
            ? workflowToolItems
            : (!hasPartsTimeline && item.toolCalls && item.toolCalls.length > 0
              ? item.toolCalls.map((tc): AgentWorkflowItem => ({
                  id: tc.id,
                  type: 'tool' as const,
                  name: tc.name,
                  status: tc.status === 'running' ? 'running' as const
                    : tc.status === 'failed' ? 'failed' as const
                    : 'completed' as const,
                  title: tc.name,
                  input: tc.arguments,
                  output: tc.result,
                  error: tc.error,
                  startTime: tc.startTime ?? new Date(item.timestamp ?? Date.now()),
                  endTime: tc.endTime,
                  durationMs: (tc as unknown as Record<string, unknown>).durationMs as number | undefined,
                  runId: item.runId ?? '',
                  toolCallId: tc.id,
                  textPositionAtStart: tc.textPositionAtStart,
                  agentLabel: tc.agentLabel,
                }))
              : [])

          const fileAttachments = item.role === 'assistant'
            ? (filesByMessageId.get(item.id) ?? undefined)
            : undefined

          return (
            <ChatMessage
              key={`${item.id}-${index}`}
              message={message}
              formatTime={formatTime}
              onCopy={onCopyMessage || (() => {})}
              onEdit={onEditMessage || (() => {})}
              onDelete={onDeleteMessage || (() => {})}
              onRegenerate={onRegenerateMessage || (() => {})}
              sessionBusy={isStreaming}
              toolItems={toolItems.length > 0 ? toolItems : undefined}
              streamingThinkingText={
                isStreaming && item.role === 'assistant' && isLatestAssistant
                  ? streamingThinkingText
                  : undefined
              }
              noEnter={noEnterMessages}
              fileAttachments={fileAttachments}
              userId={userId}
              onReplay={onReplayFromMessage}
              replayMessageId={replayMessageId}
              onReviewFileChanges={onReviewFileChanges}
            />
          )
        })}

        {/* 等待首个 token 的占位。原先带  头像，且那两个 class 在本模块 CSS 里没定义，
            表现为一闪而过的裸 emoji，直接去掉容器只留指示器 */}
        {showTypingIndicator && <TypingIndicator label="正在思考…" />}

        {/* 会话元信息：轻量居中卡片，随消息流滚动，不固定遮挡输入区。
            文件变更改由每条助手气泡底部的 TurnFileChangesCard 呈现本轮净变更，
            对话流不再用 fileEvents 驱动 SessionFileList（上传/产出语义留给 rail/composer）。 */}
        {todoCalls.length > 0 && (
          <div className={styles['session-meta-inline']}>
            <TodoPanel
              toolCalls={todoCalls}
              variant="inline"
              defaultExpanded
            />
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>
      {showScrollToLatest && (
        <button
          type="button"
          className={styles['scroll-to-latest']}
          onClick={() => {
            stickToBottomRef.current = true
            setShowScrollToLatest(false)
            scrollToBottom('smooth')
          }}
          title="回到最新消息"
          aria-label="回到最新消息"
        >
          ↓ 回到最新
        </button>
      )}
    </div>
  )
}

export default ChatContainer
// memo：输入框打字会触发 ChatPage 全量 render，但消息列表 props 未变时跳过重渲染，
// 避免拖慢中文输入法（IME）的逐字上屏。前提：ChatPage 已稳定化传入的回调与占位数组。
const ChatContainerMemo = React.memo(ChatContainer)
export { ChatContainerMemo as ChatContainer }
export type { ApprovalItem, PlanApprovalItem, MessageItem, CompactionItem, ChatItem }
