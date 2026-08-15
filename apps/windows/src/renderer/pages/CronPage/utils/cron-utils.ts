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
    const base = !isNaN(ms) ? `每 ${formatInterval(ms)}` : `固定间隔`
    // 生效窗口附加描述
    const window = formatActiveWindow(job.activeDays, job.activeHourStart, job.activeHourEnd)
    return window ? `${base}（${window}）` : base
  }

  // cron 表达式 + 窗口
  const base = describeCronExpr(expr)
  const window = formatActiveWindow(job.activeDays, job.activeHourStart, job.activeHourEnd)
  return window ? `${base}（${window}）` : base
}

/**
 * 格式化生效窗口为附加文本（周选择 + 时段）。
 * 返回空字符串表示未配置窗口（全时段有效）。
 */
function formatActiveWindow(
  activeDays?: string | null,
  activeHourStart?: number | null,
  activeHourEnd?: number | null,
): string {
  const parts: string[] = []

  const days = activeDays?.trim()
  if (days) {
    const label = formatDayList(days.split(',').map(Number))
    // 「每天」不必赘述，窗口未收窄等于没配
    if (label !== '每天') parts.push(label)
  }

  if (activeHourStart != null && activeHourEnd != null && activeHourStart !== activeHourEnd) {
    const start = String(activeHourStart).padStart(2, '0')
    const end = String(activeHourEnd).padStart(2, '0')
    parts.push(`${start}:00-${end}:00`)
  }

  return parts.join(' ')
}

/**
 * 将 cron 表达式转为人类可读描述
 */
function describeCronExpr(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  // 表达式非法时也别把 cron 原文抖到界面上，用户看不懂
  if (parts.length < 5) return '自定义计划'

  const [min, hour, dom, , dow] = parts

  // 每分钟
  if (min === '*' && hour === '*') return '每分钟'

  // 每小时
  if (hour === '*' && min !== '*') return `每小时第 ${min} 分钟`

  const time = formatTime(hour, min)

  // 每 N 天
  if (dom && dom.startsWith('*/')) return `每 ${dom.slice(2)} 天 ${time}`

  // 每月某日
  if (dom && dom !== '*' && (!dow || dow === '*')) return `每月 ${dom} 日 ${time}`

  // 指定星期：1-5 / 1,2,3,4,5 / 5 / 0,6 统一走列表格式化
  if (dow && dow !== '*') {
    const days = formatDayList(parseDow(dow))
    if (days) return `${days} ${time}`
  }

  return `每天 ${time}`
}

/** 星期数字集合 → 中文描述，工作日/周末/每天做简写 */
function formatDayList(days: readonly number[]): string {
  const unique = [...new Set(days)].filter((d) => d >= 0 && d <= 6).sort()
  if (unique.length === 0 || unique.length === 7) return '每天'
  const key = unique.join(',')
  if (key === '1,2,3,4,5') return '工作日'
  if (key === '0,6') return '周末'
  const names = ['日', '一', '二', '三', '四', '五', '六']
  return unique.map((d) => `周${names[d]}`).join('、')
}

function formatTime(hour: string, min: string): string {
  const h = hour.padStart(2, '0')
  const m = min.padStart(2, '0')
  return `${h}:${m}`
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
