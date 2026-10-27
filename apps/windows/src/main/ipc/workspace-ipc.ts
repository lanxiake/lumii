/**
 * 工作空间相关 IPC handlers
 */
import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { resolveClientStateDir } from '../paths'
import type { ConfigManager } from '../config-manager'
import type { DirectoryManager } from '../directory-manager'
import { securityUtils } from '../security-utils'
import { ensureWorkspaceTempLayout } from '../workspace-paths'
import { listTrash, restoreTrash, runCleanup, scanWorkspace } from '../workspace-cleanup'
import { applyDedupe, planDedupe } from '../workspace-dedupe'
import { getStorageCleanupPrefs } from '../storage-cleanup-prefs'
import { normalizeStorageCleanupPrefs, runScheduledCleanup } from '../workspace-cleanup-runner'
import { readCleanupHistory } from '../workspace-cleanup-history'
import { resolveLogsDir } from '../paths'
import type {
  CleanupRunResult,
  CleanupScanResponse,
  CleanupTrashEntry,
} from '../../shared/workspace-cleanup-types'
import type {
  DedupeApplyResult,
  DedupeFailure,
  DedupePlanResult,
} from '../../shared/workspace-dedupe-types'

interface WorkspaceIpcDeps {
  getMainWindow: () => BrowserWindow | null
  getConfigManager: () => ConfigManager | null
  getDirectoryManager: () => DirectoryManager
  reapplyCodingDevAcpEnv: () => void
  pluginEventBus?: import('@mtbot/plugin-core').EventBus<import('../kernel/events').MainEvents> | null
}

let deps: WorkspaceIpcDeps | null = null

export function setWorkspaceIpcDeps(d: WorkspaceIpcDeps): void {
  deps = d
}

/**
 * 解析当前生效的工作空间根目录
 */
function resolveActiveWorkspaceDir(): string {
  if (!deps) throw new Error('WorkspaceIpc deps not set')
  const mtbotDataDir = resolveClientStateDir()
  const defaultWorkspace = join(mtbotDataDir, 'workspace')
  const configured = deps.getConfigManager()?.getAppConfig().workspaceDirectory
  return configured || defaultWorkspace
}

export function registerWorkspaceIpcHandlers(): void {
  if (!deps) throw new Error('WorkspaceIpc deps not set')

  ipcMain.handle('workspace:getDir', async () => {
    return resolveActiveWorkspaceDir().replace(/\\/g, '/')
  })

  ipcMain.handle('workspace:setDir', async (_event, dirPath: string) => {
    if (typeof dirPath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    // 空字符串表示恢复默认
    if (dirPath !== '') {
      // 验证目录是否存在
      try {
        const stat = await fs.stat(dirPath)
        if (!stat.isDirectory()) {
          throw new Error('指定路径不是目录')
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error('目录不存在')
        }
        throw err
      }
    }

    const mtbotDataDir = resolveClientStateDir()
    const defaultWorkspace = join(mtbotDataDir, 'workspace')
    const resolved = dirPath !== '' ? dirPath : defaultWorkspace
    // 与 notifyChanged 对齐：校验通过后立即写入主进程权威配置。
    // 注意必须写**默认路径本身**，不能写 undefined：ConfigManager.mergeSection
    // 会过滤 undefined，写回默认时会保留上一次的自定义路径（getDir 仍指向旧目录）。
    const configManager = deps!.getConfigManager()
    if (configManager) {
      await configManager.updateAppConfig({ workspaceDirectory: resolved })
    }
    deps!.reapplyCodingDevAcpEnv()
    ensureWorkspaceTempLayout(resolved)
    deps!.pluginEventBus?.emit('workspace:changed', { oldDir: null, newDir: resolved, at: Date.now() })
    return (resolved).replace(/\\/g, '/')
  })

  /**
   * 工作空间路径已变更（用户保存设置后调用），立即重连节点使新路径生效
   * @param newDirPath 新路径；空字符串表示恢复默认路径
   */
  ipcMain.handle('workspace:notifyChanged', async (_event, newDirPath?: string) => {
    const mtbotDataDir = resolveClientStateDir()
    const defaultWorkspace = join(mtbotDataDir, 'workspace')
    const resolved =
      newDirPath !== undefined && newDirPath !== ''
        ? newDirPath
        : defaultWorkspace

    // 同步保存到 ConfigManager（主进程权威来源）；默认路径也要显式写，
    // 否则 mergeSection 过滤 undefined 会保留旧的自定义路径（见 setDir）。
    const configManager = deps!.getConfigManager()
    if (configManager) {
      await configManager.updateAppConfig({ workspaceDirectory: resolved })
    }
    deps!.reapplyCodingDevAcpEnv()
    ensureWorkspaceTempLayout(resolved)
    deps!.pluginEventBus?.emit('workspace:changed', { oldDir: null, newDir: resolved, at: Date.now() })
    // 灵栖/Lumii 独立版：无网关/节点连接，工作空间变更仅更新本地配置，Agent 运行时通过 getCwd 读取新路径
  })

  ipcMain.handle('workspace:selectDir', async (_event, currentPath?: string) => {
    const mainWindow = deps!.getMainWindow()
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择工作空间目录',
      defaultPath: currentPath,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '选择此文件夹',
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle('workspace:ensureDir', async (_event, dirPath: string) => {
    if (typeof dirPath !== 'string' || dirPath.length === 0) {
      throw new Error('路径必须是非空字符串')
    }
    // 确保工作空间根目录及标准子目录结构存在
    await fs.mkdir(dirPath, { recursive: true })
    await deps!.getDirectoryManager().ensureWorkspaceSubDirs(dirPath)
    ensureWorkspaceTempLayout(dirPath)
    // 将工作空间路径加入安全白名单，允许文件操作访问
    securityUtils.addAllowedBasePath(dirPath)
    return dirPath
  })

  // ---- 清理（P0 手动；TTL/配额自动在 P1）----
  // 主线程不阻塞：服务内部全程 fs.promises + 时间预算；错误一律结构化返回。
  ipcMain.handle(
    'workspace:cleanup:scan',
    async (_event, opts?: { budgetMs?: number }): Promise<CleanupScanResponse> => {
      try {
        const scan = await scanWorkspace({
          dir: resolveActiveWorkspaceDir(),
          ...(typeof opts?.budgetMs === 'number' ? { budgetMs: opts.budgetMs } : {}),
        })
        return { ok: true, scan }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '扫描失败' }
      }
    },
  )

  ipcMain.handle(
    'workspace:cleanup:run',
    async (
      _event,
      payload?: { target?: unknown; dryRun?: unknown; protectedPaths?: unknown },
    ): Promise<CleanupRunResult> => {
      const target = payload?.target
      if (target !== 'intermediate' && target !== 'ephemeral' && target !== 'both') {
        return { ok: false, dryRun: true, removed: 0, bytes: 0, skipped: 0, error: 'target 非法' }
      }
      const protectedPaths = Array.isArray(payload?.protectedPaths)
        ? payload.protectedPaths
            .filter((item): item is string => typeof item === 'string')
            .slice(0, 500)
        : undefined
      return runCleanup({
        dir: resolveActiveWorkspaceDir(),
        target,
        dryRun: payload?.dryRun === true,
        ...(protectedPaths ? { protectedPaths } : {}),
      })
    },
  )

  ipcMain.handle('workspace:cleanup:listTrash', async (): Promise<CleanupTrashEntry[]> => {
    return listTrash({ dir: resolveActiveWorkspaceDir() })
  })

  // ── 存储与自动清理（设置页「存储」）──
  /** 当前策略（缺省=默认值） */
  ipcMain.handle('workspace:cleanup:getPrefs', async () => getStorageCleanupPrefs())

  /** 保存策略：只落归一化后的合法字段 */
  ipcMain.handle('workspace:cleanup:setPrefs', async (_event, raw?: unknown) => {
    const prefs = normalizeStorageCleanupPrefs(raw)
    const configManager = deps!.getConfigManager()
    if (configManager) await configManager.updateAppConfig({ storageCleanup: prefs })
    return { ok: true, prefs }
  })

  /** 立即清理：用户显式点了，不等系统空闲；其余安全闸不变 */
  ipcMain.handle('workspace:cleanup:runNow', async () => {
    return runScheduledCleanup({
      dir: resolveActiveWorkspaceDir(),
      prefs: { ...getStorageCleanupPrefs(), enabled: true },
      idleSeconds: Number.MAX_SAFE_INTEGER,
      logDir: resolveLogsDir(),
    })
  })

  /** 最近清理记录（审计 jsonl 尾部） */
  ipcMain.handle('workspace:cleanup:history', async (_event, limit?: unknown) => {
    const count = typeof limit === 'number' && limit > 0 ? Math.min(500, Math.floor(limit)) : 50
    return readCleanupHistory(resolveLogsDir(), count)
  })

  // ── 中间产物内容去重（P2 T9；只手动触发）──
  ipcMain.handle(
    'workspace:cleanup:dedupePlan',
    async (_event, opts?: { budgetMs?: number }): Promise<DedupePlanResult | DedupeFailure> => {
      try {
        return await planDedupe({
          dir: resolveActiveWorkspaceDir(),
          ...(typeof opts?.budgetMs === 'number' ? { budgetMs: opts.budgetMs } : {}),
        })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '扫描重复内容失败' }
      }
    },
  )

  ipcMain.handle(
    'workspace:cleanup:dedupeApply',
    async (): Promise<DedupeApplyResult | DedupeFailure> => {
      try {
        return await applyDedupe({
          dir: resolveActiveWorkspaceDir(),
          logDir: resolveLogsDir(),
        })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '去重失败' }
      }
    },
  )

  ipcMain.handle(
    'workspace:cleanup:restore',
    async (_event, id?: unknown) => {
      if (typeof id !== 'string' || id.length === 0) {
        return { ok: false, restored: 0, conflicts: 0, error: '回收站 id 非法' }
      }
      return restoreTrash({ dir: resolveActiveWorkspaceDir(), id })
    },
  )

}

