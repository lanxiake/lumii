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
import type {
  ArtifactVersionContentResult,
  ArtifactVersionDiffResult,
  ArtifactVersionInfo,
} from '../../shared/artifact-version-types'
import type {
  ProposeSlideEditInput,
  SlideOutlineResult,
} from '../../shared/artifact-slide-types'
import type {
  ArtifactVariantResult,
  CreateVariantInput,
} from '../../shared/artifact-variant-types'
import type { LocalArtifactEdit } from '../../shared/artifact-edit-types'
import type {
  ArtifactPinFailure,
  ArtifactPinListResult,
  ArtifactPinResult,
  PinVersionInput,
} from '../../shared/artifact-pin-types'
import type { AgentRuntimeBridge } from '../agent-runtime/bridge'
import { normalizeDocumentAction } from '../artifact-edit-prompts'
import { proposeTextRangeEdit } from '../artifact-edit-llm'
import { proposeSlideEdit, readSlideOutline } from '../artifact-slides'
import { createImageVariant } from '../artifact-variant'
import {
  attachPins,
  buildMergedVersions,
  materializeVersionFile,
  readVersionBytes,
  resolveVersionContent,
} from '../artifact-versions'
import { compareVersionPair } from '../artifact-version-compare'
import {
  clearPins,
  listPins,
  pinFilePath,
  pinVersion,
  unpinVersion,
} from '../artifact-pins'
import {
  applyCheckpoint,
  planCheckpoint,
  undoCheckpoint,
  writeWorkspaceFileAtomic,
} from '../artifact-checkpoint'
import { readLocalEditBytes } from '../artifact-edit'
import { readTurnTextVersion } from '../turn-version-store'
import { getVcsService } from '../agent-runtime/vcs-accessor'
import { handleConversationFork } from './agent-runtime/conversation-commands'
import type {
  CheckpointApplyResult,
  CheckpointPlanResult,
  CheckpointUndoResult,
} from '../../shared/artifact-checkpoint-types'
import type { SingleTurnLlmService } from '../single-turn-llm'
import { getArtifactThumb, pruneThumbCache } from '../artifact-thumbnails'
import { exportArtifacts, resolveExportFiles } from '../artifact-export'
import {
  applyEdit,
  discardEdit,
  listEdits,
  proposeTextEdit,
  resolveEditTarget,
  undoEdit,
  type AppliedEditInfo,
} from '../artifact-edit'
import { restoreTrash, trashPaths } from '../workspace-cleanup'

const MAX_PATHS = 200
const MAX_SIDECAR_BYTES = 64 * 1024
const CACHE_TTL_MS = 30_000

interface ArtifactIpcDeps {
  getWorkspaceDir: () => string
  getMainWindow?: () => BrowserWindow | null
  /** 本地编辑登记 / 版本历史查询；未接时对应能力降级 */
  getAgentRuntimeBridge?: () => AgentRuntimeBridge | null
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

interface LoadedVersions {
  workspaceDir: string
  versions: readonly ArtifactVersionInfo[]
  localEdits: readonly LocalArtifactEdit[]
}

/** 版本列表（turn + local + 固化标记）；raw IPC 与命令 handler 共用同一套构建 */
async function loadArtifactVersions(
  bridge: AgentRuntimeBridge,
  sessionKey: string,
  path: string,
): Promise<{ ok: true; data: LoadedVersions } | { ok: false; reason: string }> {
  if (!bridge.conversationRepo.getConversation(sessionKey)) {
    return { ok: false, reason: '会话不存在' }
  }
  let workspaceDir: string
  try {
    workspaceDir = bridge.getCwd()
  } catch {
    return { ok: false, reason: '工作区不可用' }
  }
  const turns = bridge.conversationRepo.listFileChangeTurns(sessionKey)
  const local = workspaceDir
    ? await listEdits({ workspaceDir, sessionKey, limit: 500 })
    : { ok: true as const, edits: [] }
  const localEdits = local.ok ? local.edits : []
  try {
    const built = await buildMergedVersions({
      workspaceDir,
      path,
      turns,
      localEdits,
    })
    const pinList = await listPins({ workspaceDir, sessionKey, path })
    const versions = attachPins(built, pinList.ok ? pinList.pins : [])
    return { ok: true, data: { workspaceDir, versions, localEdits } }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : '读取版本失败' }
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
      payload?: {
        paths?: unknown
        mode?: unknown
        versionId?: unknown
        sessionKey?: unknown
      },
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

      // 导出「选定版」：先把该版物化成临时文件，再走现有导出；完成后清理临时目录
      let exportRelPaths: readonly unknown[] = paths
      let materializedDir: string | null = null
      if (payload?.versionId !== undefined) {
        const versionId = payload.versionId
        const sessionKey = payload.sessionKey
        if (typeof versionId !== 'string' || !versionId) {
          return { ok: false, exported: 0, bytes: 0, error: '版本标识非法' }
        }
        if (typeof sessionKey !== 'string' || !sessionKey) {
          return { ok: false, exported: 0, bytes: 0, error: '缺少会话信息，无法导出历史版本' }
        }
        if (paths.length !== 1) {
          return { ok: false, exported: 0, bytes: 0, error: '导出选定版只支持单个文件' }
        }
        // 物化副本在 `.lumii/exports/...` 下；打进 zip 会把这串临时目录带进包内，
        // 所以历史版本只提供「另存为」（动作条也是这么用的）。
        if (mode !== 'save') {
          return { ok: false, exported: 0, bytes: 0, error: '导出选定版只支持另存为' }
        }
        const relPath = normalizeArtifactPath(paths[0])
        if (!relPath) return { ok: false, exported: 0, bytes: 0, error: '路径不合法' }
        const bridge = deps!.getAgentRuntimeBridge?.()
        if (!bridge) return { ok: false, exported: 0, bytes: 0, error: 'Agent Runtime 未就绪' }
        const loaded = await loadArtifactVersions(bridge, sessionKey, relPath)
        if (!loaded.ok) return { ok: false, exported: 0, bytes: 0, error: loaded.reason }
        const version = loaded.data.versions.find((item) => item.versionId === versionId)
        if (!version) return { ok: false, exported: 0, bytes: 0, error: '找不到指定的版本' }
        const materialized = await materializeVersionFile({
          workspaceDir: loaded.data.workspaceDir,
          path: relPath,
          version,
          allVersions: loaded.data.versions,
          localEdits: loaded.data.localEdits,
        })
        if (!materialized.ok) {
          return { ok: false, exported: 0, bytes: 0, error: materialized.reason }
        }
        exportRelPaths = [materialized.rel]
        materializedDir = path.dirname(
          path.join(loaded.data.workspaceDir, ...materialized.rel.split('/')),
        )
      }

      // 先解析（同时做安全闸与体积校验），再弹框——用户选完目标却导不出来最恼人
      const resolved = await resolveExportFiles(root, exportRelPaths)
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

      try {
        return await exportArtifacts({
          workspaceDir: root,
          relPaths: exportRelPaths,
          mode,
          destPath: destPath!,
        })
      } finally {
        // 只清本次物化的临时版本目录；每日清理兜底
        if (materializedDir) {
          await fs.rm(materializedDir, { recursive: true, force: true }).catch(() => undefined)
        }
      }
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

      // PPT 单页：动作不同，走 python-pptx 候选
      if (payload.action === 'slide-title' || payload.action === 'slide-bullets') {
        const { editId, path: relPath, index } = payload
        if (
          typeof editId !== 'string' ||
          typeof relPath !== 'string' ||
          typeof index !== 'number' ||
          !Number.isInteger(index) ||
          index < 0
        ) {
          return { ok: false, error: '参数非法', code: 'invalid-scope' }
        }
        const input: ProposeSlideEditInput = {
          editId,
          path: relPath,
          index,
          action: payload.action,
          ...(typeof payload.sessionKey === 'string' ? { sessionKey: payload.sessionKey } : {}),
          ...(typeof payload.instruction === 'string' ? { instruction: payload.instruction } : {}),
        }
        try {
          return await proposeSlideEdit({ workspaceDir: root, input, run: singleTurn })
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : '生成 PPT 改写建议失败',
          }
        }
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

  // ---- 图片同源变体（P2 T5）----
  ipcMain.handle(
    'artifact:variant',
    async (
      _event,
      payload?: Partial<CreateVariantInput>,
    ): Promise<ArtifactVariantResult | ArtifactEditFailure> => {
      const root = workspaceRoot()
      if (!root) return { ok: false, error: '工作区不可用', code: 'unavailable' }
      const bridge = deps!.getAgentRuntimeBridge?.()
      if (!bridge) return { ok: false, error: 'Agent Runtime 未就绪', code: 'unavailable' }
      if (
        !payload ||
        typeof payload.path !== 'string' ||
        !payload.path ||
        typeof payload.model !== 'string' ||
        typeof payload.sourcePrompt !== 'string'
      ) {
        return { ok: false, error: '参数非法', code: 'invalid-scope' }
      }
      if (
        payload.width !== undefined &&
        (typeof payload.width !== 'number' || !Number.isFinite(payload.width))
      ) {
        return { ok: false, error: '参数非法', code: 'invalid-scope' }
      }
      if (
        payload.height !== undefined &&
        (typeof payload.height !== 'number' || !Number.isFinite(payload.height))
      ) {
        return { ok: false, error: '参数非法', code: 'invalid-scope' }
      }
      if (payload.instruction !== undefined && typeof payload.instruction !== 'string') {
        return { ok: false, error: '参数非法', code: 'invalid-scope' }
      }
      try {
        return await createImageVariant({
          workspaceDir: root,
          input: {
            path: payload.path,
            model: payload.model,
            sourcePrompt: payload.sourcePrompt,
            ...(typeof payload.sessionKey === 'string' ? { sessionKey: payload.sessionKey } : {}),
            ...(payload.width !== undefined ? { width: payload.width } : {}),
            ...(payload.height !== undefined ? { height: payload.height } : {}),
            ...(payload.instruction !== undefined ? { instruction: payload.instruction } : {}),
          },
          generateImage: (params) => bridge.generateImage(params),
          registerFile: (info) =>
            registerAppliedFile({
              editId: info.editId,
              sessionKey: info.sessionKey,
              path: info.path,
              absPath: info.absPath,
              action: 'variant',
              bytes: info.bytes,
              derivedFrom: info.derivedFrom,
            }),
        })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '生成变体失败' }
      }
    },
  )

  // ---- PPT 页列表（P2 T4）----
  ipcMain.handle(
    'artifact:slidesOutline',
    async (_event, payload?: { path?: unknown }): Promise<SlideOutlineResult> => {
      const root = workspaceRoot()
      if (!root) return { ok: false, error: '工作区不可用' }
      if (!payload || typeof payload.path !== 'string' || !payload.path) {
        return { ok: false, error: '参数非法' }
      }
      const target = await resolveEditTarget(root, payload.path)
      if (!target) return { ok: false, error: '目标文件不存在或不在工作区内' }
      try {
        return await readSlideOutline(target.abs)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '读取 PPT 页列表失败' }
      }
    },
  )

  // ---- 版本对照 / 单版内容（P2 T3）----
  ipcMain.handle(
    'artifact:versionDiff',
    async (
      _event,
      payload?: {
        sessionKey?: unknown
        path?: unknown
        fromVersionId?: unknown
        toVersionId?: unknown
        fromLabel?: unknown
        toLabel?: unknown
      },
    ): Promise<ArtifactVersionDiffResult> => {
      const sessionKey = payload?.sessionKey
      const relPath = payload?.path
      const fromId = payload?.fromVersionId
      const toId = payload?.toVersionId
      if (
        typeof sessionKey !== 'string' ||
        !sessionKey ||
        typeof relPath !== 'string' ||
        !relPath ||
        typeof fromId !== 'string' ||
        !fromId ||
        typeof toId !== 'string' ||
        !toId
      ) {
        return { ok: false, reason: '参数非法' }
      }
      const bridge = deps!.getAgentRuntimeBridge?.()
      if (!bridge) return { ok: false, reason: 'Agent Runtime 未就绪' }
      const loaded = await loadArtifactVersions(bridge, sessionKey, relPath)
      if (!loaded.ok) return { ok: false, reason: loaded.reason }
      const from = loaded.data.versions.find((version) => version.versionId === fromId)
      const to = loaded.data.versions.find((version) => version.versionId === toId)
      if (!from || !to) return { ok: false, reason: '找不到指定的版本' }

      return compareVersionPair({
        workspaceDir: loaded.data.workspaceDir,
        path: relPath,
        from,
        to,
        allVersions: loaded.data.versions,
        localEdits: loaded.data.localEdits,
        fromLabel: typeof payload?.fromLabel === 'string' ? payload.fromLabel : '起始版',
        toLabel: typeof payload?.toLabel === 'string' ? payload.toLabel : '目标版',
      })
    },
  )

  ipcMain.handle(
    'artifact:versionContent',
    async (
      _event,
      payload?: { sessionKey?: unknown; path?: unknown; versionId?: unknown },
    ): Promise<ArtifactVersionContentResult> => {
      const sessionKey = payload?.sessionKey
      const relPath = payload?.path
      const versionId = payload?.versionId
      if (
        typeof sessionKey !== 'string' ||
        !sessionKey ||
        typeof relPath !== 'string' ||
        !relPath ||
        typeof versionId !== 'string' ||
        !versionId
      ) {
        return { ok: false, reason: '参数非法' }
      }
      const bridge = deps!.getAgentRuntimeBridge?.()
      if (!bridge) return { ok: false, reason: 'Agent Runtime 未就绪' }
      const loaded = await loadArtifactVersions(bridge, sessionKey, relPath)
      if (!loaded.ok) return { ok: false, reason: loaded.reason }
      const version = loaded.data.versions.find((item) => item.versionId === versionId)
      if (!version) return { ok: false, reason: '找不到指定的版本' }
      const resolved = await resolveVersionContent({
        workspaceDir: loaded.data.workspaceDir,
        path: relPath,
        version,
        allVersions: loaded.data.versions,
      })
      if (!resolved.ok) return { ok: false, reason: resolved.reason }
      return {
        ok: true,
        text: resolved.content.text,
        ...(resolved.content.approximate ? { approximate: true } : {}),
      }
    },
  )

  // ---- 固化「以此为准」（P2 T6）----
  ipcMain.handle(
    'artifact:pinVersion',
    async (
      _event,
      payload?: Partial<PinVersionInput>,
    ): Promise<ArtifactPinResult | ArtifactPinFailure> => {
      const root = workspaceRoot()
      if (!root) return { ok: false, error: '工作区不可用', code: 'unavailable' }
      const relPath = payload?.path
      const versionId = payload?.versionId
      if (typeof relPath !== 'string' || !relPath || typeof versionId !== 'string' || !versionId) {
        return { ok: false, error: '参数非法', code: 'invalid-scope' }
      }
      const sessionKey =
        typeof payload?.sessionKey === 'string' && payload.sessionKey.trim()
          ? payload.sessionKey
          : null
      if (!sessionKey) {
        return { ok: false, error: '缺少会话信息，无法固化版本', code: 'invalid-scope' }
      }
      const bridge = deps!.getAgentRuntimeBridge?.()
      if (!bridge) return { ok: false, error: 'Agent Runtime 未就绪', code: 'unavailable' }
      const loaded = await loadArtifactVersions(bridge, sessionKey, relPath)
      if (!loaded.ok) return { ok: false, error: loaded.reason, code: 'not-found' }
      const version = loaded.data.versions.find((item) => item.versionId === versionId)
      if (!version) return { ok: false, error: '找不到指定的版本', code: 'not-found' }
      const bytes = await readVersionBytes({
        workspaceDir: loaded.data.workspaceDir,
        path: relPath,
        version,
        allVersions: loaded.data.versions,
        localEdits: loaded.data.localEdits,
      })
      if (!bytes.ok) return { ok: false, error: bytes.reason, code: 'unavailable' }
      return pinVersion({
        workspaceDir: loaded.data.workspaceDir,
        sessionKey,
        path: relPath,
        versionId,
        content: bytes.bytes,
      })
    },
  )

  ipcMain.handle(
    'artifact:unpin',
    async (
      _event,
      payload?: { pinId?: unknown },
    ): Promise<{ ok: true } | ArtifactPinFailure> => {
      const root = workspaceRoot()
      if (!root) return { ok: false, error: '工作区不可用', code: 'unavailable' }
      if (typeof payload?.pinId !== 'string' || !payload.pinId) {
        return { ok: false, error: 'pinId 非法', code: 'invalid-scope' }
      }
      return unpinVersion({ workspaceDir: root, pinId: payload.pinId })
    },
  )

  ipcMain.handle(
    'artifact:pins',
    async (
      _event,
      payload?: { sessionKey?: unknown; path?: unknown },
    ): Promise<ArtifactPinListResult> => {
      const root = workspaceRoot()
      if (!root) return { ok: false, error: '工作区不可用', code: 'unavailable' }
      if (payload?.path !== undefined && typeof payload.path !== 'string') {
        return { ok: false, error: '路径非法', code: 'invalid-scope' }
      }
      if (payload?.sessionKey !== undefined && typeof payload.sessionKey !== 'string') {
        return { ok: false, error: 'sessionKey 非法', code: 'invalid-scope' }
      }
      return listPins({
        workspaceDir: root,
        ...(typeof payload?.sessionKey === 'string' ? { sessionKey: payload.sessionKey } : {}),
        ...(typeof payload?.path === 'string' ? { path: payload.path } : {}),
      })
    },
  )

  ipcMain.handle(
    'artifact:pins:clear',
    async (): Promise<{ ok: true; removed: number; freedBytes: number } | ArtifactPinFailure> => {
      const root = workspaceRoot()
      if (!root) return { ok: false, error: '工作区不可用', code: 'unavailable' }
      return clearPins({ workspaceDir: root })
    },
  )

  // ---- 恢复到这一轮（P2 T7）----
  interface CheckpointContext {
    bridge: AgentRuntimeBridge
    workspaceDir: string
    sessionKey: string
    turns: ReturnType<AgentRuntimeBridge['conversationRepo']['listFileChangeTurns']>
    localEdits: readonly LocalArtifactEdit[]
    pins: readonly import('../../shared/artifact-pin-types').PinEntryInfo[]
  }

  async function loadCheckpointContext(
    sessionKey: unknown,
  ): Promise<
    | { ok: true; data: CheckpointContext }
    | { ok: false; result: { ok: false; error: string; code?: ArtifactEditFailure['code'] } }
  > {
    if (typeof sessionKey !== 'string' || !sessionKey) {
      return { ok: false, result: { ok: false, error: '参数非法', code: 'invalid-scope' } }
    }
    const bridge = deps!.getAgentRuntimeBridge?.()
    if (!bridge) {
      return { ok: false, result: { ok: false, error: 'Agent Runtime 未就绪', code: 'unavailable' } }
    }
    if (!bridge.conversationRepo.getConversation(sessionKey)) {
      return { ok: false, result: { ok: false, error: '会话不存在', code: 'not-found' } }
    }
    let workspaceDir: string
    try {
      workspaceDir = bridge.getCwd()
    } catch {
      return { ok: false, result: { ok: false, error: '工作区不可用', code: 'unavailable' } }
    }
    const turns = bridge.conversationRepo.listFileChangeTurns(sessionKey)
    const local = await listEdits({ workspaceDir, sessionKey, limit: 500 })
    const pinList = await listPins({ workspaceDir, sessionKey })
    return {
      ok: true,
      data: {
        bridge,
        workspaceDir,
        sessionKey,
        turns,
        localEdits: local.ok ? local.edits : [],
        pins: pinList.ok ? pinList.pins : [],
      },
    }
  }

  ipcMain.handle(
    'artifact:checkpoint:plan',
    async (
      _event,
      payload?: { sessionKey?: unknown; turnId?: unknown },
    ): Promise<CheckpointPlanResult> => {
      const ctx = await loadCheckpointContext(payload?.sessionKey)
      if (!ctx.ok) return ctx.result
      const turnId = payload?.turnId
      if (typeof turnId !== 'string' || !turnId) {
        return { ok: false, error: '参数非法', code: 'invalid-scope' }
      }
      const { bridge, workspaceDir, sessionKey, turns, localEdits, pins } = ctx.data
      const vcs = getVcsService()
      return planCheckpoint({
        workspaceDir,
        sessionKey,
        turnId,
        turns,
        localEdits,
        pins,
        vcs: vcs
          ? {
              lastCommitForPath: (filePath) => vcs.lastCommitForPath(workspaceDir, filePath),
              readFileAt: (oid, filePath) => vcs.readFileAt(workspaceDir, oid, filePath),
            }
          : null,
        ownerOf: (filePath) => {
          try {
            return bridge.fileRepo.findLatestOwner(filePath)?.conversationId ?? null
          } catch {
            return null
          }
        },
        canRestoreConversation: typeof bridge.conversationRepo.forkConversation === 'function',
      })
    },
  )

  ipcMain.handle(
    'artifact:checkpoint:apply',
    async (
      _event,
      payload?: {
        sessionKey?: unknown
        turnId?: unknown
        restoreConversation?: unknown
      },
    ): Promise<CheckpointApplyResult | ArtifactEditFailure> => {
      const ctx = await loadCheckpointContext(payload?.sessionKey)
      if (!ctx.ok) return ctx.result
      const turnId = payload?.turnId
      if (typeof turnId !== 'string' || !turnId) {
        return { ok: false, error: '参数非法', code: 'invalid-scope' }
      }
      const { bridge, workspaceDir, sessionKey, turns, localEdits, pins } = ctx.data
      const vcs = getVcsService()
      // 服务端重建计划：预览与真正动手之间工作区可能又变了
      const planned = await planCheckpoint({
        workspaceDir,
        sessionKey,
        turnId,
        turns,
        localEdits,
        pins,
        vcs: vcs
          ? {
              lastCommitForPath: (filePath) => vcs.lastCommitForPath(workspaceDir, filePath),
              readFileAt: (oid, filePath) => vcs.readFileAt(workspaceDir, oid, filePath),
            }
          : null,
        ownerOf: (filePath) => {
          try {
            return bridge.fileRepo.findLatestOwner(filePath)?.conversationId ?? null
          } catch {
            return null
          }
        },
        canRestoreConversation: typeof bridge.conversationRepo.forkConversation === 'function',
      })
      if (!planned.ok) return planned

      return applyCheckpoint({
        workspaceDir,
        sessionKey,
        turnId,
        plan: planned.plan,
        restoreConversation: payload?.restoreConversation !== false,
        deps: {
          vcs: vcs
            ? {
                commit: (message, author) => vcs.commit(workspaceDir, message, author),
                revertFile: (oid, filePath) => vcs.revertFile(workspaceDir, oid, filePath),
              }
            : null,
          readEditBytes: (editId) =>
            readLocalEditBytes({ workspaceDir, editId, which: 'before' }),
          readTurnStoreBytes: async (messageId, filePath) => {
            const text = await readTurnTextVersion({ workspaceDir, messageId, path: filePath })
            return text === null ? null : Buffer.from(text, 'utf8')
          },
          readPinBytes: async (pinId) => {
            const pin = pins.find((entry) => entry.pinId === pinId)
            if (!pin) return null
            try {
              return await fs.readFile(pinFilePath(workspaceDir, pin))
            } catch {
              return null
            }
          },
          writeFile: (filePath, bytes) =>
            writeWorkspaceFileAtomic(workspaceDir, filePath, bytes),
          // 用户显式动作、批量小：给足引用校验预算（默认 3s 在 1GB 工作区会被截断）
          trash: (paths) => trashPaths({ dir: workspaceDir, paths, budgetMs: 20_000 }),
          forkConversation: async (uptoMessageId) => {
            const result = await handleConversationFork(bridge, {
              type: 'conversation:fork',
              sourceSessionKey: sessionKey,
              uptoMessageId,
            })
            return {
              ok: result.success,
              ...(result.sessionKey ? { sessionKey: result.sessionKey } : {}),
              ...(result.error ? { error: result.error } : {}),
            }
          },
        },
      })
    },
  )

  ipcMain.handle(
    'artifact:checkpoint:undo',
    async (
      _event,
      payload?: { checkpointId?: unknown },
    ): Promise<CheckpointUndoResult | ArtifactEditFailure> => {
      const root = workspaceRoot()
      if (!root) return { ok: false, error: '工作区不可用', code: 'unavailable' }
      if (typeof payload?.checkpointId !== 'string' || !payload.checkpointId) {
        return { ok: false, error: '参数非法', code: 'invalid-scope' }
      }
      const vcs = getVcsService()
      return undoCheckpoint({
        workspaceDir: root,
        checkpointId: payload.checkpointId,
        deps: {
          vcs: vcs
            ? { revertFile: (oid, filePath) => vcs.revertFile(root, oid, filePath) }
            : null,
          restoreTrash: (batchId) => restoreTrash({ dir: root, id: batchId }),
        },
      })
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
