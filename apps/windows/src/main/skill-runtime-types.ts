/**
 * ClientSkillRuntime 类型定义（与 gateway/protocol/skill-execution.ts 保持一致）+ 内置技能数据。
 */

import type { SystemService } from './system-service'
import type { SkillSandbox } from './skill-sandbox'
import { createLogger } from './logger'

const log = createLogger('SkillRuntime')

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
export const BUILTIN_SKILLS: SkillDefinition[] = [
  fileListSkill,
  fileReadSkill,
  systemInfoSkill,
  executeCommandSkill,
]
