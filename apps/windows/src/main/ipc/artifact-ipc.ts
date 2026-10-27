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
import { getArtifactThumb, pruneThumbCache } from '../artifact-thumbnails'
import { exportArtifacts, resolveExportFiles } from '../artifact-export'
import { trashPaths } from '../workspace-cleanup'

const MAX_PATHS = 200
const MAX_SIDECAR_BYTES = 64 * 1024
const CACHE_TTL_MS = 30_000

interface ArtifactIpcDeps {
  getWorkspaceDir: () => string
  getMainWindow?: () => BrowserWindow | null
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
}
