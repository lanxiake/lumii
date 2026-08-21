/**
 * 文件和系统操作相关 IPC handlers
 */
import { ipcMain, app, shell } from 'electron'
import { extname } from 'path'
import { promises as fs, existsSync } from 'fs'
import type { SystemService } from '../system-service'
import { validatePid, validateUrl } from '../security-utils'
import { fileLogger } from '../file-logger'

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

  // 读取文件为 Base64 (用于图片附件)
  ipcMain.handle('file:readAsBase64', async (_event, filePath: string) => {
    if (typeof filePath !== 'string') {
      throw new Error('路径必须是字符串')
    }

    deps!.log.info(`[File] 读取文件为 Base64: ${filePath}`)

    // 获取文件扩展名和 MIME 类型
    const ext = extname(filePath).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.csv': 'text/csv',
      '.json': 'application/json',
      '.xml': 'text/xml',
      '.html': 'text/html',
      '.htm': 'text/html',
      '.log': 'text/plain',
      '.ts': 'text/plain',
      '.tsx': 'text/plain',
      '.js': 'text/plain',
      '.jsx': 'text/plain',
      '.py': 'text/plain',
      '.yaml': 'text/plain',
      '.yml': 'text/plain',
      '.toml': 'text/plain',
      '.ini': 'text/plain',
      '.cfg': 'text/plain',
      '.sh': 'text/plain',
      '.bat': 'text/plain',
      '.css': 'text/plain',
      '.sql': 'text/plain',
      '.rs': 'text/plain',
      '.go': 'text/plain',
      '.java': 'text/plain',
      '.c': 'text/plain',
      '.cpp': 'text/plain',
      '.h': 'text/plain',
    }
    const mimeType = mimeTypes[ext] || 'application/octet-stream'

    // 验证文件大小 (限制 10MB)
    const stats = await fs.stat(filePath)
    if (stats.size > 10 * 1024 * 1024) {
      throw new Error('文件大小超出限制 (最大 10MB)')
    }

    // 读取文件内容
    const buffer = await fs.readFile(filePath)
    const content = buffer.toString('base64')

    deps!.log.info(`[File] 文件读取成功: ${filePath}, 大小: ${stats.size} 字节`)

    return {
      content,
      mimeType,
      size: stats.size,
      fileName: filePath.split(/[/\\]/).pop() || 'file',
    }
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

  ipcMain.handle('system:getProcessList', async () => {
    return deps!.getSystemService()?.getProcessList()
  })

  ipcMain.handle('system:killProcess', async (_event, pid: number) => {
    // PID 验证在 SystemService 中实现
    const safePid = validatePid(pid)
    return deps!.getSystemService()?.killProcess(safePid)
  })

  ipcMain.handle('system:launchApp', async (_event, appPath: string, args?: string[]) => {
    if (typeof appPath !== 'string') {
      throw new Error('应用路径必须是字符串')
    }
    if (args !== undefined && !Array.isArray(args)) {
      throw new Error('参数必须是数组')
    }
    // 验证参数数组
    if (args && args.some((arg) => typeof arg !== 'string')) {
      throw new Error('所有参数必须是字符串')
    }
    deps!.getSystemService()?.launchApplication(appPath, args)
  })

  ipcMain.handle('system:executeCommand', async (_event, command: string) => {
    if (typeof command !== 'string') {
      throw new Error('命令必须是字符串')
    }
    if (command.length > 1000) {
      throw new Error('命令过长')
    }
    return deps!.getSystemService()?.executeCommand(command)
  })

  ipcMain.handle('system:getUserPaths', () => {
    return deps!.getSystemService()?.getUserPaths()
  })

  // === 应用相关 ===
  ipcMain.handle('app:getVersion', () => app.getVersion())

  ipcMain.handle('app:openExternal', async (_event, url: string) => {
    // 验证 URL 安全性
    const safeUrl = validateUrl(url, { allowedProtocols: ['http:', 'https:'] })
    return shell.openExternal(safeUrl)
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

export function registerAppQuitHandler(isQuittingGetter: () => boolean, setIsQuitting: (value: boolean) => void): void {
  ipcMain.on('app:quit', () => {
    setIsQuitting(true)
    app.quit()
  })
}
