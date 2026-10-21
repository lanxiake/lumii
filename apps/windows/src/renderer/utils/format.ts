/**
 * 插件的共享格式化（`api.format`）。
 *
 * 之前每个页面/插件各写一份 `formatBytes`，口径已经开始分叉（`toFixed(0)` 与
 * `toFixed(1)` 混用）。这里只收**通用**的几种：数字、百分比、货币、字节、日期、相对时间。
 *
 * 固定 `zh-CN`：应用界面是中文，跟随系统区域会让同一条数据在不同机器上显示成
 * `1,234` 或 `1 234`，截图与文档无法对齐。
 */

const LOCALE = 'zh-CN'

function toDate(value: Date | string | number): Date | null {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(LOCALE, options).format(value)
}

/** `0.42` → `42%` */
export function formatPercent(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(LOCALE, {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
}

export function formatCurrency(value: number, currency = 'CNY', digits = 2): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}`
}

export function formatDate(value: Date | string | number): string {
  const date = toDate(value)
  if (!date) return String(value)
  return new Intl.DateTimeFormat(LOCALE, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

export function formatDateTime(value: Date | string | number): string {
  const date = toDate(value)
  if (!date) return String(value)
  return new Intl.DateTimeFormat(LOCALE, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

/**
 * 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前；未来给「N 分钟后 / 小时后 / 天后」，
 * 超过 7 天回落成绝对日期（「37 天前」对读者没有意义）。
 */
export function formatRelative(value: Date | string | number, now: number = Date.now()): string {
  const date = toDate(value)
  if (!date) return String(value)

  const diff = now - date.getTime()
  const abs = Math.abs(diff)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const future = diff < 0

  if (abs < minute) return future ? '即将' : '刚刚'
  if (abs < hour) {
    const n = Math.floor(abs / minute)
    return future ? `${n} 分钟后` : `${n} 分钟前`
  }
  if (abs < day) {
    const n = Math.floor(abs / hour)
    return future ? `${n} 小时后` : `${n} 小时前`
  }
  if (abs < 7 * day) {
    const n = Math.floor(abs / day)
    return future ? `${n} 天后` : `${n} 天前`
  }
  return formatDate(date)
}

/**
 * 插件拿到的形状：`api.format.bytes(...)` 而不是 `api.format.formatBytes(...)`。
 *
 * 命名空间直接塞给插件会让方法名带着 `format` 前缀，读起来像 `api.format.formatBytes`；
 * 显式映射一层，契约就是文档里写的那七个名字。
 */
export const pluginFormat = {
  number: formatNumber,
  percent: formatPercent,
  currency: formatCurrency,
  bytes: formatBytes,
  date: formatDate,
  dateTime: formatDateTime,
  relative: formatRelative,
}
