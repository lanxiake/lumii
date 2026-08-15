/**
 * ExpiredTab - 已失效任务
 *
 * 一次性任务（scheduleType='at'）执行完自动禁用后归档于此，
 * 与用户手动暂停的重复任务分开展示，避免混淆"已完成"和"被暂停"两种语义。
 * 支持编辑（改时间/内容后重新排期）、重新执行（立即再跑一次）、删除。
 * 后端最多保留近 20 条，超出的自动清理。
 */
import type { FC } from 'react'
import { useState } from 'react'
import { AlertCircle, Clock3, Loader2, Pencil, Play, Trash2 } from 'lucide-react'
import styles from '../OverviewTab/OverviewTab.module.css'
import type { CronJob } from '../../../../hooks/business/useCron/types'
import { describeCron } from '../../utils/cron-utils'
import { ConfirmModal } from '../../../../components/ui/Modal/ConfirmModal'
import { useToast } from '../../../../components/ui/Toast/useToast'

interface ExpiredTabProps {
  jobs: CronJob[]
  onEdit: (job: CronJob) => void
  onRun: (id: string, force?: boolean) => Promise<boolean>
  onDelete: (id: string) => Promise<boolean>
}

function formatLastRun(job: CronJob): string {
  if (!job.lastRunAt) return '尚未执行'
  return `执行于 ${new Date(job.lastRunAt).toLocaleString()}`
}

export const ExpiredTab: FC<ExpiredTabProps> = ({ jobs, onEdit, onRun, onDelete }) => {
  const [deleteTarget, setDeleteTarget] = useState<CronJob | null>(null)
  const toast = useToast()

  return (
    <div className={styles.overviewTab}>
      <div className={styles.summary}>{`共 ${jobs.length} 个已失效的一次性任务（最多保留近 20 条）。`}</div>

      {jobs.length === 0 ? (
        <div className={styles.emptyList}>还没有已失效的任务。一次性任务执行完成后会自动归档到这里。</div>
      ) : (
        <div className={styles.jobList}>
          {jobs.map((job) => (
            <article key={job.id} className={styles.jobItem}>
              <div className={styles.jobMain}>
                <div className={styles.jobTitleRow}>
                  <h2 className={styles.jobName}>{job.name}</h2>
                  {job.status === 'running' && (
                    <span className={styles.runningBadge} aria-label="运行中">
                      <Loader2 size={12} className={styles.spin} />运行中
                    </span>
                  )}
                  {job.status === 'error' && <AlertCircle className={styles.errorIcon} size={16} aria-label="执行失败" />}
                </div>
                <div className={styles.jobMeta}>
                  <span><Clock3 size={14} />{describeCron(job)}</span>
                  <span>{formatLastRun(job)}</span>
                </div>
                {job.lastError && <p className={styles.errorText} title={job.lastError}>执行失败：{job.lastError}</p>}
              </div>

              <div className={styles.jobControls}>
                <button type="button" className={styles.iconButton} title="编辑并重新排期" aria-label="编辑任务" onClick={() => onEdit(job)}><Pencil size={16} /></button>
                <button type="button" className={styles.iconButton} title={job.status === 'running' ? '正在执行中' : '重新执行一次'} aria-label="重新执行" disabled={job.status === 'running'} onClick={async () => {
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
        title="删除已失效任务"
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

export default ExpiredTab
