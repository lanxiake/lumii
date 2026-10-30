import React from 'react'
import { AlertCircle, Loader2, PauseCircle, TimerReset } from 'lucide-react'
import type { CronJob } from '../../../../hooks/business/useCron/types'
import { useCronJobs } from '../../../../hooks/business/useCron/useCronJobs'
import styles from './CronStatusBar.module.css'

/**
 * 从会话 key 反查它对应的定时任务。
 *
 * 会话 id 由主进程 `cronConversationId(name, agentId)` 唯一构造：
 * `cron:<agentId||'assistant'>:<name 空白归一化>`。渲染层拿不到那个函数，
 * 这里按同一规则拼——**两处规则必须一致**，改了主进程那边要同步改这里。
 */
export function findCronJobForSession(
  sessionKey: string | null | undefined,
  jobs: readonly CronJob[],
): CronJob | undefined {
  if (!sessionKey?.startsWith('cron:')) return undefined
  return jobs.find((j) => {
    const slug = j.name.trim().replace(/\s+/g, ' ')
    const owner = j.agentId?.trim() || 'assistant'
    return `cron:${owner}:${slug}` === sessionKey
  })
}

function formatNext(atIso: string | null | undefined, now: number): string {
  if (!atIso) return ''
  const at = Date.parse(atIso)
  if (!Number.isFinite(at)) return ''
  const diff = at - now
  if (diff <= 0) return '即将触发'
  const minutes = Math.round(diff / 60_000)
  const clock = new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (minutes < 1) return `不到 1 分钟后（${clock}）`
  if (minutes < 60) return `${minutes} 分钟后（${clock}）`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} 小时后（${clock}）` : clock
}

interface CronStatusBarProps {
  /** 当前会话 key；非 `cron:` 前缀直接不渲染 */
  sessionKey: string | null | undefined
}

/**
 * 定时任务会话的状态条：等待触发 / 运行中 / 已暂停 / 上次报错。
 *
 * 只读展示，不提供操作——操作在定时任务页。放在输入框上方，随会话常驻，
 * 让用户一眼知道这条会话的任务是否还活着、下次什么时候动。
 *
 * 自己订阅 `useCronJobs`（5 秒轮询）：把轮询重渲染圈在这条小状态条内，
 * 不波及 ChatPage 的整棵消息树。
 */
export const CronStatusBar: React.FC<CronStatusBarProps> = ({ sessionKey }) => {
  const { jobs } = useCronJobs()
  const job = findCronJobForSession(sessionKey, jobs)
  if (!job) return null

  const now = Date.now()
  const paused = !job.enabled
  const running = job.status === 'running'
  const errored = job.status === 'error'

  let icon: React.ReactNode
  let label: string
  let tone = 'idle'

  if (paused) {
    icon = <PauseCircle size={14} strokeWidth={2} />
    label = '已暂停'
    tone = 'paused'
  } else if (running) {
    icon = <Loader2 size={14} strokeWidth={2} className={styles.spin} />
    label = '运行中…'
    tone = 'running'
  } else if (errored) {
    icon = <AlertCircle size={14} strokeWidth={2} />
    label = '上次运行失败'
    tone = 'error'
  } else {
    icon = <TimerReset size={14} strokeWidth={2} />
    const next = formatNext(job.nextRunAt, now)
    label = next ? `等待触发 · ${next}` : '等待触发'
  }

  return (
    <div className={styles.bar} data-tone={tone} role="status">
      <span className={styles.icon}>{icon}</span>
      <span className={styles.name}>{job.name}</span>
      <span className={styles.sep}>·</span>
      <span className={styles.label}>{label}</span>
    </div>
  )
}
