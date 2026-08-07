import type { FC } from 'react'
import { useState } from 'react'
import { AlertCircle, Clock3, Pencil, Play, Trash2 } from 'lucide-react'
import styles from './OverviewTab.module.css'
import type { CronJob } from '../../../../hooks/business/useCron/types'
import type { Agent } from '../../../../services/agent-service'
import { describeCron } from '../../utils/cron-utils'
import { ConfirmModal } from '../../../../components/ui/Modal/ConfirmModal'
import { useToast } from '../../../../components/ui/Toast/useToast'

interface OverviewTabProps {
  jobs: CronJob[]
  agents: Agent[]
  onToggle: (id: string, enabled: boolean) => Promise<boolean>
  onRun: (id: string, force?: boolean) => Promise<boolean>
  onDelete: (id: string) => Promise<boolean>
  onEdit: (job: CronJob) => void
}

function formatNextRun(job: CronJob): string {
  if (!job.enabled) return '已暂停'
  if (!job.nextRunAt) return '等待安排下次执行'
  return `下次 ${new Date(job.nextRunAt).toLocaleString()}`
}

export const OverviewTab: FC<OverviewTabProps> = ({ jobs, agents, onToggle, onRun, onDelete, onEdit }) => {
  const [deleteTarget, setDeleteTarget] = useState<CronJob | null>(null)
  const toast = useToast()

  return (
    <div className={styles.overviewTab}>
      <div className={styles.summary}>{`共 ${jobs.length} 个自动任务，其中 ${jobs.filter((job) => job.enabled).length} 个已开启。`}</div>

      {jobs.length === 0 ? (
        <div className={styles.emptyList}>还没有定时任务，点击右上角“新建任务”开始设置。</div>
      ) : (
        <div className={styles.jobList}>
          {jobs.map((job) => (
            <article key={job.id} className={styles.jobItem}>
              <div className={styles.jobMain}>
                <div className={styles.jobTitleRow}>
                  <h2 className={styles.jobName}>{job.name}</h2>
                  {job.status === 'error' && <AlertCircle className={styles.errorIcon} size={16} aria-label="上次执行失败" />}
                </div>
                <div className={styles.jobMeta}>
                  <span><Clock3 size={14} />{describeCron(job)}</span>
                  <span>Agent：{agents.find((agent) => agent.id === job.agentId)?.name ?? '系统默认 Agent'}</span>
                  <span>{formatNextRun(job)}</span>
                </div>
                {job.lastError && <p className={styles.errorText} title={job.lastError}>上次执行失败：{job.lastError}</p>}
              </div>

              <div className={styles.jobControls}>
                <label className={styles.switch} title={job.enabled ? '暂停任务' : '启用任务'}>
                  <input
                    type="checkbox"
                    checked={job.enabled}
                    onChange={async () => {
                      const ok = await onToggle(job.id, !job.enabled)
                      if (ok) toast.success(job.enabled ? '任务已暂停' : '任务已启用')
                      else toast.error('修改任务状态失败')
                    }}
                  />
                  <span aria-hidden="true" />
                </label>
                <button type="button" className={styles.iconButton} title="编辑任务" aria-label="编辑任务" onClick={() => onEdit(job)}><Pencil size={16} /></button>
                <button type="button" className={styles.iconButton} title="立即执行" aria-label="立即执行" onClick={async () => {
                  const ok = await onRun(job.id, true)
                  if (ok) toast.success('任务已开始执行')
                  else toast.error('启动任务失败')
                }}><Play size={16} /></button>
                <button type="button" className={`${styles.iconButton} ${styles.dangerButton}`} title="删除任务" aria-label="删除任务" onClick={() => setDeleteTarget(job)}><Trash2 size={16} /></button>
              </div>
            </article>
          ))}
        </div>
      )}

      <ConfirmModal
        open={Boolean(deleteTarget)}
        layer="aboveHub"
        title="删除定时任务"
        content={`确定删除“${deleteTarget?.name ?? ''}”吗？删除后无法恢复。`}
        confirmText="删除"
        confirmVariant="danger"
        onConfirm={async () => {
          if (!deleteTarget) return
          const ok = await onDelete(deleteTarget.id)
          if (ok) toast.success('任务已删除')
          else toast.error('删除任务失败')
          setDeleteTarget(null)
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
