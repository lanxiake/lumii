/**
 * OverviewTab - 概览列表视图
 *
 * 摘要卡片 + 状态过滤 + 可展开的任务列表
 */

import type { FC } from 'react'
import { useState, useMemo, useCallback } from 'react'
import styles from './OverviewTab.module.css'
import type { CronJob, CronJobStatus } from '../../../../hooks/business/useCron/types'
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
  onBatchDelete: (ids: string[]) => Promise<{ success: string[]; failed: string[] }>
  onEdit: (job: CronJob) => void
}

type StatusFilter = 'all' | CronJobStatus

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'ok', label: '正常' },
  { id: 'error', label: '错误' },
  { id: 'idle', label: '空闲' },
]

export const OverviewTab: FC<OverviewTabProps> = ({ jobs, agents, onToggle, onRun, onDelete, onBatchDelete, onEdit }) => {
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [runTarget, setRunTarget] = useState<{ id: string; name: string } | null>(null)
  const toast = useToast()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false)

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Agent 名称映射
  const agentNameMap = useMemo(
    () => new Map(agents.map((a) => [a.id, a.name])),
    [agents]
  )

  // 统计
  const stats = useMemo(() => {
    const total = jobs.length
    const ok = jobs.filter((j) => j.status === 'ok').length
    const error = jobs.filter((j) => j.status === 'error').length
    const idle = jobs.filter((j) => j.status === 'idle').length
    const running = jobs.filter((j) => j.status === 'running').length
    return { total, ok, error, idle, running }
  }, [jobs])

  // 过滤后的任务
  const filteredJobs = useMemo(() => {
    if (filter === 'all') return jobs
    return jobs.filter((j) => j.status === filter)
  }, [jobs, filter])

  const toggleSelectAll = useCallback(() => {
    setSelectedIds(prev =>
      prev.size === filteredJobs.length
        ? new Set()
        : new Set(filteredJobs.map(j => j.id))
    )
  }, [filteredJobs])

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])

  return (
    <div className={styles.overviewTab}>
      {/* 摘要卡片 */}
      <div className={styles.summaryCards}>
        <div className={styles.card}>
          <div className={styles.cardLabel}>总任务数</div>
          <div className={styles.cardValue}>{stats.total}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>正常运行</div>
          <div className={`${styles.cardValue} ${styles.cardValueOk}`}>{stats.ok}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>错误</div>
          <div className={`${styles.cardValue} ${styles.cardValueError}`}>{stats.error}</div>
        </div>
      </div>

      {/* 状态过滤 */}
      <div className={styles.filterBar}>
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.id}
            className={`${styles.filterTag} ${filter === f.id ? styles.filterTagActive : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            {f.id !== 'all' && ` (${stats[f.id as CronJobStatus]})`}
          </button>
        ))}
        {selectedIds.size > 0 && (
          <button
            className={`${styles.filterTag} ${styles.batchDeleteBtn}`}
            onClick={() => setBatchDeleteOpen(true)}
          >
            批量删除 ({selectedIds.size})
          </button>
        )}
      </div>

      {/* 任务列表 */}
      <div className={styles.jobList}>
        {filteredJobs.length > 0 && (
          <div className={styles.jobListHeader}>
            <input
              type="checkbox"
              className={styles.jobCheckbox}
              checked={selectedIds.size === filteredJobs.length && filteredJobs.length > 0}
              onChange={toggleSelectAll}
            />
            <span className={styles.jobListHeaderText}>
              {selectedIds.size > 0 ? `已选 ${selectedIds.size} 项` : '全选'}
            </span>
          </div>
        )}
        {filteredJobs.length === 0 ? (
          <div className={styles.emptyList}>
            {filter === 'all' ? '暂无定时任务' : `没有${STATUS_FILTERS.find((f) => f.id === filter)?.label}的任务`}
          </div>
        ) : (
          filteredJobs.map((job) => {
            const expanded = expandedId === job.id
            const agentName = agentNameMap.get(job.agentId) ?? job.agentId
            const scheduleDesc = describeCron(job)

            return (
              <div key={job.id}>
                <div
                  className={`${styles.jobItem} ${expanded ? styles.jobItemExpanded : ''}`}
                  onClick={() => handleToggleExpand(job.id)}
                >
                  <input
                    type="checkbox"
                    className={styles.jobCheckbox}
                    checked={selectedIds.has(job.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleSelect(job.id)}
                  />
                  <span className={expandedId === job.id ? styles.expandArrowOpen : styles.expandArrow}>▸</span>
                  <span className={`${styles.statusDot} ${
                    job.status === 'ok' ? styles.statusOk :
                    job.status === 'error' ? styles.statusError :
                    styles.statusIdle
                  }`} />
                  <span className={styles.jobName}>{job.name}</span>
                  <span className={styles.jobAgent}>{agentName}</span>
                  <span className={styles.jobSchedule}>{scheduleDesc}</span>
                  {job.lastError && (
                    <span className={styles.errorHint} title={job.lastError}>⚠</span>
                  )}
                </div>
                {expanded && (
                  <div className={styles.jobDetails}>
                    <div className={styles.detailRow}>
                      <span className={styles.detailLabel}>调度</span>
                      <span className={styles.detailValue}>{scheduleDesc}</span>
                    </div>
                    {job.lastRunAt && (
                      <div className={styles.detailRow}>
                        <span className={styles.detailLabel}>上次执行</span>
                        <span className={styles.detailValue}>
                          {new Date(job.lastRunAt).toLocaleString()}
                          {job.lastDurationMs != null && ` (${(job.lastDurationMs / 1000).toFixed(1)}s)`}
                        </span>
                      </div>
                    )}
                    {job.nextRunAt && (
                      <div className={styles.detailRow}>
                        <span className={styles.detailLabel}>下次执行</span>
                        <span className={styles.detailValue}>{new Date(job.nextRunAt).toLocaleString()}</span>
                      </div>
                    )}
                    {job.lastError && (
                      <div className={styles.detailRow}>
                        <span className={styles.detailLabel}>错误</span>
                        <span className={`${styles.detailValue} ${styles.errorText}`}>
                          {job.lastError} (连续 {job.consecutiveErrors} 次)
                        </span>
                      </div>
                    )}
                    {job.description && (
                      <div className={styles.detailRow}>
                        <span className={styles.detailLabel}>描述</span>
                        <span className={styles.detailValue}>{job.description}</span>
                      </div>
                    )}
                    <div className={styles.jobActions}>
                      <button className={styles.actionBtn} onClick={(e) => {
                        e.stopPropagation()
                        onEdit(job)
                      }}>
                        ✏ 编辑
                      </button>
                      <button className={styles.actionBtn} onClick={(e) => {
                        e.stopPropagation()
                        setRunTarget({ id: job.id, name: job.name })
                      }}>
                        ▶ 立即执行
                      </button>
                      <button
                        className={styles.actionBtn}
                        onClick={async (e) => {
                          e.stopPropagation()
                          const ok = await onToggle(job.id, !job.enabled)
                          if (ok) toast.success(job.enabled ? '已禁用' : '已启用')
                          else toast.error('操作失败')
                        }}
                      >
                        {job.enabled ? '⏸ 禁用' : '▶ 启用'}
                      </button>
                      <button
                        className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          setDeleteTarget({ id: job.id, name: job.name })
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* 删除确认弹窗 */}
      <ConfirmModal
        open={!!deleteTarget}
        title="删除定时任务"
        content={`确定要删除定时任务「${deleteTarget?.name ?? ''}」吗？删除后无法恢复。`}
        confirmText="删除"
        confirmVariant="danger"
        onConfirm={async () => {
          if (deleteTarget) {
            const ok = await onDelete(deleteTarget.id)
            if (ok) toast.success(`任务「${deleteTarget.name}」已删除`)
            else toast.error('删除失败')
          }
          setDeleteTarget(null)
        }}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* 执行确认弹窗 */}
      <ConfirmModal
        open={!!runTarget}
        title="立即执行"
        content={`确定要立即执行任务「${runTarget?.name ?? ''}」吗？`}
        confirmText="执行"
        confirmVariant="primary"
        onConfirm={async () => {
          if (runTarget) {
            const ok = await onRun(runTarget.id, true)
            if (ok) toast.success(`任务「${runTarget.name}」已触发执行`)
            else toast.error('触发执行失败')
          }
          setRunTarget(null)
        }}
        onCancel={() => setRunTarget(null)}
      />

      {/* 批量删除确认弹窗 */}
      <ConfirmModal
        open={batchDeleteOpen}
        title="批量删除定时任务"
        content={`确定要删除选中的 ${selectedIds.size} 个定时任务吗？删除后无法恢复。`}
        confirmText={`删除 ${selectedIds.size} 项`}
        confirmVariant="danger"
        onConfirm={async () => {
          const { success, failed } = await onBatchDelete(Array.from(selectedIds))
          if (success.length > 0) toast.success(`已删除 ${success.length} 个任务`)
          if (failed.length > 0) toast.error(`${failed.length} 个任务删除失败`)
          setSelectedIds(new Set())
          setBatchDeleteOpen(false)
        }}
        onCancel={() => setBatchDeleteOpen(false)}
      />
    </div>
  )
}
