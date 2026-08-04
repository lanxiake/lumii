/**
 * CronPage - 定时任务管理页面
 *
 * 四视图 Tab：Overview / Schedule / Pipelines / History
 */

import type { FC } from 'react'
import { useState, useCallback } from 'react'
import styles from './CronPage.module.css'
import { useCronJobs } from '../../hooks/business/useCron/useCronJobs'
import { useAgents } from '../../hooks/business/useAgents/useAgents'
import type { CronJob, CronViewTab } from '../../hooks/business/useCron/types'
import { OverviewTab } from './components/OverviewTab/OverviewTab'
import { ScheduleTab } from './components/ScheduleTab/ScheduleTab'
import { HistoryTab } from './components/HistoryTab/HistoryTab'
import { PipelinesTab } from './components/PipelinesTab/PipelinesTab'
import { CreateJobModal } from './components/shared/CreateJobModal'
import { useToast } from '../../components/ui/Toast/useToast'

const TABS: { id: CronViewTab; label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'schedule', label: '周计划' },
  { id: 'pipelines', label: '流水线' },
  { id: 'history', label: '运行历史' },
]

const TAB_STORAGE_KEY = 'mtbot-cron-tab'

function loadTab(): CronViewTab {
  try {
    const stored = localStorage.getItem(TAB_STORAGE_KEY)
    if (stored === 'overview' || stored === 'schedule' || stored === 'pipelines' || stored === 'history') {
      return stored
    }
  } catch { /* ignore */ }
  return 'overview'
}

export const CronPage: FC = () => {
  const [activeTab, setActiveTab] = useState<CronViewTab>(loadTab)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingJob, setEditingJob] = useState<CronJob | null>(null)
  const toast = useToast()

  const {
    jobs,
    loading,
    error,
    fetchJobs,
    addJob,
    updateJob,
    removeJob,
    removeJobs,
    runJob,
    toggleJob,
  } = useCronJobs()

  const { agents } = useAgents()

  const handleTabChange = useCallback((tab: CronViewTab) => {
    setActiveTab(tab)
    try {
      localStorage.setItem(TAB_STORAGE_KEY, tab)
    } catch { /* ignore */ }
  }, [])

  const renderContent = () => {
    if (loading) {
      return <div className={styles.loading}>加载中...</div>
    }

    switch (activeTab) {
      case 'overview':
        return (
          <OverviewTab
            jobs={jobs}
            agents={agents}
            onToggle={toggleJob}
            onRun={runJob}
            onDelete={removeJob}
            onBatchDelete={removeJobs}
            onEdit={setEditingJob}
          />
        )
      case 'schedule':
        return <ScheduleTab jobs={jobs} />
      case 'pipelines':
        return <PipelinesTab jobs={jobs} />
      case 'history':
        return <HistoryTab jobs={jobs} />
      default:
        return null
    }
  }

  return (
    <div className={styles.page}>
      {/* 页头 */}
      <div className={styles.pageHeader}>
        <h1 className={styles.title}>定时任务</h1>
        <div className={styles.headerActions}>
          <button className={styles.refreshBtn} onClick={() => fetchJobs()}>
            刷新
          </button>
          <button className={styles.createBtn} onClick={() => setShowCreateModal(true)}>
            + 新建任务
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && <div className={styles.errorBanner}>{error}</div>}

      {/* Tab 栏 */}
      <div className={styles.tabBar}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`${styles.tab} ${activeTab === tab.id ? styles.tabActive : ''}`}
            onClick={() => handleTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 内容区 */}
      <div className={styles.content}>
        {renderContent()}
      </div>

      {/* 创建/编辑任务弹窗 */}
      {(showCreateModal || editingJob) && (
        <CreateJobModal
          agents={agents}
          editingJob={editingJob ?? undefined}
          onSubmit={async (data) => {
            const result = await addJob(data)
            if (result) {
              setShowCreateModal(false)
              toast.success('任务创建成功')
            } else {
              toast.error('创建任务失败')
            }
          }}
          onUpdate={async (id, data) => {
            const patch = {
              name: data.name,
              agentId: data.agentId,
              description: data.description,
              sessionTarget: 'isolated',
              schedule: data.scheduleType === 'cron'
                ? { kind: 'cron', expr: data.scheduleExpr, tz: data.scheduleTz }
                : data.scheduleType === 'every'
                ? { kind: 'every', everyMs: parseInt(data.scheduleExpr, 10) }
                : { kind: 'at', atMs: parseInt(data.scheduleExpr, 10) },
              payload: { kind: 'agentTurn', message: data.taskText },
            }
            const ok = await updateJob(id, patch as Record<string, unknown> as Partial<CronJob>)
            if (ok) {
              setEditingJob(null)
              toast.success('任务已更新')
            } else {
              toast.error('更新任务失败')
            }
          }}
          onClose={() => { setShowCreateModal(false); setEditingJob(null) }}
        />
      )}
    </div>
  )
}

export default CronPage
