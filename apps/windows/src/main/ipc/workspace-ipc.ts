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

interface WorkspaceIpcDeps {
  getMainWindow: () => BrowserWindow | null
  getConfigManager: () => ConfigManager | null
  getDirectoryManager: () => DirectoryManager
  reapplyCodingDevAcpEnv: () => void
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
    // 与 notifyChanged 对齐：校验通过后立即写入主进程权威配置
    const configManager = deps!.getConfigManager()
    if (configManager) {
      await configManager.updateAppConfig({
        workspaceDirectory: resolved !== defaultWorkspace ? resolved : undefined,
      })
    }
    deps!.reapplyCodingDevAcpEnv()
    ensureWorkspaceTempLayout(resolved)
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

    // 同步保存到 ConfigManager（主进程权威来源）
    const configManager = deps!.getConfigManager()
    if (configManager) {
      await configManager.updateAppConfig({ workspaceDirectory: resolved !== defaultWorkspace ? resolved : undefined })
    }
    deps!.reapplyCodingDevAcpEnv()
    ensureWorkspaceTempLayout(resolved)
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

  /**
   * 会话重命名后，将"未归类/threadId"自动归档到任务目录。
   */
  ipcMain.handle('workspace:sessionRenamed', async (_event, threadId: string, newTitle: string) => {
    if (typeof threadId !== 'string' || threadId.trim().length === 0) {
      throw new Error('threadId 必须是非空字符串')
    }
    if (typeof newTitle !== 'string' || newTitle.trim().length === 0) {
      throw new Error('newTitle 必须是非空字符串')
    }
    await deps!.getDirectoryManager().renameTaskDirectory(threadId.trim(), newTitle.trim())
    return true
  })

  /**
   * 确保 thread 目录存在，供父/子 Agent 共享 workspace。
   */
  ipcMain.handle('workspace:ensureThreadDir', async (_event, threadId: string) => {
    if (typeof threadId !== 'string' || threadId.trim().length === 0) {
      throw new Error('threadId 必须是非空字符串')
    }
    const dirs = await deps!.getDirectoryManager().ensureThreadDirectories(threadId)
    securityUtils.addAllowedBasePath(dirs.root)
    return {
      root: dirs.root.replace(/\\/g, '/'),
      workspace: dirs.workspace.replace(/\\/g, '/'),
      uploads: dirs.uploads.replace(/\\/g, '/'),
      outputs: dirs.outputs.replace(/\\/g, '/'),
    }
  })
}

