import React, { useRef, useCallback, useState, useEffect, useLayoutEffect } from 'react'
import clsx from 'clsx'
import styles from './ChatInput.module.css'
import type { Agent } from '../../../../services/agent-service'
import type { ContextUsage } from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'
import { searchCommands, CATEGORY_LABELS } from '../../commands/slash-commands'
import type { SlashCommand } from '../../commands/slash-commands'
import { getSelectedAcpBackendId, BACKEND_INFO, MAIN_BACKEND_ID } from '../../commands/slash-command-executor'
import { getSupportedAttachmentAccept } from '../../utils/file-attachment-strategy'
import Switch from '../../../../components/ui/Switch/Switch'
import { formatContextUsageCompact, formatTokenCount } from '../../../../utils/format-token-count'
import ContextUsageCard from './ContextUsageCard'
import { useRotatingTip } from '../TipsBanner/useRotatingTip'
import { ComposerPlusMenu } from './ComposerPlusMenu'
import { useComposerDraft } from './useComposerDraft'
import type { ViewType } from '../../../../components/Router'

interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  /** 当前会话 key；切换时把未 flush 的本地草稿写回旧会话 */
  sessionKey?: string | null
  /** 按指定 sessionKey 持久化草稿，避免切会话后写到新会话 */
  onPersistDraft?: (sessionKey: string | null, value: string) => void
  onSend: () => void
  onAbort?: () => void | Promise<void>
  disabled?: boolean
  isStreaming?: boolean
  /**
   * 本轮 Agent 回复「正常结束」的时间戳（来自 runtime store lastTurnEndAt）。
   * 该值发生变化（边沿触发）且等待队列非空时，自动发送队列。
   * 中止/错误不更新此值，避免误发。
   */
  turnEndAt?: number | null
  isConnected?: boolean
  placeholder?: string
  /** Agent 列表（用于 /命令 面板） */
  agents?: Agent[]
  /** 当前选中的 Agent */
  selectedAgent?: Agent | null
  /** Agent 加载中 */
  agentsLoading?: boolean
  /** Agent 选择回调（与 useAgents.selectAgent 签名一致） */
  onAgentChange?: (agent: Agent | null) => void
  /** chat 候选模型列表（来自 chat 用途槽） */
  modelChoices?: Array<{ id: string; name: string }>
  /** 当前选中的模型 id */
  selectedModelId?: string
  /** 模型加载中 */
  modelsLoading?: boolean
  /** 模型选择回调 */
  onModelChange?: (modelId: string) => void
  /** 是否开启思考模式（默认 true） */
  thinkingEnabled?: boolean
  /** 推理强度（思考开启时生效） */
  reasoningEffort?: 'high' | 'max'
  /** 思考模式开关回调 */
  onThinkingEnabledChange?: (enabled: boolean) => void
  /** 推理强度变更回调 */
  onReasoningEffortChange?: (effort: 'high' | 'max') => void
  /** 当前模型上下文窗口（用于展示兜底，当 runtime 尚未推送用量时） */
  modelContextWindow?: number
  /** 统一附件上传回调（图片 + 文件） */
  onFileUpload?: (files: FileList) => void | Promise<void>
  /** @deprecated 已与 onFileUpload 合并，保留兼容 */
  onImageUpload?: (files: FileList) => void | Promise<void>
  /** 待发附件列表（由父组件管理） */
  pendingAttachments?: Array<{ fileName: string; filePath: string }>
  /** 移除待发附件回调 */
  onRemoveAttachment?: (filePath: string) => void
  /** 主导航跳转（管理技能 / MCP / Agent） */
  onViewChange?: (view: ViewType) => void
  /** 中途插话回调（AI 正在回复时可用） */
  onSteer?: (steerText: string) => void
  /** 上下文使用量（来自 agent:context:usage 事件） */
  contextUsage?: ContextUsage | null
  /** 自动压缩进行中（显示"压缩中..."动画） */
  isCompacting?: boolean
  /** 手动压缩上下文回调 */
  onCompactContext?: () => void
  /** 直接以指定值发送（用于命令自动填充后立即发送，绕过 React 状态批处理） */
  onSendWithValue?: (value: string) => void
  /** 开始语音通话回调 */
  onVoiceCallStart?: () => void
  /** 工作空间文件被拖入输入框（用于在工作空间面板定位） */
  fileReferences?: FileReference[]
  onFileReferenceAdd?: (ref: FileReference) => void
  onFileReferenceRemove?: (absolutePath: string) => void
  /** 点击 @引用 chip 时定位文件（在工作空间面板中展开/选中） */
  onLocateFile?: (absolutePath: string) => void
  /** 输入框空白时在 placeholder 位置轮播 Tips */
  showTips?: boolean
}

export interface FileReference {
  relativePath: string
  name: string
  absolutePath: string
  isDirectory: boolean
}

/**
 * 构造上下文状态无障碍标签（视觉信息由悬浮卡片承载）。
 */
function formatContextUsageLabel(contextUsage: ContextUsage): string {
  const used = contextUsage.usedTokens
  const total = contextUsage.contextWindow
  const ratio = total > 0 ? used / total : 0
  const percent = Math.round(ratio * 100)
  const threshold = Math.round(contextUsage.triggerThreshold * 100)
  const level = ratio >= contextUsage.triggerThreshold
    ? '高风险，建议立即压缩'
    : contextUsage.isNearThreshold
      ? '接近阈值，建议尽快压缩'
      : '状态健康'

  return [
    `上下文使用 ${formatTokenCount(used)} / ${formatTokenCount(total)} tokens，${percent}%`,
    `压缩阈值 ${threshold}%`,
    `状态 ${level}`,
    '点击可主动压缩上下文',
  ].join('，')
}

/**
 * 对话输入卡：本地草稿 + IME 延迟同步，避免每个按键重绘整个 ChatPage。
 */
const ChatInput: React.FC<ChatInputProps> = ({
  value,
  onChange,
  sessionKey = null,
  onPersistDraft,
  onSend,
  onAbort,
  disabled,
  isStreaming,
  turnEndAt,
  isConnected,
  placeholder,
  agents = [],
  selectedAgent,
  agentsLoading,
  onAgentChange,
  modelChoices = [],
  selectedModelId,
  modelsLoading,
  onModelChange,
  thinkingEnabled = true,
  reasoningEffort = 'high',
  onThinkingEnabledChange,
  onReasoningEffortChange,
  modelContextWindow,
  onFileUpload,
  onImageUpload,
  pendingAttachments = [],
  onRemoveAttachment,
  onViewChange,
  onSteer,
  contextUsage,
  isCompacting = false,
  onCompactContext,
  onSendWithValue,
  onVoiceCallStart,
  fileReferences = [],
  onFileReferenceAdd,
  onFileReferenceRemove,
  onLocateFile,
  showTips = false,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const steerInputRef = useRef<HTMLInputElement>(null)
  const modelPanelRef = useRef<HTMLDivElement>(null)
  const helpPanelRef = useRef<HTMLDivElement>(null)
  const slashPanelRef = useRef<HTMLDivElement>(null)
  const [steerExpanded, setSteerExpanded] = useState(false)
  const [steerValue, setSteerValue] = useState('')
  // steer 发送后切换为「正在补充...」提示
  const [steerSent, setSteerSent] = useState(false)
  // AI 回复中的等待队列：有内容时回车入队，输入框为空时回车则打断当前回复并合并发送队列
  const [queuedMessages, setQueuedMessages] = useState<string[]>([])
  // 模型切换面板状态
  const [modelPanelOpen, setModelPanelOpen] = useState(false)
  // 帮助面板状态
  const [helpPanelOpen, setHelpPanelOpen] = useState(false)
  // 上下文占用卡片悬浮态
  const [contextCardOpen, setContextCardOpen] = useState(false)
  const [currentBackend, setCurrentBackend] = useState(() => getSelectedAcpBackendId())
  // 启动时从主进程同步后端选择（主进程持久化到 config 目录，比 localStorage 更可靠）
  useEffect(() => {
    const api = window.electronAPI?.agentRuntime
    if (api?.sendCommand) {
      api.sendCommand({ type: 'codingDev:getBackend' }).then((res: unknown) => {
        const r = res as { backendId?: string } | null
        if (r?.backendId && r.backendId !== getSelectedAcpBackendId()) {
          try { localStorage.setItem('mtbot:acp-backend', r.backendId) } catch {}
          setCurrentBackend(r.backendId)
        }
      }).catch(() => {})
    }
  }, [])
  // 监听同页面后端切换事件（由 slash-command-executor handleBackend 派发）
  useEffect(() => {
    const handleBackendChanged = (e: Event) => {
      const backendId = (e as CustomEvent<{ backendId: string }>).detail?.backendId
      if (backendId) setCurrentBackend(backendId)
    }
    window.addEventListener('mtbot:backend-changed', handleBackendChanged)
    return () => window.removeEventListener('mtbot:backend-changed', handleBackendChanged)
  }, [])
  // 斜杠命令补全面板
  const [slashSuggestions, setSlashSuggestions] = useState<SlashCommand[]>([])
  const [slashSuggestionIndex, setSlashSuggestionIndex] = useState(0)

  // 拖入的工作空间文件 @引用（textarea 为纯文本，引用以独立 chip 展示，可点击定位）
  const [isDragOver, setIsDragOver] = useState(false)

  const {
    innerValue,
    isComposingRef,
    setDraft,
    flushDraft,
    handleDraftChange,
    handleCompositionStart,
    handleCompositionEnd: commitComposition,
    handleBlur: flushDraftOnBlur,
  } = useComposerDraft({
    value,
    sessionKey,
    onChange,
    onPersistDraft,
  })

  /**
   * 按当前草稿更新斜杠补全；非 / 开头且已空时跳过 setState，避免每个按键多一次渲染。
   */
  const applySlashSuggestions = useCallback((nextValue: string) => {
    if (nextValue.startsWith('/') && !nextValue.includes('\n')) {
      setSlashSuggestions(searchCommands(nextValue))
      setSlashSuggestionIndex(0)
      return
    }
    setSlashSuggestions((prev) => (prev.length === 0 ? prev : []))
  }, [])

  // 在光标处插入 @引用文本
  const insertAtCursor = useCallback((text: string) => {
    const el = textareaRef.current
    if (!el) {
      const next = innerValue + text
      setDraft(next)
      flushDraft(next)
      return
    }
    const start = el.selectionStart ?? innerValue.length
    const end = el.selectionEnd ?? innerValue.length
    const next = innerValue.slice(0, start) + text + innerValue.slice(end)
    setDraft(next)
    flushDraft(next)
    requestAnimationFrame(() => {
      const pos = start + text.length
      el.selectionStart = el.selectionEnd = pos
      el.focus()
    })
  }, [innerValue, setDraft, flushDraft])

  const handleDrop = useCallback((e: React.DragEvent) => {
    const raw = e.dataTransfer.getData('application/x-mtbot-file')
    if (!raw) return
    e.preventDefault()
    setIsDragOver(false)
    try {
      const ref = JSON.parse(raw) as FileReference
      // 在文本中插入 @相对路径（保证带空格分隔，便于 Agent 解析）
      const needsSpace = innerValue.length > 0 && !/\s$/.test(innerValue)
      insertAtCursor(`${needsSpace ? ' ' : ''}@${ref.relativePath} `)
      onFileReferenceAdd?.(ref)
    } catch (err) {
      console.error('[ChatInput] 解析拖入文件失败:', err)
    }
  }, [innerValue, insertAtCursor, onFileReferenceAdd])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-mtbot-file')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // 仅当离开整个包裹区域时取消高亮（避免子元素间移动闪烁）
    if (e.currentTarget === e.target) setIsDragOver(false)
  }, [])

  // streaming 结束时只收起插话面板，不清空草稿（避免多轮 tool 间隙短暂 !isStreaming 误删用户正在输入的内容）
  useEffect(() => {
    if (!isStreaming) {
      setSteerExpanded(false)
      setSteerSent(false)
    }
  }, [isStreaming])

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [])

  // 本地草稿或外部写入变化时同步高度（不再在 onChange 里重复读 layout）
  useLayoutEffect(() => {
    adjustHeight()
  }, [innerValue, adjustHeight])

  /**
   * 输入变化：只更新本地草稿；IME 组合期间跳过斜杠匹配。
   */
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value
    handleDraftChange(newValue)
    if (isComposingRef.current) return
    applySlashSuggestions(newValue)
  }

  /**
   * 组合结束：一次性 flush 最终文案，并补算斜杠补全。
   */
  const handleCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    const newValue = (e.target as HTMLTextAreaElement).value
    commitComposition(newValue)
    applySlashSuggestions(newValue)
  }

  // 剪贴板粘贴处理：提取文件/图片并上传
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const { clipboardData } = e
    if (!clipboardData || !clipboardData.files || clipboardData.files.length === 0) {
      return // 无文件，继续默认粘贴（文本）
    }
    // 有文件：阻止默认行为（避免粘贴 [object File] 等无效文本），调用上传处理器
    e.preventDefault()
    const handler = onFileUpload ?? onImageUpload
    if (handler) {
      handler(clipboardData.files)
    }
  }, [onFileUpload, onImageUpload])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 组合期间（中文选词等）的回车/方向键属输入法操作，不触发补全导航或发送
    if (isComposingRef.current || e.nativeEvent.isComposing || e.key === 'Process') {
      return
    }
    // 斜杠命令面板键盘导航
    if (slashSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashSuggestionIndex((i) => Math.min(i + 1, slashSuggestions.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashSuggestionIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        const selected = slashSuggestions[slashSuggestionIndex]
        if (selected) {
          e.preventDefault()
          setSlashSuggestions([])
          // 命令无参数：直接发送，绕过 React 状态批处理
          if (!selected.usage || selected.usage === selected.name) {
            setDraft(selected.name)
            flushDraft(selected.name)
            if (onSendWithValue) {
              onSendWithValue(selected.name)
            } else {
              setTimeout(() => handleSend(), 0)
            }
          } else {
            // 有参数：填充命令名 + 空格，等待用户继续输入
            const fill = `${selected.name} `
            setDraft(fill)
            flushDraft(fill)
            textareaRef.current?.focus()
          }
          return
        }
      }
      if (e.key === 'Escape') {
        setSlashSuggestions([])
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (disabled) return
      // AI 正在回复时：回车不直接发送
      if (isStreaming) {
        const text = innerValue.trim()
        if (text) {
          // 有内容 → 追加到等待队列，清空输入框，可继续输入下一条
          setQueuedMessages((prev) => [...prev, text])
          setDraft('')
          flushDraft('')
          if (textareaRef.current) textareaRef.current.style.height = 'auto'
        } else if (queuedMessages.length > 0) {
          // 输入框为空且队列非空 → 打断当前回复，合并发送队列
          flushQueuedMessages()
        }
        return
      }
      // 非流式状态：空输入框 + 队列非空 → 直接发送队列（修复队列被孤立无法发出）
      if (!innerValue.trim()) {
        if (queuedMessages.length > 0) void flushQueuedMessages()
        return
      }
      handleSend()
    }
  }

  // 把队列中的消息合并为一条发送；若正在流式回复则先打断再发送
  const flushQueuedMessages = async () => {
    if (queuedMessages.length === 0) return
    const merged = queuedMessages.join('\n')
    setQueuedMessages([])
    // streaming 时先等打断完成再发送，避免新消息被旧回复的收尾覆盖；
    // 非 streaming 时无需打断（也避免误弹"已中断回复"提示）
    if (isStreaming) {
      await Promise.resolve(onAbort?.())
    }
    onSendWithValue?.(merged)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  // 用 ref 持有最新 flush，供 turnEndAt 边沿 effect 调用，避免闭包陈旧 & 频繁重订阅
  const flushQueuedMessagesRef = useRef(flushQueuedMessages)
  flushQueuedMessagesRef.current = flushQueuedMessages

  // Agent 本轮「正常结束」时（turnEndAt 边沿变化），若等待队列非空则自动发送。
  // 仅依赖 turnEndAt：中止/错误不更新该值，工具调用间隙也不触发（turn:end 才更新）。
  const handledTurnEndAtRef = useRef<number | null>(turnEndAt ?? null)
  useEffect(() => {
    if (turnEndAt == null) return
    if (turnEndAt === handledTurnEndAtRef.current) return
    handledTurnEndAtRef.current = turnEndAt
    // 此时已是非 streaming 状态，flush 内部不会触发打断
    void flushQueuedMessagesRef.current()
  }, [turnEndAt])

  // 从等待队列移除指定消息
  const removeQueuedMessage = (index: number) => {
    setQueuedMessages((prev) => prev.filter((_, i) => i !== index))
  }

  /**
   * 用本地草稿发送。先 flush 再发，避免发送失败时父组件空草稿把输入框冲掉。
   */
  const handleSend = () => {
    flushDraft(innerValue)
    if (onSendWithValue) {
      onSendWithValue(innerValue)
    } else {
      onSend()
    }
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleButtonClick = () => {
    if (isStreaming) {
      // 流式回复中点击停止：若队列有数据，打断的同时把队列发给 Agent；否则仅打断
      if (queuedMessages.length > 0) {
        void flushQueuedMessages()
      } else {
        onAbort?.()
      }
    } else if (queuedMessages.length > 0) {
      // 非流式但队列有数据：直接发送队列
      void flushQueuedMessages()
    } else if (innerValue.trim()) {
      handleSend()
    }
  }

  /** 统一附件选择变更：优先 onFileUpload，兼容旧 onImageUpload */
  const handleAttachmentInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const handler = onFileUpload ?? onImageUpload
      handler?.(e.target.files)
      e.target.value = ''
    }
  }

  /** 打开统一附件选择器 */
  const openAttachmentPicker = useCallback(() => {
    attachmentInputRef.current?.click()
  }, [])

  /** Ctrl+U 打开统一附件选择器 */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'u') return
      if (disabled || !isConnected) return
      e.preventDefault()
      openAttachmentPicker()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [disabled, isConnected, openAttachmentPicker])

  /** 跳转技能中心 / MCP（由 Settings Hub 浮层承接） */
  const navigateSkillsTab = useCallback((tab?: 'my-skills' | 'mcp') => {
    if (tab === 'mcp') {
      onViewChange?.('mcp')
      return
    }
    if (tab) {
      try {
        sessionStorage.setItem('mtbot_skills_init_tab', tab)
      } catch {
        /* ignore */
      }
      window.dispatchEvent(new CustomEvent('mtbot:open-skills-tab', { detail: { tab } }))
    }
    onViewChange?.('skills')
  }, [onViewChange])

  const handleManageSkills = useCallback(() => {
    navigateSkillsTab('my-skills')
  }, [navigateSkillsTab])

  const handleManageMcp = useCallback(() => {
    navigateSkillsTab('mcp')
  }, [navigateSkillsTab])

  const handleManageAgents = useCallback(() => {
    onViewChange?.('agents')
  }, [onViewChange])

  const handleSteerSend = useCallback(() => {
    if (!steerValue.trim() || !onSteer) return
    onSteer(steerValue.trim())
    setSteerValue('')
    setSteerExpanded(false)
    setSteerSent(true)
  }, [steerValue, onSteer])

  const handleSteerKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSteerSend()
    } else if (e.key === 'Escape') {
      setSteerExpanded(false)
      setSteerValue('')
    }
  }

  const handleOpenSteer = () => {
    setSteerExpanded(true)
    setTimeout(() => steerInputRef.current?.focus(), 0)
  }

  // 点击模型面板外部关闭
  useEffect(() => {
    if (!modelPanelOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (modelPanelRef.current && !modelPanelRef.current.contains(e.target as Node)) {
        setModelPanelOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [modelPanelOpen])

  // 帮助面板点击外部关闭
  useEffect(() => {
    if (!helpPanelOpen) return
    // 每次打开帮助面板时刷新当前后端状态
    setCurrentBackend(getSelectedAcpBackendId())
    const handleClickOutside = (e: MouseEvent) => {
      if (helpPanelRef.current && !helpPanelRef.current.contains(e.target as Node)) {
        setHelpPanelOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [helpPanelOpen])

  // 斜杠补全面板点击外部关闭
  useEffect(() => {
    if (slashSuggestions.length === 0) return
    const handleClickOutside = (e: MouseEvent) => {
      if (slashPanelRef.current && !slashPanelRef.current.contains(e.target as Node)) {
        setSlashSuggestions([])
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [slashSuggestions.length])

  const tipsEnabled = Boolean(showTips && isConnected && !isStreaming && !innerValue.trim())
  const rotatingTip = useRotatingTip(tipsEnabled)

  /** 有输入内容或附件时，输入卡片改为不透明，避免与透出的消息文字重叠 */
  const hasInputContent =
    innerValue.trim().length > 0 ||
    pendingAttachments.length > 0 ||
    fileReferences.length > 0

  const isDisabled = disabled || !isConnected
  const effectivePlaceholder = !isConnected
    ? '请先连接服务器'
    : isStreaming
      ? (queuedMessages.length > 0
          ? '回车继续入队，清空后回车打断并发送…'
          : 'AI 回复中，回车将消息加入等待队列…')
      : rotatingTip
        ? rotatingTip
        : (placeholder || '咱们今天干点啥！')

  const currentModelLabel =
    modelChoices.find((m) => m.id === selectedModelId)?.name ?? selectedModelId ?? '默认模型'
  const effectiveContextWindow =
    (contextUsage?.contextWindow && contextUsage.contextWindow > 0
      ? contextUsage.contextWindow
      : modelContextWindow) ?? 0
  const contextUsageLabel = contextUsage || effectiveContextWindow > 0
    ? formatContextUsageLabel({
        usedTokens: contextUsage?.usedTokens ?? 0,
        contextWindow: effectiveContextWindow,
        triggerThreshold: contextUsage?.triggerThreshold ?? 0.8,
        isNearThreshold: contextUsage?.isNearThreshold ?? false,
      })
    : '点击可主动压缩上下文'
  const contextWindowText =
    effectiveContextWindow > 0
      ? formatContextUsageCompact(contextUsage?.usedTokens ?? 0, effectiveContextWindow)
      : '--'

  return (
    <div className={styles['chat-input-wrapper']}>
      {!isConnected && (
        <div className={styles['connection-warning']}>未连接到服务器，无法发送消息</div>
      )}

      {/* 斜杠命令补全面板 */}
      {slashSuggestions.length > 0 && (
        <div className={styles['slash-panel']} ref={slashPanelRef}>
          <div className={styles['slash-panel-hint']}>
            <span>↑↓ 导航</span>
            <span>Tab / Enter 选中</span>
            <span>Esc 关闭</span>
          </div>
          {/* 按分类分组显示 */}
          {((): React.ReactNode => {
            const groups = new Map<string, SlashCommand[]>()
            for (const cmd of slashSuggestions) {
              const list = groups.get(cmd.category) ?? []
              list.push(cmd)
              groups.set(cmd.category, list)
            }
            return Array.from(groups.entries()).map(([cat, cmds]) => (
              <div key={cat}>
                <div className={styles['slash-panel-category']}>{CATEGORY_LABELS[cat as keyof typeof CATEGORY_LABELS] ?? cat}</div>
                {cmds.map((cmd) => {
                  const idx = slashSuggestions.indexOf(cmd)
                  const isActive = idx === slashSuggestionIndex
                  return (
                    <button
                      key={cmd.name}
                      type="button"
                      className={clsx(styles['slash-item'], isActive && styles['slash-item--active'])}
                      onMouseEnter={() => setSlashSuggestionIndex(idx)}
                      onClick={() => {
                        setSlashSuggestions([])
                        if (!cmd.usage || cmd.usage === cmd.name) {
                          setDraft(cmd.name)
                          flushDraft(cmd.name)
                          if (onSendWithValue) {
                            onSendWithValue(cmd.name)
                          } else {
                            setTimeout(() => handleSend(), 0)
                          }
                        } else {
                          setDraft(`${cmd.name} `)
                          flushDraft(`${cmd.name} `)
                          textareaRef.current?.focus()
                        }
                      }}
                    >
                      <span className={styles['slash-item-name']}>{cmd.name}</span>
                      {cmd.aliases && cmd.aliases.length > 0 && (
                        <span className={styles['slash-item-aliases']}>{cmd.aliases.join(', ')}</span>
                      )}
                      <span className={styles['slash-item-desc']}>{cmd.description}</span>
                      {cmd.usage && cmd.usage !== cmd.name && (
                        <span className={styles['slash-item-usage']}>{cmd.usage}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            ))
          })()}
        </div>
      )}

      {/* 中途插话输入区（按需展开，避免默认占用空间） */}
      {isStreaming && onSteer && steerExpanded && (
        <div className={styles['steer-input-area']}>
          <div className={styles['steer-input-row']}>
            <span className={styles['steer-label']}>插话</span>
            <input
              ref={steerInputRef}
              type="text"
              value={steerValue}
              onChange={(e) => setSteerValue(e.target.value)}
              onKeyDown={handleSteerKeyDown}
              placeholder="输入引导内容，AI 将立即调整方向..."
              className={styles['steer-input']}
            />
            <button
              type="button"
              onClick={handleSteerSend}
              disabled={!steerValue.trim()}
              className={styles['steer-send-btn']}
            >
              发送
            </button>
            <button
              type="button"
              onClick={() => { setSteerExpanded(false); setSteerValue('') }}
              className={styles['steer-cancel-btn']}
              title="取消"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* AI 回复中的等待队列：有内容回车入队，输入框清空后回车打断并合并发送 */}
      {queuedMessages.length > 0 && (
        <div className={styles['queue-area']}>
          <div className={styles['queue-header']}>
            <span className={styles['queue-title']}>等待队列 ({queuedMessages.length})</span>
            <span className={styles['queue-hint']}>
              {isStreaming ? '清空输入框后按回车 → 打断当前回复并发送' : '按回车或点击发送 → 立即发送队列'}
            </span>
            <button
              type="button"
              onClick={flushQueuedMessages}
              className={styles['steer-send-btn']}
              title={isStreaming ? '立即打断当前回复并发送队列' : '立即发送队列'}
            >
              立即发送
            </button>
          </div>
          <div className={styles['queue-list']}>
            {queuedMessages.map((msg, index) => (
              <div key={index} className={styles['queue-item']}>
                <span className={styles['queue-item-text']} title={msg}>{msg}</span>
                <button
                  type="button"
                  onClick={() => removeQueuedMessage(index)}
                  className={styles['queue-item-remove']}
                  aria-label="移除该消息"
                  title="移除"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 主输入卡片 */}
      <div
        className={clsx(
          styles['input-card'],
          hasInputContent && styles['input-card-filled'],
          isDisabled && styles['input-card-disabled'],
          isDragOver && styles['input-card-dragover'],
        )}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {/* 拖入的工作空间文件 @引用 */}
        {fileReferences.length > 0 && (
          <div className={styles['attachment-preview-row']}>
            {fileReferences.map((ref) => (
              <div key={ref.absolutePath} className={styles['attachment-chip']}>
                <span className={styles['attachment-chip-icon']} aria-hidden>@</span>
                <button
                  type="button"
                  className={styles['attachment-chip-name']}
                  title={`点击在工作空间定位：${ref.relativePath}`}
                  onClick={() => onLocateFile?.(ref.absolutePath)}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit' }}
                >
                  {ref.name}
                </button>
                <button
                  type="button"
                  className={styles['attachment-chip-remove']}
                  onClick={() => onFileReferenceRemove?.(ref.absolutePath)}
                  aria-label={`移除引用 ${ref.name}`}
                >×</button>
              </div>
            ))}
          </div>
        )}
        {/* 待发附件预览区 */}
        {pendingAttachments.length > 0 && (
          <div className={styles['attachment-preview-row']}>
            {pendingAttachments.map((att) => {
              const isImage = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i.test(att.fileName)
              return (
                <div key={att.filePath} className={styles['attachment-chip']}>
                  <span className={styles['attachment-chip-icon']} aria-hidden>
                    {isImage ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                    )}
                  </span>
                  <span className={styles['attachment-chip-name']} title={att.filePath}>{att.fileName}</span>
                  <button
                    type="button"
                    className={styles['attachment-chip-remove']}
                    onClick={() => onRemoveAttachment?.(att.filePath)}
                    aria-label={`移除 ${att.fileName}`}
                  >×</button>
                </div>
              )
            })}
          </div>
        )}
        {/* 文本域 */}
        <textarea
          ref={textareaRef}
          value={innerValue}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onBlur={flushDraftOnBlur}
          onPaste={handlePaste}
          disabled={isDisabled}
          placeholder={effectivePlaceholder}
          rows={1}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          className={styles['chat-textarea']}
        />

        {/* 底部工具栏 */}
        <div className={styles['input-toolbar']}>
          {/* 左侧：「+」菜单 + 模型切换 + 思考 */}
          <div className={styles['toolbar-left']}>
            <ComposerPlusMenu
              disabled={isDisabled}
              onAttachFiles={openAttachmentPicker}
              agents={agents}
              selectedAgent={selectedAgent}
              agentsLoading={agentsLoading}
              onAgentChange={onAgentChange}
              onManageSkills={handleManageSkills}
              onManageMcp={handleManageMcp}
              onManageAgents={handleManageAgents}
            />

            {/* 模型切换 */}
            <div
              className={styles['toolbar-select-wrapper']}
              ref={modelPanelRef}
            >
              <button
                type="button"
                className={styles['toolbar-select-overlay']}
                onClick={() => setModelPanelOpen((v) => !v)}
                disabled={isDisabled || modelChoices.length === 0}
                aria-label="切换模型"
                title="切换对话模型"
              />
              <span className={styles['toolbar-agent-glyph']} aria-hidden>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <path d="M9 9h6v6H9z" />
                </svg>
              </span>
              <span className={styles['toolbar-select-label']}>{currentModelLabel}</span>
              <span className={styles['toolbar-select-chevron']}>∨</span>
              {modelPanelOpen && (
                <div className={styles['command-dropdown']}>
                  <div className={styles['command-dropdown-title']}>切换模型</div>
                  {modelsLoading ? (
                    <div className={styles['command-loading']}>加载中...</div>
                  ) : modelChoices.length === 0 ? (
                    <div className={styles['command-loading']}>无可用模型</div>
                  ) : (
                    modelChoices.map((m) => (
                      <button
                        type="button"
                        key={m.id}
                        className={`${styles['command-item']} ${selectedModelId === m.id ? styles['command-item--active'] : ''}`}
                        onClick={() => {
                          onModelChange?.(m.id)
                          setModelPanelOpen(false)
                        }}
                      >
                        <span className={styles['command-item-icon']} aria-hidden>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 9h6v6H9z" /></svg>
                        </span>
                        <span>{m.name}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* 思考模式 + 推理强度（紧邻模型选择） */}
            <div className={clsx(styles['thinking-controls'], thinkingEnabled && styles['thinking-controls-on'])}>
              <label className={styles['thinking-toggle']} title="控制是否开启模型思考模式">
                <span className={styles['thinking-toggle-label']}>思考</span>
                <Switch
                  size="sm"
                  checked={thinkingEnabled}
                  disabled={isDisabled}
                  onChange={(checked) => onThinkingEnabledChange?.(checked)}
                />
              </label>
              <select
                className={styles['reasoning-effort-select']}
                value={reasoningEffort}
                disabled={isDisabled || !thinkingEnabled}
                title={thinkingEnabled ? '推理努力程度' : '请先开启思考模式'}
                aria-label="推理努力程度"
                onChange={(e) => onReasoningEffortChange?.(e.target.value as 'high' | 'max')}
              >
                <option value="high">High</option>
                <option value="max">Max</option>
              </select>
            </div>
          </div>

          {/* 右侧：工具按钮 + 发送 */}
          <div className={styles['toolbar-right']}>
            {/* 当前后端标识（非默认时显示） */}
            {currentBackend !== MAIN_BACKEND_ID && (
              <span className={styles['backend-badge']} title={`当前后端: ${currentBackend}`}>
                {Object.values(BACKEND_INFO).find(b => b.acpBackendId === currentBackend)?.label ?? currentBackend}
              </span>
            )}
            {/* AI 运行状态（紧凑展示，替代大块占位） */}
            {isStreaming && (
              <div
                className={clsx(styles['streaming-status'], steerSent && styles['streaming-status-active'])}
                title={steerSent ? '已发送中途插话，AI 正在补充执行' : 'AI 正在思考或执行工具'}
              >
                <span className={styles['streaming-status-dot']} />
                <span>{steerSent ? '补充中' : '运行中'}</span>
              </div>
            )}
            {/* 中途插话按钮：放入工具栏，减少垂直占位 */}
            {isStreaming && onSteer && !steerExpanded && !steerSent && (
              <button
                type="button"
                onClick={handleOpenSteer}
                className={styles['toolbar-action-btn']}
                title="给当前回复中途插话"
              >
                中途插话
              </button>
            )}
            {/* 上下文压缩图标：悬浮展开占用明细卡片，点击主动压缩 */}
            {(isCompacting || onCompactContext) && (
              <div
                className={styles['context-usage-wrapper']}
                onMouseEnter={() => setContextCardOpen(true)}
                onMouseLeave={() => setContextCardOpen(false)}
              >
                <button
                  type="button"
                  className={clsx(
                    styles['context-compact'],
                    isCompacting
                      ? styles['context-compact-compacting']
                      : contextUsage && effectiveContextWindow > 0
                        ? (
                            contextUsage.usedTokens / effectiveContextWindow > (contextUsage.triggerThreshold ?? 0.8)
                              ? styles['context-compact-danger']
                              : contextUsage.isNearThreshold
                                ? styles['context-compact-warn']
                                : styles['context-compact-safe']
                          )
                        : styles['context-compact-safe'],
                  )}
                  aria-label={isCompacting ? '正在自动压缩上下文' : contextUsageLabel}
                  onClick={() => !isCompacting && onCompactContext?.()}
                  disabled={isCompacting || !onCompactContext || isDisabled}
                >
                  <span className={clsx(styles['context-compact-icon'], isCompacting && styles['context-compact-icon--spinning'])} aria-hidden>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8 4v4H4" />
                      <path d="M20 10A8 8 0 0 0 6.6 5.3L4 8" />
                      <path d="M16 20v-4h4" />
                      <path d="M4 14a8 8 0 0 0 13.4 4.7L20 16" />
                    </svg>
                  </span>
                  <span className={styles['context-compact-text']}>
                    <span className={styles['context-compact-line']}>
                      {isCompacting ? '压缩中...' : ''}
                    </span>
                    <span className={styles['context-compact-line']}>{contextWindowText}</span>
                  </span>
                </button>
                {contextCardOpen && !isCompacting && (
                  <ContextUsageCard
                    contextUsage={contextUsage}
                    contextWindow={effectiveContextWindow}
                  />
                )}
              </div>
            )}
            {/* 帮助/功能提示按钮 */}
            <div className={styles['help-panel-wrapper']} ref={helpPanelRef}>
              <button
                type="button"
                className={`${styles['toolbar-icon-btn']} ${helpPanelOpen ? styles['toolbar-icon-btn--active'] : ''}`}
                onClick={() => setHelpPanelOpen((v) => !v)}
                title="查看功能提示与命令"
                aria-label="帮助"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </button>
              {helpPanelOpen && (
                <div className={styles['help-panel']}>
                  <div className={styles['help-panel-header']}>
                    <span>功能提示</span>
                    <button
                      type="button"
                      className={styles['help-panel-close']}
                      onClick={() => setHelpPanelOpen(false)}
                    >×</button>
                  </div>
                  <div className={styles['help-section']}>
                    <div className={styles['help-section-title']}>快捷键</div>
                    <div className={styles['help-item']}>
                      <kbd className={styles['help-kbd']}>Enter</kbd>
                      <span>发送消息</span>
                    </div>
                    <div className={styles['help-item']}>
                      <kbd className={styles['help-kbd']}>Shift+Enter</kbd>
                      <span>换行</span>
                    </div>
                    <div className={styles['help-item']}>
                      <kbd className={styles['help-kbd']}>Ctrl+U</kbd>
                      <span>添加文件或图片</span>
                    </div>
                    <div className={styles['help-item']}>
                      <kbd className={styles['help-kbd']}>Ctrl+V</kbd>
                      <span>粘贴文件或图片</span>
                    </div>
                    <div className={styles['help-item']}>
                      <kbd className={styles['help-kbd']}>Ctrl+N</kbd>
                      <span>新建对话</span>
                    </div>
                    <div className={styles['help-item']}>
                      <kbd className={styles['help-kbd']}>Ctrl+B</kbd>
                      <span>切换侧边栏</span>
                    </div>
                  </div>
                  <div className={styles['help-section']}>
                    <div className={styles['help-section-title']}>/命令（输入 / 触发补全）</div>
                    {searchCommands('').filter(c => c.category !== 'backend').slice(0, 6).map((cmd) => (
                      <div key={cmd.name} className={styles['help-item']}>
                        <code
                          className={styles['help-code']}
                          style={{ cursor: 'pointer' }}
                          onClick={() => {
                            const fill = cmd.usage && cmd.usage !== cmd.name
                              ? `${cmd.name} `
                              : cmd.name
                            setDraft(fill)
                            flushDraft(fill)
                            setHelpPanelOpen(false)
                            textareaRef.current?.focus()
                          }}
                        >
                          {cmd.name}
                        </code>
                        <span>{cmd.description}</span>
                      </div>
                    ))}
                    <div className={styles['help-item']} style={{ paddingTop: 2 }}>
                      <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>输入 /help 查看完整命令列表</span>
                    </div>
                  </div>
                  <div className={styles['help-section']}>
                    <div className={styles['help-section-title']}>
                      后端切换
                      <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--color-text-tertiary)', fontWeight: 400 }}>
                        当前：<strong style={{ color: 'var(--color-accent, #4f8ef7)' }}>
                          {currentBackend === MAIN_BACKEND_ID ? '灵栖' : currentBackend}
                        </strong>
                      </span>
                    </div>
                    {[
                      { cmd: '/claude', label: 'Claude Code' },
                      { cmd: '/codex', label: 'Codex' },
                      { cmd: '/opencode', label: 'OpenCode' },
                      { cmd: '/gemini', label: 'Gemini CLI' },
                      { cmd: '/qoder', label: 'Qoder' },
                      { cmd: '/qwen', label: 'Qwen Code' },
                      { cmd: '/kimi', label: 'Kimi K1.5' },
                      { cmd: '/copilot', label: 'Copilot' },
                      { cmd: '/auggie', label: 'Augment' },
                      { cmd: '/cursor', label: 'Cursor' },
                      { cmd: '/lumii', label: '灵栖（默认）' },
                    ].map(({ cmd, label }) => (
                      <div key={cmd} className={styles['help-item']}>
                        <code
                          className={styles['help-code']}
                          style={{ cursor: 'pointer' }}
                          onClick={() => {
                            setDraft(cmd)
                            flushDraft(cmd)
                            setHelpPanelOpen(false)
                            textareaRef.current?.focus()
                          }}
                        >
                          {cmd}
                        </code>
                        <span>{label}</span>
                      </div>
                    ))}
                  </div>
                  <div className={styles['help-section']}>
                    <div className={styles['help-section-title']}>动态 UI</div>
                    <div className={styles['help-item']}>
                      <span className={styles['help-bullet']}>•</span>
                      <span>AI 执行工具时可查看步骤详情</span>
                    </div>
                    <div className={styles['help-item']}>
                      <span className={styles['help-bullet']}>•</span>
                      <span>流式输出中可使用「中途插话」引导 AI</span>
                    </div>
                    <div className={styles['help-item']}>
                      <span className={styles['help-bullet']}>•</span>
                      <span>点击工具卡片可展开/折叠执行详情</span>
                    </div>
                    <div className={styles['help-item']}>
                      <span className={styles['help-bullet']}>•</span>
                      <span>上传文件后 AI 可直接分析内容</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
            {/* 发送/停止按钮：streaming 时始终可点击（中断），非 streaming 时需有输入内容 */}
            {onVoiceCallStart && !isStreaming && (
              <button
                type="button"
                onClick={onVoiceCallStart}
                className={styles['voice-btn']}
                title="语音通话"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V23h2v-2.06A9 9 0 0 0 21 12v-2h-2z" />
                </svg>
                通话
              </button>
            )}
            <button
              type="button"
              onClick={handleButtonClick}
              disabled={isStreaming ? false : (isDisabled || (!innerValue.trim() && queuedMessages.length === 0))}
              className={clsx(styles['send-btn'], isStreaming && styles['stop-btn'])}
              title={
                isStreaming
                  ? (queuedMessages.length > 0 ? '停止并发送队列' : '停止生成')
                  : (queuedMessages.length > 0 ? '发送队列' : '发送消息')
              }
            >
              {isStreaming ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2 21L23 12 2 3v7l15 2-15 2v7z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* 输入卡下方单行提示：只在有输入时出现，补上 placeholder 消失后丢掉的快捷键说明。
          空闲态的 tips 仍走 placeholder，不在这里重复一遍 */}
      {innerValue.trim().length > 0 && (
        <div className={styles['composer-hint']}>
          <span><kbd className={styles['hint-kbd']}>Enter</kbd> 发送</span>
          <span><kbd className={styles['hint-kbd']}>Shift+Enter</kbd> 换行</span>
          <span><kbd className={styles['hint-kbd']}>Ctrl+U</kbd> 附件</span>
          <span className={styles['hint-count']}>{innerValue.length} 字</span>
        </div>
      )}

      {/* 统一附件 input：图片 + 文档 */}
      <input
        ref={attachmentInputRef}
        type="file"
        className={styles['hidden-input']}
        accept={getSupportedAttachmentAccept()}
        multiple
        onChange={handleAttachmentInputChange}
      />
    </div>
  )
}

const ChatInputMemo = React.memo(ChatInput)
ChatInputMemo.displayName = 'ChatInput'

export default ChatInputMemo
export { ChatInputMemo as ChatInput }
