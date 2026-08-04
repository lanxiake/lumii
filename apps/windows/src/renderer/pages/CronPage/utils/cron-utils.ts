/**
 * Cron 工具函数
 *
 * cron 表达式解析、人类可读描述、周计划网格解析
 */

import type { CronJob } from '../../../hooks/business/useCron/types'

/**
 * 生成 cron 任务的人类可读调度描述
 */
export function describeCron(job: CronJob): string {
  const expr = job.scheduleExpr ?? ''

  if (job.scheduleType === 'at') {
    const ms = parseInt(expr, 10)
    if (!isNaN(ms)) {
      return `一次性 ${new Date(ms).toLocaleString()}`
    }
    return `一次性`
  }

  if (job.scheduleType === 'every') {
    const ms = parseInt(expr, 10)
    if (!isNaN(ms)) {
      return `每 ${formatInterval(ms)}`
    }
    return `固定间隔`
  }

  // cron 表达式
  return describeCronExpr(expr)
}

/**
 * 将 cron 表达式转为人类可读描述
 */
function describeCronExpr(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length < 5) return expr

  const [min, hour, dom, , dow] = parts

  // 每分钟
  if (min === '*' && hour === '*') return '每分钟'

  // 每小时
  if (hour === '*' && min !== '*') return `每小时第 ${min} 分钟`

  // 每 N 天
  if (dom && dom.startsWith('*/')) {
    const n = dom.slice(2)
    return `每 ${n} 天 ${formatTime(hour, min)}`
  }

  // 每月
  if (dom && dom !== '*' && dow === '*') {
    return `每月第 ${dom} 日 ${formatTime(hour, min)}`
  }

  // 工作日
  if (dow === '1-5') return `工作日 ${formatTime(hour, min)}`

  // 指定星期
  if (dow && dow !== '*') {
    const dayName = getDayName(dow)
    if (dayName) return `${dayName} ${formatTime(hour, min)}`
  }

  // 每天
  if (dom === '*' && dow === '*' && hour !== '*') {
    return `每天 ${formatTime(hour, min)}`
  }

  return expr
}

function formatTime(hour: string, min: string): string {
  const h = hour.padStart(2, '0')
  const m = min.padStart(2, '0')
  return `${h}:${m}`
}

function getDayName(dow: string): string | null {
  const dayNames: Record<string, string> = {
    '0': '周日',
    '1': '周一',
    '2': '周二',
    '3': '周三',
    '4': '周四',
    '5': '周五',
    '6': '周六',
    '7': '周日',
  }
  return dayNames[dow] ?? null
}

function formatInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}秒`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}分钟`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}小时`
  return `${Math.round(ms / 86_400_000)}天`
}

/**
 * 格式化耗时
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

/**
 * 解析 cron 任务的周计划时段
 * 返回 { day: 0-6, hour: 0-23 } 数组
 */
export function parseScheduleSlots(job: CronJob): Array<{ day: number; hour: number }> {
  if (job.scheduleType !== 'cron' || !job.scheduleExpr) return []

  const parts = job.scheduleExpr.trim().split(/\s+/)
  if (parts.length < 5) return []

  const [, hour, , , dow] = parts

  // 解析小时
  const hours = parseField(hour, 0, 23)
  if (hours.length === 0) return []

  // 解析星期
  const days = parseDow(dow)

  const slots: Array<{ day: number; hour: number }> = []
  for (const d of days) {
    for (const h of hours) {
      slots.push({ day: d, hour: h })
    }
  }
  return slots
}

function parseField(field: string, min: number, max: number): number[] {
  if (field === '*') {
    return Array.from({ length: max - min + 1 }, (_, i) => min + i)
  }

  const values: number[] = []
  for (const part of field.split(',')) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number)
      for (let i = start; i <= end; i++) values.push(i)
    } else if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10)
      for (let i = min; i <= max; i += step) values.push(i)
    } else {
      const n = parseInt(part, 10)
      if (!isNaN(n)) values.push(n)
    }
  }
  return values
}

function parseDow(dow: string): number[] {
  if (dow === '*') return [0, 1, 2, 3, 4, 5, 6]
  return parseField(dow, 0, 6)
}
