/**
 * Stub for src/logging/subsystem.ts
 *
 * Windows 客户端不使用网关的日志系统（tslog/chalk/channel-registry），
 * 此 stub 将日志重定向到 console，供 src/browser/ 模块使用。
 */

export type SubsystemLogger = {
  subsystem: string
  trace: (message: string, meta?: Record<string, unknown>) => void
  debug: (message: string, meta?: Record<string, unknown>) => void
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void
  error: (message: string, meta?: Record<string, unknown>) => void
  fatal: (message: string, meta?: Record<string, unknown>) => void
  raw: (message: string) => void
  child: (name: string) => SubsystemLogger
}

function makeLogger(prefix: string): SubsystemLogger {
  return {
    subsystem: prefix,
    trace: (msg) => console.debug(`[${prefix}] ${msg}`),
    debug: (msg) => console.debug(`[${prefix}] ${msg}`),
    info: (msg) => console.log(`[${prefix}] ${msg}`),
    warn: (msg) => console.warn(`[${prefix}] ${msg}`),
    error: (msg) => console.error(`[${prefix}] ${msg}`),
    fatal: (msg) => console.error(`[${prefix}] FATAL: ${msg}`),
    raw: (msg) => console.log(msg),
    child: (name) => makeLogger(`${prefix}:${name}`),
  }
}

export function createSubsystemLogger(subsystem: string): SubsystemLogger {
  return makeLogger(subsystem)
}
