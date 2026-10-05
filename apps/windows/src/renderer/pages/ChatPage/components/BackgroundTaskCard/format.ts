/** 后台任务耗时格式化：秒级以下给秒，超过一分钟给「分m秒s」 */
export function formatTaskElapsed(startedAt: number, endedAt?: number, now = Date.now()): string {
  const end = endedAt ?? now
  const sec = Math.max(0, Math.round((end - startedAt) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  return rem > 0 ? `${min}m${rem}s` : `${min}m`
}
