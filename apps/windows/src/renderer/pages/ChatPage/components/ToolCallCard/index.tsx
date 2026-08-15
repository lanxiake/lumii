/**
 * ToolCallCard - 工具调用和子 Agent 紧凑行组件
 *
 * 设计原则：
 * - 单行显示：图标 + 工具名 + 状态，不占用太多空间
 * - 可点击展开查看输入输出详情
 * - 微妙样式，不喧宾夺主
 * - 子 Agent 有专属的视觉风格（左侧彩色边框 + 背景区分）
 */

import React, { useState, useCallback, useMemo, useEffect, createContext, useContext } from 'react'
import clsx from 'clsx'
import type { AgentWorkflowItem, ChildToolItem } from '../../../../hooks/business/useChat'
import { ImageLightbox } from '../../../../components/ImageLightbox/ImageLightbox'
import { classifyToolFamily } from './toolTaxonomy'
import styles from './ToolCallCard.module.css'

// ─── 文件预览上下文 ─────────────────────────────────────
/**
 * 向下穿透的文件预览回调，工具卡片中的"点击文件名预览"场景使用。
 * 由 ChatMessage/ChatContainer 提供实现（打开 FilePreviewModal 并定位到指定行号片段）。
 */
interface ToolFilePreviewCtx {
  onPreview: (args: {
    filePath: string
    fileName: string
    startLine?: number
    endLine?: number
  }) => void
}

export const ToolFilePreviewContext = createContext<ToolFilePreviewCtx | null>(null)

export const ToolFilePreviewProvider: React.FC<{
  value: ToolFilePreviewCtx
  children: React.ReactNode
}> = ({ value, children }) => (
  <ToolFilePreviewContext.Provider value={value}>
    {children}
  </ToolFilePreviewContext.Provider>
)

function useToolFilePreview(): ToolFilePreviewCtx | null {
  return useContext(ToolFilePreviewContext)
}

/**
 * 从工具 input 中提取文件相关元数据（路径 + 行号范围）
 * 覆盖 file_read / file_write / file_edit / writeLocalFile / readLocalFile 等常见命名。
 */
interface ToolFileInfo {
  filePath: string
  fileName: string
  /** 1-based 起始行号（可选） */
  startLine?: number
  /** 1-based 结束行号（可选，含） */
  endLine?: number
  /** 是否为读取类工具（read/view） */
  isRead: boolean
  /** 是否为写入/编辑类工具 */
  isWrite: boolean
}

function extractToolFileInfo(
  toolName: string,
  input: Record<string, unknown> | undefined,
): ToolFileInfo | null {
  if (!input) return null
  const lname = (toolName || '').toLowerCase()
  // 仅文件读写编辑类工具触发（排除 todo_write 等）
  if (lname.includes('todo')) return null
  const isRead =
    lname.includes('file_read') ||
    lname === 'read' ||
    lname === 'readfile' ||
    lname === 'readlocalfile' ||
    lname.includes('view')
  const isWrite =
    lname.includes('file_write') ||
    lname.includes('file_edit') ||
    lname === 'write' ||
    lname === 'edit' ||
    lname === 'writefile' ||
    lname === 'writelocalfile' ||
    lname.includes('notebookedit') ||
    (lname.includes('write') && !lname.includes('todo'))
  if (!isRead && !isWrite) return null

  const filePath = (input.filePath ||
    input.file_path ||
    input.path ||
    input.notebook_path ||
    input.notebookPath) as string | undefined
  if (!filePath || typeof filePath !== 'string') return null
  const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath

  // 读取类：offset + limit(行数) → startLine/endLine
  let startLine: number | undefined
  let endLine: number | undefined
  if (isRead) {
    const offset = input.offset as number | undefined
    const limit = input.limit as number | undefined
    if (typeof offset === 'number' && offset >= 1) {
      startLine = offset
      if (typeof limit === 'number' && limit > 0) {
        endLine = offset + limit - 1
      }
    }
  }
  // 写入类：直接使用 startLine/endLine 字段（file_write 的新参数）
  if (isWrite) {
    const sl = (input.startLine ?? input.start_line) as number | undefined
    const el = (input.endLine ?? input.end_line) as number | undefined
    if (typeof sl === 'number' && sl >= 1) startLine = sl
    if (typeof el === 'number' && el >= 1) endLine = el
  }

  return { filePath, fileName, startLine, endLine, isRead, isWrite }
}

/** 将行号范围格式化为紧凑标签，如 "L12-L45" 或 "L12" */
function formatLineRange(startLine?: number, endLine?: number): string {
  if (typeof startLine !== 'number') return ''
  if (typeof endLine === 'number' && endLine !== startLine) {
    return `L${startLine}-L${endLine}`
  }
  return `L${startLine}`
}

/** 带短暂"已复制"反馈的复制按钮 */
const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }, [text])

  return (
    <button
      className={clsx(styles['copy-btn'], copied && styles['copy-btn--copied'])}
      onClick={handleCopy}
      title="复制"
    >
      {copied ? '✓ 已复制' : '复制'}
    </button>
  )
}

/** 详情块：标签 + 可选复制按钮 + 内容 */
const DetailBlock: React.FC<{
  label: string
  copyText?: string
  children: React.ReactNode
}> = ({ label, copyText, children }) => (
  <div className={styles.detailBlock}>
    <div className={styles.detailHeader}>
      <span className={styles.detailLabel}>{label}</span>
      {copyText && <CopyButton text={copyText} />}
    </div>
    {children}
  </div>
)

interface ToolCallCardProps {
  item: AgentWorkflowItem
  isNested?: boolean
}

/**
 * 统一渲染工具名称标签。
 *
 * MCP 工具名形如 mcp__<server>__<tool>，展示为「server · tool」。
 */
function getToolDisplayName(name: string): string {
  if (!name) return 'unknown_tool'
  const mcpMatch = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcpMatch) {
    return `${mcpMatch[1]} · ${mcpMatch[2]}`
  }
  return name
}

/**
 * 运行中计时器：仅在 enabled=true 时每秒刷新一次当前时间。
 */
function useLiveNow(enabled: boolean): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    if (!enabled) return
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [enabled])

  return now
}

function formatParams(params: unknown): string {
  if (params === null || params === undefined) return ''
  try {
    return JSON.stringify(params, null, 2)
  } catch {
    return String(params)
  }
}

function truncate(text: string, maxLength: number = 80): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '…'
}

/** 工具家族 → 单行图标符号 */
const FAMILY_ICON: Record<ReturnType<typeof classifyToolFamily>, string> = {
  todo: '◉',
  read: '◎',
  search: '›',
  write: '◈',
  exec: '⟩',
  agent: '◌',
  image: '◈',
  other: '›',
}

function getToolIcon(name: string, type: AgentWorkflowItem['type'], status: AgentWorkflowItem['status']): string {
  if (status === 'failed') return '✕'
  if (type === 'subagent') return status === 'running' ? '◌' : '◎'
  return FAMILY_ICON[classifyToolFamily(name)]
}

/** 从 input 中提取有意义的目标名称（文件名/搜索词/命令等） */
function extractTargetName(input: Record<string, unknown> | undefined, toolName: string): string {
  if (!input) return ''

  const lname = toolName.toLowerCase()

  /** todo_write 含 "write"，优先按任务语义解析，避免走文件路径分支 */
  if (lname.includes('todo')) {
    const action = input.action as string | undefined
    if (action === 'list') return '全部任务'
    if (action === 'create' && input.subject) return truncate(String(input.subject), 40)
    if (action === 'batch_create') {
      const tasks = input.tasks as Array<{ subject?: string }> | undefined
      return tasks?.length ? `批量创建 ${tasks.length} 个任务` : '批量创建任务'
    }
    if (action === 'batch_update') {
      const updates = input.updates as Array<unknown> | undefined
      return updates?.length ? `批量更新 ${updates.length} 个任务` : '批量更新任务'
    }
    if ((action === 'update' || action === 'delete') && input.taskId) {
      return `#${String(input.taskId)}`
    }
    return ''
  }

  // 文件路径类（Read, Write, Edit, Glob）
  const filePath = (input.file_path || input.path || input.notebook_path) as string | undefined
  if (filePath) {
    // 只取文件名
    const parts = filePath.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] || filePath
  }

  // 搜索类（Grep, Search）
  if (lname.includes('grep') || lname.includes('search')) {
    const pattern = (input.pattern || input.query || input.q) as string | undefined
    if (pattern) return truncate(String(pattern), 40)
  }

  // Glob 模式
  const glob = input.pattern as string | undefined
  if (glob) return truncate(String(glob), 40)

  // Bash 命令
  const cmd = (input.command || input.cmd) as string | undefined
  if (cmd) return truncate(String(cmd).split('\n')[0], 40)

  // 技能调用
  const skill = (input.skill || input.skillName || input.name) as string | undefined
  if (skill) return String(skill)

  // 子 Agent 任务
  const task = input.task as string | undefined
  if (task) return truncate(String(task), 40)

  return ''
}

/** 生成工具的中文动作短句（如「已查看 xxx」「正在执行 xxx」），供单行卡片与批次分组复用 */
export function getStatusLabel(item: AgentWorkflowItem): string {
  const name = item.name || ''
  const lname = name.toLowerCase()
  const target = extractTargetName(item.input, name)

  if (item.type === 'subagent') {
    const task = (item.input?.task as string) || item.description || '子任务'
    if (item.status === 'running') return `启动子 Agent: ${truncate(task, 40)}`
    if (item.status === 'completed') return `子 Agent 完成: ${truncate(task, 40)}`
    if (item.status === 'failed') return `子 Agent 失败: ${truncate(task, 40)}`
    return truncate(task, 50)
  }

  const isRunning = item.status === 'running'
  const isFailed = item.status === 'failed'

  const prefix = isRunning ? '正在' : isFailed ? '失败' : '已'

  /** todo_write 含 "write"，必须在 write/create 分支之前匹配 */
  if (lname.includes('todo')) {
    const action = (item.input?.action as string) || ''
    if (action === 'list') return `${prefix}列出任务`
    if (action === 'create') return target ? `${prefix}创建任务：${target}` : `${prefix}创建任务`
    if (action === 'batch_create') return target ? `${prefix}${target}` : `${prefix}批量创建任务`
    if (action === 'update') return target ? `${prefix}更新任务 ${target}` : `${prefix}更新任务`
    if (action === 'batch_update') return target ? `${prefix}${target}` : `${prefix}批量更新任务`
    if (action === 'delete') return target ? `${prefix}删除任务 ${target}` : `${prefix}删除任务`
    return `${prefix}更新任务列表`
  }

  if (lname.includes('read') || lname.includes('view') || lname.includes('notebookread')) {
    return target ? `${prefix}查看 ${target}` : `${prefix}查看文件`
  }
  if ((lname.includes('write') || lname.includes('create')) && !lname.includes('todo')) {
    return target ? `${prefix}写入 ${target}` : `${prefix}写入文件`
  }
  if (lname.includes('edit')) {
    return target ? `${prefix}编辑 ${target}` : `${prefix}编辑文件`
  }
  if (lname.includes('grep') || (lname.includes('search') && !lname.includes('web'))) {
    return target ? `${prefix}检索 ${target}` : `${prefix}检索代码`
  }
  if (lname.includes('glob')) {
    return target ? `${prefix}检索文件 ${target}` : `${prefix}检索文件`
  }
  if (lname.includes('websearch') || (lname.includes('web') && lname.includes('search'))) {
    return target ? `${prefix}搜索网页 ${target}` : `${prefix}搜索网页`
  }
  if (lname.includes('webfetch') || (lname.includes('web') && lname.includes('fetch'))) {
    return target ? `${prefix}获取网页 ${target}` : `${prefix}获取网页`
  }
  if (lname.includes('bash') || lname.includes('exec') || lname.includes('run')) {
    return target ? `${prefix}执行 ${target}` : `${prefix}执行命令`
  }
  if (lname.includes('agent')) {
    return target ? `${prefix}调用 Agent ${target}` : `${prefix}调用 Agent`
  }
  if (lname === 'image_generate') {
    const prompt = item.input?.prompt as string | undefined
    return prompt ? `${prefix}生成图片：${truncate(prompt, 40)}` : `${prefix}生成图片`
  }
  if (lname === 'app_screenshot') {
    return `${prefix}截取界面`
  }

  // 通用技能/工具
  return target ? `${prefix}调用 ${name}: ${target}` : `${prefix}调用 ${name}`
}

/** 格式化毫秒数为人类可读耗时 */
function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`
}

/** 计算耗时字符串（优先用后端 durationMs，running 时用实时 Date.now() 而非 liveNow 避免 1 秒跳变） */
function formatDuration(startTime: Date, endTime?: Date, durationMs?: number): string {
  // 优先使用后端计算的 durationMs（精确且不受前端时间重置影响）
  if (durationMs !== undefined && durationMs >= 0) return formatMs(durationMs)
  const end = endTime ?? new Date()
  const ms = Math.max(0, end.getTime() - startTime.getTime())
  return formatMs(ms)
}

/** 从 childSessionKey 中提取简短标识符（最后一段 UUID 前8位） */
function extractShortKey(childSessionKey: string | undefined): string {
  if (!childSessionKey) return ''
  const parts = childSessionKey.split(':')
  const last = parts[parts.length - 1]
  return last.length >= 8 ? last.slice(0, 8) : last
}

/** 为子工具行生成中文可读标签（复用 getStatusLabel 逻辑） */
function getChildToolLabel(child: ChildToolItem): string {
  return getStatusLabel({
    name: child.name,
    input: child.input,
    status: child.status,
    type: 'tool',
  } as AgentWorkflowItem)
}

/** 格式化输入参数为人类可读摘要 */
function formatInputSummary(input: Record<string, unknown> | undefined, toolName: string): string {
  if (!input) return ''
  const lname = toolName.toLowerCase()

  if (lname.includes('todo')) {
    const action = input.action as string | undefined
    const lines: string[] = [`操作: ${action ?? '?'}`]
    if (input.subject) lines.push(`标题: ${String(input.subject)}`)
    if (input.taskId) lines.push(`任务 ID: ${String(input.taskId)}`)
    if (input.status) lines.push(`状态: ${String(input.status)}`)
    return lines.join('\n')
  }

  // 搜索类（优先匹配，避免 path 字段被文件路径分支拦截）
  if (lname.includes('grep') || (lname.includes('search') && !lname.includes('web'))) {
    const lines: string[] = []
    if (input.pattern || input.query) lines.push(`搜索: ${String(input.pattern || input.query)}`)
    if (input.path) lines.push(`路径: ${String(input.path)}`)
    if (input.glob) lines.push(`过滤: ${String(input.glob)}`)
    if (lines.length > 0) return lines.join('\n')
  }

  // Glob 模式
  if (lname.includes('glob')) {
    const lines: string[] = []
    if (input.pattern) lines.push(`模式: ${String(input.pattern)}`)
    if (input.path) lines.push(`路径: ${String(input.path)}`)
    if (lines.length > 0) return lines.join('\n')
  }

  // 文件路径类（Read, Write, Edit）
  const filePath = (input.file_path || input.path || input.notebook_path) as string | undefined
  if (filePath) {
    const lines: string[] = [`路径: ${filePath}`]
    if (input.pattern) lines.push(`模式: ${String(input.pattern)}`)
    if (input.old_string) lines.push(`查找: ${truncate(String(input.old_string), 60)}`)
    if (input.new_string) lines.push(`替换: ${truncate(String(input.new_string), 60)}`)
    if (input.offset) lines.push(`偏移: ${input.offset}`)
    if (input.limit) lines.push(`行数: ${input.limit}`)
    return lines.join('\n')
  }

  // Bash 命令
  if (lname.includes('bash') || lname.includes('exec')) {
    const cmd = (input.command || input.cmd) as string | undefined
    if (cmd) return `命令: ${cmd}`
  }

  // 回退到 JSON
  return formatParams(input)
}

// ─── 工具内联图片预览（image_generate / app_screenshot）──────────────────────────

/** app_screenshot text 块 JSON 的最小字段（供路径回退与尺寸展示） */
interface AppScreenshotPayload {
  ok?: boolean
  snapshotId?: string
  width?: number
  height?: number
}

/**
 * 从 app_screenshot 工具 output 的 text 块解析 payload。
 * previewPath 缺失时用于构造 temp/screenshots/{snapshotId}.jpg（相对工作空间，主进程应尽量返回绝对 previewPath）。
 */
function parseAppScreenshotPayload(output: Record<string, unknown>): AppScreenshotPayload | null {
  const content = output.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (!block || typeof block !== 'object' || (block as { type?: string }).type !== 'text') continue
    const text = (block as { text?: string }).text
    if (typeof text !== 'string') continue
    try {
      const parsed = JSON.parse(text) as AppScreenshotPayload
      if (parsed && typeof parsed === 'object' && parsed.ok) return parsed
    } catch {
      // 非 JSON 文本块，跳过
    }
  }
  return null
}

/**
 * 从工具 output 提取可预览图片路径与元数据。
 * image_generate 使用 details.filePath；app_screenshot 优先 details.previewPath。
 */
function extractToolImagePreviewDetails(output: unknown): {
  filePath: string
  width: number
  height: number
  model: string
  revisedPrompt: string
} | null {
  if (!output || typeof output !== 'object') return null
  const o = output as Record<string, unknown>
  const details = (o.details && typeof o.details === 'object') ? o.details as Record<string, unknown> : null

  let filePath: string | null = null
  if (details) {
    if (typeof details.previewPath === 'string' && details.previewPath) {
      filePath = details.previewPath
    } else if (typeof details.filePath === 'string' && details.filePath) {
      filePath = details.filePath
    }
  }

  const screenshotPayload = parseAppScreenshotPayload(o)
  // 无绝对 previewPath 时不猜测工作空间路径（用户可自定义工作空间目录）
  if (!filePath) return null

  return {
    filePath,
    width: (details?.width as number) ?? screenshotPayload?.width ?? 0,
    height: (details?.height as number) ?? screenshotPayload?.height ?? 0,
    model: (details?.model as string) ?? '',
    revisedPrompt: (details?.revisedPrompt as string) ?? '',
  }
}

/**
 * 从 jsonToolResult 的 content text 块解析 JSON 对象。
 */
function parseJsonPayloadFromToolOutput(output: unknown): Record<string, unknown> | null {
  if (!output || typeof output !== 'object') return null
  const o = output as Record<string, unknown>
  if (typeof o.ok === 'boolean') return o
  const content = o.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (!block || typeof block !== 'object' || (block as { type?: string }).type !== 'text') continue
    const text = (block as { text?: string }).text
    if (typeof text !== 'string') continue
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // 非 JSON，跳过
    }
  }
  return null
}

/**
 * 从 screen_record_stop / screen_record_narrate 结果提取可预览成片路径。
 */
function extractScreenRecordOutputPaths(
  toolName: string,
  output: unknown,
): Array<{ filePath: string; fileName: string; label: string }> {
  const lname = (toolName || '').toLowerCase()
  if (lname !== 'screen_record_stop' && lname !== 'screen_record_narrate') return []
  const payload = parseJsonPayloadFromToolOutput(output)
  if (!payload || payload.ok === false) return []
  const chips: Array<{ filePath: string; fileName: string; label: string }> = []
  const pushPath = (raw: unknown, label: string) => {
    if (typeof raw !== 'string' || !raw.trim()) return
    const filePath = raw.trim()
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath
    chips.push({ filePath, fileName, label })
  }
  pushPath(payload.path, 'WebM')
  pushPath(payload.mp4Path, 'MP4')
  pushPath(payload.outputPath, '成片')
  return chips
}

const ImageGeneratePreview: React.FC<{ output: unknown; fullSize?: boolean }> = ({ output, fullSize = false }) => {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [zoomed, setZoomed] = useState(false)

  const imgDetails = useMemo(() => extractToolImagePreviewDetails(output), [output])

  useEffect(() => {
    if (!imgDetails?.filePath) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    window.electronAPI.agentRuntime.sendCommand({
      type: 'files:read-preview-by-path',
      filePath: imgDetails.filePath,
      userId: 'local-user',
    } as Parameters<typeof window.electronAPI.agentRuntime.sendCommand>[0])
      .then((res) => {
        if (cancelled) return
        const r = res as { content?: string; mimeType?: string; encoding?: string } | null
        if (r?.content && r.encoding === 'base64') {
          setDataUrl(`data:${r.mimeType ?? 'image/png'};base64,${r.content}`)
        }
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [imgDetails?.filePath])

  if (!imgDetails) return null

  const fileName = imgDetails.filePath.replace(/\\/g, '/').split('/').pop() ?? imgDetails.filePath

  return (
    <div className={styles.imagePreviewWrap}>
      {loading && <div className={styles.imageLoading}>图片加载中…</div>}
      {!loading && dataUrl && (
        <>
          <img
            src={dataUrl}
            alt={fileName}
            className={fullSize ? styles.imageFull : styles.imageThumb}
            title="点击放大查看"
            style={{ cursor: 'zoom-in' }}
            onClick={(e) => { e.stopPropagation(); setZoomed(true) }}
          />
          {fullSize && imgDetails.width > 0 && (
            <div className={styles.imageMeta}>
              {imgDetails.model
                ? `${imgDetails.width}×${imgDetails.height} · ${imgDetails.model} · ${fileName}`
                : `${imgDetails.width}×${imgDetails.height} · ${fileName}`}
            </div>
          )}
          {zoomed && (
            <ImageLightbox src={dataUrl} alt={fileName} onClose={() => setZoomed(false)} />
          )}
        </>
      )}
    </div>
  )
}

// ─── 智能输出组件 ─────────────────────────────────────

const OUTPUT_PREVIEW_CHARS = 300
const OUTPUT_PREVIEW_LINES = 12

/**
 * 从工具结果中提取文本（pi-agent 为 content[]，也可能为 JSON 字符串）
 */
function extractTextFromToolResult(output: unknown): string | null {
  if (output == null) return null
  if (typeof output === 'string') return output
  if (typeof output === 'object') {
    const o = output as Record<string, unknown>
    if (Array.isArray(o.content)) {
      return o.content
        .map((c) => {
          if (c && typeof c === 'object' && 'text' in (c as object)) {
            return String((c as { text?: string }).text ?? '')
          }
          return ''
        })
        .join('')
    }
    if (typeof o.text === 'string') return o.text
  }
  return null
}

/**
 * 解析 todo_write 返回的 JSON（TaskRepo 结果）
 */
function parseTodoWriteJson(output: unknown): Record<string, unknown> | null {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const o = output as Record<string, unknown>
    if (
      o.status !== undefined
      && (Array.isArray(o.tasks) || (o.task && typeof o.task === 'object') || o.message !== undefined)
    ) {
      return o
    }
  }
  const text = extractTextFromToolResult(output)
  if (!text?.trim()) return null
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 将内部状态值映射为用户可读标签 */
const STATUS_LABEL: Record<string, string> = {
  pending: '待分配',
  todo: 'TODO',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
  blocked: '阻塞',
  cancelled: '已取消',
}

/** 状态徽章组件 */
const TaskStatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const badgeClass = styles[`todoStatusBadge--${status}`] ?? styles['todoStatusBadge--pending']
  const label = STATUS_LABEL[status] ?? status
  return (
    <span className={clsx(styles.todoStatusBadge, badgeClass)}>
      {label}
    </span>
  )
}

/** 渲染任务行 */
const TaskRow: React.FC<{ task: Record<string, unknown> }> = ({ task }) => (
  <li key={String(task.id ?? task.subject)} className={styles.todoListItem}>
    <span className={styles.todoId}>#{String(task.id ?? '')}</span>
    <span className={styles.todoSubject}>{String(task.subject ?? '')}</span>
    {task.status != null && <TaskStatusBadge status={String(task.status)} />}
  </li>
)

/**
 * todo_write 专用：在卡片主行下方展示任务列表/单条任务，无需展开即可阅读
 */
const TodoWriteInlinePreview: React.FC<{ output: unknown }> = ({ output }) => {
  const payload = parseTodoWriteJson(output)
  if (!payload) {
    return <div className={styles.todoMeta}>（无结构化结果，请展开查看原始输出）</div>
  }
  if (payload.status === 'error' && payload.message) {
    return <div className={styles.todoPreviewError}>{String(payload.message)}</div>
  }
  const tasks = payload.tasks as Array<Record<string, unknown>> | undefined
  if (tasks && Array.isArray(tasks)) {
    if (tasks.length === 0) {
      return <div className={styles.todoMeta}>暂无任务</div>
    }
    return (
      <ul className={styles.todoList}>
        {tasks.map((t) => (
          <TaskRow key={String(t.id ?? t.subject)} task={t} />
        ))}
      </ul>
    )
  }
  const task = payload.task as Record<string, unknown> | undefined
  if (task && typeof task === 'object' && (task.id !== undefined || task.subject !== undefined)) {
    return (
      <div className={styles.todoSingle}>
        <span>
          <span className={styles.todoId}>#{String(task.id ?? '')}</span>
          <span className={styles.todoSubject}>{String(task.subject ?? '')}</span>
          {task.status != null && <TaskStatusBadge status={String(task.status)} />}
        </span>
        {task.description != null && (
          <span className={styles.todoMeta}>{truncate(String(task.description), 72)}</span>
        )}
      </div>
    )
  }
  if (payload.status === 'partial' && tasks !== undefined) {
    // batch_update 部分成功
    return (
      <div className={styles.todoMeta}>
        批量更新：{(tasks as Array<unknown>).length} 成功
        {payload.errors ? `，${(payload.errors as Array<unknown>).length} 失败` : ''}
      </div>
    )
  }
  if (payload.status === 'not_found') {
    return <div className={styles.todoMeta}>未找到任务</div>
  }
  if ((payload.status === 'ok' || payload.status === 'partial') && typeof payload.total === 'number') {
    return <div className={styles.todoMeta}>共 {payload.total} 条</div>
  }
  return null
}

const SmartOutput: React.FC<{ output: unknown }> = ({ output }) => {
  const [expanded, setExpanded] = useState(false)
  const text = typeof output === 'string' ? output : formatParams(output)

  const { isLong, preview } = useMemo(() => {
    const lines = text.split('\n')
    const long = text.length > OUTPUT_PREVIEW_CHARS || lines.length > OUTPUT_PREVIEW_LINES
    return {
      isLong: long,
      preview: long ? lines.slice(0, OUTPUT_PREVIEW_LINES).join('\n').slice(0, OUTPUT_PREVIEW_CHARS) + '…' : text,
    }
  }, [text])

  return (
    <>
      <pre className={styles.code}>{expanded ? text : preview}</pre>
      {isLong && (
        <span className={styles.outputToggle} onClick={() => setExpanded((p) => !p)}>
          {expanded ? '收起' : `展开全部 (${text.length} 字符)`}
        </span>
      )}
    </>
  )
}

// ─── 子 Agent 内部工具调用行 ─────────────────────────────

const ChildToolRow: React.FC<{ child: ChildToolItem }> = ({ child }) => {
  const [isExpanded, setIsExpanded] = useState(false)
  const liveNow = useLiveNow(child.status === 'running')
  const previewCtx = useToolFilePreview()
  const statusIcon = child.status === 'running' ? '◌' : child.status === 'failed' ? '✕' : '✓'
  const statusClass = child.status === 'running'
    ? styles['childTool--running']
    : child.status === 'failed'
      ? styles['childTool--failed']
      : styles['childTool--completed']
  const isChildTodoWrite = (child.name || '').toLowerCase() === 'todo_write'
  const showChildTodoPreview =
    isChildTodoWrite && child.status === 'completed'

  const fileInfo = useMemo(
    () => extractToolFileInfo(child.name, child.input),
    [child.name, child.input],
  )
  const lineRangeText = fileInfo ? formatLineRange(fileInfo.startLine, fileInfo.endLine) : ''
  const canPreviewFile = !!(fileInfo && previewCtx && child.status !== 'running')

  const handlePreviewFile = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!fileInfo || !previewCtx) return
      previewCtx.onPreview({
        filePath: fileInfo.filePath,
        fileName: fileInfo.fileName,
        startLine: fileInfo.startLine,
        endLine: fileInfo.endLine,
      })
    },
    [fileInfo, previewCtx],
  )

  return (
    <div className={clsx(styles.childToolRow, statusClass)}>
      <div className={styles.childToolHeader} onClick={() => setIsExpanded((p) => !p)}>
        <span className={styles.childToolIcon}>{statusIcon}</span>
        <span className={styles.toolNameBadge}>{getToolDisplayName(child.name)}</span>
        <span className={styles.childToolName}>{getChildToolLabel(child)}</span>
        {fileInfo && (
          <span
            className={clsx(styles.fileChip, canPreviewFile && styles.fileChipClickable)}
            title={canPreviewFile ? `点击预览 ${fileInfo.filePath}` : fileInfo.filePath}
            onClick={canPreviewFile ? handlePreviewFile : undefined}
          >
            <span className={styles.fileChipName}>{fileInfo.fileName}</span>
            {lineRangeText && (
              <span className={styles.fileChipRange}>{lineRangeText}</span>
            )}
          </span>
        )}
        {(child.endTime || child.status === 'running') && (
          <span className={styles.childToolDuration}>
            {formatDuration(child.startTime, child.endTime)}
          </span>
        )}
        <span className={styles.childToolToggle}>{isExpanded ? '∧' : '∨'}</span>
      </div>
      {showChildTodoPreview && (
        <div className={styles.todoPreviewWrap} onClick={(e) => e.stopPropagation()}>
          <TodoWriteInlinePreview output={child.output} />
        </div>
      )}
      {isExpanded && (
        <div className={styles.childToolDetails}>
          {child.input && Object.keys(child.input).length > 0 && (
            <DetailBlock label="输入" copyText={formatParams(child.input)}>
              <pre className={styles.code}>{formatInputSummary(child.input, child.name)}</pre>
            </DetailBlock>
          )}
          {child.output !== undefined && (
            <DetailBlock label="输出" copyText={formatParams(child.output)}>
              <SmartOutput output={child.output} />
            </DetailBlock>
          )}
          {child.error && (
            <div className={styles.detailBlock}>
              <span className={styles.errorText}>{child.error}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── 子 Agent 专属卡片 ───────────────────────────────────

const SubagentCard: React.FC<{ item: AgentWorkflowItem }> = ({ item }) => {
  const [isExpanded, setIsExpanded] = useState(false)
  const liveNow = useLiveNow(item.status === 'running')

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev)
  }, [])

  const task = (item.input?.task as string) || item.description || '子任务'
  const isRunning = item.status === 'running'
  const isFailed = item.status === 'failed'
  const isCompleted = item.status === 'completed'
  const shortKey = extractShortKey(item.childSessionKey)
  // 优先用 agentLabel（子 Agent 名称/标识），其次 agentId，最后用 shortKey
  const agentLabel = item.agentLabel || item.agentId || shortKey
  const duration = formatDuration(item.startTime, item.endTime, item.status !== 'running' ? item.durationMs : undefined)
  const outputObj = item.output as Record<string, unknown> | undefined
  const summary = outputObj?.summary as string | undefined
  // 提取完整输出文本：优先 result/text/content，其次整个 output
  const fullOutput = (outputObj?.result ?? outputObj?.text ?? outputObj?.content) as string | undefined
  const errorMsg = item.error

  const badgeClass = isRunning
    ? styles['subagentBadge--running']
    : isFailed
      ? styles['subagentBadge--failed']
      : styles['subagentBadge--completed']

  const badgeText = isRunning ? '运行中' : isFailed ? '失败' : '完成'

  return (
    <div className={clsx(styles.subagentRow, isRunning && styles.running, isFailed && styles.failed)}>
      {/* 头部行 */}
      <div className={styles.subagentHeader} onClick={handleToggle}>
        <span className={styles.subagentIcon}>
          {isFailed ? '✕' : isRunning ? '◌' : '◎'}
        </span>

        <div className={styles.subagentMain}>
          {/* 第一行：agent 名称 + 耗时 + 状态徽标 */}
          <div className={styles.subagentNameRow}>
            <span className={styles.subagentName}>
              {agentLabel ? `agent:${agentLabel}` : '子 Agent'}
            </span>
            {(isCompleted || isFailed || isRunning) && (
              <span className={styles.subagentDuration}>{duration}</span>
            )}
            <span className={clsx(styles.subagentBadge, badgeClass)}>{badgeText}</span>
          </div>
          {/* 第二行：任务描述 */}
          <span className={styles.subagentTask}>{truncate(task, 70)}</span>
          {/* 运行中：状态提示 */}
          {isRunning && !errorMsg && (
            <span className={styles.subagentRunningHint}>
              {item.childItems && item.childItems.length > 0
                ? `正在执行… (${item.childItems.length} 个工具调用)`
                : '子 Agent 正在执行中…'}
            </span>
          )}
          {/* 折叠状态：显示工具调用数量 */}
          {!isRunning && item.childItems && item.childItems.length > 0 && !isExpanded && (
            <span className={styles.subagentChildCount}>
              {item.childItems.length} 个工具调用
            </span>
          )}
          {/* 失败：内联错误 */}
          {isFailed && errorMsg && (
            <span className={styles.subagentInlineError}>{truncate(errorMsg, 80)}</span>
          )}
          {/* 完成：内联摘要 */}
          {isCompleted && summary && (
            <span className={styles.subagentInlineSummary}>{truncate(summary, 80)}</span>
          )}
        </div>

        <div className={styles.subagentRight}>
          <span className={styles.subagentToggle}>{isExpanded ? '∧' : '∨'}</span>
        </div>
      </div>

      {/* 展开详情 */}
      {isExpanded && (
        <div className={styles.subagentDetails}>
          {/* 会话信息 */}
          <div className={styles.subagentSessionInfo}>
            {item.childSessionKey && (
              <div className={styles.subagentSessionRow}>
                <span className={styles.subagentSessionLabel}>会话</span>
                <span className={styles.subagentSessionValue}>{item.childSessionKey}</span>
                <CopyButton text={item.childSessionKey} />
              </div>
            )}
            {item.agentId && (
              <div className={styles.subagentSessionRow}>
                <span className={styles.subagentSessionLabel}>Agent</span>
                <span className={styles.subagentSessionValue}>{item.agentId}</span>
              </div>
            )}
            {(isCompleted || isFailed) && (
              <div className={styles.subagentSessionRow}>
                <span className={styles.subagentSessionLabel}>耗时</span>
                <span className={styles.subagentSessionValue}>{duration}</span>
              </div>
            )}
          </div>

          {/* 执行摘要（折叠区顶部突出显示） */}
          {summary && (
            <DetailBlock label="执行摘要" copyText={summary}>
              <pre className={styles.code}>{summary}</pre>
            </DetailBlock>
          )}

          {/* 完整任务输出 */}
          {fullOutput && fullOutput !== summary && (
            <DetailBlock label="任务输出" copyText={fullOutput}>
              <SmartOutput output={fullOutput} />
            </DetailBlock>
          )}

          {/* 如果 output 是非标准结构（没有 result/text/content/summary），显示原始 output */}
          {outputObj && !summary && !fullOutput && (
            <DetailBlock label="任务输出" copyText={formatParams(outputObj)}>
              <SmartOutput output={outputObj} />
            </DetailBlock>
          )}

          {/* 子 Agent 工具调用列表 */}
          {item.childItems && item.childItems.length > 0 && (
            <DetailBlock label={`工具调用 (${item.childItems.length})`}>
              <div className={styles.childItemsList}>
                {item.childItems.map((child) => (
                  <ChildToolRow key={child.toolCallId} child={child} />
                ))}
              </div>
            </DetailBlock>
          )}

          {/* 任务描述 */}
          <DetailBlock label="任务描述" copyText={task}>
            <pre className={styles.code}>{task}</pre>
          </DetailBlock>

          {/* 错误信息 */}
          {errorMsg && (
            <DetailBlock label="错误" copyText={errorMsg}>
              <span className={styles.errorText}>{errorMsg}</span>
            </DetailBlock>
          )}

          {!summary && !fullOutput && !outputObj && !errorMsg && isRunning && (
            <div className={styles.detailBlock}>
              <span className={styles.detailLabel}>状态</span>
              <span className={styles.code}>子 Agent 正在执行中...</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── 普通工具调用卡片 ─────────────────────────────────────

const ToolCallCard: React.FC<ToolCallCardProps> = ({ item }) => {
  // 子 Agent 使用专属组件渲染
  if (item.type === 'subagent') {
    return <SubagentCard item={item} />
  }

  const [isExpanded, setIsExpanded] = useState(false)
  const liveNow = useLiveNow(item.status === 'running')
  const previewCtx = useToolFilePreview()

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev)
  }, [])

  const icon = getToolIcon(item.name, item.type, item.status)
  const label = truncate(getStatusLabel(item))
  const isRunning = item.status === 'running'
  const isFailed = item.status === 'failed'
  const isTodoWrite = (item.name || '').toLowerCase() === 'todo_write'
  const showTodoPreview =
    isTodoWrite && !isRunning && (item.status === 'completed' || item.status === 'failed')
  const toolNameLower = (item.name || '').toLowerCase()
  const isImagePreviewTool = toolNameLower === 'image_generate' || toolNameLower === 'app_screenshot'
  const showImagePreview =
    isImagePreviewTool && item.status === 'completed' && !!extractToolImagePreviewDetails(item.output)

  // 提取文件读写元数据：存在时在头部显示"可点击文件名 + 行号范围"
  const fileInfo = useMemo(
    () => extractToolFileInfo(item.name, item.input),
    [item.name, item.input],
  )
  const lineRangeText = fileInfo ? formatLineRange(fileInfo.startLine, fileInfo.endLine) : ''
  const canPreviewFile = !!(fileInfo && previewCtx && !isRunning)

  /** 录屏成片 chip（stop / narrate 结果 path） */
  const recordingChips = useMemo(
    () =>
      item.status === 'completed' ? extractScreenRecordOutputPaths(item.name, item.output) : [],
    [item.name, item.output, item.status],
  )

  const handlePreviewFile = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!fileInfo || !previewCtx) return
      previewCtx.onPreview({
        filePath: fileInfo.filePath,
        fileName: fileInfo.fileName,
        startLine: fileInfo.startLine,
        endLine: fileInfo.endLine,
      })
    },
    [fileInfo, previewCtx],
  )

  /**
   * 打开录屏成片预览（FilePreviewModal）。
   */
  const handlePreviewRecording = useCallback(
    (e: React.MouseEvent, filePath: string, fileName: string) => {
      e.stopPropagation()
      if (!previewCtx) return
      previewCtx.onPreview({ filePath, fileName })
    },
    [previewCtx],
  )

  return (
    <div className={clsx(styles.row, isRunning && styles.running, isFailed && styles.failed, isExpanded && styles.expanded)}>
      {/* 单行头部 */}
      <div className={styles.rowHeader} onClick={handleToggle}>
        <span className={clsx(styles.icon, isRunning && styles.spinIcon)}>
          {isRunning ? '◌' : icon}
        </span>
        {item.agentLabel && (
          <span className={styles.agentLabelBadge}>{item.agentLabel}</span>
        )}
        <span className={styles.toolNameBadge}>{getToolDisplayName(item.name)}</span>
        <span className={styles.label}>{label}</span>
        {fileInfo && (
          <span
            className={clsx(styles.fileChip, canPreviewFile && styles.fileChipClickable)}
            title={canPreviewFile ? `点击预览 ${fileInfo.filePath}` : fileInfo.filePath}
            onClick={canPreviewFile ? handlePreviewFile : undefined}
          >
            <span className={styles.fileChipName}>{fileInfo.fileName}</span>
            {lineRangeText && (
              <span className={styles.fileChipRange}>{lineRangeText}</span>
            )}
          </span>
        )}
        {recordingChips.map((chip) => (
          <span
            key={`${chip.label}:${chip.filePath}`}
            className={clsx(styles.fileChip, previewCtx && styles.fileChipClickable)}
            title={previewCtx ? `点击预览 ${chip.filePath}` : chip.filePath}
            onClick={
              previewCtx
                ? (e) => handlePreviewRecording(e, chip.filePath, chip.fileName)
                : undefined
            }
          >
            <span className={styles.fileChipName}>{chip.fileName}</span>
            <span className={styles.fileChipRange}>{chip.label}</span>
          </span>
        ))}
        {(item.status === 'completed' || item.status === 'failed' || item.status === 'running') && (
          <span className={styles.duration}>
            {formatDuration(item.startTime, item.endTime ?? liveNow, item.status !== 'running' ? item.durationMs : undefined)}
          </span>
        )}
        <span className={styles.toggle}>{isExpanded ? '∧' : '∨'}</span>
      </div>

      {showTodoPreview && (
        <div className={styles.todoPreviewWrap} onClick={(e) => e.stopPropagation()}>
          <TodoWriteInlinePreview output={item.output} />
        </div>
      )}

      {showImagePreview && !isExpanded && (
        <div onClick={(e) => e.stopPropagation()}>
          <ImageGeneratePreview output={item.output} fullSize={false} />
        </div>
      )}

      {/* 可展开的详情区 */}
      {isExpanded && (
        <div className={styles.details}>
          {showImagePreview && (
            <ImageGeneratePreview output={item.output} fullSize={true} />
          )}
          {item.input && Object.keys(item.input).length > 0 && (
            <DetailBlock label="输入" copyText={formatParams(item.input)}>
              <pre className={styles.code}>{formatInputSummary(item.input, item.name)}</pre>
            </DetailBlock>
          )}
          {!showImagePreview && item.output !== undefined && (
            <DetailBlock label="输出" copyText={formatParams(item.output)}>
              <SmartOutput output={item.output} />
            </DetailBlock>
          )}
          {item.error && (
            <DetailBlock label="错误" copyText={item.error}>
              <span className={styles.errorText}>{item.error}</span>
            </DetailBlock>
          )}
        </div>
      )}
    </div>
  )
}

interface ToolCardListProps {
  items: AgentWorkflowItem[]
}

export const ToolCardList: React.FC<ToolCardListProps> = ({ items }) => {
  if (items.length === 0) return null
  return (
    <div className={styles.list}>
      {items.map((item) => (
        <ToolCallCard key={item.id} item={item} />
      ))}
    </div>
  )
}

export default ToolCallCard
export { ToolCallCard }
