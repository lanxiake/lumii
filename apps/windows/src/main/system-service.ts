/**
 * SystemService - 系统服务
 *
 * 提供文件操作、进程管理、系统信息等功能
 * 集成安全验证防止路径遍历、命令注入等攻击
 *
 * 性能优化：
 * - 使用简单的内存缓存减少重复系统调用
 * - 批量文件操作使用并行处理
 */

import { exec, spawn, ChildProcess } from 'child_process'
import { promises as fs } from 'fs'
import { join, dirname, basename, extname } from 'path'
import { promisify } from 'util'
import * as os from 'os'
import {
  securityUtils,
  SecurityError,
  validatePid,
  createSafeRegExp,
  createSearchRegExp,
  sanitizeCommandArg,
} from './security-utils'

const execAsync = promisify(exec)

// 日志输出
const log = {
  debug: (...args: unknown[]) => console.log('[SystemService:DEBUG]', ...args),
  info: (...args: unknown[]) => console.log('[SystemService]', ...args),
  warn: (...args: unknown[]) => console.warn('[SystemService]', ...args),
  error: (...args: unknown[]) => console.error('[SystemService]', ...args),
}

// ============================================================================
// 简单缓存实现
// ============================================================================

interface CacheEntry<T> {
  value: T
  timestamp: number
}

/**
 * 简单的内存缓存
 */
class SimpleCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map()
  private ttl: number

  constructor(ttlMs: number) {
    this.ttl = ttlMs
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key)
    if (!entry) {return undefined}
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T): void {
    this.cache.set(key, { value, timestamp: Date.now() })
  }

  clear(): void {
    this.cache.clear()
  }
}

/**
 * 文件信息接口
 */
export interface FileInfo {
  name: string
  path: string
  isDirectory: boolean
  size: number
  createdAt: Date
  modifiedAt: Date
  extension: string
}

/**
 * 进程信息接口
 */
export interface ProcessInfo {
  pid: number
  name: string
  cpu: number
  memory: number
  memoryBytes: number
  status: string
}

/**
 * 系统信息接口
 */
export interface SystemInfo {
  platform: string
  arch: string
  hostname: string
  release: string
  cpuModel: string
  cpuCores: number
  totalMemory: number
  freeMemory: number
  usedMemory: number
  memoryUsagePercent: number
  uptime: number
  cpuUsage?: number
}

/**
 * 磁盘信息接口
 */
export interface DiskInfo {
  name: string
  mount: string
  type: string
  total: number
  free: number
  used: number
  usagePercent: number
}

/**
 * 系统服务类
 */
export class SystemService {
  // 缓存实例：磁盘信息 30 秒，进程列表 5 秒
  private diskCache = new SimpleCache<DiskInfo[]>(30000)
  private processCache = new SimpleCache<ProcessInfo[]>(5000)
  private systemInfoCache = new SimpleCache<SystemInfo>(10000)

  constructor() {
    // 初始化时添加用户目录到允许的路径
    const userPaths = this.getUserPaths()
    securityUtils.addAllowedBasePath(userPaths.home)
    securityUtils.addAllowedBasePath(userPaths.desktop)
    securityUtils.addAllowedBasePath(userPaths.documents)
    securityUtils.addAllowedBasePath(userPaths.downloads)
    log.info('系统服务初始化完成，已配置安全路径')
  }

  /**
   * 验证并规范化路径
   * @private
   */
  private validatePath(path: string): string {
    return securityUtils.validatePath(path)
  }

  /**
   * 列出目录内容
   * 使用 Promise.all 并行获取文件信息以提高性能
   */
  async listDirectory(dirPath: string): Promise<FileInfo[]> {
    log.debug(`列出目录: ${dirPath}`)

    // 安全验证
    const safePath = this.validatePath(dirPath)

    try {
      const entries = await fs.readdir(safePath, { withFileTypes: true })

      // 过滤系统内部目录，不向用户暴露
      // 注意：Windows junction/symlink 上 Dirent.isDirectory() 常为 false，须用 stat 判定
      const HIDDEN_DIRS = new Set(['.system', '未归类'])
      const visibleEntries = entries.filter(
        (entry) => !HIDDEN_DIRS.has(entry.name),
      )

      // 使用 Promise.all 并行获取所有文件的 stat 信息
      const filePromises = visibleEntries.map(async (entry) => {
        const filePath = join(safePath, entry.name)
        try {
          // fs.stat 跟随 junction/symlink，正确识别「链接到目录」的条目
          const stats = await fs.stat(filePath)
          const isDirectory = stats.isDirectory()
          if (isDirectory && HIDDEN_DIRS.has(entry.name)) {
            return null
          }
          return {
            name: entry.name,
            path: filePath,
            isDirectory,
            size: stats.size,
            createdAt: stats.birthtime,
            modifiedAt: stats.mtime,
            extension: isDirectory ? '' : extname(entry.name).toLowerCase(),
          } as FileInfo
        } catch (statError) {
          // 跳过无法访问的文件
          log.debug(`无法获取文件信息: ${filePath}`, statError)
          return null
        }
      })

      // 等待所有文件信息获取完成，过滤掉失败的
      const results = await Promise.all(filePromises)
      const files = results.filter((file): file is FileInfo => file !== null)

      log.debug(`找到 ${files.length} 个文件/文件夹`)
      return files
    } catch (error) {
      log.error(`列出目录失败: ${safePath}`, error)
      throw error
    }
  }

  /**
   * 读取文件内容
   */
  async readFile(filePath: string): Promise<string> {
    log.debug(`读取文件: ${filePath}`)

    // 安全验证
    const safePath = this.validatePath(filePath)

    try {
      const content = await fs.readFile(safePath, 'utf-8')
      log.debug(`文件读取成功，大小: ${content.length} 字符`)
      return content
    } catch (error) {
      log.error(`读取文件失败: ${safePath}`, error)
      throw error
    }
  }

  /**
   * 写入文件内容
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    log.debug(`写入文件: ${filePath}`)

    // 安全验证
    const safePath = this.validatePath(filePath)

    try {
      // 确保目录存在
      const dir = dirname(safePath)
      await fs.mkdir(dir, { recursive: true })

      await fs.writeFile(safePath, content, 'utf-8')
      log.debug(`文件写入成功`)
    } catch (error) {
      log.error(`写入文件失败: ${safePath}`, error)
      throw error
    }
  }

  /**
   * 移动/重命名文件
   */
  async moveFile(sourcePath: string, destPath: string): Promise<void> {
    log.debug(`移动文件: ${sourcePath} -> ${destPath}`)

    // 安全验证两个路径
    const safeSourcePath = this.validatePath(sourcePath)
    const safeDestPath = this.validatePath(destPath)

    try {
      // 确保目标目录存在
      const destDir = dirname(safeDestPath)
      await fs.mkdir(destDir, { recursive: true })

      await fs.rename(safeSourcePath, safeDestPath)
      log.debug(`文件移动成功`)
    } catch (error) {
      log.error(`移动文件失败`, error)
      throw error
    }
  }

  /**
   * 复制文件或目录
   * 支持递归复制目录（使用 fs.cp）
   * Windows 跨盘 junction/symlink 会触发 EPERM，因此默认解引用并过滤 projects 下的链接
   */
  async copyFile(sourcePath: string, destPath: string): Promise<void> {
    log.debug(`复制: ${sourcePath} -> ${destPath}`)

    // 安全验证两个路径
    const safeSourcePath = this.validatePath(sourcePath)
    const safeDestPath = this.validatePath(destPath)

    try {
      // 确保目标父目录存在
      const destDir = dirname(safeDestPath)
      await fs.mkdir(destDir, { recursive: true })

      const stats = await fs.lstat(safeSourcePath)
      if (stats.isSymbolicLink()) {
        // 不复制 junction/symlink 自身，避免跨盘 EPERM；尝试解引用复制目标内容
        try {
          const targetStats = await fs.stat(safeSourcePath)
          if (targetStats.isDirectory()) {
            await fs.cp(safeSourcePath, safeDestPath, {
              recursive: true,
              force: true,
              dereference: true,
            })
            log.debug(`符号链接目录已解引用复制`)
          } else {
            await fs.copyFile(safeSourcePath, safeDestPath)
            log.debug(`符号链接文件已解引用复制`)
          }
        } catch (linkErr) {
          log.warn(`跳过无法复制的符号链接: ${safeSourcePath}`, linkErr)
        }
        return
      }

      if (stats.isDirectory()) {
        // dereference：跟随 junction；filter：跳过仍失败的链接项
        await fs.cp(safeSourcePath, safeDestPath, {
          recursive: true,
          force: true,
          dereference: true,
          filter: async (src) => {
            try {
              const st = await fs.lstat(src)
              if (st.isSymbolicLink()) {
                // projects 下的外部项目 junction 跳过，避免跨盘 EPERM
                const base = basename(dirname(src)).toLowerCase()
                if (base === 'projects') {
                  log.warn(`跳过 projects 符号链接: ${src}`)
                  return false
                }
              }
              return true
            } catch {
              return false
            }
          },
        })
        log.debug(`目录递归复制成功`)
      } else {
        await fs.copyFile(safeSourcePath, safeDestPath)
        log.debug(`文件复制成功`)
      }
    } catch (error) {
      log.error(`复制失败`, error)
      throw error
    }
  }

  /**
   * 删除文件或目录
   */
  async deleteFile(filePath: string): Promise<void> {
    log.debug(`删除文件/目录: ${filePath}`)

    // 安全验证
    const safePath = this.validatePath(filePath)

    try {
      const stats = await fs.stat(safePath)

      if (stats.isDirectory()) {
        await fs.rm(safePath, { recursive: true, force: true })
        log.debug(`目录删除成功`)
      } else {
        await fs.unlink(safePath)
        log.debug(`文件删除成功`)
      }
    } catch (error) {
      log.error(`删除失败: ${safePath}`, error)
      throw error
    }
  }

  /**
   * 创建目录
   */
  async createDirectory(dirPath: string): Promise<void> {
    log.info(`创建目录: ${dirPath}`)

    // 安全验证
    const safePath = this.validatePath(dirPath)

    try {
      await fs.mkdir(safePath, { recursive: true })
      log.info(`目录创建成功`)
    } catch (error) {
      log.error(`创建目录失败: ${safePath}`, error)
      throw error
    }
  }

  /**
   * 检查文件/目录是否存在
   */
  async exists(filePath: string): Promise<boolean> {
    // 安全验证
    const safePath = this.validatePath(filePath)

    try {
      await fs.access(safePath)
      return true
    } catch {
      return false
    }
  }

  /**
   * 获取文件信息
   */
  async getFileInfo(filePath: string): Promise<FileInfo> {
    log.info(`获取文件信息: ${filePath}`)

    // 安全验证
    const safePath = this.validatePath(filePath)

    try {
      const stats = await fs.stat(safePath)
      return {
        name: basename(safePath),
        path: safePath,
        isDirectory: stats.isDirectory(),
        size: stats.size,
        createdAt: stats.birthtime,
        modifiedAt: stats.mtime,
        extension: stats.isDirectory() ? '' : extname(safePath).toLowerCase(),
      }
    } catch (error) {
      log.error(`获取文件信息失败: ${safePath}`, error)
      throw error
    }
  }

  /**
   * 搜索文件
   */
  async searchFiles(
    dirPath: string,
    pattern: string,
    options: { recursive?: boolean; maxResults?: number } = {}
  ): Promise<FileInfo[]> {
    const { recursive = true, maxResults = 100 } = options
    log.info(`搜索文件: ${dirPath}, 模式: ${pattern}`)

    // 安全验证路径
    const safePath = this.validatePath(dirPath)

    const results: FileInfo[] = []
    // 调用方（前端 FileSearchBar）已构造好正则模式（后缀 `\.md$` / 通配符 `.*` / 字面量子串）。
    // 此处不再二次转义，否则正则元字符会被当成字面量，导致后缀/通配符搜索永远匹配不到。
    const regex = createSearchRegExp(pattern)

    const search = async (currentPath: string) => {
      if (results.length >= maxResults) {
        return
      }

      // 验证当前搜索路径仍在安全范围内
      if (!securityUtils.isPathSafe(currentPath)) {
        log.warn(`跳过不安全路径: ${currentPath}`)
        return
      }

      try {
        const entries = await fs.readdir(currentPath, { withFileTypes: true })

        for (const entry of entries) {
          if (results.length >= maxResults) {
            break
          }

          const filePath = join(currentPath, entry.name)

          let isDirectory = entry.isDirectory()
          try {
            // Windows junction：Dirent.isDirectory() 为 false，需用 stat 跟随链接判定
            const stats = await fs.stat(filePath)
            isDirectory = stats.isDirectory()
            if (regex.test(entry.name)) {
              results.push({
                name: entry.name,
                path: filePath,
                isDirectory,
                size: stats.size,
                createdAt: stats.birthtime,
                modifiedAt: stats.mtime,
                extension: isDirectory ? '' : extname(entry.name).toLowerCase(),
              })
            }
          } catch {
            // 跳过无法访问的文件
          }

          if (recursive && isDirectory) {
            await search(filePath)
          }
        }
      } catch {
        // 跳过无法访问的目录
      }
    }

    await search(safePath)
    log.info(`找到 ${results.length} 个匹配文件`)
    return results
  }

  /**
   * 获取系统信息
   * 静态信息使用缓存，动态信息（内存）实时获取
   */
  getSystemInfo(): SystemInfo {
    // 检查缓存（静态信息部分）
    const cached = this.systemInfoCache.get('system')
    if (cached) {
      // 更新动态内存信息
      const freeMemory = os.freemem()
      const usedMemory = cached.totalMemory - freeMemory
      return {
        ...cached,
        freeMemory,
        usedMemory,
        memoryUsagePercent: Math.round((usedMemory / cached.totalMemory) * 100),
        uptime: os.uptime(),
      }
    }

    log.info(`获取系统信息`)

    const cpus = os.cpus()
    const totalMemory = os.totalmem()
    const freeMemory = os.freemem()
    const usedMemory = totalMemory - freeMemory
    const memoryUsagePercent = Math.round((usedMemory / totalMemory) * 100)

    const info: SystemInfo = {
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      release: os.release(),
      cpuModel: cpus[0]?.model || 'Unknown',
      cpuCores: cpus.length,
      totalMemory,
      freeMemory,
      usedMemory,
      memoryUsagePercent,
      uptime: os.uptime(),
    }

    // 缓存静态部分
    this.systemInfoCache.set('system', info)

    log.info(`系统信息: ${info.platform} ${info.arch}, ${info.cpuCores} 核心, 内存使用 ${memoryUsagePercent}%`)
    return info
  }

  /**
   * 获取磁盘信息 (Windows)
   * 使用缓存减少 PowerShell 调用
   */
  async getDiskInfo(): Promise<DiskInfo[]> {
    // 检查缓存
    const cached = this.diskCache.get('disks')
    if (cached) {
      log.debug('使用缓存的磁盘信息')
      return cached
    }

    log.info(`获取磁盘信息`)

    try {
      // 使用 PowerShell 获取磁盘信息
      const { stdout } = await execAsync(
        'powershell -Command "Get-WmiObject Win32_LogicalDisk | Where-Object { $_.DriveType -eq 3 } | Select-Object DeviceID, Size, FreeSpace, FileSystem | ConvertTo-Json"'
      )

      const disks = JSON.parse(stdout)
      const diskArray = Array.isArray(disks) ? disks : [disks]

      const result: DiskInfo[] = diskArray.map((disk: { DeviceID: string; Size: number; FreeSpace: number; FileSystem: string }) => {
        const total = disk.Size || 0
        const free = disk.FreeSpace || 0
        const used = total - free
        return {
          name: disk.DeviceID,
          mount: disk.DeviceID,
          type: disk.FileSystem || 'Unknown',
          total,
          free,
          used,
          usagePercent: total > 0 ? Math.round((used / total) * 100) : 0,
        }
      })

      // 缓存结果
      this.diskCache.set('disks', result)

      log.info(`找到 ${result.length} 个磁盘`)
      return result
    } catch (error) {
      log.error(`获取磁盘信息失败`, error)
      return []
    }
  }

  /**
   * 获取进程列表
   * 使用缓存减少 PowerShell 调用
   */
  async getProcessList(): Promise<ProcessInfo[]> {
    // 检查缓存
    const cached = this.processCache.get('processes')
    if (cached) {
      log.debug('使用缓存的进程列表')
      return cached
    }

    log.info(`获取进程列表`)

    try {
      // 使用 PowerShell 获取进程信息
      const { stdout } = await execAsync(
        'powershell -Command "Get-Process | Select-Object Id, ProcessName, CPU, WorkingSet64 | ConvertTo-Json"'
      )

      const processes = JSON.parse(stdout)
      const processArray = Array.isArray(processes) ? processes : [processes]

      const result: ProcessInfo[] = processArray.map(
        (proc: { Id: number; ProcessName: string; CPU: number; WorkingSet64: number }) => ({
          pid: proc.Id,
          name: proc.ProcessName,
          cpu: proc.CPU || 0,
          memory: Math.round((proc.WorkingSet64 || 0) / 1024 / 1024), // 转换为 MB
          memoryBytes: proc.WorkingSet64 || 0,
          status: 'running',
        })
      )

      // 缓存结果
      this.processCache.set('processes', result)

      log.info(`找到 ${result.length} 个进程`)
      return result
    } catch (error) {
      log.error(`获取进程列表失败`, error)
      return []
    }
  }

  /**
   * 结束进程
   */
  async killProcess(pid: number): Promise<void> {
    log.info(`结束进程: ${pid}`)

    // 安全验证 PID
    const safePid = validatePid(pid)

    try {
      // 使用参数化命令防止注入
      await execAsync(`taskkill /PID ${safePid} /F`)
      log.info(`进程已结束: ${safePid}`)
    } catch (error) {
      log.error(`结束进程失败: ${safePid}`, error)
      throw error
    }
  }

  /**
   * 启动程序
   */
  launchApplication(appPath: string, args: string[] = []): ChildProcess {
    log.info(`启动程序: ${appPath}`, args)

    // 验证应用路径
    const safeAppPath = this.validatePath(appPath)

    // 消毒参数
    const safeArgs = args.map((arg) => sanitizeCommandArg(arg))

    const child = spawn(safeAppPath, safeArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })

    child.unref()
    log.info(`程序已启动, PID: ${child.pid}`)

    return child
  }

  /**
   * 执行命令
   * 注意：此方法应谨慎使用，仅允许执行白名单中的命令
   */
  async executeCommand(command: string): Promise<{ stdout: string; stderr: string }> {
    log.info(`执行命令: ${command}`)

    // 检查命令是否在白名单中
    if (!securityUtils.isCommandAllowed(command)) {
      log.warn(`命令不在白名单中: ${command}`)
      throw new SecurityError('命令不在允许列表中', 'COMMAND_NOT_ALLOWED')
    }

    try {
      const result = await execAsync(command, {
        timeout: 30000, // 30秒超时
        maxBuffer: 10 * 1024 * 1024, // 10MB 输出限制
      })
      log.info(`命令执行成功`)
      return result
    } catch (error) {
      log.error(`命令执行失败`, error)
      throw error
    }
  }

  /**
   * 获取环境变量
   */
  getEnvVariable(name: string): string | undefined {
    return process.env[name]
  }

  /**
   * 获取用户目录路径
   */
  getUserPaths(): { home: string; desktop: string; documents: string; downloads: string } {
    const home = os.homedir()
    return {
      home,
      desktop: join(home, 'Desktop'),
      documents: join(home, 'Documents'),
      downloads: join(home, 'Downloads'),
    }
  }
}
