import React, { useState, useCallback, useContext, useEffect } from 'react'
import clsx from 'clsx'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import 'katex/dist/katex.min.css'
/** 浅色对话气泡上与正文对比协调；避免 one-dark 黑底与主题文字色冲突导致「深底深字」 */
import 'highlight.js/styles/github.css'
import { Lightbulb, Inbox, AlertTriangle, Ban, Timer, Zap, AlertCircle } from 'lucide-react'
import { MessageActions } from '../MessageActions'
import { ToolFilePreviewProvider, ToolFilePreviewContext } from '../ToolCallCard'
import toolCardStyles from '../ToolCallCard/ToolCallCard.module.css'
import { A2UIRenderer } from '../../../../components/A2UIRenderer'
import { ArtifactBlock } from '../../../../components/A2UIRenderer/ArtifactBlock'
import {
  parseA2UIBlocks,
  tryParseA2UISpecFromJson,
  tryParseA2UIBlockBodyLoose,
} from '../../../../utils/parseA2UIBlocks'
import { FilePreviewModal } from '../../../../components/FilePreviewModal/FilePreviewModal'
import { ImageLightbox } from '../../../../components/ImageLightbox'
import { useWorkspace } from '../../../../hooks/business/useWorkspace'
import type { ChatMessage as ChatMessageType, AgentWorkflowItem } from '../../../../hooks/business/useChat'
import type { AssistantPart } from '@mtbot/agent-runtime/browser'
import type { RuntimeFileEvent } from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'
import { parseMediaAttachments, mergeEditedUserMessage } from '../../utils/file-attachment-strategy'
import { TurnFileChangesCard } from '../TurnFileChangesCard'
import { ToolBatchGroup, summarizeToolBatch } from '../ToolBatchGroup'
import { getStatusLabel } from '../ToolCallCard'
import { ActivityFold } from '../ActivityFold'
import styles from './ChatMessage.module.css'

interface ChatMessageProps {
  message: ChatMessageType
  formatTime: (date: Date) => string
  onCopy: (content: string) => void
  onEdit: (messageId: string, newContent: string) => void
  onDelete: (messageId: string) => void
  onRegenerate: (messageId: string) => void
  /** 会话是否正在流式输出：为 true 时禁用「重新生成」入口 */
  sessionBusy?: boolean
  /** 关联的工具调用项，按 textPositionAtStart 与文字交错显示 */
  toolItems?: AgentWorkflowItem[]
  /**
   * 本地 Runtime：当前轮次流式中的思考文本（来自 agent:thinking:delta）。
   * 与落库后的 message.thinkingText 二选一展示；流式结束后由后者承接。
   */
  streamingThinkingText?: string
  /**
   * 会话切换时批量加载的消息传 true，禁用弹跳入场动画，
   * 避免多条消息同时 mount 时的"批量弹出"感。
   */
  noEnter?: boolean
  /** 与本条消息关联的 Agent 输出文件（仅 assistant 消息展示） */
  fileAttachments?: readonly RuntimeFileEvent[]
  /** 当前登录用户 ID，传给文件操作 IPC */
  userId?: string
  /** 从此消息开始回放对话（语音消息专用） */
  onReplay?: (messageId: string) => void
  /** 当前正在回放的消息 ID */
  replayMessageId?: string | null
  /** 点击回合文件变更卡片的「查看」，透传文件相对路径与状态 */
  onReviewFileChanges?: (path: string, status: 'added' | 'modified' | 'deleted') => void
}

// ---------------------------------------------------------------
// Markdown 渲染配置（模块顶层，避免每次渲染创建新引用）
// ---------------------------------------------------------------

const REMARK_PLUGINS = [remarkMath, remarkGfm]
const REHYPE_PLUGINS = [rehypeKatex, rehypeHighlight]

const ARTIFACT_LANGS = new Set(['html', 'javascript', 'js', 'svg'])

/** 判断 img src 是否为外部地址（http/https/data），否则视为 workspace 内本地/相对路径 */
function isExternalImageSrc(src: string): boolean {
  return /^(https?:)?\/\//i.test(src) || src.startsWith('data:')
}

/**
 * Markdown 正文中的图片：
 * - 本地/相对路径（如 outputs/cards/01.png）→ 点击调用 ToolFilePreviewContext.onPreview，
 *   复用 FilePreviewModal 的应用内图片灯箱（全屏 / 缩放 / 经 IPC 安全读取 workspace 文件）。
 * - 外部 http(s)/data URL → 直接渲染，点击用 ImageLightbox 内联放大。
 */
const MarkdownInlineImage: React.FC<{ src?: string; alt?: string }> = ({ src, alt }) => {
  const previewCtx = useContext(ToolFilePreviewContext)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  if (!src) return null
  const external = isExternalImageSrc(src)
  const fileName = alt || src.split(/[\\/]/).pop() || src

  const handleClick = () => {
    if (external) {
      setLightboxOpen(true)
      return
    }
    // 本地/相对路径：交给 FilePreviewModal（filePath 模式，IPC 读取后展示图片灯箱）
    if (previewCtx) {
      previewCtx.onPreview({ filePath: src, fileName })
    }
  }

  return (
    <>
      <img
        src={src}
        alt={alt || ''}
        className={styles['md-image']}
        loading="lazy"
        style={{ cursor: 'zoom-in' }}
        title="点击预览"
        onClick={handleClick}
      />
      {external && lightboxOpen && (
        <ImageLightbox src={src} alt={fileName} onClose={() => setLightboxOpen(false)} />
      )}
    </>
  )
}

/** 从 React children 中递归提取纯文本（处理 rehype-highlight 返回节点数组的情况） */
function extractCodeText(children: React.ReactNode): string {
  if (typeof children === 'string') return children
  if (typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(extractCodeText).join('')
  if (React.isValidElement(children)) {
    const el = children as React.ReactElement<{ children?: React.ReactNode }>
    return extractCodeText(el.props.children)
  }
  return ''
}

/** 构建 Markdown 组件覆盖 — isStreaming 决定 ArtifactBlock 是否延迟预览 */
function buildMarkdownComponents(isStreaming: boolean): Components {
  return {
    code({ className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || '')
      const codeText = extractCodeText(children).replace(/\n$/, '')
      const lang = match?.[1]?.toLowerCase()
      // 判断是否为块级代码（含 language class 或 rehype-highlight 处理过）
      const isBlock = !!match || (className && className.includes('hljs'))
      if (isBlock) {
        // A2UI：模型有时把 spec 留在 markdown 代码块（未走 parseA2UIBlocks），在此兜底渲染
        if (lang === 'a2ui') {
          const loose = tryParseA2UIBlockBodyLoose(codeText)
          if (loose) {
            return <A2UIRenderer spec={loose} />
          }
        }
        if (lang === 'json') {
          const fromJson = tryParseA2UISpecFromJson(codeText)
          if (fromJson) {
            return <A2UIRenderer spec={fromJson} />
          }
        }
        // 可预览的代码块使用 ArtifactBlock（含 Toolbar + IframeArtifact）
        if (lang && ARTIFACT_LANGS.has(lang)) {
          return <ArtifactBlock content={codeText} language={lang} messageStreaming={isStreaming} />
        }
      return (
        <div className={styles['code-block']}>
          <div className={styles['code-header']}>
            <span className={styles['code-lang']}>{lang || 'code'}</span>
            <button
              className={styles['code-copy-btn']}
              onClick={() => navigator.clipboard.writeText(codeText)}
            >
              复制
            </button>
          </div>
          <pre className={styles['code-content']}>
            <code className={className} {...props}>{children}</code>
          </pre>
        </div>
      )
    }
      return <code className={styles['inline-code']} {...props}>{children}</code>
    },
    pre({ children }) {
      // react-markdown 默认会用 <pre> 包裹代码块，我们在 code 中已经处理了，这里直接透传
      return <>{children}</>
    },
    img({ src, alt }) {
      return <MarkdownInlineImage src={src} alt={alt} />
    },
    table({ children }) {
      return (
        <div className={styles['table-wrapper']}>
          <table className={styles['md-table']}>{children}</table>
        </div>
      )
    },
    a({ href, children }) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      )
    },
  }
}

// ---------------------------------------------------------------
// 交错渲染逻辑
// ---------------------------------------------------------------

/** 用户消息中的媒体文件附件列表，复用工具卡片的 fileChip 样式和 ToolFilePreviewContext */
function MediaFileChips({ mediaFiles }: { mediaFiles: Array<{ filePath: string; fileName: string }> }) {
  const previewCtx = useContext(ToolFilePreviewContext)
  if (mediaFiles.length === 0) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
      {mediaFiles.map((f) => (
        <span
          key={f.filePath}
          className={clsx(toolCardStyles.fileChip, previewCtx && toolCardStyles.fileChipClickable)}
          title={previewCtx ? `点击预览 ${f.filePath}` : f.filePath}
          onClick={previewCtx ? (e) => { e.stopPropagation(); previewCtx.onPreview({ filePath: f.filePath, fileName: f.fileName }) } : undefined}
        >
          <span className={toolCardStyles.fileChipName}>{f.fileName}</span>
        </span>
      ))}
    </div>
  )
}

/** 记忆类别 → 简短中文标签（用于展开列表） */
const MEMORY_CATEGORY_LABEL: Record<string, string> = {
  user: '用户画像',
  feedback: '交互偏好',
  project: '进行中的事',
  reference: '外部资源',
  general: '其他',
}

// ---------------------------------------------------------------
// ThinkingBlock — 思考过程折叠卡片（默认折叠，固定高度防抖动）
// ---------------------------------------------------------------

interface ThinkingBlockProps {
  thinkingText: string
  isStreaming: boolean
  isLive: boolean
  /** 内嵌于「执行过程」时用扁平行样式（去掉外层卡片描边/背景），减少视觉噪声 */
  compact?: boolean
}

const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ thinkingText, isStreaming, isLive, compact = false }) => {
  const [expanded, setExpanded] = useState(false)
  // 内容高度锁定：一旦内容区被渲染过，就固定 max-height 不再变化
  const [heightLocked, setHeightLocked] = useState(false)
  const contentRef = React.useRef<HTMLPreElement>(null)

  /**
   * 展开后自动滚到底部，保证用户始终看到最新思考增量。
   */
  useEffect(() => {
    if (!expanded || !contentRef.current) return
    contentRef.current.scrollTop = contentRef.current.scrollHeight
  }, [expanded, thinkingText, isStreaming])

  // 流式结束后锁定高度，避免后续内容追加导致抖动
  React.useEffect(() => {
    if (!isStreaming && !heightLocked && expanded) {
      setHeightLocked(true)
    }
  }, [isStreaming, heightLocked, expanded])

  // 展开时重置锁定（用户主动展开时允许重新计算）
  const handleToggle = () => {
    if (!expanded) {
      setHeightLocked(false)
    }
    setExpanded((v) => !v)
  }

  const preview = thinkingText.slice(0, 60).replace(/\n/g, ' ')

  return (
    <div className={clsx(styles['rt-thinking-card'], compact && styles['rt-thinking-card--compact'])}>
      <button
        type="button"
        className={styles['rt-thinking-card-header']}
        onClick={handleToggle}
        aria-expanded={expanded}
        title={expanded ? '收起思考内容' : '展开思考内容'}
      >
        <span className={clsx(styles['rt-unit-chevron'], expanded && styles['rt-unit-chevron--open'])} aria-hidden>›</span>
        {isStreaming && (
          <span className={styles['rt-thinking-wave']} aria-hidden>
            <i /><i /><i /><i /><i />
          </span>
        )}
        <span className={styles['rt-thinking-card-title']}>{isStreaming ? '正在思考' : '思考'}</span>
        {isLive && isStreaming && (
          <span className={styles['rt-live-badge']}>实时</span>
        )}
        {!expanded && (
          <span className={styles['rt-thinking-card-preview']}>{preview}…</span>
        )}
        <span className={styles['rt-unit-hint']}>{expanded ? '收起' : '展开'}</span>
      </button>
      {expanded && (
        <pre
          ref={contentRef}
          className={clsx(
            styles['rt-thinking-pre'],
            heightLocked && styles['rt-thinking-pre--locked'],
          )}
        >
          {thinkingText}
        </pre>
      )}
    </div>
  )
}

/** 将 tool part 映射为 ToolCallCard 所需的 AgentWorkflowItem */
function toWorkflowItem(
  part: Extract<AssistantPart, { type: 'tool' }>,
  message: ChatMessageType,
): AgentWorkflowItem {
  return {
    id: part.id,
    type: 'tool',
    name: part.name,
    status: part.status === 'running'
      ? 'running'
      : part.status === 'error'
        ? 'failed'
        : 'completed',
    title: part.name,
    input: part.args,
    output: part.result,
    error: part.isError ? String(part.result ?? '工具执行失败') : undefined,
    startTime: message.timestamp,
    runId: message.runId ?? '',
    toolCallId: part.id,
    agentLabel: part.meta?.sourceAgent?.label,
  }
}

/** 时间线渲染单元：思考 / 文本 / 工具批次组 */
type RenderUnit =
  | { kind: 'thinking'; part: Extract<AssistantPart, { type: 'thinking' }> }
  | { kind: 'text'; part: Extract<AssistantPart, { type: 'text' }> }
  | { kind: 'toolGroup'; items: AgentWorkflowItem[]; key: string }

/**
 * 把扁平的 parts 折叠成渲染单元序列：
 * 1. 先过滤 trim 后为空的 text part（根治空气泡）
 * 2. 连续的 tool part 合并为一个批次组，遇到 thinking/text 即结束当前组
 */
function buildRenderUnits(parts: readonly AssistantPart[], message: ChatMessageType): RenderUnit[] {
  const meaningful = parts.filter((p) => p.type !== 'text' || p.text.trim().length > 0)

  const units: RenderUnit[] = []
  let pending: Extract<AssistantPart, { type: 'tool' }>[] = []

  const flush = () => {
    if (pending.length === 0) return
    units.push({
      kind: 'toolGroup',
      items: pending.map((t) => toWorkflowItem(t, message)),
      key: `grp-${pending[0]!.id}`,
    })
    pending = []
  }

  for (const part of meaningful) {
    if (part.type === 'tool') {
      pending.push(part)
      continue
    }
    flush()
    units.push({ kind: part.type, part } as RenderUnit)
  }
  flush()

  return units
}

/**
 * 把渲染单元切成「过程区 / 答案区」：
 * - 过程区 = 从头到最后一个 thinking/toolGroup（含）之间的所有单元
 * - 答案区 = 其后的末尾 text 单元（最终总结性输出，露在折叠块外）
 * - 无 thinking 也无 tool 的纯问答：过程区为空，全部落入答案区（不折叠）
 */
function splitProcessAndAnswer(units: RenderUnit[]): { process: RenderUnit[]; answer: RenderUnit[] } {
  let lastProcessIdx = -1
  for (let i = 0; i < units.length; i++) {
    if (units[i]!.kind === 'thinking' || units[i]!.kind === 'toolGroup') {
      lastProcessIdx = i
    }
  }
  if (lastProcessIdx === -1) {
    return { process: [], answer: units }
  }
  return {
    process: units.slice(0, lastProcessIdx + 1),
    answer: units.slice(lastProcessIdx + 1),
  }
}

/** 过程区摘要：思考 + 全部工具批次合并计数（思考 · 读取 3 个文件 · 搜索 2 次） */
function buildProcessSummary(process: RenderUnit[]): string {
  const hasThinking = process.some((u) => u.kind === 'thinking')
  const allTools = process.flatMap((u) => (u.kind === 'toolGroup' ? u.items : []))
  const parts: string[] = []
  if (hasThinking) parts.push('思考')
  if (allTools.length > 0) parts.push(summarizeToolBatch(allTools))
  return parts.join(' · ') || '工作过程'
}

/** 流式实时状态：末个过程单元决定当前动作（正在思考 / 正在执行 grep…） */
function buildCurrentStatus(process: RenderUnit[]): string {
  const last = process[process.length - 1]
  if (!last) return '正在处理…'
  if (last.kind === 'thinking') return '正在思考…'
  if (last.kind === 'toolGroup') {
    const running = last.items.find((i) => i.status === 'running')
    if (running) return getStatusLabel(running)
    return summarizeToolBatch(last.items)
  }
  return '正在处理…'
}

// ---------------------------------------------------------------
// 组件
// ---------------------------------------------------------------

const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  formatTime,
  onCopy,
  onEdit,
  onDelete,
  onRegenerate,
  sessionBusy = false,
  toolItems,
  streamingThinkingText,
  noEnter = false,
  fileAttachments,
  userId = 'local-user',
  onReplay,
  replayMessageId,
  onReviewFileChanges,
}) => {
  const [isEditing, setIsEditing] = useState(false)
  const [memoryExpanded, setMemoryExpanded] = useState(false)
  const [previewFileId, setPreviewFileId] = useState<string | null>(null)
  const [previewFileName, setPreviewFileName] = useState<string>('')
  /** fileId 预览对应的可写绝对路径（启用会话文件 Markdown 编辑） */
  const [previewEditablePath, setPreviewEditablePath] = useState<string | undefined>(undefined)
  const { toAbsolutePath } = useWorkspace()
  // 工具卡片"按路径预览"状态（读写文件类工具点击文件名触发）
  const [previewByPath, setPreviewByPath] = useState<{
    filePath: string
    fileName: string
    startLine?: number
    endLine?: number
  } | null>(null)

  /**
   * 为工具卡片的文件名点击提供预览回调：
   * 优先使用已注册到 FileRepo 的 fileId（通过 fileAttachments 按 fileName 匹配），
   * 否则回退到按路径预览（files:read-preview-by-path）。
   */
  const handleToolFilePreview = useCallback(
    (args: { filePath: string; fileName: string; startLine?: number; endLine?: number }) => {
      const matched = fileAttachments?.find((f) => f.fileName === args.fileName)
      if (matched) {
        setPreviewFileId(matched.fileId)
        setPreviewFileName(matched.fileName)
        setPreviewEditablePath(matched.localPath ? toAbsolutePath(matched.localPath) : undefined)
        return
      }
      setPreviewByPath({
        filePath: args.filePath,
        fileName: args.fileName,
        ...(typeof args.startLine === 'number' ? { startLine: args.startLine } : {}),
        ...(typeof args.endLine === 'number' ? { endLine: args.endLine } : {}),
      })
    },
    [fileAttachments],
  )

  const handleEditStart = () => { setIsEditing(true) }
  const handleEditCancel = () => { setIsEditing(false) }
  const handleEditSave = (newContent: string) => {
    // 用户消息：编辑器只含可见正文，保存时拼回附件 / parsed text 等 Agent 后缀
    const toSave =
      message.role === 'user'
        ? mergeEditedUserMessage(message.content, newContent)
        : newContent
    // 内容有实质变化才触发「删后续重答」，未变则视为取消编辑
    if (toSave.trim() !== message.content.trim()) {
      onEdit(message.id, toSave)
    }
    setIsEditing(false)
  }

  /** 构建包含文字 + 工具调用详情的完整复制文本（用户消息剥离 Agent 注入标记） */
  const buildCopyContent = useCallback((): string => {
    const parts: string[] = []
    const thinking =
      (streamingThinkingText?.trim() ? streamingThinkingText : undefined)
      ?? message.thinkingText?.trim()
    if (thinking) {
      parts.push(`[思考过程]\n${thinking}`)
    }
    if (message.content) {
      if (message.role === 'user') {
        const { textWithoutMedia } = parseMediaAttachments(message.content)
        if (textWithoutMedia) parts.push(textWithoutMedia)
      } else {
        parts.push(message.content)
      }
    }
    if (message.parts && message.parts.length > 0) {
      for (const part of message.parts) {
        if (part.type === 'thinking' && part.text.trim()) {
          parts.push(`[思考过程]\n${part.text}`)
        }
        if (part.type === 'tool') {
          const lines: string[] = [`[工具调用: ${part.name}]`]
          if (part.args && Object.keys(part.args).length > 0) {
            lines.push(`输入:\n${JSON.stringify(part.args, null, 2)}`)
          }
          if (part.result !== undefined) {
            lines.push(`输出:\n${typeof part.result === 'string' ? part.result : JSON.stringify(part.result, null, 2)}`)
          }
          if (part.isError) {
            lines.push(`错误: ${String(part.result ?? '工具执行失败')}`)
          }
          parts.push(lines.join('\n'))
        }
      }
    } else if (toolItems && toolItems.length > 0) {
      for (const item of toolItems) {
        const lines: string[] = [`[工具调用: ${item.name}]`]
        if (item.input && Object.keys(item.input).length > 0) {
          lines.push(`输入:\n${JSON.stringify(item.input, null, 2)}`)
        }
        if (item.output !== undefined) {
          lines.push(`输出:\n${typeof item.output === 'string' ? item.output : JSON.stringify(item.output, null, 2)}`)
        }
        if (item.error) {
          lines.push(`错误: ${item.error}`)
        }
        parts.push(lines.join('\n'))
      }
    }
    return parts.join('\n\n')
  }, [message.content, message.role, message.thinkingText, message.parts, streamingThinkingText, toolItems])

  const handleCopy = useCallback(() => {
    onCopy(buildCopyContent())
  }, [onCopy, buildCopyContent])

  // 根据当前流式状态构建 markdown 组件映射（流式时 Artifact 不自动预览）
  // useMemo 确保引用稳定，避免 ReactMarkdown 不必要的重渲染
  const markdownComponents = React.useMemo(
    () => buildMarkdownComponents(!!message.isStreaming),
    [message.isStreaming]
  )

  const renderTextContent = (content: string) => {
    // 流式输出中：跳过昂贵的 remark/rehype 解析，直接渲染纯文本，避免每个 delta 触发全量重解析
    if (message.isStreaming) {
      return (
        <div className={styles['message-content-text']}>
          <pre className={styles['streaming-plain-text']}>{content}</pre>
        </div>
      )
    }

    const segments = parseA2UIBlocks(content)

    // 仅一段纯 markdown（常见路径）→ 直接渲染
    if (segments.length === 1 && segments[0].type === 'markdown') {
      return (
        <div className={styles['message-content-text']}>
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={markdownComponents}
          >
            {segments[0].content}
          </ReactMarkdown>
        </div>
      )
    }

    return (
      <div className={styles['message-content-text']}>
        {segments.map((seg, i) => {
          if (seg.type === 'markdown') {
            return (
              <ReactMarkdown
                key={i}
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={markdownComponents}
              >
                {seg.content}
              </ReactMarkdown>
            )
          }
          if (seg.type === 'a2ui') {
            return <A2UIRenderer key={i} spec={seg.spec} />
          }
          // artifact 块：直接用 ArtifactBlock 渲染
          return <ArtifactBlock key={i} content={seg.content} language={seg.language} messageStreaming={!!message.isStreaming} />
        })}
      </div>
    )
  }

  /**
   * 子 Agent 消息外层套嵌套边框与标题
   * 流式中展开，完成后折叠，避免多条子 Agent 消息堆叠导致界面混乱
   */
  const wrapSubAgent = (node: React.ReactNode) => {
    if (!message.sourceAgent) return node
    const toolCount = message.parts
      ? message.parts.filter((part) => part.type === 'tool').length
      : (toolItems?.length ?? 0)
    const label = message.sourceAgent.label ?? '子 Agent'
    const summaryText = message.isStreaming
      ? `${label} · 执行中${toolCount > 0 ? `（${toolCount} 工具）` : '...'}`
      : `${label} · 已完成${toolCount > 0 ? `（${toolCount} 个工具调用）` : ''}`
    return (
      <details className={styles['sub-agent-wrap']} open={!!message.isStreaming}>
        <summary className={styles['sub-agent-label']}>{summaryText}</summary>
        <div className={styles['sub-agent-inner']}>{node}</div>
      </details>
    )
  }

  /** 流式首 token 未到达时的占位 */
  const renderThinkingPlaceholder = () => (
    <div className={styles['rt-placeholder']}>
      <span className={styles['rt-spinner']} />
      <span>正在思考...</span>
    </div>
  )

  /**
   * 渲染单个时间线单元（思考 / 文本 / 工具组）。
   * inFold=true 时为「执行过程」内的中间单元，文本用低调的说明样式，
   * 与折叠块外的最终答案（玻璃气泡）区分开。
   */
  const renderUnit = (unit: RenderUnit, inFold: boolean) => {
    if (unit.kind === 'thinking') {
      return (
        <ThinkingBlock
          key={unit.part.id}
          thinkingText={unit.part.text}
          isStreaming={unit.part.status === 'streaming' && !!message.isStreaming}
          isLive={!!message.isStreaming}
          compact={inFold}
        />
      )
    }
    if (unit.kind === 'text') {
      return (
        <div
          key={unit.part.id}
          className={clsx(inFold ? styles['fold-note'] : styles['message-text'], styles['part-block'])}
        >
          {renderTextContent(unit.part.text)}
          {unit.part.status === 'streaming' && message.isStreaming && (
            <span className={styles['streaming-cursor']} />
          )}
        </div>
      )
    }
    return (
      <div key={unit.key} className={styles['part-block']}>
        <ToolBatchGroup items={unit.items} compact={inFold} />
      </div>
    )
  }

  /**
   * 按 parts 时间线渲染助手气泡（Cursor 式）：
   * 中间过程（思考 + 工具 + 中间文本）折叠进 ActivityFold，最终答案露在外面。
   */
  const renderPartsTimeline = () => {
    const units = buildRenderUnits(message.parts ?? [], message)
    const { process, answer } = splitProcessAndAnswer(units)
    const isStreaming = !!message.isStreaming
    return (
      <div className={styles['parts-timeline']}>
        {process.length > 0 && (
          <ActivityFold
            summary={buildProcessSummary(process)}
            currentStatus={isStreaming ? buildCurrentStatus(process) : undefined}
            isStreaming={isStreaming}
            durationMs={message.streamMetrics?.durationMs}
          >
            {process.map((u) => renderUnit(u, true))}
          </ActivityFold>
        )}
        {answer.map((u) => renderUnit(u, false))}
        {message.fileChanges && message.fileChanges.length > 0 && (
          <TurnFileChangesCard
            changes={message.fileChanges}
            onReview={onReviewFileChanges}
          />
        )}
      </div>
    )
  }

  /**
   * 无 parts 时的旧消息回退：正文 + 末尾工具卡片（Gateway 或未迁移历史）
   */
  const renderLegacyAssistantBody = () => {
    const hasTools = toolItems && toolItems.length > 0
    const hasContent = !!message.content
    const liveThinking = streamingThinkingText?.trim()
    const persistedThinking = message.thinkingText?.trim()

    if (!hasContent && !hasTools) {
      if (message.isStreaming) {
        return renderThinkingPlaceholder()
      }
      if (liveThinking || persistedThinking) {
        return (
          <ThinkingBlock
            thinkingText={liveThinking || persistedThinking || ''}
            isStreaming={!!message.isStreaming}
            isLive={!!liveThinking}
          />
        )
      }
      return null
    }

    return (
      <>
        {(liveThinking || persistedThinking) && (
          <ThinkingBlock
            thinkingText={liveThinking || persistedThinking || ''}
            isStreaming={!!message.isStreaming}
            isLive={!!liveThinking}
          />
        )}
        {hasContent && (
          <div className={styles['message-text']}>
            {renderTextContent(message.content)}
            {message.isStreaming && <span className={styles['streaming-cursor']} />}
          </div>
        )}
        {hasTools && (
          <div className={styles['part-block']}>
            <ToolBatchGroup items={toolItems!} />
          </div>
        )}
        {message.fileChanges && message.fileChanges.length > 0 && (
          <TurnFileChangesCard
            changes={message.fileChanges}
            onReview={onReviewFileChanges}
          />
        )}
      </>
    )
  }

  /** 渲染 assistant 消息正文（parts 时间线优先） */
  const renderAssistantBody = () => {
    const parts = message.parts ?? []

    if (parts.length === 0) {
      if (message.isStreaming && !message.content && !(toolItems && toolItems.length > 0)) {
        return wrapSubAgent(renderThinkingPlaceholder())
      }
      return wrapSubAgent(renderLegacyAssistantBody())
    }

    return wrapSubAgent(renderPartsTimeline())
  }

  /**
   * 当本轮回复使用了本地注入的热记忆时，在气泡底部展示轻量提示（可展开查看条目）
   */
  const renderMemoryHint = () => {
    const injected = message.injectedMemories
    if (!injected || injected.length === 0) return null
    if (message.role !== 'assistant' || message.isStreaming) return null
    const first = injected[0]!
    const preview =
      injected.length === 1
        ? `「${first.content.length > 36 ? `${first.content.slice(0, 36)}…` : first.content}」`
        : `共 ${injected.length} 条`
    return (
      <div className={styles['memory-hint']}>
        <button
          type="button"
          className={styles['memory-hint-btn']}
          onClick={() => setMemoryExpanded((v) => !v)}
          aria-expanded={memoryExpanded}
        >
          <span className={styles['memory-hint-icon']}><Lightbulb size={14} /></span>
          <span>根据记忆回复</span>
          <span className={styles['memory-hint-preview']}>{preview}</span>
        </button>
        {memoryExpanded ? (
          <ul className={styles['memory-hint-list']}>
            {injected.map((mem) => (
              <li key={mem.id}>
                <span className={styles['memory-cat']}>
                  {MEMORY_CATEGORY_LABEL[mem.category] ?? mem.category}
                </span>
                {mem.content}
                <span className={styles['memory-id']}>记忆 ID: {mem.id}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    )
  }

  const renderTokenUsage = () => {
    const { usage, isStreaming, streamMetrics, llmError } = message
    if (isStreaming) return null
    const hasUsage = usage && (usage.inputTokens > 0 || usage.outputTokens > 0)
    const hasMetrics = streamMetrics && streamMetrics.durationMs > 0
    if (!hasUsage && !hasMetrics && !llmError) return null
    return (
      <div className={styles['token-usage']}>
        {hasUsage && (
          <>
            <span className={styles['token-usage-item']}>
              <span>↑</span>
              <span>{usage!.inputTokens.toLocaleString()}</span>
            </span>
            <span className={styles['token-usage-sep']}>|</span>
            <span className={styles['token-usage-item']}>
              <span>↓</span>
              <span>{usage!.outputTokens.toLocaleString()}</span>
            </span>
            {usage!.cacheRead ? (
              <>
                <span className={styles['token-usage-sep']}>|</span>
                <span className={styles['token-usage-item']}>
                  <span>缓存</span>
                  <span>{usage!.cacheRead.toLocaleString()}</span>
                </span>
              </>
            ) : null}
          </>
        )}
        {hasMetrics && (
          <>
            {(hasUsage) && <span className={styles['token-usage-sep']}>|</span>}
            <span className={styles['token-usage-item']} title="总耗时（首包至结束）">
              <Timer size={12} />
              <span>{(streamMetrics!.durationMs / 1000).toFixed(1)}s</span>
            </span>
            <span className={styles['token-usage-sep']}>|</span>
            <span className={styles['token-usage-item']} title="输出 token 平均速度">
              <Zap size={12} />
              <span>{streamMetrics!.tokensPerSecond.toFixed(1)} tok/s</span>
            </span>
          </>
        )}
        {llmError && (
          <>
            <span className={styles['token-usage-sep']}>|</span>
            <span className={styles['token-usage-item']} title={llmError.message}>
              <AlertTriangle size={12} />
              <span>{llmError.code}{llmError.retryable ? '（可重试）' : ''}</span>
            </span>
          </>
        )}
      </div>
    )
  }

  const renderContent = () => {
    if (message.error) {
      return (
        <div className={clsx(styles['message-text'], styles['message-error'])}>
          <span className={styles['error-icon']}><AlertTriangle size={14} /></span>
          <span className={styles['error-content']}>{message.error}</span>
        </div>
      )
    }

    if (message.role === 'system') {
      // 命令反馈消息：用信息提示样式渲染，支持简单 markdown（加粗、code）
      return (
        <div className={clsx(styles['message-text'], styles['message-system-info'])}>
          <span className={styles['system-info-content']}>
            {renderTextContent(message.content)}
          </span>
        </div>
      )
    }

    if (message.role === 'assistant') {
      if (message.isAborted) {
        const hasParts = (message.parts?.length ?? 0) > 0
        return (
          <>
            {hasParts ? wrapSubAgent(renderPartsTimeline()) : (
              message.content && (
                <div className={styles['message-text']}>
                  <div className={styles['message-content-partial']}>
                    {renderTextContent(message.content)}
                  </div>
                </div>
              )
            )}
            <div className={styles['message-aborted-badge']}>
              <span className={styles['aborted-icon']}><Ban size={12} /></span>
              <span className={styles['aborted-text']}>回复已中断</span>
            </div>
          </>
        )
      }
      return renderAssistantBody()
    }

    // User message
    if (message.isAborted) {
      return (
        <div className={styles['message-text']}>
          {message.content && (
            <div className={styles['message-content-partial']}>
              {renderTextContent(message.content)}
            </div>
          )}
          <div className={styles['message-aborted-badge']}>
            <span className={styles['aborted-icon']}>🚫</span>
            <span className={styles['aborted-text']}>回复已中断</span>
          </div>
        </div>
      )
    }

    if (message.content) {
      // 语音输入：显示波形按钮（可点击回放原始录音）
      if (message.isVoice) {
        const handlePlayVoice = () => {
          if (!message.audioWavBase64) return
          const binary = atob(message.audioWavBase64)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
          const blob = new Blob([bytes], { type: 'audio/wav' })
          const url = URL.createObjectURL(blob)
          const audio = new Audio(url)
          audio.onended = () => URL.revokeObjectURL(url)
          audio.play().catch(() => URL.revokeObjectURL(url))
        }
        return (
          <div className={styles['message-text']}>
            <div
              className={styles['voice-message-bubble']}
              onClick={message.audioWavBase64 ? handlePlayVoice : undefined}
              style={message.audioWavBase64 ? { cursor: 'pointer' } : undefined}
              title={message.audioWavBase64 ? '点击回放录音' : undefined}
            >
              <span className={styles['voice-wave']}>
                <span /><span /><span />
              </span>
            </div>
            {message.content && (
              <p className={styles['voice-message-transcript']}>{message.content}</p>
            )}
          </div>
        )
      }
      const { textWithoutMedia, mediaFiles } = parseMediaAttachments(message.content)
      return (
        <div className={styles['message-text']}>
          {textWithoutMedia && renderTextContent(textWithoutMedia)}
          {mediaFiles.length > 0 && (
            <MediaFileChips mediaFiles={mediaFiles} />
          )}
        </div>
      )
    }

    return (
      <div className={clsx(styles['message-text'], styles['message-empty'])}>
        <span className={styles['empty-icon']}><Inbox size={32} /></span>
        <span className={styles['empty-content']}>未收到响应</span>
      </div>
    )
  }

  /** 角色标识：用文字代替头像图形 */
  const roleLabel =
    message.role === 'user'
      ? '你'
      : message.error || message.role === 'system'
        ? '系统'
        : 'lumii'

  const content = renderContent()

  // 助手消息：若正文和工具调用均无内容可展示（非流式），完全跳过渲染，避免空白卡片
  // streamMetrics/usage 本身不算"有内容"，不阻止过滤
  if (
    message.role === 'assistant'
    && !message.isStreaming
    && content === null
    && !(message.parts && message.parts.length > 0)
    && !message.thinkingText
    && !streamingThinkingText?.trim()
    && !message.llmError
    && !message.error
  ) {
    return null
  }

  return (
    <ToolFilePreviewProvider value={{ onPreview: handleToolFilePreview }}>
    <div
      className={clsx(
        styles.message,
        styles[message.role],
        message.isStreaming && styles.streaming,
        message.error && styles['has-error'],
        noEnter && styles['message--no-enter'],
      )}
    >
      {/* 内联文件预览：由工具卡片点击文件名触发，展示在消息顶部 */}
      {previewFileId && (
        <FilePreviewModal
          fileId={previewFileId}
          fileName={previewFileName}
          userId={userId}
          mdBasePath={previewEditablePath}
          editablePath={previewEditablePath}
          onClose={() => { setPreviewFileId(null); setPreviewEditablePath(undefined) }}
        />
      )}
      {previewByPath && (
        <FilePreviewModal
          filePath={previewByPath.filePath}
          fileName={previewByPath.fileName}
          userId={userId}
          {...(typeof previewByPath.startLine === 'number' ? { startLine: previewByPath.startLine } : {})}
          {...(typeof previewByPath.endLine === 'number' ? { endLine: previewByPath.endLine } : {})}
          onClose={() => setPreviewByPath(null)}
        />
      )}
      <div className={styles['message-avatar']}>{roleLabel}</div>
      <div className={styles['message-content-wrapper']}>
        {content}
        {message.role === 'assistant' && renderTokenUsage()}
        {message.role === 'assistant' && renderMemoryHint()}
        {/*
          注意：消息气泡底部不再重复渲染 fileAttachments。
          Agent 生成/上传的文件由对话流内的 SessionFileList 轻量卡片展示，
          避免「消息气泡底部附件列表 + 会话文件列表」双重冗余。
          fileAttachments prop 仍保留，供工具卡片按 fileName 匹配 fileId 做内联预览。
        */}

        {!message.isStreaming && (
          <div className={styles['message-actions-wrap']}>
          <MessageActions
            messageId={message.id}
            role={message.role}
            content={
              message.role === 'user'
                ? parseMediaAttachments(message.content).textWithoutMedia
                : message.content
            }
            isEditing={isEditing}
            onCopy={handleCopy}
            onEditStart={handleEditStart}
            onEditCancel={handleEditCancel}
            onEditSave={handleEditSave}
            onDelete={onDelete}
            onRegenerate={onRegenerate}
            sessionBusy={sessionBusy}
            isVoice={message.isVoice}
            isReplaying={replayMessageId === message.id}
            onReplay={onReplay ? () => onReplay(message.id) : undefined}
          />
          </div>
        )}

        <div className={styles['message-meta']}>{formatTime(message.timestamp)}</div>
      </div>
    </div>
    </ToolFilePreviewProvider>
  )
}

export default ChatMessage
export { ChatMessage }
