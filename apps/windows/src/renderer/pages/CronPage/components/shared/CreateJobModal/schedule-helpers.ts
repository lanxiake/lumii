/**
 * schedule-helpers.ts — 预设定义 + 纯函数工具
 *
 * 为 CreateJobModal 提供调度相关的辅助函数
 */

import type { CronScheduleType } from '../../../../../hooks/business/useCron/types'

// ─── 类型 ───────────────────────────────────────────────

export interface SchedulePreset {
  id: string
  label: string
  description: string
  scheduleType: CronScheduleType
  defaultExpr: string
  needsInput: boolean
}

export interface IntervalUnit {
  label: string
  value: 'minutes' | 'hours' | 'days'
  ms: number
}

export interface CronFields {
  minute: string
  hour: string
  dayOfMonth: string
  month: string
  dayOfWeek: string
}

export interface SelectOption {
  label: string
  value: string
}

// ─── 预设 ───────────────────────────────────────────────

export const PRESETS: SchedulePreset[] = [
  { id: 'daily-8',        label: '每天一次',    description: '每天早上 8:00',     scheduleType: 'cron',  defaultExpr: '0 8 * * *',   needsInput: false },
  { id: 'hourly',         label: '每小时',      description: '每小时整点',        scheduleType: 'every', defaultExpr: '3600000',      needsInput: false },
  { id: 'every-30m',      label: '每30分钟',    description: '每30分钟执行',      scheduleType: 'every', defaultExpr: '1800000',      needsInput: false },
  { id: 'weekday-9',      label: '工作日',      description: '周一至周五 9:00',   scheduleType: 'cron',  defaultExpr: '0 9 * * 1-5', needsInput: false },
  { id: 'weekly-mon',     label: '每周一次',    description: '每周一 8:00',       scheduleType: 'cron',  defaultExpr: '0 8 * * 1',   needsInput: false },
  { id: 'custom-interval',label: '自定义间隔',  description: '设置间隔时间',      scheduleType: 'every', defaultExpr: '',             needsInput: true },
  { id: 'once',           label: '执行一次',    description: '指定时间执行',      scheduleType: 'at',    defaultExpr: '',             needsInput: true },
  { id: 'custom',         label: '高级自定义',  description: 'Cron 表达式',       scheduleType: 'cron',  defaultExpr: '',             needsInput: true },
]

export const INTERVAL_UNITS: IntervalUnit[] = [
  { label: '分钟', value: 'minutes', ms: 60_000 },
  { label: '小时', value: 'hours',   ms: 3_600_000 },
  { label: '天',   value: 'days',    ms: 86_400_000 },
]

// ─── 调度验证 ───────────────────────────────────────────

export function validateSchedule(type: CronScheduleType, expr: string): string | null {
  if (!expr.trim()) return '调度表达式不能为空'

  switch (type) {
    case 'cron': {
      const parts = expr.trim().split(/\s+/)
      if (parts.length !== 5) return 'Cron 表达式需要 5 个字段（分 时 日 月 周）'
      // 基本格式验证
      const valid = /^[\d*,/\-]+$/
      for (const part of parts) {
        if (!valid.test(part)) return `字段「${part}」包含无效字符`
      }
      return null
    }
    case 'every': {
      const ms = parseInt(expr, 10)
      if (isNaN(ms) || ms <= 0) return '间隔必须是大于 0 的整数'
      if (ms < 60_000) return '间隔不能小于 1 分钟'
      return null
    }
    case 'at': {
      const ms = parseInt(expr, 10)
      if (isNaN(ms) || ms <= 0) return '时间戳无效'
      // 允许 1 分钟的误差，避免编辑现有任务时因微小时间差误报
      if (ms < Date.now() - 60_000) return '执行时间必须在未来'
      return null
    }
    default:
      return '未知调度类型'
  }
}

// ─── 间隔转换 ───────────────────────────────────────────

export function intervalToMs(amount: number, unit: IntervalUnit['value']): number {
  const u = INTERVAL_UNITS.find((u) => u.value === unit)
  return amount * (u?.ms ?? 60_000)
}

export function msToInterval(ms: number): { amount: number; unit: IntervalUnit['value'] } {
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) {
    return { amount: ms / 86_400_000, unit: 'days' }
  }
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) {
    return { amount: ms / 3_600_000, unit: 'hours' }
  }
  return { amount: Math.max(1, Math.round(ms / 60_000)), unit: 'minutes' }
}

// ─── 日期时间转换 ────────────────────────────────────────

export function datetimeLocalToMs(str: string): number {
  return new Date(str).getTime()
}

export function msToDatetimeLocal(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function getDefaultDatetime(): string {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  return msToDatetimeLocal(tomorrow.getTime())
}

// ─── 时区 ────────────────────────────────────────────────

export function getSystemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'Asia/Shanghai'
  }
}

export function getTimezoneOptions(): SelectOption[] {
  const common = [
    'Asia/Shanghai',
    'Asia/Tokyo',
    'Asia/Hong_Kong',
    'Asia/Singapore',
    'America/New_York',
    'America/Los_Angeles',
    'America/Chicago',
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Australia/Sydney',
    'Pacific/Auckland',
    'UTC',
  ]

  const system = getSystemTimezone()
  const options: SelectOption[] = []

  // 系统时区放在最前
  if (!common.includes(system)) {
    options.push({ label: `${system}（系统）`, value: system })
  }

  for (const tz of common) {
    const label = tz === system ? `${tz}（系统）` : tz
    options.push({ label, value: tz })
  }

  return options
}

// ─── Cron 构建/解析 ─────────────────────────────────────

export function buildCronExpr(fields: CronFields): string {
  return `${fields.minute} ${fields.hour} ${fields.dayOfMonth} ${fields.month} ${fields.dayOfWeek}`
}

export function parseCronExpr(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  return {
    minute: parts[0],
    hour: parts[1],
    dayOfMonth: parts[2],
    month: parts[3],
    dayOfWeek: parts[4],
  }
}

// ─── 下次执行时间 ────────────────────────────────────────

export function getNextRunTime(type: CronScheduleType, expr: string, _tz?: string): Date | null {
  const now = new Date()

  switch (type) {
    case 'at': {
      const ms = parseInt(expr, 10)
      if (isNaN(ms)) return null
      const d = new Date(ms)
      return d > now ? d : null
    }
    case 'every': {
      const ms = parseInt(expr, 10)
      if (isNaN(ms) || ms <= 0) return null
      return new Date(now.getTime() + ms)
    }
    case 'cron': {
      return getNextCronRun(expr, now)
    }
    default:
      return null
  }
}

function getNextCronRun(expr: string, now: Date): Date | null {
  const fields = parseCronExpr(expr)
  if (!fields) return null

  const minutes = expandField(fields.minute, 0, 59)
  const hours = expandField(fields.hour, 0, 23)
  const dows = expandField(fields.dayOfWeek, 0, 6)

  if (minutes.length === 0 || hours.length === 0 || dows.length === 0) return null

  // 尝试未来 7 天
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const candidate = new Date(now)
    candidate.setDate(candidate.getDate() + dayOffset)
    candidate.setSeconds(0, 0)

    if (!dows.includes(candidate.getDay())) continue

    // 如果 dayOfMonth 不是 *，检查日期匹配
    if (fields.dayOfMonth !== '*') {
      const doms = expandField(fields.dayOfMonth, 1, 31)
      if (!doms.includes(candidate.getDate())) continue
    }

    for (const h of hours) {
      for (const m of minutes) {
        candidate.setHours(h, m, 0, 0)
        if (candidate > now) return candidate
      }
    }
  }

  return null
}

function expandField(field: string, min: number, max: number): number[] {
  if (field === '*') {
    return Array.from({ length: max - min + 1 }, (_, i) => min + i)
  }

  const values: number[] = []
  for (const part of field.split(',')) {
    if (part.includes('-') && !part.startsWith('*/')) {
      const [start, end] = part.split('-').map(Number)
      for (let i = start; i <= end && i <= max; i++) values.push(i)
    } else if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10)
      if (step > 0) {
        for (let i = min; i <= max; i += step) values.push(i)
      }
    } else {
      const n = parseInt(part, 10)
      if (!isNaN(n) && n >= min && n <= max) values.push(n)
    }
  }
  return values
}

// ─── 人类可读描述 ────────────────────────────────────────

export function describeCronExpr(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length < 5) return expr

  const [min, hour, dom, , dow] = parts

  if (min === '*' && hour === '*') return '每分钟'
  if (hour === '*' && min !== '*') return `每小时第 ${min} 分钟`
  if (dom && dom.startsWith('*/')) return `每 ${dom.slice(2)} 天 ${fmtTime(hour, min)}`
  if (dow === '1-5') return `工作日 ${fmtTime(hour, min)}`
  if (dow === '0,6') return `周末 ${fmtTime(hour, min)}`
  if (dow && dow !== '*') {
    const dayMap: Record<string, string> = { '0': '周日', '1': '周一', '2': '周二', '3': '周三', '4': '周四', '5': '周五', '6': '周六' }
    const name = dayMap[dow]
    if (name) return `${name} ${fmtTime(hour, min)}`
  }
  if (dom === '*' && dow === '*' && hour !== '*') return `每天 ${fmtTime(hour, min)}`

  return expr
}

function fmtTime(hour: string, min: string): string {
  return `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
}

// ─── 相对时间描述 ────────────────────────────────────────

export function formatRelativeTime(target: Date): string {
  const diff = target.getTime() - Date.now()
  if (diff <= 0) return '已过期'

  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `约 ${minutes} 分钟后`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `约 ${hours} 小时后`

  const days = Math.floor(hours / 24)
  return `约 ${days} 天后`
}

// ─── 预设匹配 ────────────────────────────────────────

/** 根据已有任务的调度配置匹配最佳预设 */
export function matchPreset(type: CronScheduleType, expr: string): SchedulePreset {
  // 先检查固定预设是否精确匹配
  const fixed = PRESETS.find(p => !p.needsInput && p.scheduleType === type && p.defaultExpr === expr)
  if (fixed) return fixed

  // 按类型回退到 needsInput 预设
  if (type === 'every') return PRESETS.find(p => p.id === 'custom-interval')!
  if (type === 'at') return PRESETS.find(p => p.id === 'once')!
  return PRESETS.find(p => p.id === 'custom')!  // cron 回退到高级自定义
}
