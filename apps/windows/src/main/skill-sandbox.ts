/**
 * SkillSandbox - 技能沙箱隔离模块
 *
 * 使用 isolated-vm 为技能执行提供 V8 沙箱隔离
 * 限制内存使用、执行时间，防止恶意代码影响主进程
 */

import { createLogger } from './logger'

// 日志输出
const log = createLogger('SkillSandbox')

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 沙箱配置选项
 */
export interface SandboxOptions {
  /** 内存限制 (MB) */
  memoryLimitMb: number
  /** 执行超时 (ms) */
  timeoutMs: number
  /** 允许的全局对象 */
  allowedGlobals?: string[]
  /** 是否允许网络访问 */
  allowNetwork?: boolean
  /** 是否允许文件系统访问 */
  allowFileSystem?: boolean
}

/**
 * 沙箱执行结果
 */
export interface SandboxExecutionResult {
  success: boolean
  result?: unknown
  error?: {
    code: string
    message: string
    stack?: string
  }
  executionTimeMs: number
  memoryUsedBytes?: number
}

/**
 * 沙箱 API 定义
 */
export interface SandboxApi {
  name: string
  handler: (...args: unknown[]) => unknown | Promise<unknown>
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_OPTIONS: SandboxOptions = {
  memoryLimitMb: 128,
  timeoutMs: 30000,
  allowedGlobals: ['console', 'JSON', 'Math', 'Date', 'Array', 'Object', 'String', 'Number', 'Boolean'],
  allowNetwork: false,
  allowFileSystem: false,
}

// ============================================================================
// SkillSandbox 类
// ============================================================================

/**
 * 技能沙箱
 *
 * 提供安全的 JavaScript 代码执行环境
 * 注意: 需要安装 isolated-vm 依赖才能使用完整功能
 */
export class SkillSandbox {
  private options: SandboxOptions
  private isolate: unknown = null
  private apis: Map<string, SandboxApi> = new Map()
  private initialized = false

  constructor(options: Partial<SandboxOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
    log.info('SkillSandbox created', {
      memoryLimitMb: this.options.memoryLimitMb,
      timeoutMs: this.options.timeoutMs,
    })
  }

  /**
   * 初始化沙箱
   *
   * 尝试加载 isolated-vm，如果不可用则使用降级模式
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) {
      return true
    }

    try {
      // 尝试动态加载 isolated-vm
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ivm = require('isolated-vm')
      this.isolate = new ivm.Isolate({ memoryLimit: this.options.memoryLimitMb })
      this.initialized = true
      log.info('SkillSandbox initialized with isolated-vm')
      return true
    } catch (error) {
      // isolated-vm 不可用，使用降级模式（安全性较低，仅用于开发/测试环境）
      log.warn(
        'isolated-vm 不可用，沙箱已降级为 Function 构造器模式（安全性较低）。' +
        '生产环境建议安装 isolated-vm 以获得完整隔离保护。',
        { error: error instanceof Error ? error.message : String(error) }
      )
      this.initialized = true
      return false
    }
  }

  /**
   * 注册沙箱 API
   *
   * 允许在沙箱中调用的安全 API
   */
  registerApi(api: SandboxApi): void {
    this.apis.set(api.name, api)
    log.debug('API registered', { name: api.name })
  }

  /**
   * 注销沙箱 API
   */
  unregisterApi(name: string): boolean {
    return this.apis.delete(name)
  }

  /**
   * 在沙箱中执行代码
   */
  async executeInSandbox(
    code: string,
    context: Record<string, unknown> = {}
  ): Promise<SandboxExecutionResult> {
    const startTime = Date.now()

    if (!this.initialized) {
      await this.initialize()
    }

    try {
      // 如果 isolated-vm 可用，使用完整沙箱
      if (this.isolate) {
        return await this.executeWithIsolatedVm(code, context, startTime)
      }

      // 否则使用降级模式 (Function 构造器)
      return await this.executeWithFallback(code, context, startTime)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorStack = error instanceof Error ? error.stack : undefined

      log.error('Sandbox execution failed', { error: errorMessage })

      return {
        success: false,
        error: {
          code: 'SANDBOX_ERROR',
          message: errorMessage,
          stack: errorStack,
        },
        executionTimeMs: Date.now() - startTime,
      }
    }
  }

  /**
   * 使用 isolated-vm 执行代码
   */
  private async executeWithIsolatedVm(
    code: string,
    context: Record<string, unknown>,
    startTime: number
  ): Promise<SandboxExecutionResult> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ivm = require('isolated-vm')
    const isolate = this.isolate as InstanceType<typeof ivm.Isolate>

    // 创建新的上下文
    const ctx = await isolate.createContext()
    const jail = ctx.global

    // 设置全局对象引用
    await jail.set('global', jail.derefInto())

    // 注入安全的 console
    await jail.set(
      'console',
      new ivm.ExternalCopy({
        log: (...args: unknown[]) => log.info('[Sandbox]', ...args),
        warn: (...args: unknown[]) => log.warn('[Sandbox]', ...args),
        error: (...args: unknown[]) => log.error('[Sandbox]', ...args),
      }).copyInto()
    )

    // 注入上下文数据
    await jail.set('__context', new ivm.ExternalCopy(context).copyInto())

    // 注入注册的 API
    for (const [name, api] of this.apis) {
      await jail.set(
        name,
        new ivm.Reference(async (...args: unknown[]) => {
          return api.handler(...args)
        })
      )
    }

    // 包装代码以返回结果
    const wrappedCode = `
      (async function() {
        const context = __context;
        ${code}
      })()
    `

    // 编译并执行
    const script = await isolate.compileScript(wrappedCode)
    const result = await script.run(ctx, {
      timeout: this.options.timeoutMs,
      promise: true,
    })

    // 获取内存使用情况
    const heapStats = isolate.getHeapStatisticsSync()

    return {
      success: true,
      result,
      executionTimeMs: Date.now() - startTime,
      memoryUsedBytes: heapStats.used_heap_size,
    }
  }

  /**
   * 使用降级模式执行代码 (Function 构造器)
   *
   * 注意: 这种模式安全性较低，仅用于 isolated-vm 不可用时
   */
  private async executeWithFallback(
    code: string,
    context: Record<string, unknown>,
    startTime: number
  ): Promise<SandboxExecutionResult> {
    log.warn('Using fallback sandbox mode (less secure)')

    // 创建受限的全局对象
    const safeGlobals: Record<string, unknown> = {
      console: {
        log: (...args: unknown[]) => log.info('[Sandbox]', ...args),
        warn: (...args: unknown[]) => log.warn('[Sandbox]', ...args),
        error: (...args: unknown[]) => log.error('[Sandbox]', ...args),
      },
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Promise,
      __context: context,
    }

    // 添加注册的 API
    for (const [name, api] of this.apis) {
      safeGlobals[name] = api.handler
    }

    // 创建参数名和值数组
    const paramNames = Object.keys(safeGlobals)
    const paramValues = Object.values(safeGlobals)

    // 包装代码
    const wrappedCode = `
      "use strict";
      return (async function() {
        const context = __context;
        ${code}
      })();
    `

    // 使用 Function 构造器创建函数
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(...paramNames, wrappedCode)

    // 设置超时
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Execution timeout')), this.options.timeoutMs)
    })

    // 执行并等待结果
    const result = await Promise.race([fn(...paramValues), timeoutPromise])

    return {
      success: true,
      result,
      executionTimeMs: Date.now() - startTime,
    }
  }

  /**
   * 销毁沙箱，释放资源
   */
  dispose(): void {
    if (this.isolate) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const ivm = require('isolated-vm')
        const isolate = this.isolate as InstanceType<typeof ivm.Isolate>
        isolate.dispose()
      } catch {
        // 忽略错误
      }
      this.isolate = null
    }
    this.apis.clear()
    this.initialized = false
    log.info('SkillSandbox disposed')
  }

  /**
   * 获取沙箱状态
   */
  getStatus(): {
    initialized: boolean
    hasIsolatedVm: boolean
    fallbackMode: boolean
    registeredApis: string[]
    options: SandboxOptions
  } {
    return {
      initialized: this.initialized,
      hasIsolatedVm: this.isolate !== null,
      fallbackMode: this.initialized && this.isolate === null,
      registeredApis: Array.from(this.apis.keys()),
      options: this.options,
    }
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建默认配置的沙箱
 */
export function createDefaultSandbox(): SkillSandbox {
  return new SkillSandbox()
}

/**
 * 创建高安全性沙箱
 */
export function createSecureSandbox(): SkillSandbox {
  return new SkillSandbox({
    memoryLimitMb: 64,
    timeoutMs: 10000,
    allowNetwork: false,
    allowFileSystem: false,
  })
}

/**
 * 创建宽松配置的沙箱 (用于可信代码)
 */
export function createTrustedSandbox(): SkillSandbox {
  return new SkillSandbox({
    memoryLimitMb: 256,
    timeoutMs: 60000,
    allowNetwork: true,
    allowFileSystem: true,
  })
}
