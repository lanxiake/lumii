/**
 * FileLogger - 文件日志模块
 *
 * 将 console.log/error/warn/debug 输出同时写入日志文件
 * 日志文件位于客户端数据根下 logs/app/（默认 ~/.lumii/logs/app/），按日期滚动：
 * - mtbot-YYYY-MM-DD.log       全量日志（DEBUG/INFO/WARN/ERROR）
 * - mtbot-error-YYYY-MM-DD.log 仅 ERROR，供崩溃后直接抓取
 * 便携版（PORTABLE_EXECUTABLE_DIR）写入 EXE 同级 logs/ 目录
 */

import { app } from 'electron'
import { join } from 'path'

import { resolveClientStateDir } from './paths'
import { createWriteStream, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from 'fs'
import type { WriteStream } from 'fs'
import { getLocalDateString, getLocalTimeString } from './local-time'

/** 主日志文件前缀 */
const LOG_PREFIX = 'mtbot-'

/**
 * 错误日志文件前缀。
 *
 * 与主日志前缀重叠（mtbot- 也匹配 mtbot-error-），清理时必须在主日志一侧显式排除，
 * 否则两种日志会互相占掉对方的保留名额。
 */
const ERROR_LOG_PREFIX = 'mtbot-error-'

/** 主日志最大保留文件数量 */
const MAX_LOG_FILES = 7

/**
 * 错误日志最大保留文件数量。
 *
 * 比主日志留得久：错误稀少（单文件通常只有几十 KB），且是崩溃/故障复盘时
 * 唯一会被翻出来的东西——真出事时 7 天前的现场往往已经不够用了。
 */
const MAX_ERROR_LOG_FILES = 30

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
 * 按前缀清理过期日志，保留最新的 maxFiles 个
 *
 * @param excludePrefixes 需要从统计中剔除的前缀（前缀重叠时用）
 */
function cleanLogsByPrefix(
  logDir: string,
  prefix: string,
  maxFiles: number,
  excludePrefixes: readonly string[] = [],
): void {
  try {
    if (!existsSync(logDir)) {return}

    const files = readdirSync(logDir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.log'))
      .filter(f => !excludePrefixes.some(p => f.startsWith(p)))
      .map(f => ({
        name: f,
        path: join(logDir, f),
        mtime: statSync(join(logDir, f)).mtime.getTime(),
      }))
      .toSorted((a, b) => b.mtime - a.mtime)

    // 删除超出数量限制的旧文件
    for (let i = maxFiles; i < files.length; i++) {
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
 * 清理过期日志文件
 *
 * 主日志与错误日志各自按保留数量滚动：错误日志单独统计，
 * 且在主日志一侧显式排除，避免两者互相挤占名额。
 *
 * 导出仅为单测可达（前缀重叠的排除逻辑值得锁住），应用侧只经 initialize() 调用。
 */
export function cleanOldLogs(logDir: string): void {
  cleanLogsByPrefix(logDir, ERROR_LOG_PREFIX, MAX_ERROR_LOG_FILES)
  cleanLogsByPrefix(logDir, LOG_PREFIX, MAX_LOG_FILES, [ERROR_LOG_PREFIX])
}

/**
 * FileLogger 类
 */
class FileLogger {
  private stream: WriteStream | null = null
  /**
   * 错误日志流。ERROR 级别除写主日志外再写一份到独立文件：
   * 主日志保留完整时间线（排障要看上下文），错误文件供崩溃后直接抓取，
   * 不必在几十 MB 的 INFO 里捞。两者内容重叠，但错误量级极小，不值当省这份。
   */
  private errorStream: WriteStream | null = null
  private logDir: string = ''
  private currentDate: string = ''
  private initialized = false

  // 保存原始 console 方法
  private originalConsoleLog = console.log
  private originalConsoleError = console.error
  private originalConsoleWarn = console.warn
  private originalConsoleDebug = console.debug

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
   * 打开日志文件流（主日志 + 错误日志）
   */
  private openStream(): void {
    this.stream = this.createStream(this.logFilePath(LOG_PREFIX), '主日志')
    this.errorStream = this.createStream(this.logFilePath(ERROR_LOG_PREFIX), '错误日志')
  }

  /** 当前日期下的日志文件路径 */
  private logFilePath(prefix: string): string {
    return join(this.logDir, `${prefix}${this.currentDate}.log`)
  }

  /**
   * 创建写入流。写入失败只报错不抛出——日志系统本身不能拖垮应用。
   */
  private createStream(filePath: string, label: string): WriteStream {
    const stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf8' })

    stream.on('error', (err) => {
      this.originalConsoleError(`[FileLogger] ${label}写入文件失败:`, err)
    })

    return stream
  }

  /**
   * 检查是否需要切换日期文件
   */
  private checkDateRoll(): void {
    const today = getDateString()
    if (today !== this.currentDate) {
      this.currentDate = today
      this.stream?.end()
      this.errorStream?.end()
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

    this.writeLine(this.stream, line)
    // ERROR 双写：主日志留完整时间线，错误日志供快速抓取
    if (level === 'ERROR') {
      this.writeLine(this.errorStream, line)
    }
  }

  /** 单条落盘；写完即忘，失败不影响调用方 */
  private writeLine(stream: WriteStream | null, line: string): void {
    if (!stream) {return}
    try {
      stream.write(line)
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

    // debug 只落主日志、不进错误日志：它承载的是子进程 stderr 这类「平时没人看、
    // 出事时唯一线索」的输出。2026-09-15 MemPalace 整天写不进记忆，点破根因的
    // `backend resolution failed … BackendMismatchError` 就在这条通道上——而当时它
    // 没被拦截，不进任何文件，只能靠人工在终端里抓。
    console.debug = (...args: unknown[]) => {
      this.safeConsoleWrite(this.originalConsoleDebug, ...args)
      this.writeLog('DEBUG', ...args)
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
    return this.logFilePath(LOG_PREFIX)
  }

  /**
   * 获取当前错误日志文件完整路径（用于启动时在控制台打印）
   */
  getCurrentErrorLogFilePath(): string {
    return this.logFilePath(ERROR_LOG_PREFIX)
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
    if (this.errorStream) {
      this.errorStream.end()
      this.errorStream = null
    }

    // 恢复原始 console 方法
    console.log = this.originalConsoleLog
    console.error = this.originalConsoleError
    console.warn = this.originalConsoleWarn
    console.debug = this.originalConsoleDebug

    this.initialized = false
  }
}

/** 全局日志实例 */
export const fileLogger = new FileLogger()
