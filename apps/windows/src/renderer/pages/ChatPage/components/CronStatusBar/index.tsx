import React, { useState } from 'react'
import { AlertCircle, ChevronDown, ChevronRight, Loader2, PauseCircle, Play, Square, TimerReset, Trash2 } from 'lucide-react'
import type { CronJob } from '../../../../hooks/business/useCron/types'
import { useCronJobs } from '../../../../hooks/business/useCron/useCronJobs'
import { ConfirmModal } from '../../../../components/ui/Modal/ConfirmModal'
import styles from './CronStatusBar.module.css'

/**
 * 从会话 key 反查它挂着哪些定时任务。两条来源，都要走：
 *
 * 1. **发起会话**（`originConversationId === sessionKey`）：用户在**本会话**里派出去的
 *    任务——这是主路径。主会话 id 是 hex，不是 `cron:` 前缀，只能靠这个字段关联。
 * 2. **任务自己的会话**（`cron:<owner>:<任务名>`）：任务产出落地的独立会话。
 *    规则与主进程 `cronConversationId` 一致，两处必须同步。
 */
export function findCronJobsForSession(
  sessionKey: string | null | undefined,
  jobs: readonly CronJob[],
): CronJob[] {
  if (!sessionKey) return []
  const byOrigin = jobs.filter((j) => j.originConversationId === sessionKey)
  if (byOrigin.length > 0) return byOrigin
  if (!sessionKey.startsWith('cron:')) return []
  return jobs.filter((j) => {
    const slug = j.name.trim().replace(/\s+/g, ' ')
    const owner = j.agentId?.trim() || 'assistant'
    return `cron:${owner}:${slug}` === sessionKey
  })
}

/** @deprecated 用 findCronJobsForSession（支持 origin + 多任务） */
export function findCronJobForSession(
  sessionKey: string | null | undefined,
  jobs: readonly CronJob[],
): CronJob | undefined {
  return findCronJobsForSession(sessionKey, jobs)[0]
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

/** 需要用户立刻注意的状态：运行中 / 报错。它们让折叠摘要带上提示色 */
function needsAttention(job: CronJob): boolean {
  return job.status === 'running' || job.status === 'error'
}

/** 折叠状态持久化：跨会话、跨重启记住用户的选择 */
const OPEN_STORAGE_KEY = 'lumii.cronStatusBar.open'

function readStoredOpen(): boolean | null {
  try {
    const raw = localStorage.getItem(OPEN_STORAGE_KEY)
    return raw === null ? null : raw === '1'
  } catch {
    return null
  }
}

function writeStoredOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_STORAGE_KEY, open ? '1' : '0')
  } catch {
    // 隐私模式 / 配额满：记住与否不影响功能
  }
}

interface CronStatusBarProps {
  /** 当前会话 key；本会话派发的任务与 cron 独立会话都靠它反查 */
  sessionKey: string | null | undefined
}

/**
 * 定时任务状态条：等待触发 / 运行中 / 已暂停 / 上次报错。
 *
 * **默认折叠成一行**——任务多了不占地方（很多任务时逐条铺开会挡住输入框）。
 * 折叠状态**持久化**（localStorage）：用户点开过一次，之后重开会话仍是展开的；
 * 从没点过的默认按「有无需注意的任务」决定。展开后摘要行右侧提供批量操作。
 *
 * 自己订阅 `useCronJobs`（5 秒轮询）：重渲染圈在这条小状态条内，不波及消息树。
 */
export const CronStatusBar: React.FC<CronStatusBarProps> = ({ sessionKey }) => {
  const { jobs, toggleJob, abortJob, removeJob, removeJobs } = useCronJobs()
  const mine = findCronJobsForSession(sessionKey, jobs)
  // 用户显式选择过就照办；没选过才按「有需注意的任务」自动决定
  const [open, setOpen] = useState<boolean>(() => readStoredOpen() ?? mine.some(needsAttention))
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)
  if (mine.length === 0) return null

  const now = Date.now()
  const alerted = mine.filter(needsAttention)
  const pausedCount = mine.filter((j) => !j.enabled).length
  const allPaused = pausedCount === mine.length

  // 单条任务且不需要注意：它就是一行，不必再套一层折叠头
  const single = mine.length === 1 && !alerted.length

  const summary =
    alerted.length > 0
      ? `${mine.length} 个定时任务 · ${alerted.length} 个需注意`
      : `${mine.length} 个定时任务进行中${pausedCount ? `（${pausedCount} 个已暂停）` : ''}`

  const toggleOpen = () => {
    const next = !open
    setOpen(next)
    writeStoredOpen(next)
  }

  const handlePauseAll = async () => {
    // 逐个改：同一批里已有暂停的会被跳过，避免把「恢复」误当成「暂停」
    for (const job of mine) {
      if (job.enabled) await toggleJob(job.id, false)
    }
  }

  const handleDeleteAll = async () => {
    setConfirmDeleteAll(false)
    await removeJobs(mine.map((j) => j.id))
  }

  return (
    <div className={styles.stack}>
      {!single && (
        <div className={styles.summaryRow} data-tone={alerted.length > 0 ? 'alert' : 'idle'}>
          <button type="button" className={styles.summary} aria-expanded={open} onClick={toggleOpen}>
            {open ? <ChevronDown size={13} strokeWidth={2} /> : <ChevronRight size={13} strokeWidth={2} />}
            <TimerReset size={13} strokeWidth={2} />
            <span className={styles.summaryText}>{summary}</span>
          </button>
          <span className={styles.summaryActions}>
            <button
              type="button"
              className={styles.action}
              title={allPaused ? '全部已暂停' : '全部暂停（不再触发）'}
              aria-label="全部暂停"
              disabled={allPaused}
              onClick={() => void handlePauseAll()}
            >
              <PauseCircle size={13} strokeWidth={2} />
            </button>
            <button
              type="button"
              className={styles.action}
              title="全部删除（不可恢复）"
              aria-label="全部删除"
              onClick={() => setConfirmDeleteAll(true)}
            >
              <Trash2 size={13} strokeWidth={2} />
            </button>
          </span>
        </div>
      )}
      {(single || open) &&
        mine.map((job) => (
          <CronStatusRow
            key={job.id}
            job={job}
            now={now}
            onToggle={toggleJob}
            onAbort={abortJob}
            onRemove={removeJob}
          />
        ))}
      <ConfirmModal
        open={confirmDeleteAll}
        title="删除全部定时任务"
        content={`将删除本会话的 ${mine.length} 个定时任务及其运行记录，不可恢复。`}
        confirmText="全部删除"
        confirmVariant="danger"
        onConfirm={() => void handleDeleteAll()}
        onCancel={() => setConfirmDeleteAll(false)}
      />
    </div>
  )
}

const CronStatusRow: React.FC<{
  job: CronJob
  now: number
  onToggle: (id: string, enabled: boolean) => Promise<boolean>
  onAbort: (id: string) => Promise<boolean>
  onRemove: (id: string) => Promise<boolean>
}> = ({ job, now, onToggle, onAbort, onRemove }) => {
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
      <span className={styles.actions}>
        {running && (
          <button
            type="button"
            className={styles.action}
            title="中断这一轮（任务继续按计划触发）"
            aria-label="中断这一轮"
            onClick={() => void onAbort(job.id)}
          >
            <Square size={13} strokeWidth={2} />
          </button>
        )}
        <button
          type="button"
          className={styles.action}
          title={paused ? '恢复（重新按计划触发）' : '暂停（不再触发）'}
          aria-label={paused ? '恢复任务' : '暂停任务'}
          onClick={() => void onToggle(job.id, paused)}
        >
          {paused ? <Play size={13} strokeWidth={2} /> : <PauseCircle size={13} strokeWidth={2} />}
        </button>
        {paused && (
          <button
            type="button"
            className={styles.action}
            title="删除这个任务（不再出现）"
            aria-label="删除任务"
            onClick={() => void onRemove(job.id)}
          >
            <Trash2 size={13} strokeWidth={2} />
          </button>
        )}
      </span>
    </div>
  )
}
