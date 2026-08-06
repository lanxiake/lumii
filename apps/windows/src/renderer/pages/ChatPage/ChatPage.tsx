import React, { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { ChatSidebar } from './components/ChatSidebar'
import { ChatContainer } from './components/ChatContainer'
import { ChatInput } from './components/ChatInput'
import type { FileReference } from './components/ChatInput'
import type { ModelOption } from '../../services/model-config-service'
import { fetchModelCatalog, fetchChatModelChoices, saveChatModel } from '../../services/model-config-service'
import { TodoPanel } from './components/TodoPanel'
import { SessionFileList } from './components/SessionFileList'
import { Toast } from './components/Toast'
import { ConfirmModal } from '../../components/ui/Modal/ConfirmModal'
import { WorkspaceFilePanel } from './components/WorkspaceFilePanel'
import { WorkspaceVersionPanel } from './components/WorkspaceVersionPanel/WorkspaceVersionPanel'
import { WorkspaceWorkbench, type WorkbenchTab, type WorkbenchLayoutMode } from './components/WorkspaceWorkbench'
import { useWorkspaceVcs } from '../../hooks/business/useWorkspaceVcs'
import { useWorkspace } from '../../hooks/business/useWorkspace'
import { useAgents } from '../../hooks/business/useAgents'
import {
  useAgentRuntimeActions,
  useAgentRuntimeState,
  useAgentRuntimeGlobalState,
  useAnyPendingPermission,
  runtimeStore,
} from '../../hooks/business/useAgentRuntime'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { AskUserModal } from '../../components/AskUserModal'
import type { ViewType } from '../../components/Router'
import { SIDEBAR_SESSION_SLOT_ID, SIDEBAR_TOGGLE_EVENT } from '../../components/layout/Sidebar'
import { executeSlashCommand } from './commands/slash-command-executor'
import { loadSlashCommandsFromIpc } from './commands/slash-commands'
import { updateSessionState } from '../../hooks/business/useAgentRuntime/agent-runtime-store'
import clsx from 'clsx'
import {
  readPersistedSessionThinkingPrefs,
  writePersistedThinkingEnabled,
  writePersistedReasoningEffort,
} from '../../../shared/session-thinking-prefs'
import styles from './ChatPage.module.css'
import './ChatPage.global.css'
import { processFilesWithStrategies, appendAttachmentsToMessage } from './utils/file-attachment-strategy'
import { useVoiceCall } from '../../hooks/business/useVoiceCall'
import { useConversationReplay } from '../../hooks/business/useConversationReplay'
import { VoiceCallPanel } from './components/VoiceCallPanel'
import { VoiceModelDownloadDialog } from './components/VoiceModelDownloadDialog'
import type { AttachmentCategory } from './utils/file-attachment-strategy'
import {
  getDefaultStrategies,
  runImageProcessing,
  serializeRecognitionResults,
  type ImageProcessingResult,
} from './utils/image-processing-strategy'
import { InterruptBanner } from './components/InterruptBanner'
import { PanelLeft, Sparkles, Type, FolderOpen } from 'lucide-react'

/** 将 File 读取为 base64 字符串（当 file.path 不可用时使用） */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve(dataUrl.split(',')[1] ?? '')
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/** ChatPage 可选 props（由 Router 传入主导航视图） */
export interface ChatPageProps {
  /**
   * 当前主导航视图；切换到「对话」时会再次拉取会话列表，避免启动竞态下侧栏长期为空。
   */
  activeView?: ViewType
  /** 侧栏里点会话 / 新建会话时切到对话视图（会话列表常驻侧栏，不再有「对话」菜单） */
  onViewChange?: (view: ViewType) => void
}

const logger = {
  info: (...args: unknown[]) => console.log('[ChatPage]', ...args),
  error: (...args: unknown[]) => console.error('[ChatPage]', ...args),
  warn: (...args: unknown[]) => console.warn('[ChatPage]', ...args),
  debug: (...args: unknown[]) => console.debug('[ChatPage]', ...args),
}

const AUTO_APPROVE_KEY = 'mtbot-auto-approve'
const FONT_SCALE_KEY = 'mtbot:chat-font-scale'
const PAGE_ZOOM_KEY = 'mtbot:chat-page-zoom'
const ZOOM_MIN = 0.6

// 本地 Runtime 不走 Gateway 审批/workflow，这些占位恒为空。
// 提到模块级常量（而非每次 render 新建数组/Set），避免破坏 ChatContainer 的 React.memo 浅比较。
const EMPTY_APPROVAL_ITEMS: never[] = []
const EMPTY_PLAN_APPROVAL_ITEMS: never[] = []
const EMPTY_WORKFLOW_ITEMS: never[] = []
const EMPTY_RESOLVING_IDS: Set<string> = new Set<string>()
const ZOOM_MAX = 2.0
const ZOOM_STEP = 0.1

/** 字号档位 → 消息区根字号（px），通过 CSS 变量 --chat-font-size 注入 */
const FONT_SCALE_PX: Record<'small' | 'medium' | 'large', string> = {
  small: '13px',
  medium: '15px',
  large: '17px',
}
const FONT_SCALE_LABEL: Record<'small' | 'medium' | 'large', string> = {
  small: '小',
  medium: '中',
  large: '大',
}

const ChatPage: React.FC<ChatPageProps> = ({ activeView = 'dashboard', onViewChange }) => {
  // Hooks
  const { agents, userAgents, selectedAgent, isLoading: agentsLoading, selectAgent, selectAgentById, mainAgentId, agentsMap, refreshAgents } = useAgents()

  // 本地 Agent Runtime hooks（Feature Flag 开启时生效）
  const runtimeActions = useAgentRuntimeActions()
  /** listSessions 为 useCallback 稳定引用，仅依赖它可避免把整个 runtimeActions 放进 deps 导致 effect 异常抖动 */
  const { listSessions } = runtimeActions
  const runtimeIsStreaming = useAgentRuntimeState((s) => s.isStreaming)
  const runtimeThinkingLive = useAgentRuntimeState((s) => s.currentThinkingText)
  const runtimeError = useAgentRuntimeState((s) => s.error)
  const runtimeMessages = useAgentRuntimeState((s) => s.messages)
  const runtimeCurrentSessionKey = useAgentRuntimeGlobalState((s) => s.currentSessionKey)
  const { sessionKey: permissionSessionKey, pending: runtimePendingPermission } = useAnyPendingPermission()
  const runtimePendingAskUser = useAgentRuntimeState((s) => s.pendingAskUser)
  const runtimeContextUsage = useAgentRuntimeState((s) => s.contextUsage)
  const runtimeIsAutoCompacting = useAgentRuntimeState((s) => s.isAutoCompacting)
  const runtimeFileEvents = useAgentRuntimeState((s) => s.fileEvents)
  const runtimeCompactionEvents = useAgentRuntimeState((s) => s.compactionEvents)
  const runtimeLastTaskCompletion = useAgentRuntimeState((s) => s.lastTaskCompletion)
  // 本轮 Agent 正常结束时间戳（供 ChatInput 自动发送等待队列）
  const runtimeLastTurnEndAt = useAgentRuntimeState((s) => s.lastTurnEndAt)

  // 本地 Runtime 会话列表（侧边栏使用）
  const [localRuntimeSessions, setLocalRuntimeSessions] = useState<
    readonly { sessionKey: string; title: string; updatedAt: string; agentId?: string; lastMessagePreview?: string; hasRunning?: boolean; isPinned?: boolean; wasInterrupted?: boolean; channel?: string }[]
  >([])

  /**
   * 从主进程拉取会话列表写入侧栏；打日志便于排查「启动后为空、点新建才有」类竞态问题。
   */
  const refreshLocalSessions = useCallback(async () => {
    logger.info('[ChatPage] refreshLocalSessions 开始', { activeView })
    try {
      const sessions = await listSessions()
      logger.info('[ChatPage] refreshLocalSessions 完成', { count: sessions.length, activeView })
      setLocalRuntimeSessions(sessions)
    } catch (err) {
      logger.error('[ChatPage] refreshLocalSessions 失败', err)
    }
  }, [listSessions, activeView])

  /**
   * 会话列表加载：挂载即拉一次 + 订阅 isReady 兜底。
   * 只等 `runtime:ready` 不可靠——它是一次性推送，主进程先就绪、渲染侧后订阅时事件已错过，
   * store.isReady 会一直是 false，「就绪后拉列表」的分支永不执行（表现为启动后列表空白）。
   */
  useEffect(() => {
    let prevReady = runtimeStore.getState().isReady
    // 无条件拉一次：`runtime:ready` 是一次性推送，渲染侧订阅晚于它就永远收不到，
    // 只等事件会导致启动后列表空白。listSessions 内部已对 NOT_READY 重试，早拉无害。
    logger.info('[ChatPage] 挂载即 refreshLocalSessions', { prevReady })
    void refreshLocalSessions()
    void loadSlashCommandsFromIpc()
    const unsub = runtimeStore.subscribe(() => {
      const ready = runtimeStore.getState().isReady
      if (ready && !prevReady) {
        logger.info('[ChatPage] runtime isReady 变为 true，refreshLocalSessions')
        void refreshLocalSessions()
        void loadSlashCommandsFromIpc()
      }
      prevReady = ready
    })
    return unsub
  }, [refreshLocalSessions])

  /** 切换到「对话」视图时再拉一次（从概览进入对话时兜底） */
  useEffect(() => {
    if (activeView !== 'chat') return
    void refreshLocalSessions()
  }, [activeView, refreshLocalSessions])

  /**
   * 自动恢复上次会话：会话列表首次加载完成且无活跃会话时，切换到最近更新的一条。
   * 修复：初次进入时 runtimeCurrentSessionKey 为 null → 语音按钮不渲染、对话框空白。
   */
  const didAutoRestoreRef = useRef(false)
  useEffect(() => {
    if (didAutoRestoreRef.current) return
    if (runtimeCurrentSessionKey) {
      // 已有外部导航恢复的会话，标记完成
      didAutoRestoreRef.current = true
      return
    }
    if (localRuntimeSessions.length === 0) return
    const latest = [...localRuntimeSessions].sort(
      (a, b) => (b.updatedAt > a.updatedAt ? 1 : -1),
    )[0]
    if (latest) {
      didAutoRestoreRef.current = true
      logger.info(`[ChatPage] 自动恢复上次会话: ${latest.sessionKey}`)
      void runtimeActions.switchSession(latest.sessionKey)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localRuntimeSessions, runtimeCurrentSessionKey])

  /**
   * 外部通道（微信 /new、/resume 等）触发 conversation:navigate 后，
   * currentSessionKey 会切换到新会话，但 localRuntimeSessions（侧边栏列表）
   * 来自 DB，不会自动更新。这里监听 currentSessionKey 变化，刷新侧边栏列表，
   * 确保新建/切换的会话出现在侧边栏中。
   */
  useEffect(() => {
    if (!runtimeCurrentSessionKey) return
    // 检查当前 sessionKey 是否已在侧边栏列表中，不在则刷新
    const alreadyInList = localRuntimeSessions.some((s) => s.sessionKey === runtimeCurrentSessionKey)
    if (!alreadyInList) {
      void refreshLocalSessions()
    }
  }, [runtimeCurrentSessionKey, localRuntimeSessions, refreshLocalSessions])

  // 将 title 查找独立为 useMemo，避免 localRuntimeSessions 列表刷新时
  // 触发整个 localRuntimeSession（含消息映射）的重建，减少不必要的重渲染
  const activeSessionTitle = useMemo(() => {
    return localRuntimeSessions.find(
      (s) => s.sessionKey === runtimeCurrentSessionKey
    )?.title ?? '本地 Agent Runtime'
  }, [localRuntimeSessions, runtimeCurrentSessionKey])

  // 本地 Runtime 模式下，构造虚拟 session 给 ChatContainer
  const localRuntimeSession = useMemo(() => {
    logger.debug('[localRuntimeSession] 重新计算, 消息数:', runtimeMessages.length)
    if (runtimeMessages.length > 0) {
      const lastMsg = runtimeMessages[runtimeMessages.length - 1]
      const rawPreview = lastMsg.content[0]?.text ?? ''
      // 使用 Array.from 按码点截断，避免切断 emoji surrogate pair 导致乱码
      const safePreview = Array.from(rawPreview).slice(0, 50).join('')
      logger.debug('[localRuntimeSession] 最后一条消息:', {
        id: lastMsg.id,
        role: lastMsg.role,
        contentPreview: safePreview,
      })
    }
    return {
      id: runtimeCurrentSessionKey ?? 'local-runtime',
      title: activeSessionTitle,
      messages: runtimeMessages.map((msg) => ({
        id: msg.id,
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content.map((c) => c.text).join(''),
        timestamp: new Date(msg.timestamp),
        isStreaming: msg.isStreaming,
        toolCalls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.args,
          status: tc.status === 'running' ? 'running' as const
            : tc.status === 'error' ? 'failed' as const
            : 'completed' as const,
          result: tc.result,
          error: tc.error,
          startTime: tc.startMs ? new Date(tc.startMs) : new Date(),
          endTime: tc.endMs ? new Date(tc.endMs) : undefined,
          durationMs: tc.durationMs,
          textPositionAtStart: tc.textPositionAtStart,
        })),
        usage: msg.usage ? {
          inputTokens: msg.usage.inputTokens,
          outputTokens: msg.usage.outputTokens,
          cacheRead: msg.usage.cacheReadTokens,
          cacheWrite: msg.usage.cacheWriteTokens,
        } : undefined,
        thinkingText: msg.thinkingText,
        streamMetrics: msg.streamMetrics,
        llmError: msg.llmError,
        injectedMemories: msg.injectedMemories,
        sourceAgent: msg.sourceAgent,
        isVoice: msg.isVoice,
        audioWavBase64: msg.audioWavBase64,
      })),
      createdAt: new Date(),
      updatedAt: new Date(),
      source: 'local' as const,
    }
  }, [runtimeMessages, runtimeCurrentSessionKey, activeSessionTitle])

  // 本地 Runtime 会话列表 → ChatSession 格式（供侧边栏使用）
  const localRuntimeSessionsAsChatSessions = useMemo(() => {
    return localRuntimeSessions.map((s) => ({
      id: s.sessionKey,
      title: s.title,
      messages: s.lastMessagePreview
        ? [{
            id: `preview-${s.sessionKey}`,
            role: 'assistant' as const,
            content: s.lastMessagePreview,
            timestamp: new Date(s.updatedAt),
          }]
        : [],
      createdAt: new Date(s.updatedAt),
      updatedAt: new Date(s.updatedAt),
      source: 'local' as const,
      agentId: s.agentId,
      isStreaming: Boolean(s.hasRunning),
      isPinned: s.isPinned,
      wasInterrupted: s.wasInterrupted,
      channel: s.channel,
    }))
  }, [localRuntimeSessions])

  // 当前会话是否被中断
  const currentSessionInterrupted = useMemo(() => {
    if (!runtimeCurrentSessionKey) return false
    return localRuntimeSessions.some(
      (s) => s.sessionKey === runtimeCurrentSessionKey && s.wasInterrupted,
    )
  }, [localRuntimeSessions, runtimeCurrentSessionKey])

  /** 当前会话中所有 todo 工具调用（供底部任务列表面板使用） */
  const sessionTodoCalls = useMemo(() => {
    const calls: {
      id: string
      name: string
      status: 'running' | 'completed' | 'failed' | 'error'
      result?: unknown
    }[] = []
    for (const msg of runtimeMessages) {
      if (msg.role === 'assistant' && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          if (tc.name?.toLowerCase().includes('todo')) {
            calls.push({
              id: tc.id,
              name: tc.name,
              status: tc.status as 'running' | 'completed' | 'failed' | 'error',
              result: tc.result,
            })
          }
        }
      }
    }
    return calls
  }, [runtimeMessages])

  // 中断恢复：继续任务
  const handleContinueInterrupted = useCallback(async (sessionKey: string) => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return
    await api.sendCommand({ type: 'conversation:continue-interrupted', sessionKey })
    void refreshLocalSessions()
  }, [refreshLocalSessions])

  // 中断恢复：忽略
  const handleDismissInterrupt = useCallback((sessionKey: string) => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return
    void api.sendCommand({ type: 'conversation:dismiss-interrupt', sessionKey })
    void refreshLocalSessions()
  }, [refreshLocalSessions])

  // Local state
  const [draftsBySession, setDraftsBySession] = useState<Record<string, string>>({})
  const [globalDraft, setGlobalDraft] = useState('')
  const [fileReferencesBySession, setFileReferencesBySession] = useState<Record<string, FileReference[]>>({})
  const fileReferenceKey = runtimeCurrentSessionKey ?? '__global__'
  const inputValue = runtimeCurrentSessionKey ? (draftsBySession[runtimeCurrentSessionKey] ?? '') : globalDraft
  const activeFileReferences = fileReferencesBySession[fileReferenceKey] ?? []
  const setInputValue = useCallback((nextValue: string) => {
    const sessionKey = runtimeCurrentSessionKey
    if (!sessionKey) {
      setGlobalDraft(nextValue)
      return
    }
    setDraftsBySession((prev) => ({ ...prev, [sessionKey]: nextValue }))
  }, [runtimeCurrentSessionKey])
  const clearCurrentInputState = useCallback((targetSessionKey: string | null = runtimeCurrentSessionKey) => {
    const refKey = targetSessionKey ?? '__global__'
    if (!targetSessionKey) {
      setGlobalDraft('')
      setFileReferencesBySession((prev) => ({ ...prev, [refKey]: [] }))
      return
    }
    setDraftsBySession((prev) => ({ ...prev, [targetSessionKey]: '' }))
    setFileReferencesBySession((prev) => ({ ...prev, [refKey]: [] }))
  }, [runtimeCurrentSessionKey])
  const handleFileReferenceAdd = useCallback((ref: FileReference) => {
    const refKey = runtimeCurrentSessionKey ?? '__global__'
    setFileReferencesBySession((prev) => {
      const refs = prev[refKey] ?? []
      if (refs.some((item) => item.absolutePath === ref.absolutePath)) return prev
      return { ...prev, [refKey]: [...refs, ref] }
    })
  }, [runtimeCurrentSessionKey])
  const handleFileReferenceRemove = useCallback((absolutePath: string) => {
    const refKey = runtimeCurrentSessionKey ?? '__global__'
    setFileReferencesBySession((prev) => ({
      ...prev,
      [refKey]: (prev[refKey] ?? []).filter((ref) => ref.absolutePath !== absolutePath),
    }))
  }, [runtimeCurrentSessionKey])
  const [voiceCallState, voiceCallActions] = useVoiceCall()
  const conversationReplay = useConversationReplay()
  /**
   * pendingAttachments 存储当前待发附件的元信息：
   * - fileName / filePath / category 来自策略层
   * - recognitionResults 为图片识别策略的输出（可选，图片类才有）
   */
  const [pendingAttachments, setPendingAttachments] = useState<Array<{
    fileName: string
    filePath: string
    category: AttachmentCategory
    /** 伴生文本文件路径（workspace 相对），仅文档类附件有值 */
    parsedTextPath?: string | null
    recognitionResults?: ImageProcessingResult[]
  }>>([])

  /** 输入框空白且无附件时展示 Tips 轮播 */
  const showInputTips = useMemo(() => {
    if (voiceCallState.state !== 'idle') return false
    if (currentSessionInterrupted) return false
    if (inputValue.trim()) return false
    if (pendingAttachments.length > 0) return false
    if (activeFileReferences.length > 0) return false
    return true
  }, [
    voiceCallState.state,
    currentSessionInterrupted,
    inputValue,
    pendingAttachments.length,
    activeFileReferences.length,
  ])

  /**
   * 处理文件上传：
   * 1. 策略层识别文件类别
   * 2. 通过 files:import 导入到 workspace/uploads/YYYY-MM-DD/
   * 3. 对图片类附件：异步运行图片处理策略（识别 / OCR），结果追加到附件
   *
   * 图片处理采用"异步 post-import"：不阻塞 files:import 的响应，
   * 用户上传后立即看到附件 chip，识别结果后续回填（UI 可无感）。
   */
  const handleFilesImport = useCallback(async (files: FileList) => {
    const attached = processFilesWithStrategies(files)
    const imported = await Promise.all(
      attached.map(async (a, i) => {
        try {
          const hasPath = a.filePath && a.filePath !== a.fileName
          const commandPayload: Record<string, unknown> = {
            type: 'files:import',
            userId: 'local-user',
            fileName: a.fileName,
            mimeType: a.mimeType,
          }
          if (hasPath) {
            commandPayload.sourcePath = a.filePath
          } else {
            const file = files[i]
            if (file) {
              commandPayload.fileBuffer = await readFileAsBase64(file)
            }
          }
          const result = await window.electronAPI?.agentRuntime?.sendCommand(commandPayload)
          const importResult = result as { absPath: string; parsedTextPath?: string | null }
          return {
            fileName: a.fileName,
            filePath: importResult.absPath,
            category: a.category,
            parsedTextPath: importResult.parsedTextPath ?? null,
          }
        } catch (err) {
          logger.error('[handleFilesImport] files:import 失败:', err)
          return { fileName: a.fileName, filePath: a.filePath, category: a.category, parsedTextPath: null }
        }
      })
    )
    setPendingAttachments((prev) => [...prev, ...imported])

    // 异步启动图片识别策略（不阻塞 UI）
    const imageFiles = imported.filter((f) => f.category === 'image')
    if (imageFiles.length > 0) {
      void (async () => {
        try {
          // 把导入后的 absPath 传给策略层，用作识别入口
          const attachedFilesForStrategy = imageFiles.map((f) => ({
            fileName: f.fileName,
            filePath: f.filePath,
            mimeType: '',
            size: 0,
            category: 'image' as const,
          }))
          // 从已加载模型列表中挑选一个支持视觉的模型用于识别
          // 默认 balanced tier（deepseek-v4-flash）不支持视觉，必须显式指定
          const models = availableModelsRef.current
          const visionModelId =
            models.find((m) => m.supportsMultiModal === true)?.id ?? undefined
          logger.info(
            `[handleFilesImport] 后台识别 ${imageFiles.length} 张图片 visionModelId=${visionModelId ?? '(default/balanced)'}`,
          )
          const strategies = getDefaultStrategies()
          const results = await runImageProcessing(attachedFilesForStrategy, strategies, {
            visionModelId,
            includeOcr: true,
          })
          if (results.size === 0) return
          // 把识别结果回填到 pendingAttachments
          setPendingAttachments((prev) =>
            prev.map((a) => {
              const outcomes = results.get(a.filePath)
              return outcomes ? { ...a, recognitionResults: outcomes } : a
            }),
          )
        } catch (err) {
          logger.warn('[handleFilesImport] 图片处理策略执行失败（已忽略）:', err)
        }
      })()
    }
  }, [])
  /**
   * 外层侧栏的会话列表挂载点。首帧 DOM 未提交必然取不到，用一次 layout effect 触发重渲染后
   * 每帧重新解析：节点被替换也能自愈，不会像「只取一次」那样永久落空。
   */
  const [slotReady, setSlotReady] = useState(false)
  useLayoutEffect(() => {
    setSlotReady(true)
  }, [])
  const sessionSlot = slotReady ? document.getElementById(SIDEBAR_SESSION_SLOT_ID) : null
  // 会话列表已挪进最外层侧栏，折叠由 MainLayout 统一管，这里只发事件
  const toggleOuterSidebar = useCallback(() => {
    window.dispatchEvent(new Event(SIDEBAR_TOGGLE_EVENT))
  }, [])
  // 改为 per-session 跟踪，避免会话A发消息时阻塞会话B的输入
  const [sendingSessionIds, setSendingSessionIds] = useState<Set<string>>(new Set())
  const isSending = sendingSessionIds.has(runtimeCurrentSessionKey ?? '')
  // 模型 catalog（来源 LiteLLM，供上下文压缩同步与视觉模型挑选）
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  // 用户当前选择的 chat 模型（来自系统设置「模型配置」，对应 chat 用途槽候选之一）
  const [selectedModelId, setSelectedModelId] = useState<string>(() => {
    try { return localStorage.getItem('mtbot:chat-model') ?? '' } catch { return '' }
  })
  /** 思考模式开关（默认开启） */
  const [thinkingEnabled, setThinkingEnabled] = useState<boolean>(
    () => readPersistedSessionThinkingPrefs().thinkingEnabled,
  )
  /** 推理强度（思考开启时生效，默认 high） */
  const [reasoningEffort, setReasoningEffort] = useState<'high' | 'max'>(
    () => readPersistedSessionThinkingPrefs().reasoningEffort,
  )
  // chat 槽候选模型（对话内模型下拉用，与系统设置双向同步）
  const [chatModelChoices, setChatModelChoices] = useState<ModelOption[]>([])

  /** 模型列表拉取后同步到主进程，供 ContextCompactor / 用量条解析 contextWindow、maxTokens */
  const catalogSyncSignatureRef = useRef('')
  const runtimeCurrentSessionKeyRef = useRef(runtimeCurrentSessionKey)
  runtimeCurrentSessionKeyRef.current = runtimeCurrentSessionKey

  useEffect(() => {
    if (availableModels.length === 0) return
    const signature = availableModels
      .map((m) => `${m.id}:${m.contextWindow ?? ''}:${m.maxTokens ?? ''}`)
      .join('|')
    if (catalogSyncSignatureRef.current === signature) return
    catalogSyncSignatureRef.current = signature

    void runtimeActions.syncModelCatalog(
      availableModels.map((m) => ({
        id: m.id,
        ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
      })),
    ).then(() => {
      const sk = runtimeCurrentSessionKeyRef.current
      if (sk) void runtimeActions.refreshContextUsage(sk)
    })
  }, [availableModels]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * availableModels 的 ref 镜像。
   * 用于在 useCallback 内部读取最新模型列表（不污染 callback 的 deps，
   * 避免每次模型列表变化都触发组件树重渲染）。
   */
  const availableModelsRef = useRef<ModelOption[]>([])
  useEffect(() => {
    availableModelsRef.current = availableModels
  }, [availableModels])

  /**
   * 从已加载的模型列表中挑选一个支持视觉的模型 id（用于图片识别）。
   *
   * 优先策略：
   * 1. 当前选中的模型本身就支持视觉 → 直接复用
   * 2. 列表中第一个 supportsMultiModal === true 的模型
   * 3. 找不到 → 返回 undefined，让后端用 balanced tier 默认模型
   *    （注意：默认 deepseek-v4-flash 不支持视觉，此时识别会失败，
   *     ChatPage 会以"图片附件未识别"占位文本注入到消息）
   */
  const pickVisionModelId = useCallback((): string | undefined => {
    const models = availableModelsRef.current
    if (models.length === 0) return undefined
    const current = selectedModelId ? models.find((m) => m.id === selectedModelId) : undefined
    if (current?.supportsMultiModal === true) return current.id
    const visionModel = models.find((m) => m.supportsMultiModal === true)
    return visionModel?.id
  }, [selectedModelId])

  // 加载模型 catalog（供压缩/视觉）与用户 chat 模型选择（来自系统设置/用途槽）
  useEffect(() => {
    const loadModels = async () => {
      setModelsLoading(true)
      try {
        const [catalog, chatChoices] = await Promise.all([
          fetchModelCatalog(),
          fetchChatModelChoices().catch(() => null),
        ])
        setAvailableModels(catalog)
        if (chatChoices) {
          setChatModelChoices(chatChoices.candidates)
        }
        // 用户 chat 模型选择：优先配置返回的 selected，其次本地缓存，无则空
        setSelectedModelId((prev) => {
          const fromServer = chatChoices?.selected
          if (fromServer) {
            try { localStorage.setItem('mtbot:chat-model', fromServer) } catch { /* ignore */ }
            return fromServer
          }
          if (prev && catalog.some((m) => m.id === prev)) return prev
          return catalog[0]?.id ?? ''
        })
      } catch (err) {
        logger.error('[loadModels] 加载模型列表失败:', err)
      } finally {
        setModelsLoading(false)
      }
    }
    void loadModels()

    // 系统设置「模型配置」修改后，同步刷新当前会话使用的 chat 模型
    const onChatModelChanged = (e: Event) => {
      const modelId = (e as CustomEvent<{ modelId: string }>).detail?.modelId
      if (modelId) setSelectedModelId(modelId)
      void loadModels()
    }
    const onProviderChanged = () => { void loadModels() }
    window.addEventListener('mtbot:chat-model-changed', onChatModelChanged)
    window.addEventListener('mtbot:provider-config-changed', onProviderChanged)
    return () => {
      window.removeEventListener('mtbot:chat-model-changed', onChatModelChanged)
      window.removeEventListener('mtbot:provider-config-changed', onProviderChanged)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 对话内切换模型：乐观更新本地、持久化到租户配置、广播事件供系统设置同步。
   * 立即对当前会话生效（runtimeActions.setSessionPreferredModel 写入会话偏好）。
   */
  const handleSelectChatModel = useCallback(async (modelId: string) => {
    if (!modelId || modelId === selectedModelId) return
    setSelectedModelId(modelId)
    try { localStorage.setItem('mtbot:chat-model', modelId) } catch { /* ignore */ }
    if (runtimeCurrentSessionKey) {
      void runtimeActions.setSessionPreferredModel(runtimeCurrentSessionKey, modelId)
    }
    window.dispatchEvent(new CustomEvent('mtbot:chat-model-changed', { detail: { modelId } }))
    try {
      await saveChatModel(modelId)
    } catch (err) {
      logger.error('[handleSelectChatModel] 保存模型选择失败:', err)
    }
  }, [selectedModelId, runtimeCurrentSessionKey, runtimeActions])

  /** 当前选中模型的上下文窗口（用于用量条分母兜底） */
  const selectedModelContextWindow = useMemo(() => {
    const KNOWN: Record<string, number> = {
      'deepseek-v4': 1_000_000,
      'deepseek-v4-pro': 1_000_000,
      'deepseek-v4-flash': 1_000_000,
    }
    const shortId = selectedModelId.includes('/')
      ? selectedModelId.slice(selectedModelId.lastIndexOf('/') + 1)
      : selectedModelId
    const fromCatalog = selectedModelId
      ? availableModels.find((m) => m.id === selectedModelId || m.id.endsWith(`/${shortId}`))?.contextWindow
      : undefined
    if (fromCatalog && fromCatalog > 0) return fromCatalog
    const fromChoices = selectedModelId
      ? chatModelChoices.find((m) => m.id === selectedModelId)?.contextWindow
      : undefined
    if (fromChoices && fromChoices > 0) return fromChoices
    if (shortId && KNOWN[shortId]) return KNOWN[shortId]
    return undefined
  }, [selectedModelId, availableModels, chatModelChoices])

  /**
   * 思考模式开关变更：持久化并同步到当前会话主进程
   */
  const handleThinkingEnabledChange = useCallback((enabled: boolean) => {
    setThinkingEnabled(enabled)
    writePersistedThinkingEnabled(enabled)
    if (runtimeCurrentSessionKey) {
      void runtimeActions.setSessionThinkingPrefs(runtimeCurrentSessionKey, { thinkingEnabled: enabled })
    }
  }, [runtimeCurrentSessionKey, runtimeActions])

  /**
   * 推理强度变更：仅思考开启时生效
   */
  const handleReasoningEffortChange = useCallback((effort: 'high' | 'max') => {
    setReasoningEffort(effort)
    writePersistedReasoningEffort(effort)
    if (runtimeCurrentSessionKey && thinkingEnabled) {
      void runtimeActions.setSessionThinkingPrefs(runtimeCurrentSessionKey, { reasoningEffort: effort })
    }
  }, [runtimeCurrentSessionKey, runtimeActions, thinkingEnabled])

  /** 新建/切换会话时同步思考偏好到主进程 */
  useEffect(() => {
    if (!runtimeCurrentSessionKey) return
    void runtimeActions.setSessionThinkingPrefs(runtimeCurrentSessionKey, {
      thinkingEnabled,
      reasoningEffort,
    })
  }, [runtimeCurrentSessionKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // 所有会话的审批项，每项携带 sessionKey 实现会话隔离（已移除 Gateway 审批 state，本地 Runtime 使用 runtimePendingPermission）
  // 用模块级稳定空占位，保持 ChatContainer 接口兼容且不破坏 memo
  const approvalItems = EMPTY_APPROVAL_ITEMS
  const resolvingIds = EMPTY_RESOLVING_IDS
  const planApprovalItems = EMPTY_PLAN_APPROVAL_ITEMS
  const planResolvingIds = EMPTY_RESOLVING_IDS
  const workflowItems = EMPTY_WORKFLOW_ITEMS
  const [workbench, setWorkbench] = useState<{ open: boolean; tab: WorkbenchTab }>({
    open: false,
    tab: 'files',
  })
  /** 工作台当前宽度（px），用于对话区 padding 自适应 */
  const [workbenchWidth, setWorkbenchWidth] = useState(0)
  const [workbenchResizing, setWorkbenchResizing] = useState(false)
  const [workbenchLayout, setWorkbenchLayout] = useState<WorkbenchLayoutMode>('default')
  /** 点击输入框 @引用 chip 时要在工作空间面板定位的绝对路径（含一次性 token 触发重复定位） */
  const [locateFileTarget, setLocateFileTarget] = useState<{ path: string; token: number } | null>(null)
  const { uncommittedDiff, refresh: refreshVcs } = useWorkspaceVcs()
  const { workspaceDir } = useWorkspace()

  const toggleFilesWorkbench = useCallback(() => {
    setWorkbenchLayout('default')
    setWorkbench((w) =>
      w.open && w.tab === 'files' ? { ...w, open: false } : { open: true, tab: 'files' },
    )
  }, [])

  /** 离开对话视图时关闭工作台（设置/概览等） */
  useEffect(() => {
    if (activeView && activeView !== 'chat') {
      setWorkbench((w) => (w.open ? { ...w, open: false } : w))
    }
  }, [activeView])

  /** 工作台宽度变化；拖拽中关闭 padding transition */
  const handleWorkbenchWidthChange = useCallback((w: number) => {
    setWorkbenchWidth(w)
  }, [])

  const handleWorkbenchLayoutChange = useCallback((mode: WorkbenchLayoutMode) => {
    setWorkbenchLayout(mode)
  }, [])
  /** 单调递增定位 token，避免 Date.now() 在快速点击时碰撞 */
  const locateTokenRef = useRef(0)

  const [autoApprove, setAutoApprove] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTO_APPROVE_KEY) === 'true'
    } catch {
      return false
    }
  })

  /** 消息字号档位：small | medium | large，存 localStorage，作用于消息区 CSS 变量 */
  const [fontScale, setFontScale] = useState<'small' | 'medium' | 'large'>(() => {
    try {
      const v = localStorage.getItem(FONT_SCALE_KEY)
      return v === 'small' || v === 'large' ? v : 'medium'
    } catch {
      return 'medium'
    }
  })
  const cycleFontScale = useCallback(() => {
    setFontScale((prev) => {
      const next = prev === 'small' ? 'medium' : prev === 'medium' ? 'large' : 'small'
      try { localStorage.setItem(FONT_SCALE_KEY, next) } catch { /* ignore */ }
      return next
    })
  }, [])

  /**
   * 对话页整体缩放比例（Ctrl + 滚轮调节），仅作用于 ChatPage 根容器，
   * 通过 CSS zoom 同时放大/缩小布局与字体。范围 0.6 ~ 2.0，存 localStorage。
   */
  const [pageZoom, setPageZoom] = useState<number>(() => {
    try {
      const v = parseFloat(localStorage.getItem(PAGE_ZOOM_KEY) ?? '')
      return Number.isFinite(v) && v >= ZOOM_MIN && v <= ZOOM_MAX ? v : 1
    } catch {
      return 1
    }
  })
  const chatPageRef = useRef<HTMLDivElement>(null)
  // 用原生事件监听 wheel（passive:false 才能 preventDefault 阻止浏览器默认缩放）
  useEffect(() => {
    const el = chatPageRef.current
    if (!el) return
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setPageZoom((prev) => {
        const step = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP
        const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((prev + step) * 100) / 100))
        try { localStorage.setItem(PAGE_ZOOM_KEY, String(next)) } catch { /* ignore */ }
        return next
      })
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [])
  // Ctrl+0 复位缩放
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === '0')) {
        e.preventDefault()
        setPageZoom(1)
        try { localStorage.setItem(PAGE_ZOOM_KEY, '1') } catch { /* ignore */ }
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  // Toast state
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null)

  // 监听 task_complete 工具调用，触发任务完成 Toast
  // 用 timestamp 去重：lastTaskCompletion 是会话持久状态，进入历史会话时引用也会变化，
  // 仅当 timestamp 比上次处理过的更新（真正新发生的完成）时才弹，避免重复弹窗。
  const handledTaskCompletionTsRef = useRef(0)
  useEffect(() => {
    if (!runtimeLastTaskCompletion) return
    if (runtimeLastTaskCompletion.timestamp <= handledTaskCompletionTsRef.current) return
    handledTaskCompletionTsRef.current = runtimeLastTaskCompletion.timestamp
    const msg = runtimeLastTaskCompletion.summary
      ? `✅ 任务完成：${runtimeLastTaskCompletion.summary}`
      : '✅ 任务已完成'
    setToast({ message: msg, type: 'success' })
  }, [runtimeLastTaskCompletion])

  // 自动压缩完成现以对话流内的「上下文压缩」卡片展示（见 ChatContainer + CompactionCard），
  // 不再额外弹 toast，避免与卡片重复提示。

  // Confirm modal state for session deletion
  const [isDeleteSessionModalOpen, setIsDeleteSessionModalOpen] = useState(false)
  const [sessionToDelete, setSessionToDelete] = useState<string | null>(null)

  // Refs
  const autoApproveRef = useRef(autoApprove)
  // isStreamingRef 使用本地 Runtime 的 runtimeIsStreaming
  const isStreamingRef = useRef(runtimeIsStreaming)

  useEffect(() => {
    autoApproveRef.current = autoApprove
    try {
      localStorage.setItem(AUTO_APPROVE_KEY, String(autoApprove))
    } catch {
      // ignore
    }
  }, [autoApprove])

  useEffect(() => {
    isStreamingRef.current = runtimeIsStreaming
  }, [runtimeIsStreaming])

  /**
   * 任务完成（task_complete 工具调用）且主窗口不在前台时，发送桌面通知。
   * 普通对话回复结束不触发，仅任务完成时触发。
   * 同样用 timestamp 去重，避免进入历史会话时重复发送桌面通知。
   */
  const handledDesktopNotifyTsRef = useRef(0)
  useEffect(() => {
    if (!runtimeLastTaskCompletion) return
    if (runtimeLastTaskCompletion.timestamp <= handledDesktopNotifyTsRef.current) return
    handledDesktopNotifyTsRef.current = runtimeLastTaskCompletion.timestamp
    if (typeof document !== 'undefined' && document.hasFocus()) return
    const api = window.electronAPI?.notifyDesktop
    if (!api) return
    const sessionTitle = localRuntimeSession?.title?.trim() || '当前对话'
    const summary = runtimeLastTaskCompletion.summary?.trim()
    const body = summary || (sessionTitle.length > 120 ? `${sessionTitle.slice(0, 117)}…` : sessionTitle)
    void api('MtBot · 任务已完成', body).catch(() => undefined)
  }, [runtimeLastTaskCompletion, localRuntimeSession?.title])

  // 本地 Runtime 自动审批：检测到待审批权限请求且 autoApprove 开启时自动放行
  useEffect(() => {
    if (autoApprove && runtimePendingPermission) {
      runtimeActions.respondPermission('allow-once')
    }
  }, [runtimePendingPermission, autoApprove, runtimeActions])

  // Event handlers
  const handleNewConversation = useCallback(async (agentId?: string): Promise<string | null> => {
    // 若调用方未指定 agentId（如侧边栏“新建对话”按鈕），使用当前选中的 Agent 作为默认值
    // 防御：onClick 回调会将 MouseEvent 作为第一个参数传入，需要过滤非 string 值
    const safeAgentId = typeof agentId === 'string' ? agentId : undefined
    const effectiveAgentId = safeAgentId ?? selectedAgent?.id ?? mainAgentId ?? undefined
  
    try {
      const sessionKey = await runtimeActions.createSession('新对话', effectiveAgentId, selectedModelId || undefined)
      void refreshLocalSessions()
      return sessionKey
    } catch (err) {
      logger.error(`[handleNewConversation] ${err instanceof Error ? err.message : String(err)}`)
      setToast({ message: '创建本地会话失败', type: 'error' })
      return null
    }
  }, [selectedAgent, mainAgentId, selectedModelId, runtimeActions, refreshLocalSessions])

  // 检测来自 AI 团队页面的“发起对话”指令：自动新建对话并选中对应 Agent
  useEffect(() => {
    const handleStartChat = (e: Event) => {
      const agentId = (e as CustomEvent<string>).detail
      if (!agentId) return
      const targetAgent = agents.find((a) => a.id === agentId)
      if (targetAgent) selectAgent(targetAgent)
      void runtimeActions.createSession('新对话', agentId, selectedModelId || undefined).then(() => {
        void refreshLocalSessions()
      })
    }
    window.addEventListener('mtbot:start-chat-agent', handleStartChat)
    return () => window.removeEventListener('mtbot:start-chat-agent', handleStartChat)
  }, [agents, selectAgent, runtimeActions, refreshLocalSessions, selectedModelId])
  
  // 手动压缩上下文（定义在 handleSend 之前，供命令执行器引用）
  const handleCompactContext = useCallback(async () => {
    const sessionKey = runtimeCurrentSessionKey
    if (!sessionKey) return
    try {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return
      // 手动压缩：立即设置压缩中状态，让按钮显示 spinner
      updateSessionState(sessionKey, (prev) => ({ ...prev, isAutoCompacting: true }))
      setToast({ message: '正在压缩上下文，请稍候...', type: 'info' })
      const result = await api.sendCommand({
        type: 'user:compact-context',
        sessionKey,
        keepRecentTurns: 6,
      }) as { success: boolean; previousMessageCount: number; newMessageCount: number; messagesRemoved: number; hadSummary?: boolean }
      if (result.success) {
        if (result.messagesRemoved === 0) {
          setToast({ message: '上下文消息较少，无需压缩', type: 'info' })
        } else {
          const summaryNote = result.hadSummary ? '，已生成摘要保留关键信息' : ''
          setToast({ message: `上下文已压缩${summaryNote}`, type: 'success' })
        }
        // 重新加载会话消息（agent:context:compacted 事件会清除 isAutoCompacting）
        await runtimeActions.switchSession(sessionKey)
      }
    } catch (err) {
      logger.error('[handleCompactContext] 压缩失败:', err)
      setToast({ message: '压缩失败', type: 'error' })
      // 出错时也要清除压缩中状态
      updateSessionState(sessionKey, (prev) => ({ ...prev, isAutoCompacting: false }))
    }
  }, [runtimeCurrentSessionKey, runtimeActions])

  /** 向当前会话注入一条虚拟 system 消息（不持久化、不发给 LLM） */
  const addSystemMessage = useCallback((text: string) => {
    const sessionKey = runtimeCurrentSessionKey
    if (!sessionKey) return
    const msgId = `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    updateSessionState(sessionKey, (prev) => ({
      ...prev,
      messages: [
        ...prev.messages,
        {
          id: msgId,
          role: 'system' as const,
          content: [{ type: 'text' as const, text }],
          timestamp: Date.now(),
          isStreaming: false,
          toolCalls: [],
        },
      ],
    }))
  }, [runtimeCurrentSessionKey])

  const handleSend = useCallback(async (overrideValue?: string) => {
    const valueToSend = overrideValue !== undefined ? overrideValue : inputValue
    if (!valueToSend.trim() && pendingAttachments.length === 0) return
    if (isSending) return

    // 将待发附件追加到消息文本
    const attachedFiles = pendingAttachments.map((a) => ({
      fileName: a.fileName,
      filePath: a.filePath,
      mimeType: '',
      size: 0,
      category: a.category,
    }))
    let finalContent = appendAttachmentsToMessage(valueToSend, attachedFiles)

    // 判断当前模型是否支持多模态视觉输入（来自 model_providers.models.supportsMultiModal）
    // 找不到模型元数据时默认为 false，走"识别注入文本"兜底路径，保证模型能"看到"图片内容
    const currentModel = selectedModelId
      ? availableModels.find((m) => m.id === selectedModelId)
      : undefined
    const modelSupportsVision = currentModel?.supportsMultiModal === true
    const imagePendingAttachments = pendingAttachments.filter((a) => a.category === 'image')

    logger.info(
      `[handleSend] 发送决策: model=${selectedModelId ?? '(default)'} supportsVision=${modelSupportsVision} imageCount=${imagePendingAttachments.length}`,
    )

    // 仅当模型不支持视觉、且有图片附件时，才需要"先识别再注入文本"
    if (!modelSupportsVision && imagePendingAttachments.length > 0) {
      const needsRecognition = imagePendingAttachments.filter(
        (a) => !a.recognitionResults || a.recognitionResults.length === 0,
      )
      if (needsRecognition.length > 0) {
        // 必须显式挑选一个支持视觉的模型用于识别（默认 balanced=deepseek-v4-flash 不支持视觉）
        const visionModelId = pickVisionModelId()
        if (!visionModelId) {
          // 系统内一个支持视觉的模型都没有 → 提示用户并给出占位文本
          logger.warn(`[handleSend] 系统内未配置任何视觉模型，无法识别图片`)
          setToast({
            message: '当前没有可用的视觉模型，请联系管理员配置或切换到支持图片的模型',
            type: 'error',
          })
          const placeholderLines = needsRecognition
            .map((a) => `[图片附件: ${a.fileName}] 系统未配置视觉模型，未能识别图片内容`)
            .join('\n')
          finalContent = `${finalContent}\n\n${placeholderLines}`
        } else {
          logger.info(
            `[handleSend] 当前模型(${selectedModelId})不支持视觉，使用视觉模型 ${visionModelId} 识别 ${needsRecognition.length} 张图片`,
          )
          setToast({ message: `正在用视觉模型识别 ${needsRecognition.length} 张图片...`, type: 'info' })
          try {
            const strategies = getDefaultStrategies()
            const recognized = await runImageProcessing(
              needsRecognition.map((a) => ({
                fileName: a.fileName,
                filePath: a.filePath,
                mimeType: '',
                size: 0,
                category: 'image' as const,
              })),
              strategies,
              { visionModelId, includeOcr: true },
            )
            // 把刚识别完的结果回填到 pendingAttachments
            setPendingAttachments((prev) =>
              prev.map((a) => {
                const outcomes = recognized.get(a.filePath)
                return outcomes && outcomes.length > 0 ? { ...a, recognitionResults: outcomes } : a
              }),
            )
            // 同步刷新本地副本（state 在 useCallback 内不会立即生效）
            for (const a of imagePendingAttachments) {
              const outcomes = recognized.get(a.filePath)
              if (outcomes && outcomes.length > 0) {
                a.recognitionResults = outcomes
              }
            }
            // 检查识别是否真的成功：没有 recognize 类型结果的文件视为失败
            const hasSuccessfulRecognition = (outcomes: import('./utils/image-processing-strategy').ImageProcessingResult[] | undefined) =>
              outcomes?.some((r) => r.kind === 'recognize') ?? false
            const failedFiles = needsRecognition.filter((a) => !hasSuccessfulRecognition(recognized.get(a.filePath)))
            // 检查是否因为模型不支持视觉而失败（MODEL_NO_VISION）
            const hasNoVisionError = needsRecognition.some((a) => {
              const outcomes = recognized.get(a.filePath)
              return outcomes?.some((r) => r.kind === 'failed' && r.errorCode === 'MODEL_NO_VISION')
            })
            if (hasNoVisionError) {
              setToast({
                message: `所选视觉模型不支持图像输入，请在模型列表中选择支持"图片"的模型`,
                type: 'error',
              })
            }
            if (failedFiles.length > 0) {
              logger.warn(
                `[handleSend] ${failedFiles.length}/${needsRecognition.length} 张图片识别失败，注入占位文本`,
              )
              const placeholderLines = failedFiles
                .map((a) => `[图片附件: ${a.fileName}] 识别失败，请尝试切换到支持视觉的模型`)
                .join('\n')
              finalContent = `${finalContent}\n\n${placeholderLines}`
            }
            if (failedFiles.length < needsRecognition.length) {
              logger.info(`[handleSend] 图片识别完成，已注入识别结果`)
            }
          } catch (err) {
            logger.warn(
              `[handleSend] 图片识别整体失败，注入占位文本: ${err instanceof Error ? err.message : String(err)}`,
            )
            setToast({ message: '图片识别失败，将以占位文本发送', type: 'error' })
            const placeholderLines = needsRecognition
              .map((a) => `[图片附件: ${a.fileName}] 识别调用失败，未能提取图片内容`)
              .join('\n')
            finalContent = `${finalContent}\n\n${placeholderLines}`
          }
        }
      }
    }

    // 图片识别结果注入：把图片描述与 OCR 写入消息，让 Agent 即使使用
    // 纯文本模型也能理解图片内容（模型本身是多模态时仍然会额外接收图片路径）
    const recognitionMap = new Map<string, ImageProcessingResult[]>()
    const fileNameMap = new Map<string, string>()
    for (const a of pendingAttachments) {
      if (a.recognitionResults && a.recognitionResults.length > 0) {
        recognitionMap.set(a.filePath, a.recognitionResults)
        fileNameMap.set(a.filePath, a.fileName)
      }
    }
    if (recognitionMap.size > 0) {
      const recognitionText = serializeRecognitionResults(recognitionMap, fileNameMap)
      if (recognitionText) {
        finalContent = `${finalContent}\n\n${recognitionText}`
      }
    }

    // 文档解析伴生文件注入：告知 Agent 可通过 file_read 读取解析后的纯文本
    const parsedDocs = pendingAttachments.filter((a) => a.parsedTextPath)
    if (parsedDocs.length > 0) {
      const parsedLines = parsedDocs.map(
        (a) => `[parsed text: ${a.parsedTextPath} (from ${a.fileName})]`
      ).join('\n')
      finalContent = `${finalContent}\n${parsedLines}`
    }

    // 拦截斜杠命令
    if (valueToSend.trim().startsWith('/')) {
      const sessionKey = runtimeCurrentSessionKey
      if (sessionKey) {
        const handled = await executeSlashCommand(valueToSend.trim(), {
          sessionKey,
          agentId: selectedAgent?.id ?? mainAgentId ?? undefined,
          addSystemMessage,
          showToast: (message, type) => setToast({ message, type }),
          compactContext: handleCompactContext,
          createSession: async () => {
            await handleNewConversation()
          },
          switchSession: async (sk: string) => {
            await runtimeActions.switchSession(sk)
            void refreshLocalSessions()
          },
          listSessions: async () => {
            const list = await runtimeActions.listSessions()
            return list
          },
        })
        if (handled) {
          clearCurrentInputState(sessionKey)
          return
        }
      }
    }

    const sendingSessionId = runtimeCurrentSessionKey ?? ''
    setSendingSessionIds((prev) => new Set(prev).add(sendingSessionId))
    try {
      const agentId = selectedAgent?.id ?? mainAgentId ?? undefined
      const modelId = selectedModelId || undefined
      // 仅当模型支持视觉时，把图片路径以结构化方式传给主进程，
      // 由 bridge 读盘转 base64 注入 LLM 的 vision API；
      // 否则前面已把识别结果注入文本，这里不再传图片路径，避免重复发送图片块。
      const imageAttachmentPaths = modelSupportsVision && imagePendingAttachments.length > 0
        ? imagePendingAttachments.map((a) => a.filePath)
        : undefined
      if (imageAttachmentPaths) {
        logger.info(
          `[handleSend] 支持视觉的模型，将传递 ${imageAttachmentPaths.length} 张图片到主进程: ${imageAttachmentPaths[0]}...`,
        )
      }
      try {
        await runtimeActions.sendMessage(finalContent, { agentId, modelId, imageAttachmentPaths })
        void refreshLocalSessions()
      } catch (err) {
        if (err instanceof Error && err.message.includes('No active session')) {
          await runtimeActions.createSession('新对话', agentId, selectedModelId || undefined)
          await runtimeActions.sendMessage(finalContent, { agentId, modelId, imageAttachmentPaths })
          void refreshLocalSessions()
        } else {
          throw err
        }
      }
      clearCurrentInputState(sendingSessionId)
      setPendingAttachments([])
    } catch (err) {
      logger.error(`[handleSend] 发送失败: ${err instanceof Error ? err.message : String(err)}`)
      setToast({ message: `发送失败: ${err instanceof Error ? err.message : '未知错误'}`, type: 'error' })
    } finally {
      setSendingSessionIds((prev) => { const next = new Set(prev); next.delete(sendingSessionId); return next })
    }
  }, [
    inputValue,
    pendingAttachments,
    isSending,
    runtimeCurrentSessionKey,
    selectedAgent,
    mainAgentId,
    selectedModelId,
    availableModels,
    pickVisionModelId,
    runtimeActions,
    refreshLocalSessions,
    addSystemMessage,
    handleCompactContext,
    handleNewConversation,
    clearCurrentInputState,
  ])

  // approvalItems/planApprovalItems 始终为空，这些 handler 不会被触发，为了保持接口兼容而保留
  const handleApprovalDecision = useCallback((_id: string, _decision: unknown) => {
    // Gateway 审批已禁用
  }, [])

  const handlePlanApprove = useCallback(async (_requestId: string) => {
    // Gateway 计划审批已禁用
  }, [])

  const handlePlanReject = useCallback(async (_requestId: string, _feedback?: string) => {
    // Gateway 计划审批已禁用
  }, [])

  const handleToggleAutoApprove = useCallback(() => {
    setAutoApprove((v) => !v)
  }, [])

  const formatTime = useCallback((date: Date): string => {
    return new Date(date).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }, [])

  // Message action handlers
  const handleCopyMessage = useCallback((content: string) => {
    navigator.clipboard.writeText(content).then(() => {
      setToast({ message: '已复制到剪贴板', type: 'success' })
    }).catch((err) => {
      logger.error(`[handleCopyMessage] 复制失败: ${err instanceof Error ? err.message : String(err)}`)
      setToast({ message: '复制失败', type: 'error' })
    })
  }, [])

  // 编辑用户消息保存 = 改问题重新问：删后续 + 用新内容重答（与「重新生成」统一）
  const handleEditMessage = useCallback((messageId: string, newContent: string) => {
    const sessionKey = runtimeCurrentSessionKey
    if (!sessionKey) return
    void runtimeActions.editAndResend(messageId, newContent, { sessionKey }).catch((err) => {
      logger.error(`[handleEditMessage] 编辑失败: ${err instanceof Error ? err.message : String(err)}`)
      setToast({ message: '编辑失败，请重试', type: 'error' })
    })
  }, [runtimeActions, runtimeCurrentSessionKey])

  const handleDeleteMessage = useCallback((messageId: string) => {
    const sessionKey = runtimeCurrentSessionKey
    if (!sessionKey) return
    void runtimeActions.deleteMessage(messageId, { sessionKey }).catch((err) => {
      logger.error(`[handleDeleteMessage] 删除失败: ${err instanceof Error ? err.message : String(err)}`)
      setToast({ message: '删除失败，请重试', type: 'error' })
    })
  }, [runtimeActions, runtimeCurrentSessionKey])

  const handleRegenerateMessage = useCallback((messageId: string) => {
    const sessionKey = runtimeCurrentSessionKey
    if (!sessionKey) return
    // 统一语义：回到对应的用户提问 → 删除其后所有消息 → 复用原文重新回答。
    // assistant 消息回退到它前面最近的 user；user 消息就以自身为锚点。
    const messages = runtimeMessages
    const msgIndex = messages.findIndex((m) => m.id === messageId)
    if (msgIndex === -1) return
    let anchor: typeof messages[0] | null = null
    for (let i = messages[msgIndex].role === 'user' ? msgIndex : msgIndex - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { anchor = messages[i]; break }
    }
    if (!anchor) return
    const anchorIdx = messages.findIndex((m) => m.id === anchor!.id)
    const userContent = anchor.content.map((c) => ('text' in c ? c.text : '')).join('')
    if (!userContent.trim()) return

    const removedCount = messages.length - anchorIdx - 1
    void runtimeActions.editAndResend(anchor.id, userContent, { sessionKey }).then(() => {
      if (removedCount > 0) setToast({ message: `已删除后续 ${removedCount} 条消息`, type: 'info' })
    }).catch((err) => {
      logger.error(`[handleRegenerateMessage] 重新生成失败: ${err instanceof Error ? err.message : String(err)}`)
      setToast({ message: '重新生成失败，请重试', type: 'error' })
    })
  }, [runtimeActions, runtimeCurrentSessionKey, runtimeMessages])

  // Session management handlers
  const handlePinSession = useCallback(async (sessionId: string) => {
    await runtimeActions.pinSession(sessionId)
    await refreshLocalSessions()
  }, [runtimeActions, refreshLocalSessions])

  const handleDeleteSession = useCallback((sessionId: string) => {
    setSessionToDelete(sessionId)
    setIsDeleteSessionModalOpen(true)
  }, [])

  const handleConfirmDeleteSession = useCallback(async () => {
    if (!sessionToDelete) return
    try {
      await runtimeActions.deleteSession(sessionToDelete)
      await refreshLocalSessions()
      setToast({ message: '会话已删除', type: 'info' })
    } catch (err) {
      logger.error('[handleConfirmDeleteSession] 删除会话失败:', err)
      setToast({ message: '删除会话失败', type: 'error' })
    }
    setIsDeleteSessionModalOpen(false)
    setSessionToDelete(null)
  }, [sessionToDelete, runtimeActions, refreshLocalSessions])

  const handleCancelDeleteSession = useCallback(() => {
    setIsDeleteSessionModalOpen(false)
    setSessionToDelete(null)
  }, [])

  const handleRenameSession = useCallback((sessionId: string, newTitle: string) => {
    void runtimeActions.renameSession(sessionId, newTitle).then(() => {
      void refreshLocalSessions()
    })
  }, [runtimeActions, refreshLocalSessions])

  // Handle suggestion click from empty state
  const handleSuggestionClick = useCallback((suggestion: string) => {
    setInputValue(suggestion)
  }, [setInputValue])

  // 稳定化传给 ChatContainer 的回调，避免每次 render 新建函数破坏 memo
  const handleReplayFromMessage = useCallback((messageId: string) => {
    if (conversationReplay.isReplaying) {
      conversationReplay.stopReplay()
    } else {
      conversationReplay.startReplay(messageId, localRuntimeSession?.messages ?? [])
    }
  }, [conversationReplay, localRuntimeSession])

  // 处理手动中断 Agent
  const handleAbort = useCallback(async () => {
    await runtimeActions.abort()
    setToast({ message: '已中断回复', type: 'info' })
  }, [runtimeActions])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd + N: New conversation
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault()
        handleNewConversation()
      }
      // Ctrl/Cmd + B: 折叠/展开最外层侧栏（会话列表在里面）
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault()
        toggleOuterSidebar()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleNewConversation, toggleOuterSidebar])

  // 客户端命令工具事件监听（Agent 主动调用工具时触发）
  useEffect(() => {
    const onCreateRequest = () => { void handleNewConversation() }
    const onSwitchRequest = (e: Event) => {
      const { sessionKey } = (e as CustomEvent<{ sessionKey: string }>).detail ?? {}
      if (sessionKey) void runtimeActions.switchSession(sessionKey)
    }
    window.addEventListener('mtbot:session-create-request', onCreateRequest)
    window.addEventListener('mtbot:session-switch-request', onSwitchRequest)
    return () => {
      window.removeEventListener('mtbot:session-create-request', onCreateRequest)
      window.removeEventListener('mtbot:session-switch-request', onSwitchRequest)
    }
  }, [handleNewConversation, runtimeActions])

  return (
    <div
      className={styles['chat-page']}
      ref={chatPageRef}
      style={pageZoom !== 1 ? ({ zoom: pageZoom } as React.CSSProperties) : undefined}
    >
      {/* 会话列表 portal 进最外层侧栏。不做「原地渲染」兜底：ChatPage 在非对话视图下被
          display:none 包着，退回原地等于把列表藏起来，比直接不渲染更难发现 */}
      {sessionSlot &&
        createPortal(
          <ChatSidebar
            sessions={localRuntimeSessionsAsChatSessions}
            activeSessionId={runtimeCurrentSessionKey ?? null}
            onSelectSession={(sessionKey) => {
              onViewChange?.('chat')
              void runtimeActions.switchSession(sessionKey, selectedModelId || undefined)
            }}
            onCreateSession={() => {
              onViewChange?.('chat')
              void (async () => {
                await runtimeActions.createSession('新对话', selectedAgent?.id, selectedModelId || undefined)
                void refreshLocalSessions()
              })()
            }}
            onPinSession={handlePinSession}
            onDeleteSession={handleDeleteSession}
            onRenameSession={handleRenameSession}
          />,
          sessionSlot,
        )}

      <div
        className={clsx(styles['chat-main'], workbenchResizing && styles.chatMainResizing)}
        data-chat-dialog
        style={
          workbench.open && workbenchWidth > 0
            ? {
                paddingRight: workbenchWidth,
                ['--workbench-inset' as string]: `${workbenchWidth}px`,
              }
            : undefined
        }
      >
        {/* 消息层：全屏滚动，顶部/底部浮层可透视 */}
        <div
          className={styles['chat-main-body']}
          style={{ ['--chat-font-size' as string]: FONT_SCALE_PX[fontScale] }}
        >
          <ChatContainer
            session={localRuntimeSession}
            approvalItems={approvalItems}
            planApprovalItems={planApprovalItems}
            workflowItems={workflowItems}
            isLoading={false}
            isStreaming={runtimeIsStreaming}
            isSending={isSending}
            resolvingIds={resolvingIds}
            planResolvingIds={planResolvingIds}
            formatTime={formatTime}
            onApprovalDecision={handleApprovalDecision as any}
            onPlanApprove={handlePlanApprove}
            onPlanReject={handlePlanReject}
            onCopyMessage={handleCopyMessage}
            onEditMessage={handleEditMessage}
            onDeleteMessage={handleDeleteMessage}
            onRegenerateMessage={handleRegenerateMessage}
            onSuggestionClick={handleSuggestionClick}
            streamingThinkingText={runtimeThinkingLive}
            fileEvents={runtimeFileEvents}
            compactionEvents={runtimeCompactionEvents}
            onReplayFromMessage={handleReplayFromMessage}
            replayMessageId={conversationReplay.replayMessageId}
          />
        </div>

        {/* 顶部毛玻璃浮层：会话标题 + 工具栏 */}
        <div className={styles['chat-overlay-top']}>
          <div className={styles['chat-toolbar']}>
            <button
              type="button"
              className={styles['icon-btn']}
              onClick={toggleOuterSidebar}
              title="折叠/展开侧栏 (Ctrl+B)"
              aria-label="折叠/展开侧栏"
            >
              <PanelLeft size={16} strokeWidth={1.8} />
            </button>
            <h2 className={styles['chat-title']}>
              {localRuntimeSession?.title ?? 'AI 助手对话'}
            </h2>
            <div className={styles['toolbar-actions']}>
            {pageZoom !== 1 && (
              <button
                type="button"
                className={styles['icon-btn']}
                onClick={() => { setPageZoom(1); try { localStorage.setItem(PAGE_ZOOM_KEY, '1') } catch { /* ignore */ } }}
                title="点击复位缩放（Ctrl+0）"
                aria-label="复位缩放"
                style={{ fontSize: 11, fontWeight: 600 }}
              >
                {Math.round(pageZoom * 100)}%
              </button>
            )}
            <button
              type="button"
              className={styles['icon-btn']}
              onClick={cycleFontScale}
              title={`消息字号：${FONT_SCALE_LABEL[fontScale]}（点击切换 小/中/大）`}
              aria-label="切换消息字号"
            >
              <Type size={16} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className={clsx(styles['auto-approve-toggle'], autoApprove && styles['auto-approve-toggle--on'])}
              onClick={handleToggleAutoApprove}
              title={autoApprove ? '自动审批已开启，点击关闭' : '自动审批已关闭，点击开启'}
            >
              {autoApprove ? '自动审批' : '需要审批'}
            </button>
            <button
              type="button"
              className={clsx(styles['icon-btn'], workbench.open && styles['icon-btn--active'])}
              onClick={toggleFilesWorkbench}
              title="工作空间文件"
              aria-label="打开工作空间文件"
              aria-pressed={workbench.open}
            >
              <FolderOpen size={16} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className={styles['icon-btn']}
              onClick={async () => {
                // 绑定当前会话：先写入主进程 activeSessionKey，宠物窗口 resolvePetSessionKey 会优先复用
                if (runtimeCurrentSessionKey) {
                  await window.electronAPI?.pet?.setActiveSessionKey(runtimeCurrentSessionKey).catch(() => {})
                }
                const r = await window.electronAPI?.pet?.switchMode('pet')
                if (r && !r.success) {
                  setToast({ message: `进入宠物模式失败：${r.error ?? '未知错误'}`, type: 'error' })
                }
              }}
              title="进入宠物模式"
              aria-label="进入宠物模式"
            >
              <Sparkles size={16} strokeWidth={1.8} />
            </button>
            </div>
          </div>
        </div>

        {/* 底部毛玻璃浮层：文件/任务、Tips、输入框 */}
        <div className={styles['chat-overlay-bottom']}>
          {(runtimeFileEvents.length > 0 || sessionTodoCalls.length > 0) && (
            <div className={styles['chat-meta-bar']}>
              <SessionFileList
                files={runtimeFileEvents}
                userId="local-user"
                sessionKey={runtimeCurrentSessionKey}
                compact
              />
              {sessionTodoCalls.length > 0 && (
                <TodoPanel
                  key={runtimeCurrentSessionKey ?? ''}
                  toolCalls={sessionTodoCalls}
                  compact
                />
              )}
            </div>
          )}

          {/* 权限审批：行内卡片贴在输入框上方（原型 .apr），不再弹窗遮挡上下文 */}
          {runtimePendingPermission && !autoApprove && (
            <div className={styles['chat-inline-approval']}>
              <ConfirmationDialog
                open
                description={runtimePendingPermission.description}
                toolName={runtimePendingPermission.toolName}
                timeoutMs={runtimePendingPermission.timeoutMs}
                sessionHint={
                  permissionSessionKey && permissionSessionKey !== runtimeCurrentSessionKey
                    ? `来自后台会话：${permissionSessionKey}`
                    : undefined
                }
                onAllow={() => runtimeActions.respondPermission('allow-always')}
                onDeny={() => runtimeActions.respondPermission('deny')}
              />
            </div>
          )}

          {currentSessionInterrupted && runtimeCurrentSessionKey && (
            <InterruptBanner
              sessionKey={runtimeCurrentSessionKey}
              onContinue={handleContinueInterrupted}
              onDismiss={handleDismissInterrupt}
            />
          )}

          {voiceCallState.state !== 'idle' ? (
            <VoiceCallPanel
              state={voiceCallState.state}
              partialTranscript={voiceCallState.partialTranscript}
              finalTranscript={voiceCallState.finalTranscript}
              error={voiceCallState.error}
              onHangup={() => void voiceCallActions.stopCall()}
              analyserNode={voiceCallState.analyserNode}
            />
          ) : (
          <ChatInput
            value={inputValue}
            onChange={setInputValue}
            onSend={handleSend}
            onSendWithValue={handleSend}
            onAbort={handleAbort}
            disabled={isSending}
            isStreaming={runtimeIsStreaming}
            turnEndAt={runtimeLastTurnEndAt}
            isConnected={true}
            agents={userAgents}
            selectedAgent={selectedAgent}
            agentsLoading={agentsLoading}
            onAgentChange={(agent) => {
              selectAgent(agent)
              if (!agent) return
              void runtimeActions.createSession('新对话', agent.id, selectedModelId || undefined).then(() => {
                void refreshLocalSessions()
              })
            }}
            modelChoices={chatModelChoices.map((m) => ({ id: m.id, name: m.name }))}
            selectedModelId={selectedModelId}
            modelsLoading={modelsLoading}
            onModelChange={(modelId) => { void handleSelectChatModel(modelId) }}
            thinkingEnabled={thinkingEnabled}
            reasoningEffort={reasoningEffort}
            onThinkingEnabledChange={handleThinkingEnabledChange}
            onReasoningEffortChange={handleReasoningEffortChange}
            modelContextWindow={selectedModelContextWindow}
            onSteer={runtimeActions.steer}
            contextUsage={runtimeContextUsage}
            isCompacting={runtimeIsAutoCompacting}
            onCompactContext={handleCompactContext}
            pendingAttachments={pendingAttachments}
            onFileUpload={handleFilesImport}
            onRemoveAttachment={(filePath) => {
              setPendingAttachments((prev) => prev.filter((a) => a.filePath !== filePath))
            }}
            onViewChange={onViewChange}
            fileReferences={activeFileReferences}
            onFileReferenceAdd={handleFileReferenceAdd}
            onFileReferenceRemove={handleFileReferenceRemove}
            onVoiceCallStart={runtimeCurrentSessionKey ? () => void voiceCallActions.startCall(runtimeCurrentSessionKey, selectedAgent?.id) : undefined}
            onLocateFile={(absolutePath) => {
              setWorkbench({ open: true, tab: 'files' })
              locateTokenRef.current += 1
              setLocateFileTarget({ path: absolutePath, token: locateTokenRef.current })
            }}
            showTips={showInputTips}
          />
          )}
        </div>
      </div>

      {/* 语音模型下载对话框 */}
      {voiceCallState.modelsNotReady && (
        <VoiceModelDownloadDialog
          models={voiceCallState.modelsNotReady}
          onClose={() => voiceCallActions.dismissModelDownload()}
          onAllReady={() => {
            voiceCallActions.dismissModelDownload()
            if (runtimeCurrentSessionKey) {
              void voiceCallActions.startCall(runtimeCurrentSessionKey, selectedAgent?.id)
            }
          }}
        />
      )}

      {/* Toast notification */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}

      {/* Delete Session Confirm Modal */}
      <ConfirmModal
        open={isDeleteSessionModalOpen}
        title="确认删除会话"
        content="确定要删除这个会话吗？删除后所有消息将丢失，此操作不可恢复。"
        confirmText="删除"
        cancelText="取消"
        confirmVariant="danger"
        onConfirm={handleConfirmDeleteSession}
        onCancel={handleCancelDeleteSession}
      />

      {runtimePendingAskUser ? (
        <AskUserModal
          open
          questions={runtimePendingAskUser.questions}
          timeoutMs={runtimePendingAskUser.timeoutMs}
          onSubmit={(payload) => runtimeActions.respondAskUser(payload)}
          onDecline={() => runtimeActions.respondAskUser({ answers: {}, declined: true })}
        />
      ) : null}

      {/* 工作空间共享壳：文件 + 版本（可拖拽改宽，对话区自适应） */}
      <WorkspaceWorkbench
        open={workbench.open}
        tab={workbench.tab}
        onTabChange={(tab) => {
          setWorkbenchLayout('default')
          setWorkbench((w) => ({ ...w, tab, open: true }))
        }}
        onClose={() => setWorkbench((w) => ({ ...w, open: false }))}
        uncommittedCount={uncommittedDiff.length}
        onRefresh={() => { void refreshVcs() }}
        onWidthChange={handleWorkbenchWidthChange}
        onResizingChange={setWorkbenchResizing}
        layoutMode={workbenchLayout}
        onLayoutModeChange={handleWorkbenchLayoutChange}
        childrenFiles={
          <WorkspaceFilePanel
            open={workbench.open}
            onClose={() => setWorkbench((w) => ({ ...w, open: false }))}
            locateTarget={locateFileTarget}
            embedded
          />
        }
        childrenVcs={
          <WorkspaceVersionPanel
            open={workbench.open}
            onClose={() => setWorkbench((w) => ({ ...w, open: false }))}
            embedded
            layoutMode={workbenchLayout}
            onLayoutModeChange={handleWorkbenchLayoutChange}
            onRevealInFiles={(relPath) => {
              const root = (workspaceDir ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
              const abs = root
                ? `${root}/${relPath.replace(/^\/+/, '')}`
                : relPath
              setWorkbenchLayout('default')
              setWorkbench({ open: true, tab: 'files' })
              locateTokenRef.current += 1
              setLocateFileTarget({ path: abs, token: locateTokenRef.current })
            }}
          />
        }
      />
    </div>
  )
}

export { ChatPage }
export default ChatPage
