/**
 * ClientSkillRuntime - 客户端技能运行时
 *
 * 在 Windows 客户端本地执行技能
 * 支持权限检查、用户确认、超时控制等功能
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { dialog, BrowserWindow } from 'electron'
import { EventEmitter } from 'events'
import type { SystemService } from './system-service'
import { SkillSandbox, createDefaultSandbox } from './skill-sandbox'
import { LocalSkillStore, type SkillManifest, type SkillIndexEntry } from './skill-store'
import { TypeScriptRunner, RESULT_PREFIX } from './ts-runner'
import { PythonRunner } from './python-runner'
import { ShellRunner } from './shell-runner'
import { SkillExecutionLogger } from './skill-execution-logger'
import { SkillExporter } from './skill-exporter'
import { SkillImporter } from './skill-importer'
import { createLogger } from './logger'

// 日志输出
const log = createLogger('SkillRuntime')

// 安全限制常量
const MAX_PACKAGE_SIZE = 50 * 1024 * 1024 // 50MB - 技能包最大大小

// ============================================================================
// 类型定义 (与 gateway/protocol/skill-execution.ts 保持一致)
// ============================================================================

/**
 * 技能执行模式
 */
export type SkillRunMode = 'server' | 'local' | 'hybrid'

/**
 * 技能执行请求
 */
export interface SkillExecuteRequest {
  requestId: string
  skillId: string
  skillName?: string
  params: Record<string, unknown>
  requireConfirm: boolean
  confirmMessage?: string
  timeoutMs: number
  runMode: SkillRunMode
  priority?: number
  metadata?: Record<string, unknown>
}

/**
 * 技能执行结果
 */
export interface SkillExecuteResult {
  requestId: string
  success: boolean
  result?: unknown
  error?: SkillExecuteError
  executionTimeMs: number
  resourceUsage?: SkillResourceUsage
}

/**
 * 技能执行错误
 */
export interface SkillExecuteError {
  code: SkillErrorCode
  message: string
  details?: Record<string, unknown>
  stack?: string
}

/**
 * 技能错误代码
 */
export type SkillErrorCode =
  | 'SKILL_NOT_FOUND'
  | 'SKILL_DISABLED'
  | 'PERMISSION_DENIED'
  | 'USER_CANCELLED'
  | 'TIMEOUT'
  | 'EXECUTION_ERROR'
  | 'INVALID_PARAMS'
  | 'RESOURCE_LIMIT'
  | 'SANDBOX_VIOLATION'
  | 'NETWORK_ERROR'
  | 'INTERNAL_ERROR'

/**
 * 资源使用情况
 */
export interface SkillResourceUsage {
  cpuTimeMs?: number
  memoryPeakBytes?: number
  networkRequests?: number
  fileOperations?: number
}

/**
 * 技能定义
 */
export interface SkillDefinition {
  id: string
  name: string
  description?: string
  version: string
  runMode: SkillRunMode
  enabled: boolean
  permissions?: SkillPermissions
  execute: (params: Record<string, unknown>, context: SkillExecutionContext) => Promise<unknown>
}

/**
 * 技能权限
 */
export interface SkillPermissions {
  fileSystem?: {
    read?: string[]
    write?: string[]
  }
  network?: {
    allowedHosts?: string[]
    allowAll?: boolean
  }
  process?: {
    allowedCommands?: string[]
    allowAll?: boolean
  }
  requireConfirm?: boolean
}

/**
 * 技能执行上下文
 */
export interface SkillExecutionContext {
  /** 系统服务 */
  systemService: SystemService
  /** 请求用户确认 */
  confirm: (message: string) => Promise<boolean>
  /** 日志输出 */
  log: typeof log
  /** 取消信号 */
  abortSignal?: AbortSignal
  /** 沙箱实例 (可选) */
  sandbox?: SkillSandbox
}

// ============================================================================
// 内置技能实现
// ============================================================================

/**
 * 内置技能：文件列表
 */
const fileListSkill: SkillDefinition = {
  id: 'builtin:file-list',
  name: '文件列表',
  description: '列出指定目录下的文件',
  version: '1.0.0',
  runMode: 'local',
  enabled: true,
  permissions: {
    fileSystem: { read: ['*'] },
  },
  execute: async (params, context) => {
    const dirPath = params['path'] as string
    if (!dirPath) {
      throw new Error('缺少 path 参数')
    }
    const files = await context.systemService.listDirectory(dirPath)
    return { files, count: files.length }
  },
}

/**
 * 内置技能：读取文件
 */
const fileReadSkill: SkillDefinition = {
  id: 'builtin:file-read',
  name: '读取文件',
  description: '读取指定文件的内容',
  version: '1.0.0',
  runMode: 'local',
  enabled: true,
  permissions: {
    fileSystem: { read: ['*'] },
  },
  execute: async (params, context) => {
    const filePath = params['path'] as string
    if (!filePath) {
      throw new Error('缺少 path 参数')
    }
    const content = await context.systemService.readFile(filePath)
    return { content, path: filePath }
  },
}

/**
 * 内置技能：系统信息
 */
const systemInfoSkill: SkillDefinition = {
  id: 'builtin:system-info',
  name: '系统信息',
  description: '获取系统基本信息',
  version: '1.0.0',
  runMode: 'local',
  enabled: true,
  execute: async (_params, context) => {
    const info = await context.systemService.getSystemInfo()
    return info
  },
}

/**
 * 内置技能：执行命令
 */
const executeCommandSkill: SkillDefinition = {
  id: 'builtin:execute-command',
  name: '执行命令',
  description: '执行系统命令',
  version: '1.0.0',
  runMode: 'local',
  enabled: true,
  permissions: {
    process: { allowAll: false },
    requireConfirm: true,
  },
  execute: async (params, context) => {
    const command = params['command'] as string
    if (!command) {
      throw new Error('缺少 command 参数')
    }

    // 需要用户确认
    const confirmed = await context.confirm(`确认执行命令: ${command}`)
    if (!confirmed) {
      throw new Error('用户取消执行')
    }

    const result = await context.systemService.executeCommand(command)
    return result
  },
}

// 内置技能列表
const BUILTIN_SKILLS: SkillDefinition[] = [
  fileListSkill,
  fileReadSkill,
  systemInfoSkill,
  executeCommandSkill,
]

// ============================================================================
// ClientSkillRuntime 类
// ============================================================================

/**
 * 客户端技能运行时
 */
export class ClientSkillRuntime extends EventEmitter {
  private skills: Map<string, SkillDefinition> = new Map()
  private systemService: SystemService | null = null
  private mainWindow: BrowserWindow | null = null
  private runningTasks: Map<string, AbortController> = new Map()
  private confirmHandler: ((skillName: string, params: Record<string, unknown>) => Promise<boolean>) | null = null
  private initialized = false
  private sandbox: SkillSandbox | null = null
  private sandboxEnabled = false
  private skillStore: LocalSkillStore | null = null
  private tsRunner: TypeScriptRunner | null = null
  private pyRunner: PythonRunner | null = null
  private shellRunner: ShellRunner | null = null
  private executionLogger: SkillExecutionLogger | null = null
  private skillExporter: SkillExporter | null = null
  private skillImporter: SkillImporter | null = null

  constructor(systemService?: SystemService) {
    super()
    if (systemService) {
      this.systemService = systemService
    }

    // 注册内置技能
    for (const skill of BUILTIN_SKILLS) {
      this.skills.set(skill.id, skill)
    }

    log.info('ClientSkillRuntime created', {
      builtinSkills: BUILTIN_SKILLS.length,
    })
  }

  /**
   * 初始化技能运行时
   *
   * 初始化沙箱、本地技能存储和 TypeScript Runner
   * 从 skillsDir 加载已安装的外部技能
   */
  async initialize(skillsDir: string, enableSandbox = false, logsDir?: string): Promise<void> {
    if (this.initialized) {
      log.warn('SkillRuntime already initialized')
      return
    }

    log.info('Initializing SkillRuntime', { skillsDir, enableSandbox })

    // 初始化沙箱 (如果启用)
    if (enableSandbox) {
      this.sandbox = createDefaultSandbox()
      const sandboxReady = await this.sandbox.initialize()
      this.sandboxEnabled = sandboxReady
      log.info('Sandbox initialization', { enabled: this.sandboxEnabled })
    }

    // 初始化本地技能存储和所有 Runner
    this.skillStore = new LocalSkillStore(skillsDir)
    await this.skillStore.initialize()
    this.tsRunner = new TypeScriptRunner()
    this.pyRunner = new PythonRunner()
    this.shellRunner = new ShellRunner()

    // 初始化执行日志（优先使用传入的 logsDir，否则回退到 skillsDir 同级的 logs/skills）
    const resolvedLogsDir = logsDir ?? path.join(path.dirname(skillsDir), 'logs', 'skills')
    this.executionLogger = new SkillExecutionLogger(resolvedLogsDir)
    await this.executionLogger.initialize()

    // 初始化导出/导入器
    this.skillExporter = new SkillExporter()
    this.skillImporter = new SkillImporter(this.skillStore)

    // 加载已安装的外部技能
    await this.loadExternalSkills()

    this.initialized = true
    log.info('SkillRuntime initialized', {
      totalSkills: this.skills.size,
    })
  }

  /**
   * 设置系统服务
   */
  setSystemService(service: SystemService): void {
    this.systemService = service
    log.info('SystemService set')
  }

  /**
   * 设置确认对话框处理器
   */
  setConfirmHandler(handler: (skillName: string, params: Record<string, unknown>) => Promise<boolean>): void {
    this.confirmHandler = handler
    log.info('ConfirmHandler set')
  }

  /**
   * 启用/禁用沙箱
   */
  async setSandboxEnabled(enabled: boolean): Promise<void> {
    if (enabled && !this.sandbox) {
      this.sandbox = createDefaultSandbox()
      await this.sandbox.initialize()
    }
    this.sandboxEnabled = enabled
    log.info('Sandbox enabled state changed', { enabled })
  }

  /**
   * 获取沙箱状态
   */
  getSandboxStatus(): { enabled: boolean; hasIsolatedVm: boolean; fallbackMode: boolean } | null {
    if (!this.sandbox) {
      return null
    }
    const status = this.sandbox.getStatus()
    return {
      enabled: this.sandboxEnabled,
      hasIsolatedVm: status.hasIsolatedVm,
      fallbackMode: status.fallbackMode,
    }
  }

  /**
   * 设置主窗口 (用于显示确认对话框)
   */
  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window
  }

  /**
   * 注册技能
   */
  registerSkill(skill: SkillDefinition): void {
    this.skills.set(skill.id, skill)
    log.info('Skill registered', { skillId: skill.id, name: skill.name })
  }

  /**
   * 注销技能
   */
  unregisterSkill(skillId: string): boolean {
    const removed = this.skills.delete(skillId)
    if (removed) {
      log.info('Skill unregistered', { skillId })
    }
    return removed
  }

  /**
   * 获取技能列表
   */
  listSkills(): SkillDefinition[] {
    return Array.from(this.skills.values()).filter((s) => s.enabled)
  }

  /**
   * 获取技能
   */
  getSkill(skillId: string): SkillDefinition | undefined {
    return this.skills.get(skillId)
  }

  /**
   * 执行技能
   */
  async executeSkill(request: SkillExecuteRequest): Promise<SkillExecuteResult> {
    const startTime = Date.now()
    const { requestId, skillId, params, requireConfirm, confirmMessage, timeoutMs } = request

    log.info('Executing skill', { requestId, skillId, params })

    try {
      // 检查 SystemService 是否已设置
      if (!this.systemService) {
        return this.createErrorResult(requestId, 'INTERNAL_ERROR', 'SystemService 未初始化', startTime)
      }

      // 查找技能
      const skill = this.skills.get(skillId)
      if (!skill) {
        return this.createErrorResult(requestId, 'SKILL_NOT_FOUND', `技能不存在: ${skillId}`, startTime)
      }

      // 检查技能是否启用
      if (!skill.enabled) {
        return this.createErrorResult(requestId, 'SKILL_DISABLED', `技能已禁用: ${skillId}`, startTime)
      }

      // 用户确认 (如果需要)
      if (requireConfirm || skill.permissions?.requireConfirm) {
        const message = confirmMessage || `确认执行技能: ${skill.name}?`
        const confirmed = await this.showConfirmDialog(message, skill.name, params)
        if (!confirmed) {
          return this.createErrorResult(requestId, 'USER_CANCELLED', '用户取消执行', startTime)
        }
      }

      // 创建取消控制器
      const abortController = new AbortController()
      this.runningTasks.set(requestId, abortController)

      // 设置超时
      const timeoutId = setTimeout(() => {
        abortController.abort()
      }, timeoutMs)

      try {
        // 创建执行上下文
        const context: SkillExecutionContext = {
          systemService: this.systemService,
          confirm: (msg) => this.showConfirmDialog(msg, skill.name, params),
          log,
          abortSignal: abortController.signal,
          sandbox: this.sandboxEnabled ? this.sandbox ?? undefined : undefined,
        }

        // 执行技能
        const result = await skill.execute(params, context)

        clearTimeout(timeoutId)

        return {
          requestId,
          success: true,
          result,
          executionTimeMs: Date.now() - startTime,
        }
      } finally {
        clearTimeout(timeoutId)
        this.runningTasks.delete(requestId)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorCode: SkillErrorCode = errorMessage.includes('abort')
        ? 'TIMEOUT'
        : 'EXECUTION_ERROR'

      log.error('Skill execution failed', { requestId, skillId, error: errorMessage })

      return this.createErrorResult(requestId, errorCode, errorMessage, startTime)
    }
  }

  /**
   * 取消正在执行的技能
   */
  cancelExecution(requestId: string): boolean {
    const controller = this.runningTasks.get(requestId)
    if (controller) {
      controller.abort()
      this.runningTasks.delete(requestId)
      log.info('Skill execution cancelled', { requestId })
      return true
    }
    return false
  }

  /**
   * 显示确认对话框
   */
  private async showConfirmDialog(message: string, skillName: string, params?: Record<string, unknown>): Promise<boolean> {
    // 如果设置了自定义确认处理器，使用它
    if (this.confirmHandler) {
      return this.confirmHandler(skillName, params || {})
    }

    // 否则使用默认的 Electron 对话框
    if (!this.mainWindow) {
      log.warn('No mainWindow set, auto-confirming')
      return true
    }

    const result = await dialog.showMessageBox(this.mainWindow, {
      type: 'question',
      buttons: ['确认', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: '技能执行确认',
      message: skillName,
      detail: message,
    })

    return result.response === 0
  }

  /**
   * 创建错误结果
   */
  private createErrorResult(
    requestId: string,
    code: SkillErrorCode,
    message: string,
    startTime: number
  ): SkillExecuteResult {
    return {
      requestId,
      success: false,
      error: { code, message },
      executionTimeMs: Date.now() - startTime,
    }
  }

  /**
   * 从本地技能存储加载外部技能
   *
   * 统一使用 Claude Code 格式（SKILL.md + 可选的可执行脚本）
   */
  private async loadExternalSkills(): Promise<void> {
    if (!this.skillStore || !this.tsRunner) {
      log.warn('SkillStore 或 TSRunner 未初始化，跳过外部技能加载')
      return
    }

    const installed = await this.skillStore.listInstalled()
    log.info('加载外部技能', { count: installed.length })

    for (const entry of installed) {
      if (!entry.enabled) {
        log.debug('跳过已禁用技能', { skillId: entry.id })
        continue
      }

      try {
        // 获取技能目录
        const skillDir = this.skillStore.getSkillDirectory(entry.id)
        if (!skillDir) {
          log.warn('技能目录不存在，跳过', { skillId: entry.id })
          continue
        }

        const skillMdPath = path.join(skillDir, 'SKILL.md')

        // 检查 SKILL.md 是否存在
        try {
          await fs.access(skillMdPath)
        } catch {
          log.warn('SKILL.md 不存在，跳过', { skillId: entry.id })
          continue
        }
        // 自动检测入口文件
        const entryFile = await this.detectClaudeCodeEntry(skillDir)

        if (!entryFile) {
          // 没有可执行文件，这是纯指令型技能
          // 创建纯指令型技能定义
          const skillDef = this.createInstructionOnlySkillDefinition(entry, skillMdPath)
          this.skills.set(entry.id, skillDef)
          continue
        }

        // 有可执行文件，创建可执行型技能
        const entryPath = path.join(skillDir, entryFile.path)
        const runtime = entryFile.runtime

        log.debug('检测到入口文件', { skillId: entry.id, entryFile: entryFile.path, runtime })

        // 选择对应的 Runner
        const runner = this.selectRunner(runtime)
        if (!runner) {
          log.warn('不支持的 runtime 类型，跳过', { skillId: entry.id, runtime })
          continue
        }

        // 读取技能自定义 env 配置（skill-env.json）
        const skillEnv = await this.readSkillEnv(skillDir)

        // 创建 Claude Code 技能定义
        const skillDef = this.createClaudeCodeSkillDefinition(entry, entryPath, runtime, runner, skillEnv)
        this.skills.set(entry.id, skillDef)

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        log.error('加载外部技能失败', { skillId: entry.id, error: errorMessage })
      }
    }
  }

  /**
   * 读取技能目录下的 skill-env.json，展开 ~ 路径为 Windows 绝对路径
   *
   * 技能作者（或安装 UI）可在技能目录下放置 skill-env.json，格式：
   * { "SOME_VAR": "~/path/to/something", ... }
   */
  private async readSkillEnv(skillDir: string): Promise<Record<string, string> | undefined> {
    try {
      const raw = await fs.readFile(path.join(skillDir, 'skill-env.json'), 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
      const home = os.homedir()
      const result: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') {
          // 展开 ~ 并统一为 Windows 路径分隔符
          result[k] = v.replace(/^~(?=[/\\]|$)/, home).replace(/\//g, path.sep)
        }
      }
      return Object.keys(result).length > 0 ? result : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 检测 Claude Code 技能的入口文件
   *
   * 检测优先级：
   * 1. 根目录下的 .py 文件（如 save_markdown.py）
   * 2. scripts/ 目录下的 .py 文件
   * 3. 根目录下的 .ts/.js 文件
   * 4. scripts/ 目录下的 .ts/.js 文件
   * 5. Windows: .ps1 / .bat / .cmd，其他平台: .sh
   */
  private async detectClaudeCodeEntry(skillDir: string): Promise<{ path: string; runtime: string } | null> {
    try {
      // 检测根目录
      const rootFiles = await fs.readdir(skillDir)

      // 优先查找 Python 文件
      const pyFiles = rootFiles.filter(f => f.endsWith('.py') && !f.startsWith('test_') && !f.startsWith('__'))
      if (pyFiles.length > 0) {
        return { path: pyFiles[0], runtime: 'python' }
      }

      // 查找 TypeScript/JavaScript 文件
      const tsFiles = rootFiles.filter(f => (f.endsWith('.ts') || f.endsWith('.js')) && !f.startsWith('test_'))
      if (tsFiles.length > 0) {
        const runtime = tsFiles[0].endsWith('.ts') ? 'typescript' : 'javascript'
        return { path: tsFiles[0], runtime }
      }

      // Windows 原生脚本（.ps1 / .bat / .cmd，Windows 平台优先于 .sh）
      if (process.platform === 'win32') {
        const ps1Files = rootFiles.filter(f => f.endsWith('.ps1'))
        if (ps1Files.length > 0) return { path: ps1Files[0], runtime: 'shell' }
        const batFiles = rootFiles.filter(f => f.endsWith('.bat') || f.endsWith('.cmd'))
        if (batFiles.length > 0) return { path: batFiles[0], runtime: 'shell' }
      }

      // 查找 Shell 脚本
      const shFiles = rootFiles.filter(f => f.endsWith('.sh'))
      if (shFiles.length > 0) {
        return { path: shFiles[0], runtime: 'shell' }
      }

      // 检测 scripts/ 目录
      const scriptsDir = path.join(skillDir, 'scripts')
      try {
        await fs.access(scriptsDir)
        const scriptFiles = await fs.readdir(scriptsDir)

        // 优先查找 Python 文件
        const scriptPyFiles = scriptFiles.filter(f => f.endsWith('.py') && !f.startsWith('test_') && !f.startsWith('__'))
        if (scriptPyFiles.length > 0) {
          return { path: `scripts/${scriptPyFiles[0]}`, runtime: 'python' }
        }

        // 查找 TypeScript/JavaScript 文件
        const scriptTsFiles = scriptFiles.filter(f => (f.endsWith('.ts') || f.endsWith('.js')) && !f.startsWith('test_'))
        if (scriptTsFiles.length > 0) {
          const runtime = scriptTsFiles[0].endsWith('.ts') ? 'typescript' : 'javascript'
          return { path: `scripts/${scriptTsFiles[0]}`, runtime }
        }

        // Windows 原生脚本（scripts/ 子目录）
        if (process.platform === 'win32') {
          const scriptPs1Files = scriptFiles.filter(f => f.endsWith('.ps1'))
          if (scriptPs1Files.length > 0) return { path: `scripts/${scriptPs1Files[0]}`, runtime: 'shell' }
          const scriptBatFiles = scriptFiles.filter(f => f.endsWith('.bat') || f.endsWith('.cmd'))
          if (scriptBatFiles.length > 0) return { path: `scripts/${scriptBatFiles[0]}`, runtime: 'shell' }
        }

        // 查找 Shell 脚本
        const scriptShFiles = scriptFiles.filter(f => f.endsWith('.sh'))
        if (scriptShFiles.length > 0) {
          return { path: `scripts/${scriptShFiles[0]}`, runtime: 'shell' }
        }
      } catch {
        // scripts 目录不存在，继续
      }

      return null
    } catch (error) {
      log.error('检测 Claude Code 入口文件失败', { skillDir, error })
      return null
    }
  }

  /**
   * 创建 Claude Code 技能定义
   */
  private createClaudeCodeSkillDefinition(
    entry: SkillIndexEntry,
    entryPath: string,
    runtime: string,
    runner: { execute: (opts: import('./ts-runner').RunnerOptions) => Promise<import('./ts-runner').RunnerResult> },
    extraEnv?: Record<string, string>
  ): SkillDefinition {
    return {
      id: entry.id,
      name: entry.name,
      description: `Claude Code 技能 - ${entry.name}`,
      version: entry.version,
      runMode: 'local',
      enabled: true,
      execute: async (params: Record<string, unknown>, _context: SkillExecutionContext) => {
        const startTime = Date.now()

        try {
          // 执行技能脚本
          const result = await runner.execute({
            entryPath,
            params,
            timeoutMs: 120000, // 默认 2 分钟超时
            env: extraEnv,
          })

          const executionTime = Date.now() - startTime

          if (result.success) {
            return {
              success: true,
              result: result.result,
              executionTimeMs: executionTime,
            }
          } else {
            return {
              success: false,
              error: {
                code: 'EXECUTION_ERROR',
                message: result.error || '技能执行失败',
              },
              executionTimeMs: executionTime,
            }
          }
        } catch (error) {
          const executionTime = Date.now() - startTime
          return {
            success: false,
            error: {
              code: 'EXECUTION_ERROR',
              message: error instanceof Error ? error.message : String(error),
            },
            executionTimeMs: executionTime,
          }
        }
      }
    }
  }

  /**
   * 创建纯指令型 Claude Code 技能定义
   *
   * 这类技能只有 SKILL.md 文件，没有可执行脚本
   * 执行时返回 SKILL.md 的内容作为 AI 指令
   */
  private createInstructionOnlySkillDefinition(
    entry: SkillIndexEntry,
    skillMdPath: string
  ): SkillDefinition {
    return {
      id: entry.id,
      name: entry.name,
      description: `Claude Code 指令型技能 - ${entry.name}`,
      version: entry.version,
      runMode: 'local',
      enabled: true,
      execute: async (_params: Record<string, unknown>, _context: SkillExecutionContext) => {
        const startTime = Date.now()

        try {
          // 读取 SKILL.md 内容
          const content = await fs.readFile(skillMdPath, 'utf-8')
          const executionTime = Date.now() - startTime

          return {
            success: true,
            result: {
              type: 'instruction',
              content,
              message: '这是一个 AI 指令型技能，请根据以下指令执行任务',
            },
            executionTimeMs: executionTime,
          }
        } catch (error) {
          const executionTime = Date.now() - startTime
          return {
            success: false,
            error: {
              code: 'EXECUTION_ERROR',
              message: error instanceof Error ? error.message : String(error),
            },
            executionTimeMs: executionTime,
          }
        }
      }
    }
  }

  /**
   * 根据 runtime 类型选择对应的 Runner
   *
   * @param runtime - 技能运行时类型
   * @returns 对应的 Runner 实例，不支持的类型返回 null
   */
  private selectRunner(runtime: string): { execute: (opts: import('./ts-runner').RunnerOptions) => Promise<import('./ts-runner').RunnerResult> } | null {
    switch (runtime) {
      case 'typescript':
      case 'javascript':
        return this.tsRunner
      case 'python':
        return this.pyRunner
      case 'shell':
        return this.shellRunner
      default:
        log.warn('未知的 runtime 类型', { runtime })
        return null
    }
  }

  /**
   * 为外部技能创建 SkillDefinition
   *
   * 将 SkillManifest 转换为 SkillDefinition，根据 runtime 选择对应 Runner
   */
  private createExternalSkillDefinition(
    manifest: SkillManifest,
    entryPath: string,
  ): SkillDefinition {
    // 确保 skillStore 已初始化
    if (!this.skillStore) {
      throw new Error('SkillStore not initialized')
    }
    const store = this.skillStore
    const runtime = this

    return {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      runMode: 'local',
      enabled: true,
      permissions: manifest.permissions,
      execute: async (params, context) => {
        log.info('执行外部技能', {
          skillId: manifest.id,
          entryPath,
          runtime: manifest.runtime,
        })

        const runner = runtime.selectRunner(manifest.runtime)
        if (!runner) {
          throw new Error(`不支持的 runtime 类型: ${manifest.runtime}`)
        }

        const result = await runner.execute({
          entryPath,
          params,
          timeoutMs: 120_000,
          abortSignal: context.abortSignal,
        })

        // 更新执行统计
        await store.recordExecution(manifest.id).catch((err) => {
          log.warn('更新执行统计失败', { skillId: manifest.id, error: String(err) })
        })

        // 记录执行日志
        await runtime.executionLogger?.logExecution({
          requestId: crypto.randomUUID(),
          skillId: manifest.id,
          skillName: manifest.name,
          runtime: manifest.runtime,
          params,
          startedAt: new Date(Date.now() - result.executionTimeMs).toISOString(),
          executionTimeMs: result.executionTimeMs,
          success: result.success,
          resultSummary: result.result ? JSON.stringify(result.result).slice(0, 1024) : undefined,
          error: result.error,
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, 4096),
          stderr: result.stderr.slice(0, 4096),
        }).catch((err) => {
          log.warn('记录执行日志失败', { skillId: manifest.id, error: String(err) })
        })

        if (!result.success) {
          throw new Error(result.error ?? '技能执行失败')
        }

        return result.result
      },
    }
  }

  /**
   * 获取本地技能存储（供外部使用）
   */
  getSkillStore(): LocalSkillStore | null {
    return this.skillStore
  }

  /**
   * 获取执行日志管理器（供外部使用）
   */
  getExecutionLogger(): SkillExecutionLogger | null {
    return this.executionLogger
  }

  // ============================================================================
  // IPC 委托方法 — 供 main/index.ts 的 IPC 处理器调用
  // ============================================================================

  // ---------- 执行日志相关 ----------

  /**
   * 查询技能执行日志
   */
  async queryExecutionLogs(filter: {
    skillId?: string
    dateFrom?: string
    dateTo?: string
    success?: boolean
    limit?: number
    offset?: number
  }): Promise<{ entries: import('./skill-execution-logger').ExecutionLogEntry[]; total: number }> {
    if (!this.executionLogger) {
      return { entries: [], total: 0 }
    }
    return this.executionLogger.queryLogs(filter)
  }

  /**
   * 获取执行日志统计
   */
  async getExecutionLogStats(): Promise<{
    totalExecutions: number
    successCount: number
    failureCount: number
    totalLogFiles: number
    totalLogSizeBytes: number
  }> {
    if (!this.executionLogger) {
      return { totalExecutions: 0, successCount: 0, failureCount: 0, totalLogFiles: 0, totalLogSizeBytes: 0 }
    }
    return this.executionLogger.getStats()
  }

  /**
   * 清理旧的执行日志
   */
  async clearOldExecutionLogs(daysBefore: number): Promise<number> {
    if (!this.executionLogger) {
      return 0
    }
    return this.executionLogger.clearOldLogs(daysBefore)
  }

  // ---------- 导出/导入相关 ----------

  /**
   * 导出技能为 .ocskill 文件
   */
  async exportSkill(skillId: string, outputPath: string): Promise<{
    success: boolean
    outputPath?: string
    fileSize?: number
    error?: string
  }> {
    if (!this.skillStore || !this.skillExporter) {
      return { success: false, error: '技能系统未初始化' }
    }

    const skillDir = this.skillStore.getSkillDirectory(skillId)
    if (!skillDir) {
      return { success: false, error: `技能不存在: ${skillId}` }
    }

    log.info('IPC: exportSkill', { skillId, outputPath })
    return this.skillExporter.exportSkill(skillDir, outputPath)
  }

  /**
   * 从 .ocskill 文件导入技能
   */
  async importSkill(ocskillPath: string): Promise<{
    success: boolean
    skillId?: string
    skillName?: string
    error?: string
  }> {
    if (!this.skillImporter) {
      return { success: false, error: '技能系统未初始化' }
    }

    log.info('IPC: importSkill', { ocskillPath })
    const result = await this.skillImporter.importSkill(ocskillPath)

    if (result.success) {
      await this.reloadExternalSkills()
    }

    return result
  }

  /**
   * 预览 .ocskill 文件内容（不安装）
   */
  async previewOcskill(ocskillPath: string): Promise<{
    meta: import('./skill-exporter').OcskillMeta | null
    error?: string
  }> {
    if (!this.skillImporter) {
      return { meta: null, error: '技能系统未初始化' }
    }

    return this.skillImporter.previewSkill(ocskillPath)
  }

  /**
   * 从目录安装技能并自动重新加载
   */
  async installFromDirectory(sourceDir: string): Promise<{
    success: boolean
    skillId?: string
    error?: string
  }> {
    if (!this.skillStore) {
      return { success: false, error: 'SkillStore 未初始化' }
    }

    log.info('IPC: installFromDirectory', { sourceDir })
    const result = await this.skillStore.installFromDirectory(sourceDir)

    if (result.success) {
      await this.reloadExternalSkills()
    }

    return result
  }

  /**
   * 卸载本地技能并注销
   */
  async uninstallLocal(skillId: string): Promise<{
    success: boolean
    error?: string
  }> {
    if (!this.skillStore) {
      return { success: false, error: 'SkillStore 未初始化' }
    }

    log.info('IPC: uninstallLocal', { skillId })
    const result = await this.skillStore.uninstall(skillId)

    if (result.success) {
      this.unregisterSkill(skillId)
    }

    return result
  }

  /**
   * 列出本地已安装技能
   */
  async listLocalInstalled(): Promise<SkillIndexEntry[]> {
    if (!this.skillStore) {
      return []
    }
    return this.skillStore.listInstalled()
  }

  /**
   * 获取技能详情（manifest + indexEntry）
   */
  async getSkillDetail(skillId: string): Promise<{
    manifest: SkillManifest | null
    indexEntry: SkillIndexEntry | null
  }> {
    if (!this.skillStore) {
      return { manifest: null, indexEntry: null }
    }

    const manifest = await this.skillStore.getManifest(skillId)
    const installed = await this.skillStore.listInstalled()
    const indexEntry = installed.find((s) => s.id === skillId) ?? null

    return { manifest, indexEntry }
  }

  /**
   * 启用/禁用本地技能并重新加载
   */
  async setLocalEnabled(skillId: string, enabled: boolean): Promise<boolean> {
    if (!this.skillStore) {
      return false
    }

    log.info('IPC: setLocalEnabled', { skillId, enabled })
    const result = await this.skillStore.setEnabled(skillId, enabled)

    if (result) {
      await this.reloadExternalSkills()
    }

    return result
  }

  /**
   * 重新加载外部技能
   *
   * 清除所有非内置技能后重新从存储加载
   */
  async reloadExternalSkills(): Promise<void> {
    // 移除所有非内置技能
    for (const [skillId] of this.skills) {
      if (!skillId.startsWith('builtin:')) {
        this.skills.delete(skillId)
      }
    }

    // 重新读取磁盘索引
    if (this.skillStore) {
      await this.skillStore.reload()
    }

    // 重新加载
    await this.loadExternalSkills()

    log.info('外部技能重新加载完成', { totalSkills: this.skills.size })
  }

  /**
   * 处理来自 Gateway 的技能安装推送
   *
   * 解码 base64 包 → 校验 SHA-256 → 解压 → 安装 → 重新加载
   *
   * @param request - 安装推送请求
   * @returns 安装结果
   */
  async handleSkillInstallPush(request: {
    requestId: string
    skillId: string
    version: string
    packageBase64: string
    packageHash: string
    manifest: SkillManifest
  }): Promise<{ success: boolean; error?: string }> {
    log.info('收到技能安装推送', {
      requestId: request.requestId,
      skillId: request.skillId,
      version: request.version,
    })

    const tempDir = path.join(os.tmpdir(), `skill-install-${request.skillId}-${Date.now()}`)

    try {
      // 1. 验证 base64 大小（防止 DoS 攻击）
      // Base64 编码后大小约为原始大小的 4/3，所以用 0.75 估算原始大小
      const estimatedSize = request.packageBase64.length * 0.75
      if (estimatedSize > MAX_PACKAGE_SIZE) {
        log.error('技能包过大', {
          skillId: request.skillId,
          estimatedSize,
          maxSize: MAX_PACKAGE_SIZE,
        })
        return {
          success: false,
          error: `技能包过大（${(estimatedSize / 1024 / 1024).toFixed(2)}MB），最大允许 ${MAX_PACKAGE_SIZE / 1024 / 1024}MB`,
        }
      }

      // 2. base64 解码
      const packageBuffer = Buffer.from(request.packageBase64, 'base64')

      // 3. SHA-256 校验
      const actualHash = crypto.createHash('sha256').update(packageBuffer).digest('hex')
      if (actualHash !== request.packageHash) {
        log.error('技能包哈希校验失败', {
          skillId: request.skillId,
          expected: request.packageHash,
          actual: actualHash,
        })
        return { success: false, error: '包完整性校验失败：SHA-256 不匹配' }
      }

      // 4. 解压到临时目录
      await fs.mkdir(tempDir, { recursive: true })
      const archivePath = path.join(tempDir, `${request.skillId}.tgz`)
      await fs.writeFile(archivePath, packageBuffer)

      // 使用 tar 解压
      const tar = await import('tar')
      await tar.x({ file: archivePath, cwd: tempDir })

      // 5. 找到包含 skill.json 的子目录
      const entries = await fs.readdir(tempDir, { withFileTypes: true })
      const skillSubDir = entries.find((e) => e.isDirectory())
      if (!skillSubDir) {
        return { success: false, error: '解压后未找到技能目录' }
      }
      const skillDir = path.join(tempDir, skillSubDir.name)

      // 6. 通过 LocalSkillStore 安装
      if (!this.skillStore) {
        return { success: false, error: '技能存储未初始化' }
      }
      const installResult = await this.skillStore.installFromDirectory(skillDir)
      if (!installResult.success) {
        return { success: false, error: installResult.error || '安装失败' }
      }

      // 7. 重新加载外部技能
      await this.reloadExternalSkills()

      log.info('技能安装推送完成', {
        skillId: request.skillId,
        version: request.version,
      })

      return { success: true }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.error('技能安装推送失败', {
        skillId: request.skillId,
        error: errorMessage,
      })
      return { success: false, error: errorMessage }
    } finally {
      // 清理临时目录
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

// 导出事件名称常量
export const SKILL_EXECUTE_EVENT = 'skill.execute.request'
export const SKILL_RESULT_METHOD = 'assistant.skill.result'
export const SKILL_INSTALL_EVENT = 'skill.install.request'
export const SKILL_INSTALL_RESULT_METHOD = 'assistant.skill.installResult'
