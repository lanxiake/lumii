/**
 * 集中式日志工具
 * 为 Windows 客户端提供统一的日志接口
 */

import { getLocalDateTimeString } from './local-time'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface Logger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** 通过环境变量 LOG_LEVEL 控制最低输出级别，默认 info */
const MIN_LEVEL: number = LOG_LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? 'info'] ?? LOG_LEVELS.info

/**
 * 创建带命名空间的日志记录器
 * @param namespace 日志命名空间（如 'ApiClient', 'ShellRunner'）
 * @returns Logger 实例
 */
export function createLogger(namespace: string): Logger {
  const formatMessage = (level: LogLevel, args: unknown[]): string => {
    // 本地时区而非 toISOString()（UTC），避免和 file-logger.ts 落盘的行前缀时区不一致
    const timestamp = getLocalDateTimeString()
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${namespace}]`
    return `${prefix} ${args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ')}`
  }

  return {
    debug: (...args: unknown[]) => {
      if (MIN_LEVEL <= LOG_LEVELS.debug) console.log(formatMessage('debug', args))
    },
    info: (...args: unknown[]) => {
      if (MIN_LEVEL <= LOG_LEVELS.info) console.log(formatMessage('info', args))
    },
    warn: (...args: unknown[]) => {
      if (MIN_LEVEL <= LOG_LEVELS.warn) console.warn(formatMessage('warn', args))
    },
    error: (...args: unknown[]) => {
      console.error(formatMessage('error', args))
    },
  }
}
