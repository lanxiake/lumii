/** 收件箱 inbox 状态 → 中文展示文案 */
const INBOX_STATUS_LABEL: Record<string, string> = {
  pending: '待处理',
  processing: '处理中',
  failed: '失败',
  organized: '已整理',
  discarded: '已丢弃',
}

/** 归档运行状态 → 中文展示文案 */
const RUN_STATUS_LABEL: Record<string, string> = {
  running: '进行中',
  succeeded: '已完成',
  degraded: '部分降级',
  partial: '部分完成',
  failed: '失败',
}

/** 归档运行明细 outcome → 中文展示文案 */
const OUTCOME_LABEL: Record<string, string> = {
  archived: '已归档',
  corrected: '已纠正',
  degraded: '已降级',
  failed: '失败',
}

/** 归档运行明细正文来源 → 中文展示文案 */
const EXTRACT_LABEL: Record<string, string> = {
  preview: '已有预览',
  extracted: '本次提取',
  none: '无正文',
}

/**
 * 将 inbox 状态枚举映射为中文标签；未知值原样返回。
 */
export function inboxStatusLabel(status: string): string {
  return INBOX_STATUS_LABEL[status] ?? status
}

/**
 * 将归档运行状态枚举映射为中文标签；未知值原样返回。
 */
export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABEL[status] ?? status
}

/**
 * 将归档运行明细 outcome 映射为中文标签；未知值原样返回。
 */
export function outcomeLabel(outcome: string): string {
  return OUTCOME_LABEL[outcome] ?? outcome
}

/**
 * 将归档运行明细正文来源映射为中文标签；未知值原样返回。
 */
export function extractLabel(extract: string): string {
  return EXTRACT_LABEL[extract] ?? extract
}

/**
 * 格式化为中文相对时间；`ts` 为 null 时返回空字符串。
 * 覆盖：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 上周 / 本地短日期。
 */
export function formatRelativeTime(ts: number | null, now: number = Date.now()): string {
  if (ts == null) return ''

  const diffMs = Math.max(0, now - ts)
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`

  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  if (days < 14) return '上周'

  const date = new Date(ts)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${month}-${day}`
}
