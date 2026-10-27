/**
 * 时间分节（纯函数）：今天 / 昨天 / 具体日期。
 *
 * 只按**本地时区日历天**比较，不按「24 小时前」——用户心里的「昨天」是日历上的昨天，
 * 23:50 写的东西在今天 00:10 看，不该被叫成「今天」。
 */

export interface TimeSection {
  /** 稳定 key（同一天同一节） */
  key: string
  /** 显示文案：今天 / 昨天 / 2026-10-24 */
  label: string
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function sectionOf(timestamp: number, now: Date = new Date()): TimeSection {
  const todayStart = startOfDay(now)
  const yesterdayStart = startOfDay(new Date(todayStart - 24 * 60 * 60 * 1000))
  const target = startOfDay(new Date(timestamp))

  if (target >= todayStart) return { key: `day:${todayStart}`, label: '今天' }
  if (target === yesterdayStart) return { key: `day:${yesterdayStart}`, label: '昨天' }
  const date = new Date(timestamp)
  return {
    key: `day:${target}`,
    label: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
  }
}

/** 按时间倒序的条目 → 分节（保持输入顺序，节内顺序不变） */
export function groupBySections<T>(
  items: readonly T[],
  timeOf: (item: T) => number,
  now: Date = new Date(),
): Array<{ section: TimeSection; items: T[] }> {
  const out: Array<{ section: TimeSection; items: T[] }> = []
  for (const item of items) {
    const section = sectionOf(timeOf(item), now)
    const last = out[out.length - 1]
    if (last && last.section.key === section.key) last.items.push(item)
    else out.push({ section, items: [item] })
  }
  return out
}
