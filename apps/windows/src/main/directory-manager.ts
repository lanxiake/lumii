/**
 * DirectoryManager - 统一目录管理
 *
 * 负责管理 Windows 客户端的所有目录结构
 * 确保目录存在、权限正确、路径规范
 */

import { join } from 'path'
import { promises as fs } from 'fs'
import {
  resolveClientStateDir,
} from './paths'

const log = {
  info: (...args: unknown[]) => console.log('[DirectoryManager]', ...args),
  error: (...args: unknown[]) => console.error('[DirectoryManager]', ...args),
  warn: (...args: unknown[]) => console.warn('[DirectoryManager]', ...args),
}

/**
 * 目录结构定义
 */
export interface DirectoryStructure {
  /** 根目录 */
  root: string
  /** RFS 工作目录 */
  workspace: string
  /** 技能目录 */
  skills: string
  /** 项目目录 */
  projects: string
  /** 工作区内用户上传目录 */
  workspaceUploads: string
  /** 工作区内 Agent 产出目录 */
  workspaceOutputs: string
  /** 工作区内用户自主管理目录 */
  workspaceFiles: string
  /** 工作区系统隐藏目录 */
  workspaceSystem: string
  /** 工作区系统线程目录 */
  workspaceSystemThreads: string
  /** 配置目录 */
  config: string
  /** 缓存目录 */
  cache: string
  /** 日志目录 */
  logs: string
  /** 临时文件目录 */
  temp: string
}

/**
 * 目录管理器
 */
export class DirectoryManager {
  private dirs: DirectoryStructure | null = null
  private initialized = false

  /**
   * 初始化目录结构
   */
  async initialize(): Promise<DirectoryStructure> {
    if (this.initialized && this.dirs) {
      return this.dirs
    }

    log.info('初始化目录结构')

    // 确定根目录
    const root = this.getRootDirectory()
    log.info(`根目录: ${root}`)

    // 定义目录结构
    this.dirs = {
      root,
      workspace: join(root, 'workspace'),
      skills: join(root, 'workspace', 'skills'),
      projects: join(root, 'workspace', 'projects'),
      workspaceUploads: join(root, 'workspace', 'uploads'),
      workspaceOutputs: join(root, 'workspace', 'outputs'),
      workspaceFiles: join(root, 'workspace', 'files'),
      workspaceSystem: join(root, 'workspace', '.system'),
      workspaceSystemThreads: join(root, 'workspace', '.system', 'threads'),
      config: join(root, 'config'),
      cache: join(root, 'cache'),
      logs: join(root, 'logs'),
      temp: join(root, 'temp'),
    }

    // 创建所有目录
    await this.ensureDirectories()
    // 用户目录延迟到用户认证后创建，这里仅初始化根级别目录

    this.initialized = true
    log.info('目录结构初始化完成')

    return this.dirs
  }

  /**
   * 获取根目录（从 paths.ts 模块获取）
   */
  private getRootDirectory(): string {
    return resolveClientStateDir()
  }

  /**
   * 确保所有目录存在
   */
  private async ensureDirectories(): Promise<void> {
    if (!this.dirs) {
      throw new Error('目录结构未初始化')
    }

    const dirsToCreate = [
      this.dirs.root,
      this.dirs.workspace,
      this.dirs.skills,
      this.dirs.projects,
      this.dirs.workspaceUploads,
      this.dirs.workspaceOutputs,
      this.dirs.workspaceFiles,
      this.dirs.workspaceSystem,
      this.dirs.workspaceSystemThreads,
      this.dirs.config,
      this.dirs.cache,
      this.dirs.logs,
      this.dirs.temp,
      join(this.dirs.temp, 'downloads'),
      // 默认工作空间下的临时布局（录屏/截图）；自定义工作空间由 ensureWorkspaceSubDirs 覆盖
      join(this.dirs.workspace, 'temp'),
      join(this.dirs.workspace, 'temp', 'recordings'),
      join(this.dirs.workspace, 'temp', 'screenshots'),
    ]

    for (const dir of dirsToCreate) {
      try {
        await fs.mkdir(dir, { recursive: true })
      } catch (error) {
        log.error(`创建目录失败: ${dir}`, error)
        throw error
      }
    }
  }

  /**
   * 获取目录结构
   */
  getDirectories(): DirectoryStructure {
    if (!this.dirs) {
      throw new Error('目录管理器未初始化，请先调用 initialize()')
    }
    return this.dirs
  }

  /**
   * 获取特定目录
   */
  getDirectory(name: keyof DirectoryStructure): string {
    if (!this.dirs) {
      throw new Error('目录管理器未初始化')
    }
    return this.dirs[name]
  }

  /**
   * 解析线程目录（thread 根、workspace、uploads、outputs）。
   */
  resolveThreadDirectories(threadId: string): {
    root: string
    workspace: string
    uploads: string
    outputs: string
  } {
    if (!this.dirs) {
      throw new Error('目录管理器未初始化')
    }
    const normalizedThreadId = threadId.trim().replace(/:/g, '_')
    if (!normalizedThreadId) {
      throw new Error('threadId 不能为空')
    }
    const root = join(this.dirs.workspaceSystemThreads, normalizedThreadId)
    return {
      root,
      workspace: join(root, 'workspace'),
      uploads: join(this.dirs.workspaceUploads, '未归类', normalizedThreadId),
      outputs: join(this.dirs.workspaceOutputs, '未归类', normalizedThreadId),
    }
  }

  /**
   * 确保线程目录结构存在（workspace / uploads / outputs）。
   */
  async ensureThreadDirectories(threadId: string): Promise<{
    root: string
    workspace: string
    uploads: string
    outputs: string
  }> {
    const dirs = this.resolveThreadDirectories(threadId)
    // 只创建 thread workspace 目录；uploads/outputs 子目录延迟到实际有文件时再创建，
    // 避免在用户可见的"我上传的"和"AI生成的"目录下产生大量空文件夹。
    await fs.mkdir(dirs.workspace, { recursive: true })
    return dirs
  }

  /**
   * 解析任务目录，若不存在则自动创建（并返回规范化路径）。
   */
  async resolveTaskDirectory(taskName: string, type: 'uploads' | 'outputs'): Promise<string> {
    if (!this.dirs) {
      throw new Error('目录管理器未初始化')
    }
    const safeName = this.sanitizeFolderName(taskName)
    const base = type === 'uploads' ? this.dirs.workspaceUploads : this.dirs.workspaceOutputs
    const target = join(base, safeName || '未命名任务')
    await fs.mkdir(target, { recursive: true })
    return target
  }

  /**
   * 将“未归类/{threadId}”目录重命名为任务名目录（上传与产出同步处理）。
   */
  async renameTaskDirectory(oldName: string, newName: string): Promise<void> {
    if (!this.dirs) {
      throw new Error('目录管理器未初始化')
    }
    const sourceName = oldName.trim()
    if (!sourceName) {
      return
    }
    const targetName = this.sanitizeFolderName(newName)
    if (!targetName) {
      return
    }

    const oldUploadPath = join(this.dirs.workspaceUploads, '未归类', sourceName)
    const oldOutputPath = join(this.dirs.workspaceOutputs, '未归类', sourceName)
    const newUploadPath = await this.getUniquePath(join(this.dirs.workspaceUploads, targetName))
    const newOutputPath = await this.getUniquePath(join(this.dirs.workspaceOutputs, targetName))

    await this.tryRename(oldUploadPath, newUploadPath)
    await this.tryRename(oldOutputPath, newOutputPath)
  }

  /**
   * 尝试重命名目录，源不存在时静默忽略（避免 TOCTOU）。
   */
  private async tryRename(oldPath: string, newPath: string): Promise<void> {
    try {
      await fs.rename(oldPath, newPath)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw err
    }
  }

  /**
   * 过滤非法文件夹字符并限制目录名长度。
   */
  private sanitizeFolderName(name: string): string {
    return name
      .replace(/[<>:"/\\|?*]/g, '')           // 半角非法字符
      .replace(/[：""''、？！＊＜＞＼／｜]/g, '') // 全角非法字符
      .replace(/\.{2,}/g, '.')                 // 连续点号合并为单点
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 50)
  }

  /**
   * 检查路径是否存在。
   */
  private async pathExists(path: string): Promise<boolean> {
    try {
      await fs.access(path)
      return true
    } catch {
      return false
    }
  }

  /**
   * 获取唯一目录路径，避免重名覆盖。
   */
  private async getUniquePath(basePath: string): Promise<string> {
    if (!(await this.pathExists(basePath))) {
      return basePath
    }
    let counter = 1
    let nextPath = `${basePath} (${counter})`
    while (await this.pathExists(nextPath)) {
      counter += 1
      nextPath = `${basePath} (${counter})`
    }
    return nextPath
  }

  /**
   * 确保自定义工作空间根下的标准子目录结构存在。
   * 用于 workspace:ensureDir IPC handler 切换工作空间路径时。
   */
  async ensureWorkspaceSubDirs(workspaceRoot: string): Promise<void> {
    const subDirs = [
      'skills',
      'uploads',
      'outputs',
      'files',
      'projects',
      'temp',
      'temp/recordings',
      'temp/screenshots',
      '.system/threads',
    ]
    for (const sub of subDirs) {
      await fs.mkdir(join(workspaceRoot, sub), { recursive: true })
    }
  }

  /**
   * 检查路径是否在 workspace 内（RFS 可访问）
   */
  isInWorkspace(path: string): boolean {
    if (!this.dirs) {
      return false
    }
    const normalized = path.replace(/\\/g, '/')
    const workspace = this.dirs.workspace.replace(/\\/g, '/')
    return normalized.startsWith(workspace)
  }

  /**
   * 清理临时文件
   */
  async cleanTemp(): Promise<void> {
    if (!this.dirs) {
      return
    }

    try {
      const tempDir = this.dirs.temp
      const files = await fs.readdir(tempDir)

      for (const file of files) {
        const filePath = join(tempDir, file)
        const stat = await fs.stat(filePath)

        // 删除超过 24 小时的文件
        const age = Date.now() - stat.mtimeMs
        if (age > 24 * 60 * 60 * 1000) {
          await fs.rm(filePath, { recursive: true, force: true })
          log.info(`已删除过期临时文件: ${filePath}`)
        }
      }
    } catch (error) {
      log.error('清理临时文件失败:', error)
    }
  }
}

// 导出单例
export const directoryManager = new DirectoryManager()
