/**
 * FileLogger - 文件日志模块
 *
 * 将 console.log/error/warn 输出同时写入日志文件
 * 日志文件位于客户端数据根下 logs/app/（默认 ~/.lumii/logs/app/），按日期滚动
 * 便携版（PORTABLE_EXECUTABLE_DIR）写入 EXE 同级 logs/ 目录
 */

import { app } from 'electron'
import { join } from 'path'

import { resolveClientStateDir } from './paths'
import { createWriteStream, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from 'fs'
import type { WriteStream } from 'fs'
import { getLocalDateString, getLocalTimeString } from './local-time'

/** 最大保留日志文件数量 */
const MAX_LOG_FILES = 7

/** 日志级别 */
type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

/**
 * 获取日志目录路径
 *
 * portable EXE: 优先使用 PORTABLE_EXECUTABLE_DIR（EXE 所在目录），
 *               因为 portable 模式下 app.getPath('exe') 指向临时解压目录。
 * 普通安装 / 开发环境: 统一使用用户数据根下 logs/app/，避免写入 Program Files 需要管理员权限。
 */
function getLogDir(): string {
  // portable EXE 通过环境变量获取原始 EXE 所在目录
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  if (portableDir) {
    return join(portableDir, 'logs')
  }

  const mtbotDataDir = resolveClientStateDir()
  return join(mtbotDataDir, 'logs', 'app')
}

/** 获取当前日期字符串 (YYYY-MM-DD)，本地时区 */
const getDateString = getLocalDateString

/** 获取时间戳字符串 (HH:mm:ss.SSS)，本地时区 */
const getTimeString = getLocalTimeString

/**
 * 格式化日志参数为字符串
 */
function formatArgs(args: unknown[]): string {
  return args.map(arg => {
    if (arg instanceof Error) {
      return `${arg.message}\n${arg.stack || ''}`
    }
    if (typeof arg === 'object' && arg !== null) {
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    }
    return String(arg)
  }).join(' ')
}

/**
 * 清理过期日志文件
 */
function cleanOldLogs(logDir: string): void {
  try {
    if (!existsSync(logDir)) {return}

    const files = readdirSync(logDir)
      .filter(f => f.startsWith('mtbot-') && f.endsWith('.log'))
      .map(f => ({
        name: f,
        path: join(logDir, f),
        mtime: statSync(join(logDir, f)).mtime.getTime(),
      }))
      .toSorted((a, b) => b.mtime - a.mtime)

    // 删除超出数量限制的旧文件
    for (let i = MAX_LOG_FILES; i < files.length; i++) {
      try {
        unlinkSync(files[i].path)
      } catch {
        // 忽略删除失败
      }
    }
  } catch {
    // 忽略清理失败
  }
}

/**
 * FileLogger 类
 */
class FileLogger {
  private stream: WriteStream | null = null
  private logDir: string = ''
  private currentDate: string = ''
  private initialized = false

  // 保存原始 console 方法
  private originalConsoleLog = console.log
  private originalConsoleError = console.error
  private originalConsoleWarn = console.warn

  /**
   * 初始化日志系统
   *
   * 必须在 app.whenReady() 之后调用
   */
  initialize(): void {
    if (this.initialized) {return}

    this.logDir = getLogDir()
    this.currentDate = getDateString()

    // 确保日志目录存在
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true })
    }

    // 创建日志文件流
    this.openStream()

    // 清理旧日志
    cleanOldLogs(this.logDir)

    // 拦截 console 方法
    this.interceptConsole()

    this.initialized = true
    this.writeLog('INFO', '[FileLogger] 日志系统已初始化', `目录: ${this.logDir}`)
  }

  /**
   * 打开日志文件流
   */
  private openStream(): void {
    const logFile = join(this.logDir, `mtbot-${this.currentDate}.log`)
    this.stream = createWriteStream(logFile, { flags: 'a', encoding: 'utf8' })

    this.stream.on('error', (err) => {
      this.originalConsoleError('[FileLogger] 写入日志文件失败:', err)
    })
  }

  /**
   * 检查是否需要切换日期文件
   */
  private checkDateRoll(): void {
    const today = getDateString()
    if (today !== this.currentDate) {
      this.currentDate = today
      this.stream?.end()
      this.openStream()
      cleanOldLogs(this.logDir)
    }
  }

  /**
   * 写入日志
   */
  private writeLog(level: LogLevel, ...args: unknown[]): void {
    if (!this.stream) {return}

    this.checkDateRoll()

    const line = `[${getDateString()} ${getTimeString()}] [${level}] ${formatArgs(args)}\n`

    try {
      this.stream.write(line)
    } catch {
      // 忽略写入失败
    }
  }

  /**
   * 安全写入控制台
   *
   * 当父进程管道已关闭（如终端窗口被关闭）时，
   * Node.js 的 SyncWriteStream.write 会抛出 EPIPE 同步异常。
   * 捕获后标记 stdoutBroken，后续调用只写文件不再尝试 stdout。
   */
  private stdoutBroken = false

  private safeConsoleWrite(
    originalFn: (...args: unknown[]) => void,
    ...args: unknown[]
  ): void {
    if (this.stdoutBroken) {return}
    try {
      originalFn(...args)
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
        this.stdoutBroken = true
      }
      // 静默忽略控制台写入失败，日志仍会写入文件
    }
  }

  /**
   * 拦截 console 方法，同时写入文件和控制台
   */
  private interceptConsole(): void {
    console.log = (...args: unknown[]) => {
      this.safeConsoleWrite(this.originalConsoleLog, ...args)
      this.writeLog('INFO', ...args)
    }

    console.error = (...args: unknown[]) => {
      this.safeConsoleWrite(this.originalConsoleError, ...args)
      this.writeLog('ERROR', ...args)
    }

    console.warn = (...args: unknown[]) => {
      this.safeConsoleWrite(this.originalConsoleWarn, ...args)
      this.writeLog('WARN', ...args)
    }
  }

  /**
   * 获取日志目录路径
   */
  getLogDir(): string {
    return this.logDir
  }

  /**
   * 获取当前日志文件完整路径（用于启动时在控制台打印）
   */
  getCurrentLogFilePath(): string {
    return join(this.logDir, `mtbot-${this.currentDate}.log`)
  }

  /**
   * 关闭日志系统
   */
  destroy(): void {
    if (this.stream) {
      this.writeLog('INFO', '[FileLogger] 日志系统关闭')
      this.stream.end()
      this.stream = null
    }

    // 恢复原始 console 方法
    console.log = this.originalConsoleLog
    console.error = this.originalConsoleError
    console.warn = this.originalConsoleWarn

    this.initialized = false
  }
}

/** 全局日志实例 */
export const fileLogger = new FileLogger()
