/**
 * FileMemoryHandler — 文件写入事件处理与用户记忆整理
 *
 * 职责：
 * - handleFileWritten: writeLocalFile 工具执行后注册文件元数据并推送事件
 * - appendToUserMemory: 将新提取的个人记忆候选经 LLM 去重合并后写入 user_memory
 * - 辅助函数：guessMimeType、determineFileCategory
 */

import path from 'node:path'
import fs from 'node:fs'
import type { FileRepo } from '@mtbot/agent-runtime'
import { consolidateUserMemory, resolveAgentFilePath } from '@mtbot/agent-runtime'
import type { InstanceStateStore } from './bridge-instance-state'
import type { AgentRuntimeEvent as IpcEvent } from '../../shared/agent-runtime-events'

const log = {
  info: (...args: unknown[]) => console.log('[FileMemoryHandler]', ...args),
  warn: (...args: unknown[]) => console.warn('[FileMemoryHandler]', ...args),
  error: (...args: unknown[]) => console.error('[FileMemoryHandler]', ...args),
}

export interface FileMemoryHandlerDeps {
  /** 文件仓储（懒初始化，可能为 null） */
  getFileRepo: () => FileRepo | null
  /** 获取 Agent workspace 根目录 */
  getCwd: () => string
  /** instanceId → conversationId 映射 */
  instanceToConversation: Map<string, string>
  /** Per-instance 聚合状态存储（提供 ctx / streamingAssistantMsgId） */
  instanceStates: InstanceStateStore
  /** 推送 IPC 事件到渲染进程 */
  forwardIpcEvent: (event: IpcEvent) => void
  /** 读取用户记忆全文（可选） */
  getUserMemory?: () => Promise<{ content: string; updatedAt?: string } | undefined>
  /** 更新用户记忆全文（可选） */
  updateUserMemory?: (content: string) => Promise<{ updatedAt?: string } | undefined> | Promise<void>
  /** LLM 调用（可选，用于个人记忆智能整理） */
  callLLM?: (prompt: string) => Promise<string>
}

export class FileMemoryHandler {
  /** 防止并发写入 user_memory 的简单锁 */
  private _userMemoryWriting = false
  /** 写入锁期间累积的个人记忆候选，解锁后合并处理 */
  private _pendingPersonalCandidates: Array<{ content: string; category: string }> = []
  /** 已扫描注册并推送过 UI 事件的文件路径，避免重复推送（键：conversationId:localRelPath） */
  private _scannedPaths = new Set<string>()

  constructor(private readonly deps: FileMemoryHandlerDeps) {}

  /**
   * 从文件路径判断文件类别
   */
  determineFileCategory(filePath: string): 'upload' | 'output' {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase()
    // cwd 即为 workspace 根；兼容绝对路径中带 /workspace/uploads/ 的历史形式
    if (normalized.includes('/uploads/') || normalized.includes('/workspace/uploads/')) {
      return 'upload'
    }
    return 'output'
  }

  /**
   * 从文件扩展名推导 MIME 类型（简单映射，覆盖常见类型）
   */
  guessMimeType(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase()
    const map: Record<string, string> = {
      '.html': 'text/html',
      '.htm': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.ts': 'text/typescript',
      '.json': 'application/json',
      '.md': 'text/markdown',
      '.txt': 'text/plain',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.csv': 'text/csv',
      '.xml': 'application/xml',
      '.zip': 'application/zip',
      '.py': 'text/x-python',
      '.sh': 'text/x-sh',
    }
    return map[ext] ?? null
  }

  /**
   * writeLocalFile 工具成功执行后，注册文件元数据并推送 agent:file:created 事件
   */
  async handleFileWritten(instanceId: string, args: Record<string, unknown>): Promise<void> {
    const fileRepo = this.deps.getFileRepo()
    if (!fileRepo) return

    const absPath = typeof args['filePath'] === 'string' ? args['filePath'] : null
    if (!absPath) {
      log.warn(`[file:created] writeLocalFile args 缺少 filePath，跳过注册 instanceId=${instanceId}`)
      return
    }

    const { instanceToConversation, instanceStates } = this.deps
    const conversationId = instanceToConversation.get(instanceId) ?? null
    const state = instanceStates.get(instanceId)
    const runCtx = state?.ctx
    const msgId = state?.streamingAssistantMsgId ?? null
    const cwd = this.deps.getCwd()

    // 相对路径（如 outputs/foo.pdf）必须相对 agent cwd，而非 Electron process.cwd()
    let resolvedAbs: string
    try {
      resolvedAbs = resolveAgentFilePath(absPath, cwd)
    } catch (err) {
      log.warn(
        `[file:created] 路径无效或超出 workspace，拒绝注册: path=${absPath} cwd=${cwd}`,
        err,
      )
      return
    }

    let fileSize: number | null = null
    try {
      const stat = fs.statSync(resolvedAbs)
      fileSize = stat.size
    } catch {
      // 文件可能刚写完还未刷盘，忽略
    }

    const fileName = path.basename(resolvedAbs)
    const mimeType = this.guessMimeType(resolvedAbs)
    const category = this.determineFileCategory(resolvedAbs)
    const agentId = runCtx?.sessionKey ?? null

    this.registerAndEmit({
      absPath: resolvedAbs,
      cwd,
      conversationId,
      messageId: msgId,
      agentId,
      fileName,
      fileSize,
      mimeType,
      category,
    })
  }

  /**
   * 注册单个文件到 FileRepo 并推送 agent:file:created 事件
   */
  private registerAndEmit(params: {
    absPath: string
    cwd: string
    conversationId: string | null
    messageId: string | null
    agentId: string | null
    fileName: string
    fileSize: number | null
    mimeType: string | null
    category: 'upload' | 'output'
  }): string | null {
    const fileRepo = this.deps.getFileRepo()
    if (!fileRepo) return null

    const localRelPath = path.relative(params.cwd, params.absPath).replace(/\\/g, '/')

    const fileId = fileRepo.registerOrUpdate({
      userId: 'local-user',
      agentId: params.agentId,
      conversationId: params.conversationId,
      messageId: params.messageId,
      channel: 'windows',
      sourceType: 'agent_output',
      fileName: params.fileName,
      fileSize: params.fileSize,
      mimeType: params.mimeType,
      localPath: localRelPath,
      category: params.category,
    })

    log.info(
      `[file:created] 已注册文件 fileId=${fileId} fileName=${params.fileName} path=${localRelPath}`,
    )

    this.deps.forwardIpcEvent({
      type: 'agent:file:created',
      fileId,
      fileName: params.fileName,
      localPath: localRelPath,
      mimeType: params.mimeType,
      fileSize: params.fileSize,
      conversationId: params.conversationId,
      messageId: params.messageId,
      agentId: params.agentId,
      channel: 'windows',
      category: params.category,
    })

    return fileId
  }

  /**
   * exec / bash 类工具执行后，扫描 workspace 根下的 outputs/，注册自工具开始后新增/修改的文件
   * （与 workspaceLayout.outputsDir = 'outputs' 一致；cwd 即为 workspace 根）
   */
  async scanAndRegisterOutputs(instanceId: string, sinceMs: number | undefined): Promise<void> {
    const fileRepo = this.deps.getFileRepo()
    if (!fileRepo) return

    const cwd = this.deps.getCwd()
    const outputsDir = path.join(cwd, 'outputs')

    let entries: string[]
    try {
      entries = this.walkDir(outputsDir)
    } catch {
      return
    }
    if (entries.length === 0) return

    const { instanceToConversation, instanceStates } = this.deps
    const conversationId = instanceToConversation.get(instanceId) ?? null
    const state = instanceStates.get(instanceId)
    const runCtx = state?.ctx
    const msgId = state?.streamingAssistantMsgId ?? null
    const agentId = runCtx?.sessionKey ?? null
    const cutoff = sinceMs ?? Date.now() - 60_000

    for (const absPath of entries) {
      let stat: fs.Stats
      try {
        stat = fs.statSync(absPath)
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      if (stat.mtimeMs < cutoff) continue

      const localRelPath = path.relative(cwd, absPath).replace(/\\/g, '/')
      if (this._scannedPaths.has(`${conversationId ?? ''}:${localRelPath}`)) continue
      this._scannedPaths.add(`${conversationId ?? ''}:${localRelPath}`)

      this.registerAndEmit({
        absPath,
        cwd,
        conversationId,
        messageId: msgId,
        agentId,
        fileName: path.basename(absPath),
        fileSize: stat.size,
        mimeType: this.guessMimeType(absPath),
        category: 'output',
      })
    }
  }

  /** 递归收集目录下所有文件的绝对路径（限制深度，防止符号链接环路） */
  private walkDir(dir: string, depth = 0): string[] {
    if (depth > 8) return []
    const result: string[] = []
    const dirents = fs.readdirSync(dir, { withFileTypes: true })
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name)
      if (dirent.isDirectory()) {
        result.push(...this.walkDir(full, depth + 1))
      } else if (dirent.isFile()) {
        result.push(full)
      }
    }
    return result
  }

  /**
   * 将新提取的个人记忆候选整理合并到 user_memory Markdown 文档。
   * 优先使用 LLM 去重/冲突消解；无 LLM 时回退到简单追加。
   */
  async appendToUserMemory(
    candidates: readonly { readonly content: string; readonly category: string }[],
  ): Promise<void> {
    if (!this.deps.getUserMemory || !this.deps.updateUserMemory) return

    if (this._userMemoryWriting) {
      for (const c of candidates) {
        this._pendingPersonalCandidates.push(c)
      }
      log.info(`[appendToUserMemory] 写入中，暂存 ${candidates.length} 条个人记忆候选`)
      return
    }

    const allCandidates = [...candidates, ...this._pendingPersonalCandidates]
    this._pendingPersonalCandidates = []
    this._userMemoryWriting = true

    try {
      const existing = await this.deps.getUserMemory()
      const currentContent = existing?.content ?? ''

      const extractedCandidates = allCandidates.map((c) => ({
        content: c.content,
        category: c.category as import('@mtbot/agent-runtime').MemoryCategory,
        importance: 0.7,
        tags: [] as string[],
      }))

      let updated: string
      let merged = false

      if (this.deps.callLLM) {
        const result = await consolidateUserMemory({
          existingContent: currentContent,
          newCandidates: extractedCandidates,
          callLLM: this.deps.callLLM,
        })
        updated = result.content
        merged = result.merged
      } else {
        const newItems = allCandidates.filter((c) => !currentContent.includes(c.content))
        if (newItems.length === 0) {
          log.info('[appendToUserMemory] 所有候选已存在，跳过追加')
          return
        }
        const newLines = newItems.map((c) => `- ${c.content}`).join('\n')
        updated = currentContent.trimEnd() + `\n\n${newLines}`
      }

      if (updated === currentContent) {
        log.info('[appendToUserMemory] 整理后无变化，跳过写入')
        return
      }

      const MAX_LENGTH = 65536
      if (updated.length > MAX_LENGTH) {
        log.warn(
          `[appendToUserMemory] 超出 ${MAX_LENGTH} 字符限制 (${updated.length})，跳过本次写入`,
        )
        return
      }

      await this.deps.updateUserMemory(updated)
      log.info(
        `[appendToUserMemory] 已${merged ? 'LLM 整理合并' : '追加'}个人记忆 (${allCandidates.length} 条候选)`,
      )
    } catch (err) {
      log.error('[appendToUserMemory] 整理写入失败:', err)
    } finally {
      this._userMemoryWriting = false
      if (this._pendingPersonalCandidates.length > 0) {
        const pending = this._pendingPersonalCandidates.splice(0)
        void this.appendToUserMemory(pending).catch((err: unknown) => {
          log.error('[appendToUserMemory] 处理积压候选失败:', err)
        })
      }
    }
  }
}
