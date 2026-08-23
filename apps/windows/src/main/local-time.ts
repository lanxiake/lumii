/**
 * 本地时区日期/时间格式化工具
 *
 * 所有主进程日志（logger.ts、file-logger.ts）与性能日志展示统一使用本地时区，
 * 避免 toISOString() 输出 UTC 时间导致同一条日志出现两个不同时区的时间戳。
 */

/** 获取当前日期字符串 (YYYY-MM-DD)，本地时区 */
export function getLocalDateString(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 获取时间戳字符串 (HH:mm:ss.SSS)，本地时区 */
export function getLocalTimeString(date: Date = new Date()): string {
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  const ms = String(date.getMilliseconds()).padStart(3, '0')
  return `${hours}:${minutes}:${seconds}.${ms}`
}

/** 获取完整的本地时区日期时间字符串 (YYYY-MM-DD HH:mm:ss.SSS) */
export function getLocalDateTimeString(date: Date = new Date()): string {
  return `${getLocalDateString(date)} ${getLocalTimeString(date)}`
}
