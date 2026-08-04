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
import { TypingIndicator } from '../TypingIndicator'
import { MessageActions } from '../MessageActions'
import { ToolCallCard, ToolFilePreviewProvider, ToolFilePreviewContext } from '../ToolCallCard'
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
import type { RuntimeFileEvent } from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'
import styles from './ChatMessage.module.css'

interface ChatMessageProps {
  message: ChatMessageType
  formatTime: (date: Date) => string
  isLatestAssistant: boolean
  onCopy: (content: string) => void
  onEdit: (messageId: string, newContent: string) => void
  onDelete: (messageId: string) => void
  onRegenerate: (messageId: string) => void
  /** 编辑后「基于历史创建新对话分支」 */
  onFork?: (messageId: string, newContent: string) => void
  /** 编辑后「删除后续并重新回答」 */
  onEditAndResend?: (messageId: string, newContent: string) => void
  /** 删除后续消息的预估条数（用于分支面板提示） */
  deleteCount?: number
  /** 打开工作空间版本面板的回调（用于回溯联动） */
  onOpenVersionPanel?: () => void
  /** 会话是否正在流式输出：为 true 时禁用用户消息的「重新生成」入口 */
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

/** 解析消息文本中的 [media attached: path (fileName)] 行，返回文件列表和剩余文本 */
function parseMediaAttachments(content: string): {
  textWithoutMedia: string
  mediaFiles: Array<{ filePath: string; fileName: string }>
} {
  const MEDIA_RE = /^\[media attached:\s*(.+?)(?:\s+\(([^)]+)\))?\]$/
  const lines = content.split('\n')
  const mediaFiles: Array<{ filePath: string; fileName: string }> = []
  const textLines: string[] = []
  for (const line of lines) {
    const m = MEDIA_RE.exec(line.trim())
    if (m) {
      const rawPath = m[1].trim()
      const fileName = m[2]?.trim() ?? rawPath.split(/[\\/]/).pop() ?? rawPath
      mediaFiles.push({ filePath: rawPath, fileName })
    } else {
      textLines.push(line)
    }
  }
  return { textWithoutMedia: textLines.join('\n').trim(), mediaFiles }
}

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

type Segment =
  | { type: 'text'; content: string }
  | { type: 'tool'; item: AgentWorkflowItem }

/** 记忆类别 → 简短中文标签（用于展开列表） */
const MEMORY_CATEGORY_LABEL: Record<string, string> = {
  user: '用户画像',
  feedback: '交互偏好',
  project: '进行中的事',
  reference: '外部资源',
  general: '其他',
}

/**
 * 判断 index 处是否为「文字 / 工具卡片」段落级切段边界。
 *
 * 设计原则：只在**段落边界**（连续两个 \n，即空行）切割，不在单行换行处切割。
 * 这样可保证 Markdown 块结构（表格、列表、代码块等）的完整性，避免工具卡片
 * 被插入到表格的表头行和分隔符行之间，导致 Markdown 渲染错乱。
 *
 * 段落边界规则：当前位置是 
，且上一个字符也是 
（即 

 序列的第二个 
）。
 */
function isBoundaryPunctuation(text: string, index: number): boolean {
  const ch = text[index]
  if (ch === undefined) {
    return false
  }
  // 仅在连续双换行（段落分隔）处切割，单 \n 不切（避免破坏 Markdown 表格、列表等多行结构）
  if (ch === '\n') {
    return text[index - 1] === '\n'
  }
  if ('。？！；'.includes(ch)) {
    return true
  }
  if (ch === '?' || ch === '!') {
    return true
  }

  if (ch === '.') {
    const prev = text[index - 1]
    const next = text[index + 1]
    // Markdown 有序列表加粗：**1.** 正文 — 句点后接闭合 *，不能当句末否则「1.」与后文被卡片拆开
    if (prev !== undefined && /\d/.test(prev) && next === '*') {
      return false
    }
    // 域名 / TLD：点后紧跟字母数字（wttr.in、example.com）
    if (next !== undefined && /[a-zA-Z0-9]/.test(next)) {
      return false
    }
    // 小数：数字.数字
    if (
      prev !== undefined
      && next !== undefined
      && /\d/.test(prev)
      && /\d/.test(next)
    ) {
      return false
    }
    return true
  }

  return false
}

/**
 * 从 pos 向后查找最近的句子结束位置（含结束符本身）。
 * 用于将工具调用切割点对齐到句子末尾，保证句子完整性。
 *
 * maxLookahead 限制向后扫描的最大字符数，防止在找不到边界时把后续所有文字
 * （包括工具调用之后的总结段落）都归入当前文字段，导致工具卡片后方的总结文字
 * 「跑到」卡片上方的错位问题。超过 maxLookahead 仍无边界时，直接在 pos 处切割。
 */
function snapToSentenceEnd(text: string, pos: number, maxLookahead = 300): number {
  if (pos <= 0) {
    return 0
  }
  // 切割点已落在一处「真实边界」之后：无需再向前延伸
  if (isBoundaryPunctuation(text, pos - 1)) {
    return pos
  }

  const limit = Math.min(pos + maxLookahead, text.length)
  for (let i = pos; i < limit; i++) {
    if (isBoundaryPunctuation(text, i)) {
      return i + 1
    }
  }
  // 超出查找范围仍无边界：直接在原始位置切割，避免把后续段落（包括总结文字）
  // 全部归入当前文字段，导致工具卡片之后的内容「错位」到卡片上方
  return pos
}

/**
 * 清理文字段的首尾：
 * - 移除开头的 \n\n 分隔符（由服务端在两轮文字之间插入）
 * - 移除末尾多余空白
 */
function cleanTextSegment(text: string): string {
  // 最多移除开头 2 个连续 \n（即服务端插入的 \n\n 轮次分隔符）
  let start = 0
  let stripped = 0
  while (stripped < 2 && start < text.length && text[start] === '\n') {
    start++
    stripped++
  }
  return text.slice(start).trimEnd()
}

/**
 * 将消息文字和工具调用按 textPositionAtStart 交错合并成 Segment 序列。
 * 切割点会对齐到句子结束边界，保证每个文字段的句子完整性。
 */
function buildSegments(text: string, toolItems: AgentWorkflowItem[]): Segment[] {
  const positioned = toolItems
    .filter((t) => t.textPositionAtStart !== undefined)
    .toSorted((a, b) => {
      const posDiff = (a.textPositionAtStart ?? 0) - (b.textPositionAtStart ?? 0)
      if (posDiff !== 0) return posDiff
      // 同一文本位置：按 startTime 升序，保证多个工具（含子 Agent）按真实触发时间先后渲染
      const aMs = a.startTime ? a.startTime.getTime() : 0
      const bMs = b.startTime ? b.startTime.getTime() : 0
      return aMs - bMs
    })

  // 没有位置信息：回退到全部工具在文字末尾
  if (positioned.length === 0) {
    const segs: Segment[] = []
    if (text) segs.push({ type: 'text', content: text })
    toolItems.forEach((item) => segs.push({ type: 'tool', item }))
    return segs
  }

  const segs: Segment[] = []
  let lastPos = 0

  for (const item of positioned) {
    const rawPos = Math.min(item.textPositionAtStart ?? 0, text.length)
    // 对齐到句子边界，避免切割在句子中间；
    // 同时确保对齐后的位置不超过文本末尾，防止把全部文字都归入当前段导致后续内容错位
    const snapped = snapToSentenceEnd(text, rawPos)
    // 对齐后的位置不能超过下一个工具的原始位置（若有），以免吞掉相邻工具之间的文字段
    const pos = Math.max(lastPos, snapped)

    const textChunk = cleanTextSegment(text.slice(lastPos, pos))
    if (textChunk) {
      segs.push({ type: 'text', content: textChunk })
    }
    segs.push({ type: 'tool', item })
    lastPos = pos
  }

  // 所有工具之后的剩余文字，清理开头分隔符
  const tail = cleanTextSegment(text.slice(lastPos))
  if (tail) segs.push({ type: 'text', content: tail })

  return segs
}

// ---------------------------------------------------------------
// ThinkingBlock — 思考过程折叠卡片（默认折叠，固定高度防抖动）
// ---------------------------------------------------------------

interface ThinkingBlockProps {
  thinkingText: string
  isStreaming: boolean
  isLive: boolean
}

const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ thinkingText, isStreaming, isLive }) => {
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
    <div className={styles['rt-thinking-card']}>
      <button
        type="button"
        className={styles['rt-thinking-card-header']}
        onClick={handleToggle}
      >
        <span className={styles['rt-thinking-card-icon']}>💭</span>
        <span className={styles['rt-thinking-card-title']}>思考过程</span>
        {isLive && isStreaming && (
          <span className={styles['rt-live-badge']}>实时</span>
        )}
        {!expanded && (
          <span className={styles['rt-thinking-card-preview']}>{preview}…</span>
        )}
        <span className={styles['rt-thinking-card-chevron']}>{expanded ? '∧' : '∨'}</span>
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

// ---------------------------------------------------------------
// ToolsSection — 工具调用折叠列表
// ---------------------------------------------------------------

interface ToolsSectionProps {
  tools: AgentWorkflowItem[]
  runningTools: AgentWorkflowItem[]
  doneCount: number
  failCount: number
  isStreaming: boolean
}

const ToolsSection: React.FC<ToolsSectionProps> = ({
  tools,
  runningTools,
  doneCount,
  failCount,
  isStreaming,
}) => {
  const [expanded, setExpanded] = useState(false)

  const totalCount = tools.length
  const hasRunning = runningTools.length > 0

  // 折叠时只展示运行中的工具；展开后展示全部
  const visibleTools = expanded ? tools : runningTools

  const summaryLabel = expanded
    ? `收起（共 ${totalCount} 步）`
    : `展开全部 ${totalCount} 步`

  const statusMeta = [
    doneCount > 0 && `${doneCount} 完成`,
    failCount > 0 && `${failCount} 失败`,
    isStreaming && hasRunning && `${runningTools.length} 运行中`,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className={styles['rt-tools-section']}>
      {/* 顶部也提供收起按钮，便于在思考卡片下方就地操作 */}
      {totalCount > 0 && expanded && (
        <button
          type="button"
          className={styles['rt-tools-toggle']}
          onClick={() => setExpanded(false)}
        >
          <span className={styles['rt-tools-toggle-icon']}>▾</span>
          <span>收起（共 {totalCount} 步）</span>
          {statusMeta && <span className={styles['rt-tools-toggle-meta']}>{statusMeta}</span>}
        </button>
      )}

      {/* 运行中的工具（始终可见） */}
      {visibleTools.length > 0 && (
        <div className={styles['rt-tools-list']}>
          {visibleTools.map((item, idx) => {
            const globalIdx = expanded ? idx : tools.indexOf(item)
            return (
              <div key={item.id} className={styles['rt-tool-row']}>
                <div className={styles['rt-tool-step-line']}>
                  <span className={styles['rt-step-num']}>{globalIdx + 1}</span>
                  {idx < visibleTools.length - 1 && (
                    <span className={styles['rt-step-connector']} />
                  )}
                </div>
                <div className={styles['rt-tool-card']}>
                  <ToolCallCard item={item} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 折叠/展开切换按钮（工具数 > 0 时显示） */}
      {totalCount > 0 && (
        <button
          type="button"
          className={styles['rt-tools-toggle']}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className={styles['rt-tools-toggle-icon']}>{expanded ? '▾' : '▸'}</span>
          <span>{summaryLabel}</span>
          {statusMeta && <span className={styles['rt-tools-toggle-meta']}>{statusMeta}</span>}
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------
// 组件
// ---------------------------------------------------------------

const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  formatTime,
  isLatestAssistant,
  onCopy,
  onEdit,
  onDelete,
  onRegenerate,
  onFork,
  onEditAndResend,
  deleteCount,
  onOpenVersionPanel,
  sessionBusy = false,
  toolItems,
  streamingThinkingText,
  noEnter = false,
  fileAttachments,
  userId = 'local-user',
  onReplay,
  replayMessageId,
}) => {
  const [isEditing, setIsEditing] = useState(false)
  /** 编辑后分支选择状态：null=无选择；有值则展示选择面板 */
  const [pendingEdit, setPendingEdit] = useState<{ newContent: string } | null>(null)
  const [deleteConfirming, setDeleteConfirming] = useState(false)
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
  const handleEditCancel = () => { setIsEditing(false); setPendingEdit(null) }
  const handleEditSave = (newContent: string) => {
    // user 消息且内容有实质变化 → 弹出分支选择；非 user 或内容未变 → 原路保存
    if (message.role === 'user' && newContent.trim() !== message.content.trim() && (onFork || onEditAndResend)) {
      setIsEditing(false)
      setPendingEdit({ newContent })
      return
    }
    onEdit(message.id, newContent)
    setIsEditing(false)
  }
  /** 「重新生成 ▾」直达入口：不经编辑态，直接以原文触发回溯/分支面板 */
  const handleRegenerateMenu = () => {
    if (message.role !== 'user') return
    setPendingEdit({ newContent: message.content })
  }

  /** 构建包含文字 + 工具调用详情的完整复制文本 */
  const buildCopyContent = useCallback((): string => {
    const parts: string[] = []
    const thinking =
      (streamingThinkingText?.trim() ? streamingThinkingText : undefined)
      ?? message.thinkingText?.trim()
    if (thinking) {
      parts.push(`[思考过程]\n${thinking}`)
    }
    if (message.content) parts.push(message.content)
    if (toolItems && toolItems.length > 0) {
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
  }, [message.content, message.thinkingText, streamingThinkingText, toolItems])

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
    const toolCount = toolItems?.length ?? 0
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

  /**
   * 渲染 LLM 思考过程 + 工具调用列表。
   *
   * 设计：
   * - 不再用卡片包裹，直接展开显示在消息气泡上方
   * - 思考内容框默认滚动展示（max-height + overflow-y: auto）
   * - 工具列表默认折叠，只展示「运行中」的工具卡片；展开后按顺序显示全部
   */
  const renderReasoningTimeline = () => {
    const live = streamingThinkingText?.trim()
    const persisted = message.thinkingText?.trim()
    const thinkingText = live || persisted
    const hasThinking = !!thinkingText
    const tools = toolItems ?? []
    const hasTools = tools.length > 0
    const isStreaming = message.isStreaming

    // 无思考也无工具
    if (!hasThinking && !hasTools) {
      if (isStreaming && !message.content) {
        return (
          <div className={styles['rt-placeholder']}>
            <span className={styles['rt-spinner']} />
            <span>正在思考...</span>
          </div>
        )
      }
      return null
    }

    const runningTools = tools.filter((t) => t.status === 'running')
    const doneCount = tools.filter((t) => t.status === 'completed').length
    const failCount = tools.filter((t) => t.status === 'failed').length

    return (
      <div className={styles['rt-inline']}>
        {/* 思考过程：可折叠卡片，默认折叠，固定高度防抖动 */}
        {hasThinking && (
          <ThinkingBlock
            thinkingText={thinkingText}
            isStreaming={!!isStreaming}
            isLive={!!live}
          />
        )}

        {/* 工具调用列表：默认折叠，只展示运行中；展开后显示全部 */}
        {hasTools && (
          <ToolsSection
            tools={tools}
            runningTools={runningTools}
            doneCount={doneCount}
            failCount={failCount}
            isStreaming={!!isStreaming}
          />
        )}
      </div>
    )
  }

  /**
   * 渲染 assistant 消息正文 + 交错的工具调用行。
   * 整体包在一个 message-text div 里，工具行用轻微色差区分。
   */
  const renderAssistantBody = () => {
    const hasTools = toolItems && toolItems.length > 0
    const hasContent = !!message.content

    if (!hasContent && !hasTools) {
      if (message.isStreaming) {
        return wrapSubAgent(
          <>
            {renderReasoningTimeline()}
            {!message.thinkingText && !streamingThinkingText && <TypingIndicator />}
          </>,
        )
      }
      if (message.thinkingText?.trim()) {
        return wrapSubAgent(renderReasoningTimeline())
      }
      return null
    }

    if (!hasContent && hasTools) {
      return wrapSubAgent(
        <>
          {renderReasoningTimeline()}
          {message.isStreaming && <TypingIndicator />}
        </>,
      )
    }

    return wrapSubAgent(
      <>
        {renderReasoningTimeline()}
        <div className={styles['message-text']}>
          {renderTextContent(message.content)}
          {message.isStreaming && <span className={styles['streaming-cursor']}></span>}
        </div>
      </>,
    )
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
        return (
          <>
            {renderReasoningTimeline()}
            <div className={styles['message-text']}>
              {message.content && (
                <div className={styles['message-content-partial']}>
                  {renderTextContent(message.content)}
                </div>
              )}
              <div className={styles['message-aborted-badge']}>
                <span className={styles['aborted-icon']}><Ban size={12} /></span>
                <span className={styles['aborted-text']}>回复已中断</span>
              </div>
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

  /**
   * 渲染会话头像：用户 / 助手 / 告警 使用简洁 SVG，避免 emoji，风格与 MtBot 助手产品一致。
   */
  const renderAvatar = () => {
    if (message.role === 'user') {
      return (
        <svg className={styles['avatar-svg']} viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.75" />
          <path
            d="M5 20c.8-3.2 3.6-5 7-5s6.2 1.8 7 5"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      )
    }
    if (message.error || message.role === 'system') {
      return (
        <svg className={styles['avatar-svg']} viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 3L3 19h18L12 3z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
          <path d="M12 9v4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
          <circle cx="12" cy="17" r="1" fill="currentColor" />
        </svg>
      )
    }
    return (
      <svg className={styles['avatar-svg']} viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.75" />
        <path d="M9 10V8a3 3 0 0 1 6 0v2" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        <circle cx="9" cy="15" r="1" fill="currentColor" />
        <circle cx="15" cy="15" r="1" fill="currentColor" />
        <path d="M9 7V5a3 3 0 0 1 6 0v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.35" />
      </svg>
    )
  }

  const content = renderContent()

  // 助手消息：若正文和工具调用均无内容可展示（非流式），完全跳过渲染，避免空白卡片
  // streamMetrics/usage 本身不算"有内容"，不阻止过滤
  if (
    message.role === 'assistant'
    && !message.isStreaming
    && content === null
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
      <div className={styles['message-avatar']}>{renderAvatar()}</div>
      <div className={styles['message-content-wrapper']}>
        {content}
        {message.role === 'assistant' && renderTokenUsage()}
        {message.role === 'assistant' && renderMemoryHint()}
        {/*
          注意：消息气泡底部不再重复渲染 fileAttachments。
          Agent 生成/上传的文件由会话底部统一的 SessionFileList 展示，
          避免「消息气泡底部附件列表 + 会话文件列表」双重冗余。
          fileAttachments prop 仍保留，供工具卡片按 fileName 匹配 fileId 做内联预览。
        */}

        {!message.isStreaming && (
          <div className={styles['message-actions-wrap']}>
          <MessageActions
            messageId={message.id}
            role={message.role}
            content={message.content}
            isLatestAssistant={isLatestAssistant}
            isEditing={isEditing}
            onCopy={handleCopy}
            onEditStart={handleEditStart}
            onEditCancel={handleEditCancel}
            onEditSave={handleEditSave}
            onDelete={onDelete}
            onRegenerate={onRegenerate}
            onRegenerateMenu={(!sessionBusy && (onFork || onEditAndResend)) ? handleRegenerateMenu : undefined}
            isVoice={message.isVoice}
            isReplaying={replayMessageId === message.id}
            onReplay={onReplay ? () => onReplay(message.id) : undefined}
          />
          </div>
        )}

        {/* 编辑后分支选择面板 */}
        {pendingEdit && (
          <div className={styles['edit-branch-panel']}>
            <p className={styles['edit-branch-hint']}>
              {pendingEdit.newContent.trim() === message.content.trim()
                ? '从这条消息重新开始，请选择方式：'
                : '消息已编辑，请选择后续操作：'}
            </p>
            <div className={styles['edit-branch-actions']}>
              {onFork && (
                <button
                  type="button"
                  className={styles['edit-branch-btn']}
                  onClick={() => {
                    onFork(message.id, pendingEdit.newContent)
                    setPendingEdit(null)
                    setDeleteConfirming(false)
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                  基于当前历史创建新对话
                </button>
              )}
              {onEditAndResend && (
                deleteConfirming ? (
                  <>
                    <p className={styles['edit-branch-note']} style={{ color: 'var(--color-error, #ef4444)', fontWeight: 500 }}>
                      {typeof deleteCount === 'number' && deleteCount > 0
                        ? `确认删除后续 ${deleteCount} 条消息并重新回答？此操作不可撤销。`
                        : '确认删除后续消息并重新回答？此操作不可撤销。'}
                    </p>
                    <div className={styles['edit-branch-actions']}>
                      <button
                        type="button"
                        className={styles['edit-branch-btn']}
                        style={{ color: 'var(--color-error, #ef4444)', borderColor: 'var(--color-error, #ef4444)' }}
                        onClick={() => {
                          onEditAndResend(message.id, pendingEdit.newContent)
                          setPendingEdit(null)
                          setDeleteConfirming(false)
                        }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                          <polyline points="23 4 23 10 17 10" />
                          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                        </svg>
                        确认删除
                      </button>
                      <button
                        type="button"
                        className={styles['edit-branch-btn']}
                        onClick={() => setDeleteConfirming(false)}
                      >
                        取消
                      </button>
                    </div>
                  </>
                ) : (
                  <button
                    type="button"
                    className={styles['edit-branch-btn']}
                    onClick={() => {
                      if (typeof deleteCount === 'number' && deleteCount > 0) {
                        setDeleteConfirming(true)
                      } else {
                        onEditAndResend(message.id, pendingEdit.newContent)
                        setPendingEdit(null)
                      }
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                      <polyline points="23 4 23 10 17 10" />
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                    {typeof deleteCount === 'number' && deleteCount > 0
                      ? `删除后续 ${deleteCount} 条并重新回答`
                      : '删除后续并重新回答'}
                  </button>
                )
              )}
              <button
                type="button"
                className={styles['edit-branch-btn']}
                onClick={() => { setPendingEdit(null); setDeleteConfirming(false) }}
              >
                取消
              </button>
            </div>
            <p className={styles['edit-branch-note']}>
              提示：工作空间文件不会自动回退。
              {onOpenVersionPanel ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className={styles['edit-branch-note-btn']}
                    onClick={() => {
                      onOpenVersionPanel()
                      setPendingEdit(null)
                      setDeleteConfirming(false)
                    }}
                  >
                    打开工作空间版本
                  </button>
                  {' '}手动回滚。
                </>
              ) : (
                '如需可在「工作空间版本」中手动回滚。'
              )}
            </p>
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
