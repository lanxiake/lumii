/**
 * 定时任务 focus 渠道与工作记忆的边界。
 *
 * 简报/日报/复盘产出已写入 Wiki 与系统通知，不应再以「{任务名}：{正文}」
 * 形式灌进工作记忆（进行中的事），否则会污染 memory_manage / 日报数据源。
 */

/** focus 渠道写入记忆时使用的前缀标签（与 cron-notify-format focus 策略一致） */
export const CRON_FOCUS_MEMORY_LABELS = [
  '早间简报',
  '工作日报整理',
  '每周复盘',
  '专注提醒',
] as const

/** 预置简报类任务：禁止 focus 写工作记忆 */
export const CRON_JOBS_SKIP_FOCUS_MEMORY = new Set([
  'seed-morning-briefing',
  'seed-daily-report',
  'seed-weekly-review',
])

/**
 * 判断工作记忆条目是否为定时任务 focus 渠道写入的噪声。
 */
export function isCronFocusMemoryNoise(content: string): boolean {
  const trimmed = content.trim()
  if (!trimmed) return false
  for (const label of CRON_FOCUS_MEMORY_LABELS) {
    if (trimmed.startsWith(`${label}：`)) return true
  }
  return false
}

/**
 * 判断是否应跳过 focus → addMemory。
 */
export function shouldSkipCronFocusMemoryWrite(params: {
  jobId?: string
  jobName: string
  taskText: string
  output: string
}): boolean {
  if (params.jobId && CRON_JOBS_SKIP_FOCUS_MEMORY.has(params.jobId)) return true
  const label = params.jobName.trim()
  if ((CRON_FOCUS_MEMORY_LABELS as readonly string[]).includes(label)) return true
  // 产出仍是任务指令原文（Agent 未真正总结）时不写记忆
  if (params.output.trim() === params.taskText.trim()) return true
  return isCronFocusMemoryNoise(`${label}：${params.output}`)
}

/**
 * 清理 assistant 工作记忆中由定时任务 focus 渠道写入的条目。
 */
export function purgeCronFocusNoiseMemories(
  memoryManager: {
    listActive: (agentId: string, userId: string) => readonly { id: string; content: string }[]
    deleteMemory: (memoryId: string) => void
  },
  agentId = 'assistant',
  userId = 'local-user',
): number {
  let removed = 0
  for (const entry of memoryManager.listActive(agentId, userId)) {
    if (!isCronFocusMemoryNoise(entry.content)) continue
    memoryManager.deleteMemory(entry.id)
    removed++
  }
  return removed
}
