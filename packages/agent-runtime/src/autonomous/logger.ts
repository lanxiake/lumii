/**
 * 简单的结构化日志工具
 * 用于自主进化 Agent 的可观测性
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogContext {
  [key: string]: any;
}

/**
 * 格式化日志输出
 */
function formatLog(level: LogLevel, message: string, context?: LogContext): string {
  const timestamp = new Date().toISOString();
  const contextStr = context ? ` ${JSON.stringify(context)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${contextStr}`;
}

/**
 * 简单的 logger
 */
export const logger = {
  info(message: string, context?: LogContext) {
    console.log(formatLog('info', message, context));
  },

  warn(message: string, context?: LogContext) {
    console.warn(formatLog('warn', message, context));
  },

  error(message: string, context?: LogContext) {
    console.error(formatLog('error', message, context));
  },

  debug(message: string, context?: LogContext) {
    if (process.env.DEBUG) {
      console.log(formatLog('debug', message, context));
    }
  },
};
