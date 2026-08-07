/**
 * FilePreviewModal — 文件内容预览
 *
 * - variant=modal（默认）：居中弹窗；全屏时覆盖对话区（data-chat-dialog）
 * - variant=window：独立 BrowserWindow 内铺满，可拖出主窗口外
 * - variant=embedded：填满父容器（保留兼容）
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import MDEditor from '@uiw/react-md-editor'
import {
  X,
  Maximize2,
  Minimize2,
  Copy,
  Pencil,
  AppWindow,
  File,
} from 'lucide-react'
import { useDataThemeColorMode } from '../../hooks/common/useDataThemeColorMode'
import { PdfJsPreview } from './PdfJsPreview'
import { ExcelPreview } from './ExcelPreview'
import { PptxPreview } from './PptxPreview'
import styles from './FilePreviewModal.module.css'

/**
 * HTML 文件预览（可能含内联 <script>，如 AI 生成的小游戏）：
 * 用 Electron <webview> 在独立渲染进程中运行，拥有进程级沙箱隔离，
 * 不继承父页面 CSP，内联脚本可正常执行，同时与主进程完全隔离。
 * 内容通过 blob URL 传入，避免写临时文件。
 */
const HtmlActiveSandboxFrame: React.FC<{ content: string; fileName: string }> = ({ content, fileName }) => {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)

  useEffect(() => {
    const blob = new Blob([content], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    setBlobUrl(url)
    return () => { URL.revokeObjectURL(url) }
  }, [content])

  if (!blobUrl) return null
  return (
    // @ts-ignore — webview 是 Electron 专有标签，React 类型定义中不包含
    <webview
      src={blobUrl}
      title={fileName}
      className={styles.sandboxFrame}
    />
  )
}

/**
 * CSS / SVG 静态内容预览：无脚本需求，直接用 srcDoc 渲染，不授予任何脚本权限。
 */
const HtmlStaticSandboxFrame: React.FC<{ content: string; fileName: string }> = ({ content, fileName }) => (
  <iframe
    className={styles.sandboxFrame}
    sandbox=""
    srcDoc={content}
    title={fileName}
  />
)

// ── 预览路由（单一分支） ──
type PreviewRoute =
  | 'html-active'   // text/html：blob URL + allow-scripts（AI 生成的游戏/页面）
  | 'html-static'   // text/css, image/svg+xml：srcDoc 无脚本沙箱
  | 'image'
  | 'audio'
  | 'video'
  | 'code'
  | 'pdf'
  | 'docx'
  | 'xlsx'          // Excel（xlsx/xls）：SheetJS 转 HTML 表格
  | 'pptx'          // PowerPoint（pptx）：pptx-preview 渲染幻灯片
  | 'legacy-doc'
  | 'legacy-ppt'    // 旧版 .ppt：无纯 JS 渲染，提示用系统应用打开
  | 'unsupported'

const HTML_ACTIVE_MIMES = new Set([
  'text/html',
])

const HTML_STATIC_MIMES = new Set([
  'text/css',
  'image/svg+xml',
])

/**
 * 判断 content 是否为 PDF 的 base64：先快速匹配常见前缀，再 atob 校验文件头 %PDF
 */
function isPdfBase64Payload(content: string | null): boolean {
  if (content === null || content.length < 8) return false
  const t = content.replace(/\s/g, '')
  if (!/^[A-Za-z0-9+/=]+$/.test(t)) return false
  if (t.startsWith('JVBERi')) return true
  try {
    let head = t.slice(0, 120)
    const pad = head.length % 4
    if (pad !== 0) head += '='.repeat(4 - pad)
    const bin = atob(head)
    return bin.startsWith('%PDF')
  } catch {
    return false
  }
}

/**
 * 依据 MIME、文件名与编码选择预览路由
 */
function getPreviewRoute(
  mimeType: string | null,
  fileName: string,
  encoding: 'utf-8' | 'base64' | undefined,
  content: string | null,
): PreviewRoute {
  const nameLower = fileName.toLowerCase()
  const pdfByMimeOrName = mimeType === 'application/pdf' || nameLower.endsWith('.pdf')
  /** 主进程未传 encoding 时，仍可根据 PDF 的 base64 特征走 iframe 预览 */
  if (pdfByMimeOrName && (encoding === 'base64' || isPdfBase64Payload(content))) {
    return 'pdf'
  }

  const enc = encoding ?? 'utf-8'
  if (enc === 'base64') {
    const isDocx =
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      nameLower.endsWith('.docx')
    if (isDocx) return 'docx'
    const isLegacyDoc =
      mimeType === 'application/msword' ||
      (nameLower.endsWith('.doc') && !nameLower.endsWith('.docx'))
    if (isLegacyDoc) return 'legacy-doc'
    const isXlsx =
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel' ||
      nameLower.endsWith('.xlsx') ||
      nameLower.endsWith('.xls')
    if (isXlsx) return 'xlsx'
    const isPptx =
      mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      nameLower.endsWith('.pptx')
    if (isPptx) return 'pptx'
    const isLegacyPpt =
      mimeType === 'application/vnd.ms-powerpoint' ||
      (nameLower.endsWith('.ppt') && !nameLower.endsWith('.pptx'))
    if (isLegacyPpt) return 'legacy-ppt'
    if (mimeType?.startsWith('image/')) return 'image'
    if (mimeType?.startsWith('audio/')) return 'audio'
    if (mimeType?.startsWith('video/')) return 'video'
    return 'unsupported'
  }
  if (!mimeType) {
    if (nameLower.endsWith('.txt') || nameLower.endsWith('.md') || nameLower.endsWith('.json')) {
      return 'code'
    }
    return 'unsupported'
  }
  if (HTML_ACTIVE_MIMES.has(mimeType)) return 'html-active'
  if (HTML_STATIC_MIMES.has(mimeType)) return 'html-static'
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/x-javascript' ||
    mimeType === 'application/typescript'
  ) {
    return 'code'
  }
  return 'unsupported'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface PreviewResult {
  truncated: boolean
  content: string | null
  size: number
  mimeType: string | null
  encoding?: 'utf-8' | 'base64'
  ranged?: boolean
  startLine?: number
  endLine?: number
}

/**
 * 构造图片 data URL（兼容 base64 与 utf-8 文本类 SVG）
 */
function buildImageDataUrl(result: PreviewResult): string {
  const mime = result.mimeType ?? 'application/octet-stream'
  const raw = result.content ?? ''
  if (result.encoding === 'base64') {
    return `data:${mime};base64,${raw}`
  }
  if (mime === 'image/svg+xml') {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`
  }
  try {
    return `data:${mime};base64,${btoa(unescape(encodeURIComponent(raw)))}`
  } catch {
    return ''
  }
}

/**
 * 音频/视频：base64 → Blob URL，供 <audio>/<video> src 使用
 * 调用方负责在组件卸载时 revokeObjectURL
 */
function buildMediaBlobUrl(result: PreviewResult): string {
  if (!result.content || result.encoding !== 'base64') return ''
  try {
    const mime = result.mimeType ?? 'application/octet-stream'
    const bytes = Uint8Array.from(atob(result.content.replace(/\s/g, '')), (c) => c.charCodeAt(0))
    const blob = new Blob([bytes], { type: mime })
    return URL.createObjectURL(blob)
  } catch {
    return ''
  }
}

/**
 * 解析 md 中图片 src 相对当前 md 文件目录的路径。
 * 渲染进程无 node:path，用字符串处理，归一化 ./ 与 ../。
 */
function resolveRelativeImagePath(mdFilePath: string, src: string): string {
  const normSrc = src.replace(/\\/g, '/')
  const dir = mdFilePath.replace(/\\/g, '/').replace(/\/[^/]*$/, '')
  const segments = `${dir}/${normSrc}`.split('/')
  const stack: string[] = []
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { stack.pop(); continue }
    stack.push(seg)
  }
  // 还原盘符开头的绝对路径（如 D:）不带前导斜杠；其余保持
  return stack.join('/')
}

/**
 * md 正文中的本地/相对图片：经 files:read-preview-by-path IPC 读取（workspace 边界安全），
 * 转为 base64 data URL 注入 <img>。http(s)/data 直接原样渲染。
 *
 * 缓存键含 version：预览重新打开或保存后 version 变化即旁路旧缓存，
 * 避免"改了图片但预览仍显示旧图"（读取缓存导致不更新）。
 */
const markdownImageCache = new Map<string, string>()

const MarkdownImage: React.FC<{
  src?: string
  alt?: string
  mdFilePath?: string
  version?: number
}> = ({ src, alt, mdFilePath, version = 0 }) => {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const isExternal = !!src && (/^(https?:)?\/\//i.test(src) || src.startsWith('data:'))

  useEffect(() => {
    setDataUrl(null)
    setFailed(false)
    if (!src || isExternal) return
    // 本地相对图片必须有解析基准路径，否则无从读取——明确置为失败而非永久转圈
    if (!mdFilePath) { setFailed(true); return }
    let cancelled = false
    const resolved = resolveRelativeImagePath(mdFilePath, src)
    const cacheKey = `${resolved}@${version}`
    const cached = markdownImageCache.get(cacheKey)
    if (cached) { setDataUrl(cached); return }
    // 超时兜底：IPC 异常未返回时不至于无限"加载中"
    const timer = setTimeout(() => { if (!cancelled) setFailed(true) }, 15000)
    window.electronAPI.agentRuntime
      .sendCommand({ type: 'files:read-preview-by-path', filePath: resolved, userId: 'local-user' })
      .then((res) => {
        const r = res as PreviewResult
        if (cancelled) return
        if (r?.encoding === 'base64' && r.content) {
          const url = `data:${r.mimeType ?? 'image/png'};base64,${r.content}`
          markdownImageCache.set(cacheKey, url)
          setDataUrl(url)
        } else {
          setFailed(true)
        }
      })
      .catch(() => { if (!cancelled) setFailed(true) })
      .finally(() => clearTimeout(timer))
    return () => { cancelled = true; clearTimeout(timer) }
  }, [src, isExternal, mdFilePath, version])

  if (isExternal) return <img src={src} alt={alt ?? ''} />
  if (failed) return <span style={{ color: 'var(--color-text-tertiary)' }}>[图片无法加载: {alt || src}]</span>
  if (!dataUrl) return <span style={{ color: 'var(--color-text-tertiary)' }}>[加载图片中...]</span>
  return <img src={dataUrl} alt={alt ?? ''} />
}

/**
 * 两种打开方式二选一：
 * - fileId：通过已注册到 FileRepo 的文件 ID 读取
 * - filePath：直接按 Agent workspace 内的文件路径读取（工具卡片点击文件名场景）
 */
export interface FilePreviewModalProps {
  fileId?: string
  filePath?: string
  fileName: string
  userId?: string
  /** 可选：按行号片段预览（仅 filePath 模式生效） */
  startLine?: number
  endLine?: number
  /**
   * 可选：Markdown 正文中相对图片的解析基准路径。
   * fileId 模式下无 filePath，需由调用方提供（如会话文件的 localPath），
   * 否则 MarkdownImage 无法解析相对图片导致一直转圈。
   */
  mdBasePath?: string
  /**
   * 可选：Markdown 编辑写回的绝对路径。
   * fileId 模式（会话文件）下无 filePath，需由调用方提供可写绝对路径以启用编辑。
   * filePath 模式下默认用 filePath，无需额外提供。
   */
  editablePath?: string
  onClose: () => void
  /**
   * 呈现形态：modal=应用内弹窗；window=独立窗；embedded=填满父级
   * 兼容旧 prop：embedded=true 等价于 variant='embedded'
   */
  variant?: 'modal' | 'window' | 'embedded'
  /** @deprecated 使用 variant='embedded' */
  embedded?: boolean
}

/** 读取对话区边界，供全屏预览覆盖整个对话框 */
function useChatDialogBounds(active: boolean): DOMRect | null {
  const [bounds, setBounds] = useState<DOMRect | null>(null)
  useEffect(() => {
    if (!active) {
      setBounds(null)
      return
    }
    const update = () => {
      const el = document.querySelector('[data-chat-dialog]')
      setBounds(el?.getBoundingClientRect() ?? null)
    }
    update()
    window.addEventListener('resize', update)
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(update)
        : null
    const el = document.querySelector('[data-chat-dialog]')
    if (el && ro) ro.observe(el)
    return () => {
      window.removeEventListener('resize', update)
      ro?.disconnect()
    }
  }, [active])
  return bounds
}

export const FilePreviewModal: React.FC<FilePreviewModalProps> = ({
  fileId,
  filePath,
  fileName,
  userId = 'local-user',
  startLine,
  endLine,
  mdBasePath,
  editablePath,
  onClose,
  variant: variantProp,
  embedded = false,
}) => {
  const variant = variantProp ?? (embedded ? 'embedded' : 'modal')
  const isWindow = variant === 'window'
  const isEmbedded = variant === 'embedded'

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PreviewResult | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  /** Markdown 非编辑态：预览 / 源码 */
  const [mdViewMode, setMdViewMode] = useState<'preview' | 'source'>('preview')
  /** 与系统/应用主题一致，驱动 MDEditor 代码块与表格明暗样式 */
  const mdColorMode = useDataThemeColorMode()
  const dialogBounds = useChatDialogBounds(isFullscreen && variant === 'modal')

  /** DOCX：mammoth 转 HTML */
  const [docxHtml, setDocxHtml] = useState<string | null>(null)
  const [docxLoading, setDocxLoading] = useState(false)
  const [docxError, setDocxError] = useState<string | null>(null)

  /**
   * Markdown 编辑模式：仅 filePath 且 route==='code' && mimeType==='text/markdown' 时可用。
   * 进入编辑模式后，MDEditor 切换为 live 预览，显示保存/取消按钮。
   */
  const [isEditingMarkdown, setIsEditingMarkdown] = useState(false)
  const [editingContent, setEditingContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** md 图片缓存失效版本：内容重载或保存后递增，强制 MarkdownImage 旁路旧缓存 */
  const [imageVersion, setImageVersion] = useState(0)

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((v) => !v)
  }, [])

  /** 弹出独立窗口，关闭当前应用内预览 */
  const handlePopOut = useCallback(async () => {
    try {
      await window.electronAPI.filePreview.open({
        fileName,
        fileId,
        filePath,
        userId,
        startLine,
        endLine,
        mdBasePath,
        editablePath,
      })
      onClose()
    } catch (err) {
      console.error('[FilePreviewModal] 弹出独立窗口失败:', err)
    }
  }, [fileName, fileId, filePath, userId, startLine, endLine, mdBasePath, editablePath, onClose])

  // Esc 退出全屏；编辑模式下 Esc 先退出编辑
  useEffect(() => {
    if (isWindow) return // 独立窗由系统关闭 / 顶栏关闭
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (isEditingMarkdown) {
        e.stopPropagation()
        setIsEditingMarkdown(false)
        setSaveError(null)
      } else if (isFullscreen) {
        e.stopPropagation()
        setIsFullscreen(false)
      } else {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isFullscreen, isEditingMarkdown, onClose, isWindow])

  /** 切换文件时重置 Markdown 视图为预览 */
  useEffect(() => {
    setMdViewMode('preview')
    setIsEditingMarkdown(false)
    setIsFullscreen(false)
  }, [fileId, filePath, fileName])

  const handleEnterEdit = useCallback(() => {
    setEditingContent(result?.content ?? '')
    setSaveError(null)
    setIsEditingMarkdown(true)
  }, [result])

  const handleCancelEdit = useCallback(() => {
    setIsEditingMarkdown(false)
    setSaveError(null)
  }, [])

  const handleSaveEdit = useCallback(async () => {
    const writePath = filePath ?? editablePath
    if (!writePath) return
    setIsSaving(true)
    setSaveError(null)
    try {
      await window.electronAPI.file.write(writePath, editingContent)
      // 回写到 result，使预览立即反映最新内容
      setResult((prev) => prev ? { ...prev, content: editingContent } : prev)
      // 图片路径可能已变更，递增版本号使图片缓存失效并重新拉取
      setImageVersion((v) => v + 1)
      setIsEditingMarkdown(false)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setIsSaving(false)
    }
  }, [filePath, editablePath, editingContent])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    const loadPromise = fileId
      ? window.electronAPI.agentRuntime.sendCommand({
          type: 'files:read-preview-content',
          fileId,
          userId,
        })
      : filePath
        ? window.electronAPI.agentRuntime.sendCommand({
            type: 'files:read-preview-by-path',
            filePath,
            userId,
            ...(typeof startLine === 'number' ? { startLine } : {}),
            ...(typeof endLine === 'number' ? { endLine } : {}),
          })
        : Promise.reject(new Error('FilePreviewModal 缺少 fileId 或 filePath'))

    loadPromise
      .then((res) => {
        if (!cancelled) {
          setResult(res as PreviewResult)
          setLoading(false)
          // 每次重新读取文件后旁路旧图缓存，确保改图后预览同步更新
          setImageVersion((v) => v + 1)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '读取文件失败')
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [fileId, filePath, userId, startLine, endLine])

  /** 复制反馈：'file' 复制文件成功、'err' 失败，2s 后自动清除 */
  const [copyHint, setCopyHint] = useState<'file' | 'err' | null>(null)
  useEffect(() => {
    if (!copyHint) return
    const t = setTimeout(() => setCopyHint(null), 2000)
    return () => clearTimeout(t)
  }, [copyHint])

  const handleOpen = useCallback(async () => {
    try {
      if (fileId) {
        await window.electronAPI.agentRuntime.sendCommand({
          type: 'files:open',
          fileId,
          userId,
        })
      }
      // filePath 模式下暂不支持用系统应用打开（需额外 IPC），留待后续扩展
    } catch {
      // 忽略
    }
  }, [fileId, userId])

  const route = useMemo(
    () =>
      result
        ? getPreviewRoute(result.mimeType, fileName, result.encoding, result.content)
        : null,
    [result, fileName],
  )

  /** 是否可编辑：filePath 模式 或 提供了 editablePath（会话文件），且为完整 Markdown 文件 */
  const isMarkdownEditable = useMemo(
    () =>
      (!!filePath || !!editablePath) &&
      result?.mimeType === 'text/markdown' &&
      route === 'code' &&
      !result?.ranged, // 行号片段预览不可编辑，避免保存覆盖整文件
    [filePath, editablePath, result, route],
  )

  /** Markdown 文件（可切换预览/源码，不要求可写） */
  const isMarkdown = useMemo(
    () => result?.mimeType === 'text/markdown' && route === 'code',
    [result, route],
  )

  const imageDataUrl = useMemo(() => {
    if (!result || route !== 'image' || result.truncated) return ''
    return buildImageDataUrl(result)
  }, [result, route])

  /** 音频/视频 Blob URL（需在卸载时 revoke） */
  const [mediaBlobUrl, setMediaBlobUrl] = useState<string>('')
  useEffect(() => {
    if (!result || (route !== 'audio' && route !== 'video') || result.truncated) {
      setMediaBlobUrl('')
      return
    }
    const url = buildMediaBlobUrl(result)
    setMediaBlobUrl(url)
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [result, route])

  /**
   * PDF 原始字节（Electron 内 iframe+blob 常空白，改由 PdfJsPreview 走 PDF.js）
   */
  const pdfBytes = useMemo(() => {
    const raw = result?.content
    if (!result || route !== 'pdf' || result.truncated || !raw) return null
    if (!(result.encoding === 'base64' || isPdfBase64Payload(raw))) return null
    try {
      const normalized = raw.replace(/\s/g, '')
      return Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0))
    } catch {
      return null
    }
  }, [result, route])

  /** Excel / PPTX 原始字节（base64 → Uint8Array） */
  const officeBytes = useMemo(() => {
    const raw = result?.content
    if (!result || (route !== 'xlsx' && route !== 'pptx') || result.truncated || !raw) return null
    if (result.encoding !== 'base64') return null
    try {
      return Uint8Array.from(atob(raw.replace(/\s/g, '')), (c) => c.charCodeAt(0))
    } catch {
      return null
    }
  }, [result, route])

  // DOCX：mammoth 转 HTML
  useEffect(() => {
    if (!result || route !== 'docx' || result.encoding !== 'base64' || !result.content) {
      setDocxHtml(null)
      setDocxError(null)
      setDocxLoading(false)
      return
    }
    let cancelled = false
    setDocxLoading(true)
    setDocxError(null)
    setDocxHtml(null)
    const rawB64 = result.content
    void (async () => {
      try {
        const mammoth = await import('mammoth')
        const buf = Uint8Array.from(atob(rawB64), (c) => c.charCodeAt(0))
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        const { value } = await mammoth.convertToHtml({ arrayBuffer: ab })
        if (!cancelled) setDocxHtml(value)
      } catch (e) {
        if (!cancelled) {
          setDocxError(e instanceof Error ? e.message : '解析 DOCX 失败')
        }
      } finally {
        if (!cancelled) setDocxLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [result, route])

  /** 可复制文件本身的绝对路径（filePath 或会话文件的 editablePath） */
  const copyableFilePath = filePath ?? editablePath ?? null

  const handleCopyFile = useCallback(async () => {
    if (!copyableFilePath) return
    try {
      await window.electronAPI.clipboard.writeFiles([copyableFilePath])
      setCopyHint('file')
    } catch {
      setCopyHint('err')
    }
  }, [copyableFilePath])

  /** 面板外壳 class */
  const shellClass = clsx(
    styles.modal,
    isWindow && styles.modalWindow,
    isEmbedded && styles.modalEmbedded,
    isFullscreen && !isWindow && styles.modalDialogFullscreen,
  )

  const panel = (
      <div className={shellClass} onClick={(e) => e.stopPropagation()}>
        {/* 标题栏 */}
        <div className={styles.header}>
          <div className={styles.titleBlock}>
            <File size={15} strokeWidth={1.8} className={styles.titleIcon} aria-hidden />
            <span className={styles.title} title={fileName}>{fileName}</span>
            {result && (
              <span className={styles.meta}>
                {formatSize(result.size)}
                {result.ranged && result.startLine !== undefined && (
                  <>
                    {' · '}
                    L{result.startLine}
                    {result.endLine !== undefined && result.endLine !== result.startLine
                      ? `-${result.endLine}`
                      : ''}
                  </>
                )}
              </span>
            )}
          </div>
          <div className={styles.headerActions}>
            {/* Markdown：预览 / 源码切换（非编辑态） */}
            {isMarkdown && !isEditingMarkdown && (
              <div className={styles.mdToggle} role="group" aria-label="Markdown 视图">
                <button
                  type="button"
                  className={clsx(styles.mdToggleBtn, mdViewMode === 'preview' && styles.mdToggleBtnActive)}
                  onClick={() => setMdViewMode('preview')}
                >
                  预览
                </button>
                <button
                  type="button"
                  className={clsx(styles.mdToggleBtn, mdViewMode === 'source' && styles.mdToggleBtnActive)}
                  onClick={() => setMdViewMode('source')}
                >
                  源码
                </button>
              </div>
            )}
            {isMarkdownEditable && !isEditingMarkdown && (
              <button
                type="button"
                className={styles.iconBtn}
                onClick={handleEnterEdit}
                title="编辑 Markdown"
                aria-label="编辑"
              >
                <Pencil size={14} strokeWidth={1.8} />
              </button>
            )}
            {isEditingMarkdown && (
              <>
                {saveError && <span className={styles.saveError}>{saveError}</span>}
                <button
                  type="button"
                  className={clsx(styles.actionBtn, styles.saveBtn)}
                  onClick={() => void handleSaveEdit()}
                  disabled={isSaving}
                  title="保存 (Ctrl+S)"
                >
                  {isSaving ? '保存中…' : '保存'}
                </button>
                <button
                  type="button"
                  className={styles.actionBtn}
                  onClick={handleCancelEdit}
                  disabled={isSaving}
                  title="取消编辑 (Esc)"
                >
                  取消
                </button>
              </>
            )}
            {!isEditingMarkdown && copyHint && (
              <span className={styles.copyHint}>
                {copyHint === 'file' ? '已复制' : '复制失败'}
              </span>
            )}
            {!isEditingMarkdown && copyableFilePath && (
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => void handleCopyFile()}
                title="复制文件到剪贴板"
                aria-label="复制文件"
              >
                <Copy size={14} strokeWidth={1.8} />
              </button>
            )}
            {!isWindow && (
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => void handlePopOut()}
                title="弹出独立窗口（可拖到主窗口外）"
                aria-label="弹出独立窗口"
              >
                <AppWindow size={14} strokeWidth={1.8} />
              </button>
            )}
            {!isWindow && (
              <button
                type="button"
                className={styles.iconBtn}
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? '退出全屏' : '全屏覆盖对话区'}
                title={isFullscreen ? '退出全屏 (Esc)' : '全屏覆盖对话区'}
              >
                {isFullscreen ? (
                  <Minimize2 size={14} strokeWidth={1.8} />
                ) : (
                  <Maximize2 size={14} strokeWidth={1.8} />
                )}
              </button>
            )}
            <button
              type="button"
              className={styles.iconBtn}
              onClick={onClose}
              aria-label="关闭"
              title="关闭"
            >
              <X size={15} strokeWidth={2} />
            </button>
          </div>
        </div>

        {/* 内容区 */}
        <div className={styles.body}>
          {loading && (
            <div className={styles.center}>
              <span className={styles.spinner} />
              <span>加载中…</span>
            </div>
          )}

          {error && (
            <div className={styles.center}>
              <p className={styles.errorMsg}>{error}</p>
              <button type="button" className={styles.actionBtn} onClick={handleOpen}>
                用系统应用打开
              </button>
            </div>
          )}

          {!loading && !error && result && result.truncated && (
            <div className={styles.center}>
              <p>文件过大（{formatSize(result.size)}），无法预览</p>
              <button type="button" className={styles.actionBtn} onClick={handleOpen}>
                用系统应用打开
              </button>
            </div>
          )}

          {!loading && !error && result && !result.truncated && route === 'html-active' && (
            <HtmlActiveSandboxFrame content={result.content ?? ''} fileName={fileName} />
          )}

          {!loading && !error && result && !result.truncated && route === 'html-static' && (
            <HtmlStaticSandboxFrame content={result.content ?? ''} fileName={fileName} />
          )}

          {!loading && !error && result && !result.truncated && route === 'image' && imageDataUrl && (
            <div className={styles.imageWrap}>
              <img
                src={imageDataUrl}
                alt={fileName}
                className={styles.image}
              />
            </div>
          )}

          {!loading && !error && result && !result.truncated && route === 'audio' && mediaBlobUrl && (
            <div className={styles.mediaWrap}>
              <audio controls src={mediaBlobUrl} className={styles.audioPlayer}>
                您的浏览器不支持音频播放
              </audio>
            </div>
          )}

          {!loading && !error && result && !result.truncated && route === 'video' && mediaBlobUrl && (
            <div className={styles.mediaWrap}>
              <video controls src={mediaBlobUrl} className={styles.videoPlayer}>
                您的浏览器不支持视频播放
              </video>
            </div>
          )}

          {!loading && !error && result && !result.truncated && route === 'code' && result.mimeType === 'text/markdown' && (
            <div className={clsx(styles.markdownWrap, isEditingMarkdown && styles.markdownWrapEditing)} data-color-mode={mdColorMode}>
              {isEditingMarkdown ? (
                <MDEditor
                  value={editingContent}
                  onChange={(v) => setEditingContent(v ?? '')}
                  preview="live"
                  height="100%"
                  style={{ flex: 1, minHeight: 0 }}
                  data-color-mode={mdColorMode}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                      e.preventDefault()
                      void handleSaveEdit()
                    }
                  }}
                />
              ) : mdViewMode === 'source' ? (
                <pre className={styles.code}>
                  <code>{result.content}</code>
                </pre>
              ) : (
                <MDEditor.Markdown
                  source={result.content ?? ''}
                  style={{ background: 'transparent', color: 'inherit' }}
                  components={{
                    img: ({ src, alt }) => (
                      <MarkdownImage src={src} alt={alt} mdFilePath={filePath ?? mdBasePath} version={imageVersion} />
                    ),
                  }}
                />
              )}
            </div>
          )}

          {!loading && !error && result && !result.truncated && route === 'code' && result.mimeType !== 'text/markdown' && (
            <pre className={styles.code}>
              <code>{result.content}</code>
            </pre>
          )}

          {!loading && !error && result && !result.truncated && route === 'pdf' && pdfBytes && (
            <PdfJsPreview bytes={pdfBytes} fileName={fileName} />
          )}

          {!loading && !error && result && !result.truncated && route === 'docx' && (
            <div className={styles.docxWrap}>
              {docxLoading && (
                <div className={styles.center}>
                  <span className={styles.spinner} />
                  <span>正在解析 Word 文档…</span>
                </div>
              )}
              {docxError && (
                <div className={styles.center}>
                  <p className={styles.errorMsg}>{docxError}</p>
                  <button type="button" className={styles.actionBtn} onClick={handleOpen}>
                    用系统应用打开
                  </button>
                </div>
              )}
              {!docxLoading && !docxError && docxHtml !== null && (
                <div
                  className={styles.docxHtml}
                  dangerouslySetInnerHTML={{ __html: docxHtml }}
                />
              )}
            </div>
          )}

          {!loading && !error && result && !result.truncated && route === 'xlsx' && officeBytes && (
            <ExcelPreview bytes={officeBytes} fileName={fileName} />
          )}

          {!loading && !error && result && !result.truncated && route === 'pptx' && officeBytes && (
            <PptxPreview bytes={officeBytes} fileName={fileName} onOpenExternal={handleOpen} />
          )}

          {!loading && !error && result && !result.truncated && route === 'legacy-doc' && (
            <div className={styles.center}>
              <p>旧版 Word（.doc）无法在应用内预览，请使用系统应用打开。</p>
              <button type="button" className={styles.actionBtn} onClick={handleOpen}>
                用系统应用打开
              </button>
            </div>
          )}

          {!loading && !error && result && !result.truncated && route === 'legacy-ppt' && (
            <div className={styles.center}>
              <p>旧版 PowerPoint（.ppt）无法在应用内预览，请使用系统应用打开。</p>
              <button type="button" className={styles.actionBtn} onClick={handleOpen}>
                用系统应用打开
              </button>
            </div>
          )}

          {!loading && !error && result && !result.truncated && route === 'unsupported' && (
            <div className={styles.center}>
              <p>该文件类型不支持预览</p>
              <button type="button" className={styles.actionBtn} onClick={handleOpen}>
                用系统应用打开
              </button>
            </div>
          )}
        </div>
      </div>
  )

  // 独立窗口：直接铺满
  if (isWindow) {
    return <div className={styles.windowHost}>{panel}</div>
  }

  // 内嵌：填满父级
  if (isEmbedded) {
    return <div className={styles.embeddedHost}>{panel}</div>
  }

  // 全屏：覆盖对话区（有 data-chat-dialog 时按边界定位；否则铺满主内容区）
  if (isFullscreen) {
    if (typeof document === 'undefined') return null
    const overlayStyle: React.CSSProperties = dialogBounds
      ? {
          position: 'fixed',
          top: dialogBounds.top,
          left: dialogBounds.left,
          width: dialogBounds.width,
          height: dialogBounds.height,
        }
      : {
          position: 'fixed',
          top: 'var(--mt-titlebar-h, 36px)',
          left: 0,
          right: 0,
          bottom: 0,
        }
    return createPortal(
      <div
        className={styles.dialogOverlay}
        style={overlayStyle}
        role="dialog"
        aria-modal="true"
        aria-label="文件预览全屏"
        data-file-preview-open
      >
        {panel}
      </div>,
      document.body,
    )
  }

  // 默认弹窗
  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      className={styles.overlay}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="文件预览"
      data-file-preview-open
    >
      {panel}
    </div>,
    document.body,
  )
}
