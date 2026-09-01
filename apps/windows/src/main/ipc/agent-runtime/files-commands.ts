/**
 * Files (文件) 命令处理器
 *
 * 提取自 agent-runtime-ipc.ts
 */

import path from 'node:path'
import fs from 'node:fs'
import { shell } from 'electron'
import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import { resolveRecordingsDir } from '../../workspace-paths'
import { buildLocalMediaUrl, allowLocalMediaPreviewPath } from '../../local-media-protocol'
import { extractDocumentText } from '../../vendor/document-parser.js'
import { resolveWikiRefPreviewTarget } from './resolve-wiki-ref-preview'
import { isVaultRefPath } from '@mtbot/agent-runtime'

const log = {
  info: (...args: unknown[]) => console.log('[AgentRuntime:IPC]', ...args),
  warn: (...args: unknown[]) => console.warn('[AgentRuntime:IPC]', ...args),
}

const LOCAL_USER_ID = 'local-user'

/** 预览允许的最大文件体积（超过则标记 truncated，不读入内存） */
const PREVIEW_MAX_BYTES = 500 * 1024 * 1024
/** 超过此体积的二进制改为 lumii-local 流式读取，避免 IPC base64 撑爆 */
const INLINE_BASE64_MAX_BYTES = 8 * 1024 * 1024
/** 文本预览仍走 IPC 字符串，过大则截断 */
const TEXT_PREVIEW_MAX_BYTES = 10 * 1024 * 1024

/**
 * 音视频、录屏目录、以及超过内联上限的二进制走协议 URL。
 */
function shouldStreamPreviewViaFileUrl(
  mime: string,
  fileName: string,
  size: number,
  inRecordings: boolean,
): boolean {
  if (mime.startsWith('video/') || mime.startsWith('audio/') || inRecordings) return true
  if (deps!.shouldReadPreviewAsUtf8(mime, fileName)) return false
  return size > INLINE_BASE64_MAX_BYTES
}

/**
 * 构造流式预览返回值，并把路径登记进 lumii-local ACL（含工作区外的 wiki 原文件）。
 */
function streamedPreviewPayload(
  absPath: string,
  size: number,
  mime: string,
  extra?: { fileName: string },
): {
  truncated: false
  content: null
  fileUrl: string
  size: number
  mimeType: string
  encoding: 'base64'
  fileName?: string
  ranged?: boolean
} {
  allowLocalMediaPreviewPath(absPath)
  return {
    truncated: false,
    content: null,
    fileUrl: buildLocalMediaUrl(absPath),
    size,
    mimeType: mime,
    encoding: 'base64',
    ...(extra ? { fileName: extra.fileName, ranged: false as const } : {}),
  }
}

// ============================================================
// 依赖注入接口
// ============================================================

interface FilesDependencies {
  inferPreviewMimeFromFileName: (fileName: string) => string | null
  shouldReadPreviewAsUtf8: (mimeType: string | null, fileName: string) => boolean
  expandTildePath: (filePath: string) => string
  isAllowedPreviewPath: (resolvedAbs: string, resolvedCwd: string) => boolean
  isResolvedPathInsideWorkspace: (resolvedAbs: string, resolvedCwd: string) => boolean
  audioTranscribeCallback: ((fileBase64: string, mimeType: string) => Promise<string>) | null
}

let deps: FilesDependencies | null = null

export function setFilesDependencies(dependencies: FilesDependencies): void {
  deps = dependencies
}

// ============================================================
// 命令处理器
// ============================================================

export function handleFilesList(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'files:list' }>,
): unknown {
  const { userId, agentId, conversationId, channel, category, limit, offset } = command
  // 若指定了 conversationId，直接走按对话查询（返回格式与 listByUser 保持一致）
  if (conversationId) {
    const files = bridge.fileRepo.listByConversation(conversationId)
    return { files, total: files.length }
  }
  return bridge.fileRepo.listByUser(userId, { agentId, channel, category, limit, offset })
}

export function handleFilesSearch(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'files:search' }>,
): unknown {
  const { userId, query, filters } = command
  const results = bridge.fileRepo.search(userId, query, filters)
  return results.map((f) => ({
    id: f.id,
    fileName: f.fileName,
    localPath: f.localPath,
    fileSize: f.fileSize,
    mimeType: f.mimeType,
    createdAt: f.createdAt,
    channel: f.channel,
    agentId: f.agentId,
    conversationId: f.conversationId,
  }))
}

export async function handleFilesDelete(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'files:delete' }>,
): Promise<{ deletedCount: number }> {
  const { fileIds } = command
  const cwd = bridge.getCwd()
  const resolvedCwd = path.resolve(cwd)
  for (const id of fileIds) {
    const file = bridge.fileRepo.findById(id)
    if (!file) continue
    const absPath = path.resolve(cwd, file.localPath)
    const resolvedAbs = path.resolve(absPath)
    if (deps!.isResolvedPathInsideWorkspace(resolvedAbs, resolvedCwd)) {
      try {
        await fs.promises.unlink(resolvedAbs)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          log.warn(`[files:delete] 磁盘删除失败 ${resolvedAbs}:`, err)
        }
      }
    } else {
      log.warn(`[files:delete] 跳过工作区外路径: ${resolvedAbs}`)
    }
    bridge.fileRepo.hardDelete(id)
  }
  return { deletedCount: fileIds.length }
}

export async function handleFilesOpen(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'files:open' }>,
): Promise<{ success: boolean }> {
  const { fileId } = command
  const file = bridge.fileRepo.findById(fileId)
  if (!file) throw new Error(`文件不存在: ${fileId}`)
  const cwd = bridge.getCwd()
  const absPath = path.resolve(cwd, file.localPath)
  if (!fs.existsSync(absPath)) {
    bridge.fileRepo.markMissing(fileId)
    throw new Error('文件已丢失，可能已被删除或移动')
  }
  await shell.openPath(absPath)
  return { success: true }
}

export async function handleFilesSaveAs(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'files:save-as' }>,
): Promise<{ success: boolean }> {
  const { fileId, savePath } = command
  const file = bridge.fileRepo.findById(fileId)
  if (!file) throw new Error(`文件不存在: ${fileId}`)
  const cwd = bridge.getCwd()
  const absPath = path.resolve(cwd, file.localPath)
  if (!fs.existsSync(absPath)) {
    bridge.fileRepo.markMissing(fileId)
    throw new Error('文件已丢失，可能已被删除或移动')
  }
  await fs.promises.copyFile(absPath, savePath)
  return { success: true }
}

export async function handleFilesReadPreviewContent(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'files:read-preview-content' }>,
): Promise<unknown> {
  const { fileId } = command
  const file = bridge.fileRepo.findById(fileId)
  if (!file) throw new Error(`文件不存在: ${fileId}`)
  const cwd = bridge.getCwd()
  const absPath = path.resolve(cwd, file.localPath)
  if (!fs.existsSync(absPath)) {
    bridge.fileRepo.markMissing(fileId)
    throw new Error('文件已丢失，可能已被删除或移动')
  }
  const inferred = deps!.inferPreviewMimeFromFileName(file.fileName)
  /** 元数据误标为 text/* 时仍以扩展名为准（避免 PDF 等被按 UTF-8 读坏） */
  let effectiveMime = file.mimeType ?? inferred
  if (
    inferred &&
    file.mimeType?.startsWith('text/') &&
    (inferred === 'application/pdf' ||
      inferred === 'application/msword' ||
      inferred === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  ) {
    effectiveMime = inferred
  }
  const stat = await fs.promises.stat(absPath)
  if (stat.size > PREVIEW_MAX_BYTES) {
    return { truncated: true, content: null, size: stat.size, mimeType: effectiveMime }
  }
  const inRecordings = absPath.startsWith(path.resolve(resolveRecordingsDir()) + path.sep)
  if (shouldStreamPreviewViaFileUrl(effectiveMime, file.fileName, stat.size, inRecordings)) {
    return streamedPreviewPayload(absPath, stat.size, effectiveMime)
  }
  if (deps!.shouldReadPreviewAsUtf8(effectiveMime, file.fileName) && stat.size > TEXT_PREVIEW_MAX_BYTES) {
    return { truncated: true, content: null, size: stat.size, mimeType: effectiveMime }
  }
  if (deps!.shouldReadPreviewAsUtf8(effectiveMime, file.fileName)) {
    const content = await fs.promises.readFile(absPath, 'utf-8')
    return {
      truncated: false,
      content,
      size: stat.size,
      mimeType: effectiveMime,
      encoding: 'utf-8',
    }
  }
  const buf = await fs.promises.readFile(absPath)
  return {
    truncated: false,
    content: buf.toString('base64'),
    size: stat.size,
    mimeType: effectiveMime,
    encoding: 'base64',
  }
}

export async function handleFilesReadPreviewByPath(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'files:read-preview-by-path' }>,
): Promise<unknown> {
  const { filePath, startLine, endLine } = command
  const cwd = bridge.getCwd()
  const expandedPath = deps!.expandTildePath(filePath)
  // 路径安全：须位于 workspace / recordings / 截图临时目录内
  const absPath = path.isAbsolute(expandedPath) ? expandedPath : path.resolve(cwd, expandedPath)
  let resolvedAbs = path.resolve(absPath)
  const resolvedCwd = path.resolve(cwd)
  if (!deps!.isAllowedPreviewPath(resolvedAbs, resolvedCwd)) {
    throw new Error('该路径不在允许的预览目录内（工作区 / recordings / 截图），无法预览')
  }
  // 工作区内的 .lumii-ref 只是指针，预览必须跟到原文件（可在工作区外，可多层引用）
  if (isVaultRefPath(resolvedAbs)) {
    resolvedAbs = resolveWikiRefPreviewTarget(resolvedAbs, resolvedCwd)
  }
  if (!fs.existsSync(resolvedAbs)) {
    throw new Error('文件不存在或已被删除')
  }
  const fileName = path.basename(resolvedAbs)
  /** 与 files:read-preview-content 共用推断，避免 PDF 等被误作 text/plain */
  const inferred = deps!.inferPreviewMimeFromFileName(fileName)
  let effectiveMime = inferred ?? 'text/plain'
  const stat = await fs.promises.stat(resolvedAbs)
  if (stat.isDirectory()) {
    throw new Error('无法预览目录，请在文件树中展开查看')
  }

  if (stat.size > PREVIEW_MAX_BYTES) {
    return {
      truncated: true,
      content: null,
      size: stat.size,
      mimeType: effectiveMime,
      fileName,
      ranged: false,
    }
  }

  const inRecordings = resolvedAbs.startsWith(path.resolve(resolveRecordingsDir()) + path.sep)
  if (shouldStreamPreviewViaFileUrl(effectiveMime, fileName, stat.size, inRecordings)) {
    return streamedPreviewPayload(resolvedAbs, stat.size, effectiveMime, { fileName })
  }

  if (deps!.shouldReadPreviewAsUtf8(effectiveMime, fileName) && stat.size > TEXT_PREVIEW_MAX_BYTES) {
    return {
      truncated: true,
      content: null,
      size: stat.size,
      mimeType: effectiveMime,
      fileName,
      ranged: false,
    }
  }

  const textMode = deps!.shouldReadPreviewAsUtf8(effectiveMime, fileName)

  if (textMode) {
    const raw = await fs.promises.readFile(resolvedAbs, 'utf-8')
    if (typeof startLine === 'number' && startLine >= 1) {
      const lines = raw.length === 0 ? [] : raw.split('\n')
      const start0 = Math.max(0, startLine - 1)
      const end0 =
        typeof endLine === 'number' && endLine >= startLine
          ? Math.min(lines.length, endLine)
          : lines.length
      const sliced = lines.slice(start0, end0).join('\n')
      return {
        truncated: false,
        content: sliced,
        size: stat.size,
        mimeType: effectiveMime,
        fileName,
        ranged: true,
        startLine,
        endLine: typeof endLine === 'number' ? endLine : lines.length,
        encoding: 'utf-8',
      }
    }
    return {
      truncated: false,
      content: raw,
      size: stat.size,
      mimeType: effectiveMime,
      fileName,
      ranged: false,
      encoding: 'utf-8',
    }
  }

  const buf = await fs.promises.readFile(resolvedAbs)
  return {
    truncated: false,
    content: buf.toString('base64'),
    size: stat.size,
    mimeType: effectiveMime,
    fileName,
    ranged: false,
    encoding: 'base64',
  }
}

export async function handleFilesImport(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'files:import' }>,
): Promise<{
  fileId: string
  localPath: string
  absPath: string
  fileName: string
  mimeType: string
  fileSize: number
  parsedTextPath: string | null
}> {
  const { sourcePath, fileName, mimeType, conversationId, fileBuffer } = command
  const cwd = bridge.getCwd()
  // 按日期创建 uploads 子目录
  const today = new Date()
  const dateFolder = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const uploadsDir = path.join(cwd, 'uploads', dateFolder)
  await fs.promises.mkdir(uploadsDir, { recursive: true })
  // 避免文件名冲突：加时间戳前缀
  const ts = Date.now()
  const ext = path.extname(fileName)
  const base = path.basename(fileName, ext)
  const destFileName = `${base}_${ts}${ext}`
  const destAbs = path.join(uploadsDir, destFileName)

  let fileBase64: string
  if (fileBuffer) {
    // 渲染进程直接传来文件内容（file.path 不可用时的 fallback）
    await fs.promises.writeFile(destAbs, Buffer.from(fileBuffer as string, 'base64'))
    fileBase64 = fileBuffer as string
  } else {
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw new Error(`源文件不存在: ${sourcePath}`)
    }
    await fs.promises.copyFile(sourcePath, destAbs)
    fileBase64 = (await fs.promises.readFile(destAbs)).toString('base64')
  }

  const stat = await fs.promises.stat(destAbs)
  const localPath = path.relative(cwd, destAbs).replace(/\\/g, '/')
  const fileId = bridge.fileRepo.registerOrUpdate({
    userId: LOCAL_USER_ID,
    agentId: null,
    conversationId: conversationId ?? null,
    messageId: null,
    channel: 'windows',
    sourceType: 'user_upload',
    fileName: destFileName,
    fileSize: stat.size,
    mimeType: mimeType || 'application/octet-stream',
    localPath,
  })

  // 对可解析的文档格式，生成伴生 .extracted.txt 文件
  // Agent 通过 file_read 读取伴生文件即可获得可理解的纯文本内容
  let parsedTextPath: string | null = null
  const parsableMimes = new Set([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-powerpoint',
    'text/csv',
    'text/tab-separated-values',
    'application/epub+zip',
    'application/rtf',
    'text/rtf',
  ])
  const parsableExts = new Set([
    '.pdf',
    '.docx',
    '.doc',
    '.xlsx',
    '.xls',
    '.pptx',
    '.ppt',
    '.csv',
    '.tsv',
    '.epub',
    '.rtf',
  ])
  // 音频文件通过 ASR 转录
  const audioMimes = new Set([
    'audio/wav',
    'audio/x-wav',
    'audio/wave',
    'audio/mpeg',
    'audio/ogg',
    'audio/flac',
    'audio/mp4',
    'audio/aac',
  ])
  const audioExts = new Set(['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aac'])
  const effectiveMime = mimeType || 'application/octet-stream'
  const fileExt = ext.toLowerCase()
  if (parsableMimes.has(effectiveMime) || parsableExts.has(fileExt)) {
    try {
      const parseResult = await extractDocumentText(fileBase64, destFileName, effectiveMime)
      if (parseResult.ok && parseResult.text) {
        const txtFileName = `${base}_${ts}.extracted.txt`
        const txtAbs = path.join(uploadsDir, txtFileName)
        const header = [
          `# 文档解析结果`,
          `# 原始文件: ${destFileName}`,
          `# 格式: ${effectiveMime}`,
          parseResult.pages ? `# 页数: ${parseResult.pages}` : null,
          `# 解析时间: ${new Date().toISOString()}`,
          ``,
        ]
          .filter(Boolean)
          .join('\n')
        await fs.promises.writeFile(txtAbs, header + parseResult.text, 'utf-8')
        parsedTextPath = path.relative(cwd, txtAbs).replace(/\\/g, '/')
        log.info(
          `[files:import] 文档解析成功: ${destFileName} → ${txtFileName} (${parseResult.text.length} chars)`,
        )
      } else {
        log.warn(`[files:import] 文档解析失败或无内容: ${destFileName}`)
      }
    } catch (parseErr) {
      log.warn(`[files:import] 文档解析异常（已忽略）: ${destFileName}`, parseErr)
    }
  } else if (
    (audioMimes.has(effectiveMime) || audioExts.has(fileExt)) &&
    deps!.audioTranscribeCallback
  ) {
    // 音频文件：调用 ASR 引擎转录，生成伴生文本
    try {
      log.info(`[files:import] 开始 ASR 转录音频文件: ${destFileName}`)
      const transcribedText = await deps!.audioTranscribeCallback(fileBase64, effectiveMime)
      if (transcribedText) {
        const txtFileName = `${base}_${ts}.extracted.txt`
        const txtAbs = path.join(uploadsDir, txtFileName)
        const header = [
          `# 语音转录结果`,
          `# 原始文件: ${destFileName}`,
          `# 格式: ${effectiveMime}`,
          `# 转录时间: ${new Date().toISOString()}`,
          ``,
        ]
          .filter(Boolean)
          .join('\n')
        await fs.promises.writeFile(txtAbs, header + transcribedText, 'utf-8')
        parsedTextPath = path.relative(cwd, txtAbs).replace(/\\/g, '/')
        log.info(
          `[files:import] ASR 转录成功: ${destFileName} → ${txtFileName} (${transcribedText.length} chars)`,
        )
      } else {
        log.warn(`[files:import] ASR 转录无内容: ${destFileName}`)
      }
    } catch (asrErr) {
      log.warn(`[files:import] ASR 转录异常（已忽略）: ${destFileName}`, asrErr)
    }
  }

  return {
    fileId,
    localPath,
    absPath: destAbs,
    fileName: destFileName,
    mimeType: effectiveMime,
    fileSize: stat.size,
    /** 伴生文本文件的相对路径（workspace 相对），null 表示无法解析或不需要解析 */
    parsedTextPath,
  }
}

