/**
 * SecurityUtils - 安全工具模块
 *
 * 提供路径验证、输入消毒、命令安全执行等安全功能
 * 用于防止路径遍历、命令注入、XSS 等安全漏洞
 */

import { normalize, resolve, isAbsolute, join } from 'path'
import * as os from 'os'

// 日志输出
const log = {
  debug: (...args: unknown[]) => console.log('[Security:DEBUG]', ...args),
  info: (...args: unknown[]) => console.log('[Security]', ...args),
  warn: (...args: unknown[]) => console.warn('[Security]', ...args),
  error: (...args: unknown[]) => console.error('[Security]', ...args),
}

/**
 * 安全配置
 */
export interface SecurityConfig {
  /** 允许访问的基础目录列表 */
  allowedBasePaths: string[]
  /** 禁止访问的路径模式 */
  forbiddenPatterns: RegExp[]
  /** 允许执行的命令白名单 */
  allowedCommands: string[]
  /** 最大文件大小限制 (bytes) */
  maxFileSize: number
  /** 最大路径深度 */
  maxPathDepth: number
}

/**
 * 默认安全配置
 */
const DEFAULT_CONFIG: SecurityConfig = {
  allowedBasePaths: [
    os.homedir(),
    os.tmpdir(),
  ],
  forbiddenPatterns: [
    /(?:^|[\\/])\.\.(?:[\\/]|$)/, // 禁止路径遍历（仅匹配路径组件 ..，不误报文件名中的 ..）
    /^\/etc/i, // 系统配置目录
    /^\/var/i, // 系统变量目录
    /^C:\\Windows/i, // Windows 系统目录
    /^C:\\Program Files/i, // 程序目录
    /^C:\\ProgramData/i, // 程序数据目录
    /System32/i, // 系统目录
    /\.ssh/i, // SSH 密钥目录
    /\.gnupg/i, // GPG 密钥目录
    /\.aws/i, // AWS 凭证
    /\.azure/i, // Azure 凭证
    /credentials/i, // 凭证文件
    /secrets/i, // 密钥文件
  ],
  allowedCommands: [
    'powershell',
    'cmd',
    'tasklist',
    'taskkill',
    'systeminfo',
    'wmic',
  ],
  maxFileSize: 100 * 1024 * 1024, // 100MB
  maxPathDepth: 20,
}

/**
 * 安全工具类
 */
export class SecurityUtils {
  private config: SecurityConfig

  constructor(config: Partial<SecurityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    log.info('安全工具初始化完成')
  }

  /**
   * 验证并规范化路径
   * 防止路径遍历攻击
   *
   * @param inputPath 用户输入的路径
   * @param basePath 可选的基础路径限制
   * @returns 规范化后的安全路径
   * @throws 如果路径不安全则抛出错误
   */
  validatePath(inputPath: string, basePath?: string): string {
    log.debug(`验证路径: ${inputPath}`)

    // 检查空路径
    if (!inputPath || typeof inputPath !== 'string') {
      throw new SecurityError('路径不能为空', 'INVALID_PATH')
    }

    // 去除首尾空白
    const trimmedPath = inputPath.trim()

    // 检查路径长度
    if (trimmedPath.length > 260) {
      throw new SecurityError('路径长度超出限制', 'PATH_TOO_LONG')
    }

    // 规范化路径
    let normalizedPath: string
    if (isAbsolute(trimmedPath)) {
      normalizedPath = normalize(trimmedPath)
    } else if (basePath) {
      normalizedPath = normalize(resolve(basePath, trimmedPath))
    } else {
      throw new SecurityError('相对路径必须提供基础路径', 'RELATIVE_PATH_NO_BASE')
    }

    // 检查禁止的模式
    for (const pattern of this.config.forbiddenPatterns) {
      if (pattern.test(normalizedPath)) {
        log.warn(`路径匹配禁止模式: ${normalizedPath}, 模式: ${pattern}`)
        throw new SecurityError('访问被禁止的路径', 'FORBIDDEN_PATH')
      }
    }

    // 检查路径深度
    const pathParts = normalizedPath.split(/[/\\]/).filter(Boolean)
    if (pathParts.length > this.config.maxPathDepth) {
      throw new SecurityError('路径深度超出限制', 'PATH_TOO_DEEP')
    }

    // 如果指定了基础路径，确保规范化后的路径仍在基础路径内
    if (basePath) {
      const normalizedBase = normalize(resolve(basePath))
      if (!normalizedPath.startsWith(normalizedBase)) {
        log.warn(`路径遍历尝试: ${normalizedPath} 不在 ${normalizedBase} 内`)
        throw new SecurityError('路径遍历攻击被阻止', 'PATH_TRAVERSAL')
      }
    }

    // 检查是否在允许的基础路径内
    const isAllowed = this.config.allowedBasePaths.some((allowedBase) => {
      const normalizedAllowed = normalize(resolve(allowedBase))
      return normalizedPath.startsWith(normalizedAllowed)
    })

    if (!isAllowed) {
      log.warn(`路径不在允许范围内: ${normalizedPath}`)
      throw new SecurityError('路径不在允许的访问范围内', 'PATH_NOT_ALLOWED')
    }

    log.debug(`路径验证通过: ${normalizedPath}`)
    return normalizedPath
  }

  /**
   * 验证路径是否安全（不抛出异常版本）
   */
  isPathSafe(inputPath: string, basePath?: string): boolean {
    try {
      this.validatePath(inputPath, basePath)
      return true
    } catch {
      return false
    }
  }

  /**
   * 添加允许的基础路径
   */
  addAllowedBasePath(path: string): void {
    const normalizedPath = normalize(resolve(path))
    if (!this.config.allowedBasePaths.includes(normalizedPath)) {
      this.config.allowedBasePaths.push(normalizedPath)
      log.info(`添加允许的基础路径: ${normalizedPath}`)
    }
  }

  /**
   * 消毒用户输入字符串
   * 移除或转义危险字符
   *
   * @param input 用户输入
   * @param options 消毒选项
   * @returns 消毒后的字符串
   */
  sanitizeInput(
    input: string,
    options: {
      maxLength?: number
      allowedChars?: RegExp
      stripHtml?: boolean
      stripControlChars?: boolean
    } = {}
  ): string {
    const {
      maxLength = 10000,
      allowedChars,
      stripHtml = true,
      stripControlChars = true,
    } = options

    if (typeof input !== 'string') {
      return ''
    }

    let sanitized = input

    // 限制长度
    if (sanitized.length > maxLength) {
      sanitized = sanitized.substring(0, maxLength)
    }

    // 移除控制字符（保留换行和制表符）
    if (stripControlChars) {
      sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    }

    // 移除 HTML 标签
    if (stripHtml) {
      sanitized = sanitized.replace(/<[^>]*>/g, '')
    }

    // 只保留允许的字符
    if (allowedChars) {
      sanitized = sanitized
        .split('')
        .filter((char) => allowedChars.test(char))
        .join('')
    }

    return sanitized.trim()
  }

  /**
   * 消毒文件名
   * 移除路径分隔符和危险字符
   */
  sanitizeFileName(fileName: string): string {
    if (typeof fileName !== 'string') {
      return ''
    }

    // 移除路径分隔符和危险字符
    let sanitized = fileName
      .replace(/[/\\:*?"<>|]/g, '_') // 替换 Windows 禁止的字符
      .replace(/\.\./g, '_') // 防止路径遍历
      .replace(/^\.+/, '') // 移除开头的点
      .trim()

    // 限制长度
    if (sanitized.length > 200) {
      const ext = sanitized.lastIndexOf('.')
      if (ext > 0) {
        const name = sanitized.substring(0, ext)
        const extension = sanitized.substring(ext)
        sanitized = name.substring(0, 200 - extension.length) + extension
      } else {
        sanitized = sanitized.substring(0, 200)
      }
    }

    return sanitized || 'unnamed'
  }

  /**
   * 验证并消毒命令参数
   * 防止命令注入攻击
   */
  sanitizeCommandArg(arg: string): string {
    if (typeof arg !== 'string') {
      return ''
    }

    // 移除危险的 shell 元字符
    const dangerous = /[;&|`$(){}[\]<>!#*?~]/g
    let sanitized = arg.replace(dangerous, '')

    // 移除换行符
    sanitized = sanitized.replace(/[\r\n]/g, ' ')

    // 转义双引号
    sanitized = sanitized.replace(/"/g, '\\"')

    return sanitized.trim()
  }

  /**
   * 验证命令是否在白名单中
   */
  isCommandAllowed(command: string): boolean {
    const cmdLower = command.toLowerCase().trim()
    const cmdBase = cmdLower.split(/[\s/\\]/)[0]

    return this.config.allowedCommands.some(
      (allowed) => allowed.toLowerCase() === cmdBase
    )
  }

  /**
   * 验证 PID 是否有效
   */
  validatePid(pid: unknown): number {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      throw new SecurityError('无效的进程 ID', 'INVALID_PID')
    }

    // PID 通常不会超过这个值
    if (pid > 4194304) {
      throw new SecurityError('进程 ID 超出有效范围', 'PID_OUT_OF_RANGE')
    }

    return pid
  }

  /**
   * 验证 URL 是否安全
   */
  validateUrl(url: string, options: { allowedProtocols?: string[] } = {}): string {
    const { allowedProtocols = ['http:', 'https:', 'ws:', 'wss:'] } = options

    if (typeof url !== 'string' || !url.trim()) {
      throw new SecurityError('URL 不能为空', 'INVALID_URL')
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      throw new SecurityError('无效的 URL 格式', 'INVALID_URL_FORMAT')
    }

    // 检查协议
    if (!allowedProtocols.includes(parsedUrl.protocol)) {
      throw new SecurityError(
        `不允许的协议: ${parsedUrl.protocol}`,
        'FORBIDDEN_PROTOCOL'
      )
    }

    // 检查是否是本地地址（可能的 SSRF）
    const hostname = parsedUrl.hostname.toLowerCase()
    const localPatterns = [
      /^localhost$/i,
      /^127\./,
      /^192\.168\./,
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^0\.0\.0\.0$/,
      /^::1$/,
      /^fe80:/i,
    ]

    // 对于外部 URL，阻止访问内网地址
    const isLocal = localPatterns.some((pattern) => pattern.test(hostname))
    if (isLocal && !options.allowedProtocols?.includes('local')) {
      log.warn(`检测到本地地址访问: ${hostname}`)
      // 注意：这里不阻止，因为 Gateway 可能在本地
    }

    return parsedUrl.href
  }

  /**
   * 转义正则表达式特殊字符
   */
  escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /**
   * 创建安全的正则表达式
   * 防止 ReDoS 攻击
   */
  createSafeRegExp(pattern: string, flags = 'i'): RegExp {
    // 转义用户输入
    const escaped = this.escapeRegExp(pattern)

    // 限制模式长度
    if (escaped.length > 100) {
      throw new SecurityError('正则表达式模式过长', 'PATTERN_TOO_LONG')
    }

    return new RegExp(escaped, flags)
  }

  /**
   * 编译"调用方已构造好的正则模式"。
   * 与 createSafeRegExp 不同：本方法不对模式做整体转义，
   * 适用于前端已生成的搜索正则（如 `\.md$`、`.*` 通配符）。
   * 仍通过长度上限抑制 ReDoS；编译失败时退化为字面量子串匹配。
   */
  createSearchRegExp(pattern: string, flags = 'i'): RegExp {
    if (pattern.length > 100) {
      throw new SecurityError('正则表达式模式过长', 'PATTERN_TOO_LONG')
    }
    try {
      return new RegExp(pattern, flags)
    } catch {
      // 非法正则：退回为对原始文本的字面量子串匹配
      return new RegExp(this.escapeRegExp(pattern), flags)
    }
  }

  /**
   * 验证数字范围
   */
  validateNumber(
    value: unknown,
    options: { min?: number; max?: number; integer?: boolean } = {}
  ): number {
    const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, integer = false } = options

    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new SecurityError('无效的数字', 'INVALID_NUMBER')
    }

    if (integer && !Number.isInteger(value)) {
      throw new SecurityError('必须是整数', 'NOT_INTEGER')
    }

    if (value < min || value > max) {
      throw new SecurityError(`数字超出范围 [${min}, ${max}]`, 'NUMBER_OUT_OF_RANGE')
    }

    return value
  }

  /**
   * 验证字符串
   */
  validateString(
    value: unknown,
    options: { minLength?: number; maxLength?: number; pattern?: RegExp } = {}
  ): string {
    const { minLength = 0, maxLength = 10000, pattern } = options

    if (typeof value !== 'string') {
      throw new SecurityError('必须是字符串', 'NOT_STRING')
    }

    if (value.length < minLength) {
      throw new SecurityError(`字符串长度不能小于 ${minLength}`, 'STRING_TOO_SHORT')
    }

    if (value.length > maxLength) {
      throw new SecurityError(`字符串长度不能超过 ${maxLength}`, 'STRING_TOO_LONG')
    }

    if (pattern && !pattern.test(value)) {
      throw new SecurityError('字符串格式不正确', 'INVALID_FORMAT')
    }

    return value
  }
}

/**
 * 安全错误类
 */
export class SecurityError extends Error {
  code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'SecurityError'
    this.code = code
    log.error(`安全错误 [${code}]: ${message}`)
  }
}

/**
 * 默认安全工具实例
 */
export const securityUtils = new SecurityUtils()

/**
 * 导出便捷函数
 */
export const validatePath = (path: string, basePath?: string) =>
  securityUtils.validatePath(path, basePath)

export const sanitizeInput = (input: string, options?: Parameters<SecurityUtils['sanitizeInput']>[1]) =>
  securityUtils.sanitizeInput(input, options)

export const sanitizeFileName = (fileName: string) =>
  securityUtils.sanitizeFileName(fileName)

export const sanitizeCommandArg = (arg: string) =>
  securityUtils.sanitizeCommandArg(arg)

export const validatePid = (pid: unknown) =>
  securityUtils.validatePid(pid)

export const validateUrl = (url: string, options?: Parameters<SecurityUtils['validateUrl']>[1]) =>
  securityUtils.validateUrl(url, options)

export const escapeRegExp = (str: string) =>
  securityUtils.escapeRegExp(str)

export const createSafeRegExp = (pattern: string, flags?: string) =>
  securityUtils.createSafeRegExp(pattern, flags)

export const createSearchRegExp = (pattern: string, flags?: string) =>
  securityUtils.createSearchRegExp(pattern, flags)
