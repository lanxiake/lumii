/**
 * 文件和系统操作相关 IPC handlers
 */
import { ipcMain, app, shell } from 'electron'
import { extname } from 'path'
import { promises as fs, existsSync } from 'fs'
import type { SystemService } from '../system-service'
import { validateUrl } from '../security-utils'
import { fileLogger } from '../file-logger'
import { openExternalWithFallback } from '../window/in-app-browser'

interface FileSystemIpcDeps {
  getSystemService: () => SystemService | null
  log: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
  }
}

let deps: FileSystemIpcDeps | null = null

export function setFileSystemIpcDeps(d: FileSystemIpcDeps): void {
  deps = d
}

export function registerFileSystemIpcHandlers(): void {
  if (!deps) throw new Error('FileSystemIpc deps not set')

  // === 文件操作 ===
  // 注意：文件操作的路径验证已在 SystemService 中实现
  ipcMain.handle('file:list', async (_event, dirPath: string) => {
    if (typeof dirPath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    return deps!.getSystemService()?.listDirectory(dirPath)
  })

  ipcMain.handle('file:read', async (_event, filePath: string) => {
    if (typeof filePath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    return deps!.getSystemService()?.readFile(filePath)
  })

  ipcMain.handle('file:write', async (_event, filePath: string, content: string) => {
    if (typeof filePath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    if (typeof content !== 'string') {
      throw new Error('内容必须是字符串')
    }
    // 限制写入内容大小
    if (content.length > 10 * 1024 * 1024) {
      throw new Error('写入内容超出大小限制 (10MB)')
    }
    return deps!.getSystemService()?.writeFile(filePath, content)
  })

  ipcMain.handle('file:move', async (_event, sourcePath: string, destPath: string) => {
    if (typeof sourcePath !== 'string' || typeof destPath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    return deps!.getSystemService()?.moveFile(sourcePath, destPath)
  })

  ipcMain.handle('file:copy', async (_event, sourcePath: string, destPath: string) => {
    if (typeof sourcePath !== 'string' || typeof destPath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    return deps!.getSystemService()?.copyFile(sourcePath, destPath)
  })

  ipcMain.handle('file:delete', async (_event, filePath: string) => {
    if (typeof filePath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    return deps!.getSystemService()?.deleteFile(filePath)
  })

  ipcMain.handle('file:createDir', async (_event, dirPath: string) => {
    if (typeof dirPath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    return deps!.getSystemService()?.createDirectory(dirPath)
  })

  ipcMain.handle('file:exists', async (_event, filePath: string) => {
    if (typeof filePath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    return deps!.getSystemService()?.exists(filePath)
  })

  ipcMain.handle('file:getInfo', async (_event, filePath: string) => {
    if (typeof filePath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    return deps!.getSystemService()?.getFileInfo(filePath)
  })

  ipcMain.handle('file:search', async (_event, dirPath: string, pattern: string, options?: unknown) => {
    if (typeof dirPath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    // 类型筛选可传空 pattern（由 extensions 驱动）；关键词 pattern 放宽上限
    if (typeof pattern !== 'string' || pattern.length > 500) {
      throw new Error('搜索模式无效')
    }
    return deps!.getSystemService()?.searchFiles(
      dirPath,
      pattern,
      options as {
        recursive?: boolean
        maxResults?: number
        extensions?: readonly string[]
        skipDirs?: readonly string[]
      },
    )
  })

  // === 系统信息 ===
  ipcMain.handle('system:getInfo', () => {
    return deps!.getSystemService()?.getSystemInfo()
  })

  ipcMain.handle('system:getDiskInfo', async () => {
    return deps!.getSystemService()?.getDiskInfo()
  })

  ipcMain.handle('system:getUserPaths', () => {
    return deps!.getSystemService()?.getUserPaths()
  })

  // === 应用相关 ===
  ipcMain.handle('app:getVersion', () => app.getVersion())

  ipcMain.handle('app:openExternal', async (_event, url: string) => {
    // 验证 URL 安全性
    const safeUrl = validateUrl(url, { allowedProtocols: ['http:', 'https:'] })
    // 系统无默认浏览器（关联失效）时退回应用内浏览器窗口，不让点击静默失败
    await openExternalWithFallback(safeUrl, (message) => deps!.log.warn(message))
  })

  ipcMain.handle('app:showItemInFolder', (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) {
      throw new Error('文件路径无效')
    }
    shell.showItemInFolder(filePath)
  })

  /**
   * 在资源管理器中打开当前应用日志文件（便于用户排查问题）
   */
  ipcMain.handle('app:openLogFile', async () => {
    const logFile = fileLogger.getCurrentLogFilePath()
    if (logFile && existsSync(logFile)) {
      shell.showItemInFolder(logFile)
      return { success: true, path: logFile }
    }
    const logDir = fileLogger.getLogDir()
    if (logDir && existsSync(logDir)) {
      await shell.openPath(logDir)
      return { success: true, path: logDir }
    }
    return { success: false, error: '日志目录不存在' }
  })
}
