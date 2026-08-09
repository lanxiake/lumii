import type { FC } from 'react'
import { useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import styles from './CronPage.module.css'
import { useCronJobs } from '../../hooks/business/useCron/useCronJobs'
import { useAgents } from '../../hooks/business/useAgents/useAgents'
import type { CronJob } from '../../hooks/business/useCron/types'
import { OverviewTab } from './components/OverviewTab/OverviewTab'
import { HistoryTab } from './components/HistoryTab/HistoryTab'
import { ExpiredTab } from './components/ExpiredTab/ExpiredTab'
import { CreateJobModal } from './components/shared/CreateJobModal'
import { useToast } from '../../components/ui/Toast/useToast'

/** 一次性任务执行完自动禁用后归为「已失效」；用户手动暂停的重复任务仍留在「任务列表」 */
function isExpired(job: CronJob): boolean {
  return job.scheduleType === 'at' && !job.enabled
}

export const CronPage: FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingJob, setEditingJob] = useState<CronJob | null>(null)
  const [view, setView] = useState<'active' | 'expired' | 'history'>('active')
  const toast = useToast()
  const { jobs, loading, error, fetchJobs, addJob, updateJob, removeJob, runJob, toggleJob } = useCronJobs()
  const { agents, mainAgentId } = useAgents()

  const activeJobs = jobs.filter((job) => !isExpired(job))
  const expiredJobs = jobs.filter(isExpired)

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
      <div className={styles.tabBar} role="tablist" aria-label="定时任务视图">
        <button type="button" role="tab" aria-selected={view === 'active'} className={view === 'active' ? styles.tabActive : styles.tab} onClick={() => setView('active')}>任务列表</button>
        {/* 一次性任务执行完自动禁用后归档于此，与用户手动暂停的重复任务区分开 */}
        <button type="button" role="tab" aria-selected={view === 'expired'} className={view === 'expired' ? styles.tabActive : styles.tab} onClick={() => setView('expired')}>已失效</button>
        {/* 执行记录读 cron:runs，与任务启停无关 */}
        <button type="button" role="tab" aria-selected={view === 'history'} className={view === 'history' ? styles.tabActive : styles.tab} onClick={() => setView('history')}>执行记录</button>
      </div>
      <div className={styles.content}>
        {loading
          ? <div className={styles.loading}>正在加载定时任务...</div>
          : view === 'history'
            ? <HistoryTab jobs={jobs} />
            : view === 'expired'
              ? <ExpiredTab jobs={expiredJobs} onEdit={setEditingJob} onRun={runJob} onDelete={removeJob} />
              : <OverviewTab jobs={activeJobs} agents={agents} onToggle={toggleJob} onRun={runJob} onDelete={removeJob} onEdit={setEditingJob} />}
      </div>

      {(showCreateModal || editingJob) && (
        <CreateJobModal
          agents={agents}
          defaultAgentId={mainAgentId}
          editingJob={editingJob ?? undefined}
          onSubmit={async (data) => {
            const result = await addJob(data)
            if (result) { setShowCreateModal(false); toast.success('任务已创建') }
            else toast.error('创建任务失败')
          }}
          onUpdate={async (id, data) => {
            // 编辑已失效的一次性任务时自动重新启用，让调度器按新时间重新排期
            const wasExpired = Boolean(editingJob && isExpired(editingJob))
            const ok = await updateJob(id, {
              name: data.name, taskText: data.taskText, agentId: data.agentId,
              scheduleType: data.scheduleType, scheduleExpr: data.scheduleExpr,
              ...(wasExpired ? { enabled: true } : {}),
            })
            if (ok) { setEditingJob(null); toast.success(wasExpired ? '任务已更新并重新启用' : '任务已更新') }
            else toast.error('更新任务失败')
          }}
          onClose={() => { setShowCreateModal(false); setEditingJob(null) }}
        />
      )}
    </div>
  )
}

export default CronPage
