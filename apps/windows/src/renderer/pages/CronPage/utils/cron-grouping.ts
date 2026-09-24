/**
 * 定时任务列表分组（纯函数，便于单测）。
 * 组序固定：我的任务 → 系统任务 → Agent 自建；空组返回时过滤。
 */
import type { CronJob, CronJobSource } from '../../../hooks/business/useCron/types'

export interface CronJobGroup {
  source: CronJobSource
  label: string
  jobs: CronJob[]
}

const GROUP_ORDER: CronJobSource[] = ['user', 'system', 'agent']

const GROUP_LABELS: Record<CronJobSource, string> = {
  user: '我的任务',
  system: '系统任务',
  agent: 'Agent 自建',
}

function nextRunMs(job: CronJob): number | null {
  if (!job.nextRunAt) return null
  const t = Date.parse(job.nextRunAt)
  return Number.isNaN(t) ? null : t
}

/** 组内排序：启用优先 → 下次运行近的在前（无下次运行排最后）→ 创建时间早的在前 */
function sortGroupJobs(jobs: CronJob[]): CronJob[] {
  return [...jobs].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    const na = nextRunMs(a)
    const nb = nextRunMs(b)
    if (na !== nb) {
      if (na === null) return 1
      if (nb === null) return -1
      return na - nb
    }
    return Date.parse(a.createdAt || '') - Date.parse(b.createdAt || '')
  })
}

export function groupCronJobs(jobs: CronJob[]): CronJobGroup[] {
  return GROUP_ORDER.map((source) => ({
    source,
    label: GROUP_LABELS[source],
    jobs: sortGroupJobs(jobs.filter((job) => job.source === source)),
  })).filter((group) => group.jobs.length > 0)
}
