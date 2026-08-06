import type { FC } from 'react'
import { useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import styles from './CronPage.module.css'
import { useCronJobs } from '../../hooks/business/useCron/useCronJobs'
import { useAgents } from '../../hooks/business/useAgents/useAgents'
import type { CronJob } from '../../hooks/business/useCron/types'
import { OverviewTab } from './components/OverviewTab/OverviewTab'
import { CreateJobModal } from './components/shared/CreateJobModal'
import { useToast } from '../../components/ui/Toast/useToast'

export const CronPage: FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingJob, setEditingJob] = useState<CronJob | null>(null)
  const toast = useToast()
  const { jobs, loading, error, fetchJobs, addJob, updateJob, removeJob, runJob, toggleJob } = useCronJobs()
  const { agents } = useAgents()

  return (
    <div className={clsx(styles.page, embedded && styles.pageEmbedded)}>
      <div className={styles.pageHeader}>
        <div className={styles.pageIntro}>
          {!embedded && <h1 className={styles.title}>定时任务</h1>}
          <p className={styles.subtitle}>设置一次，到点自动完成。</p>
        </div>
        <div className={styles.headerActions}>
          <button type="button" className={styles.iconButton} onClick={() => fetchJobs()} title="刷新任务" aria-label="刷新任务"><RefreshCw size={16} /></button>
          <button type="button" className={styles.createBtn} onClick={() => setShowCreateModal(true)}><Plus size={16} />新建任务</button>
        </div>
      </div>

      {error && <div className={styles.errorBanner}>{error}</div>}
      <div className={styles.content}>
        {loading ? <div className={styles.loading}>正在加载定时任务...</div> : <OverviewTab jobs={jobs} onToggle={toggleJob} onRun={runJob} onDelete={removeJob} onEdit={setEditingJob} />}
      </div>

      {(showCreateModal || editingJob) && (
        <CreateJobModal
          agents={agents}
          editingJob={editingJob ?? undefined}
          onSubmit={async (data) => {
            const result = await addJob(data)
            if (result) { setShowCreateModal(false); toast.success('任务已创建') }
            else toast.error('创建任务失败')
          }}
          onUpdate={async (id, data) => {
            const ok = await updateJob(id, { name: data.name, taskText: data.taskText, scheduleType: data.scheduleType, scheduleExpr: data.scheduleExpr })
            if (ok) { setEditingJob(null); toast.success('任务已更新') }
            else toast.error('更新任务失败')
          }}
          onClose={() => { setShowCreateModal(false); setEditingJob(null) }}
        />
      )}
    </div>
  )
}

export default CronPage
