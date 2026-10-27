/**
 * 产物元数据 IPC（侧车读取）
 *
 * 工具声明走 `result.details.artifacts`；PPT 这类「技能 + bash」没有工具层，
 * 由技能在成品旁写 `<name>.lumii-artifact.json`。渲染层只给路径，主进程负责
 * 路径安全、大小上限与 30s 缓存。
 */

import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  normalizeArtifactPath,
  parseSidecar,
  sidecarPathFor,
  type ArtifactSidecar,
} from '../../shared/artifact-declaration'
import type { ArtifactThumbResult } from '../../shared/artifact-thumbs-types'
import type {
  ArtifactExportResult,
  ArtifactTrashResult,
} from '../../shared/artifact-export-types'
import type {
  ArtifactEditAction,
  ArtifactEditApplyResult,
  ArtifactEditFailure,
  ArtifactEditListResult,
  ArtifactEditProposal,
  ArtifactEditUndoResult,
  EditTone,
  ProposeTextEditInput,
} from '../../shared/artifact-edit-types'
import { normalizeDocumentAction } from '../artifact-edit-prompts'
import { proposeTextRangeEdit } from '../artifact-edit-llm'
import type { SingleTurnLlmService } from '../single-turn-llm'
import { getArtifactThumb, pruneThumbCache } from '../artifact-thumbnails'
import { exportArtifacts, resolveExportFiles } from '../artifact-export'
import {
  applyEdit,
  discardEdit,
  listEdits,
  proposeTextEdit,
  undoEdit,
  type AppliedEditInfo,
} from '../artifact-edit'
import { trashPaths } from '../workspace-cleanup'

const MAX_PATHS = 200
const MAX_SIDECAR_BYTES = 64 * 1024
const CACHE_TTL_MS = 30_000

interface ClientFileRegistrar {
  registerOrUpdate(params: {
    userId: string
    agentId?: string | null
    conversationId?: string | null
    messageId?: string | null
    channel?: string
    sourceType: 'agent_output' | 'channel_upload' | 'user_upload'
    fileName: string
    fileSize?: number | null
    mimeType?: string | null
    localPath: string
    category?: 'upload' | 'output'
    metadata?: Record<string, unknown> | null
  }): string
}

interface ArtifactIpcDeps {
  getWorkspaceDir: () => string
  getMainWindow?: () => BrowserWindow | null
  /** 本地编辑应用后登记到 client_files（「全部」作用域可见）；未接时不登记 */
  getAgentRuntimeBridge?: () => { fileRepo: ClientFileRegistrar } | null
  /** 文档选区改写用的单轮 LLM（主进程单例，带取消） */
  singleTurn?: SingleTurnLlmService
  log?: { warn: (...args: unknown[]) => void }
}

let deps: ArtifactIpcDeps | null = null

export function setArtifactIpcDeps(next: ArtifactIpcDeps): void {
  deps = next
}

interface CacheEntry {
  mtimeMs: number
  size: number
  parsed: ArtifactSidecar | null
  at: number
}

const cache = new Map<string, CacheEntry>()

function inside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function pruneCache(): void {
  if (cache.size <= 1000) return
  const now = Date.now()
  for (const [key, entry] of cache) {
    if (now - entry.at > CACHE_TTL_MS) cache.delete(key)
  }
  while (cache.size > 1000) {
    const first = cache.keys().next().value
    if (first === undefined) break
    cache.delete(first)
  }
}

async function readOne(
  root: string,
  relativePath: string,
): Promise<ArtifactSidecar | null> {
  const sidecar = sidecarPathFor(relativePath)
  const abs = path.join(root, ...sidecar.split('/'))
  if (!inside(root, abs)) return null
  try {
    const stat = await fs.stat(abs)
    if (!stat.isFile() || stat.size > MAX_SIDECAR_BYTES) return null
    const cached = cache.get(abs)
    if (
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size &&
      Date.now() - cached.at <= CACHE_TTL_MS
    ) {
      return cached.parsed
    }
    const text = await fs.readFile(abs, 'utf8')
    const parsed = parseSidecar(text)
    cache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, parsed, at: Date.now() })
    pruneCache()
    return parsed
  } catch {
    return null
  }
}

export interface ArtifactMetaResponse {
  ok: boolean
  metas: Record<string, ArtifactSidecar>
  error?: string
}

const LOCAL_USER_ID = 'local-user'

function workspaceRoot(): string | null {
  try {
    return deps!.getWorkspaceDir()
  } catch {
    return null
  }
}

/** 应用成功后的登记失败只影响「全部」作用域，不影响本次写入 */
function registerAppliedFile(info: AppliedEditInfo): void {
  const bridge = deps!.getAgentRuntimeBridge?.()
  if (!bridge) return
  // client_files 的唯一键是 (conversation_id, local_path)，NULL 不参与唯一性约束；
  // 工作区级（没有会话）的编辑不登记，避免每次应用都插一条重复行。
  if (!info.sessionKey) return
  try {
    bridge.fileRepo.registerOrUpdate({
      userId: LOCAL_USER_ID,
      conversationId: info.sessionKey,
      messageId: null,
      channel: 'windows',
      sourceType: 'agent_output',
      fileName: path.basename(info.path),
      fileSize: info.bytes,
      localPath: info.path,
      category: 'output',
      metadata: {
        source: 'workbench-edit',
        editId: info.editId,
        action: info.action,
      },
    })
  } catch (err) {
    deps!.log?.warn('[artifact-edit] client_files 登记失败:', err)
  }
}

export function registerArtifactIpcHandlers(): void {
  if (!deps) throw new Error('ArtifactIpc deps not set')

  ipcMain.handle(
    'artifact:thumb',
    async (_event, relPath: unknown): Promise<ArtifactThumbResult> => {
      if (typeof relPath !== 'string' || !relPath) {
        return { ok: false, error: '路径非法' }
      }
      try {
        return await getArtifactThumb({
          workspaceDir: deps!.getWorkspaceDir(),
          relPath,
        })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '缩略图失败' }
      }
    },
  )

  // 启动后延迟清一次缓存；日常清理由 P1 的存储清理任务接管。
  // getWorkspaceDir 是同步的，配置未初始化时会 throw —— 必须在 try 里调，
  // 否则异常冒到 uncaughtException 处理器直接 process.exit(1)。
  const timer = setTimeout(() => {
    try {
      void pruneThumbCache(deps!.getWorkspaceDir()).catch(() => undefined)
    } catch {
      // 工作区还拿不到就跳过这次清理
    }
  }, 60_000)
  timer.unref?.()

  ipcMain.handle('artifact:readMeta', async (_event, paths: unknown): Promise<ArtifactMetaResponse> => {
    if (!Array.isArray(paths)) return { ok: false, metas: {}, error: 'paths 必须是数组' }
    let root: string
    try {
      root = path.resolve(deps!.getWorkspaceDir())
    } catch (err) {
      return { ok: false, metas: {}, error: err instanceof Error ? err.message : '工作区不可用' }
    }

    const metas: Record<string, ArtifactSidecar> = {}
    const unique = new Set<string>()
    for (const raw of paths.slice(0, MAX_PATHS)) {
      const normalized = normalizeArtifactPath(raw)
      if (normalized) unique.add(normalized)
    }
    for (const relativePath of unique) {
      const sidecar = await readOne(root, relativePath)
      if (sidecar) metas[relativePath] = sidecar
    }
    return { ok: true, metas }
  })

  // ---- 导出（多选）----
  // 主进程弹保存框、写 zip / 拷文件：大文件不进 renderer，UI 线程不参与压缩。
  ipcMain.handle(
    'artifact:export',
    async (
      _event,
      payload?: { paths?: unknown; mode?: unknown },
    ): Promise<ArtifactExportResult> => {
      const mode = payload?.mode
      if (mode !== 'zip' && mode !== 'copy' && mode !== 'save') {
        return { ok: false, exported: 0, bytes: 0, error: '导出方式非法' }
      }
      const paths = Array.isArray(payload?.paths) ? (payload.paths as unknown[]) : []
      if (paths.length === 0) return { ok: false, exported: 0, bytes: 0, error: '没有要导出的文件' }

      let root: string
      try {
        root = deps!.getWorkspaceDir()
      } catch (err) {
        return { ok: false, exported: 0, bytes: 0, error: err instanceof Error ? err.message : '工作区不可用' }
      }

      // 先解析（同时做安全闸与体积校验），再弹框——用户选完目标却导不出来最恼人
      const resolved = await resolveExportFiles(root, paths)
      if (!resolved.ok) return { ok: false, exported: 0, bytes: 0, error: resolved.error }

      const mainWindow = deps!.getMainWindow?.() ?? null
      let destPath: string | undefined
      if (mode === 'save') {
        if (resolved.files.length !== 1) {
          return { ok: false, exported: 0, bytes: 0, error: '另存为只支持单个文件' }
        }
        const options: Electron.SaveDialogOptions = {
          title: '另存为',
          defaultPath: path.basename(resolved.files[0]!.rel),
        }
        const result = mainWindow
          ? await dialog.showSaveDialog(mainWindow, options)
          : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) {
          return { ok: false, exported: 0, bytes: 0, error: '已取消' }
        }
        destPath = result.filePath
      } else if (mode === 'zip') {
        const options: Electron.SaveDialogOptions = {
          title: `导出 ${resolved.files.length} 个产物`,
          defaultPath: 'artifacts.zip',
          filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
        }
        const result = mainWindow
          ? await dialog.showSaveDialog(mainWindow, options)
          : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) {
          return { ok: false, exported: 0, bytes: 0, error: '已取消' }
        }
        destPath = result.filePath
      } else {
        const options: Electron.OpenDialogOptions = {
          title: `复制 ${resolved.files.length} 个产物到…`,
          properties: ['openDirectory', 'createDirectory'],
          buttonLabel: '复制到此文件夹',
        }
        const result = mainWindow
          ? await dialog.showOpenDialog(mainWindow, options)
          : await dialog.showOpenDialog(options)
        if (result.canceled || result.filePaths.length === 0) {
          return { ok: false, exported: 0, bytes: 0, error: '已取消' }
        }
        destPath = result.filePaths[0]
      }

      return exportArtifacts({ workspaceDir: root, relPaths: paths, mode, destPath: destPath! })
    },
  )

  // ---- 批量移入回收站（显式删除）----
  ipcMain.handle(
    'artifact:trash',
    async (_event, paths?: unknown): Promise<ArtifactTrashResult> => {
      if (!Array.isArray(paths) || paths.length === 0) {
        return { ok: false, removed: 0, bytes: 0, skipped: 0, error: '没有要删除的文件' }
      }
      let root: string
      try {
        root = deps!.getWorkspaceDir()
      } catch (err) {
        return {
          ok: false,
          removed: 0,
          bytes: 0,
          skipped: 0,
          error: err instanceof Error ? err.message : '工作区不可用',
        }
      }
      return trashPaths({ dir: root, paths: paths.slice(0, MAX_PATHS) })
    },
  )

  // ---- 就地修改（P2 编辑底座）----
  // 提议只写候选稿；应用前会校验 baseHash，文件被改过就拒绝。
  const EDIT_ACTIONS = new Set<ArtifactEditAction>([
    'manual',
    'rewrite',
    'expand',
    'shorten',
    'tone',
    'slide-title',
    'slide-bullets',
    'variant',
    'undo',
  ])

  ipcMain.handle(
    'artifact:edit:proposeText',
    async (
      _event,
      payload?: Record<string, unknown>,
    ): Promise<ArtifactEditProposal | ArtifactEditFailure> => {
      const root = workspaceRoot()
      if (!root) return { ok: false, error: '工作区不可用', code: 'unavailable' }
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: '参数非法', code: 'invalid-scope' }
      }
      const relPath = payload.path
      const { start, end, replacement } = payload
      if (
        typeof relPath !== 'string' ||
        typeof replacement !== 'string' ||
        typeof start !== 'number' ||
        typeof end !== 'number'
      ) {
        return { ok: false, error: '参数非法', code: 'invalid-scope' }
      }
      const action =
        typeof payload.action === 'string' && EDIT_ACTIONS.has(payload.action as ArtifactEditAction)
          ? (payload.action as ArtifactEditAction)
          : undefined
      const input: ProposeTextEditInput = {
        path: relPath,
        start,
        end,
        replacement,
        ...(typeof payload.sessionKey === 'string' ? { sessionKey: payload.sessionKey } : {}),
        ...(action ? { action } : {}),
        ...(typeof payload.instruction === 'string' ? { instruction: payload.instruction } : {}),
        ...(typeof payload.baseHash === 'string' ? { baseHash: payload.baseHash } : {}),
        ...(typeof payload.editId === 'string' ? { editId: payload.editId } : {}),
      }
      try {
        return await proposeTextEdit({ workspaceDir: root, input })
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : '生成候选稿失败',
        }
      }
    },
  )

  ipcMain.handle(
    'artifact:edit:propose',
    async (
      _event,
      payload?: Record<string, unknown>,
    ): Promise<ArtifactEditProposal | ArtifactEditFailure> => {
      const root = workspaceRoot()
      if (!root) return { ok: false, error: '工作区不可用', code: 'unavailable' }
      const singleTurn = deps!.singleTurn
      if (!singleTurn) {
        return { ok: false, error: '当前版本不支持 AI 改写', code: 'unavailable' }
      }
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: '参数非法', code: 'invalid-scope' }
      }
      const action = normalizeDocumentAction(payload.action)
      if (!action) return { ok: false, error: '不支持的动作', code: 'invalid-scope' }
      const { editId, path: relPath, start, end } = payload
      if (
        typeof editId !== 'string' ||
        typeof relPath !== 'string' ||
        typeof start !== 'number' ||
        typeof end !== 'number'
      ) {
        return { ok: false, error: '参数非法', code: 'invalid-scope' }
      }
      const tone: EditTone | undefined =
        payload.tone === 'formal' || payload.tone === 'casual' || payload.tone === 'confident'
          ? payload.tone
          : undefined
      try {
        return await proposeTextRangeEdit({
          workspaceDir: root,
          input: {
            editId,
            path: relPath,
            start,
            end,
            action,
            ...(tone ? { tone } : {}),
            ...(typeof payload.sessionKey === 'string' ? { sessionKey: payload.sessionKey } : {}),
            ...(typeof payload.instruction === 'string'
              ? { instruction: payload.instruction }
              : {}),
            ...(typeof payload.baseHash === 'string' ? { baseHash: payload.baseHash } : {}),
          },
          run: singleTurn,
        })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '生成改写建议失败' }
      }
    },
  )

  ipcMain.handle(
    'artifact:edit:abort',
    async (
      _event,
      payload?: { editId?: unknown },
    ): Promise<{ ok: true; aborted: boolean }> => {
      const editId = payload?.editId
      if (typeof editId !== 'string' || !editId) return { ok: true, aborted: false }
      return { ok: true, aborted: deps!.singleTurn?.abort(editId) ?? false }
    },
  )

  ipcMain.handle(
    'artifact:edit:apply',
    async (
      _event,
      payload?: { editId?: unknown },
    ): Promise<ArtifactEditApplyResult | ArtifactEditFailure> => {
      const root = workspaceRoot()
      if (!root) return { ok: false, error: '工作区不可用', code: 'unavailable' }
      try {
        return await applyEdit({
          workspaceDir: root,
          editId: payload?.editId,
          registerFile: registerAppliedFile,
        })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '应用失败' }
      }
    },
  )

  ipcMain.handle(
    'artifact:edit:discard',
    async (
      _event,
      payload?: { editId?: unknown },
    ): Promise<{ ok: true } | ArtifactEditFailure> => {
      const root = workspaceRoot()
      if (!root) return { ok: false, error: '工作区不可用', code: 'unavailable' }
      try {
        return await discardEdit({ workspaceDir: root, editId: payload?.editId })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '取消失败' }
      }
    },
  )

  ipcMain.handle(
    'artifact:edit:undo',
    async (
      _event,
      payload?: { editId?: unknown },
    ): Promise<ArtifactEditUndoResult | ArtifactEditFailure> => {
      const root = workspaceRoot()
      if (!root) return { ok: false, error: '工作区不可用', code: 'unavailable' }
      try {
        return await undoEdit({
          workspaceDir: root,
          editId: payload?.editId,
          registerFile: registerAppliedFile,
        })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '撤销失败' }
      }
    },
  )

  ipcMain.handle(
    'artifact:edits:list',
    async (
      _event,
      payload?: { sessionKey?: unknown; limit?: unknown },
    ): Promise<ArtifactEditListResult | ArtifactEditFailure> => {
      const root = workspaceRoot()
      if (!root) return { ok: false, error: '工作区不可用', code: 'unavailable' }
      if (payload?.sessionKey !== undefined && typeof payload.sessionKey !== 'string') {
        return { ok: false, error: 'sessionKey 非法', code: 'invalid-scope' }
      }
      if (payload?.limit !== undefined && typeof payload.limit !== 'number') {
        return { ok: false, error: 'limit 非法', code: 'invalid-scope' }
      }
      try {
        return await listEdits({
          workspaceDir: root,
          ...(payload?.sessionKey !== undefined ? { sessionKey: payload.sessionKey as string } : {}),
          ...(payload?.limit !== undefined ? { limit: payload.limit as number } : {}),
        })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '读取本地修改失败' }
      }
    },
  )
}
