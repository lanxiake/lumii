/**
 * HistoryTab - 运行历史视图
 *
 * 时间范围过滤 + 任务筛选 + 运行记录表格 + 统计汇总
 */

import type { FC } from 'react'
import React, { useState, useEffect, useMemo, useCallback } from 'react'
import styles from './HistoryTab.module.css'
import type { CronJob, CronRun } from '../../../../hooks/business/useCron/types'
import { formatDuration } from '../../utils/cron-utils'
import { TokenTrendChart } from './TokenTrendChart'

interface HistoryTabProps {
  jobs: CronJob[]
}

type TimeRange = 'today' | 'week' | 'month'

const TIME_RANGES: { id: TimeRange; label: string }[] = [
  { id: 'today', label: '今天' },
  { id: 'week', label: '本周' },
  { id: 'month', label: '本月' },
]

export const HistoryTab: FC<HistoryTabProps> = ({ jobs }) => {
  const [runs, setRuns] = useState<CronRun[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [timeRange, setTimeRange] = useState<TimeRange>('today')
  const [filterJobId, setFilterJobId] = useState<string>('all')
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)

  // 任务名称映射
  const jobNameMap = useMemo(
    () => new Map(jobs.map((j) => [j.id, j.name])),
    [jobs]
  )

  // 获取运行记录 — 并行请求
  const fetchRuns = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const results = await Promise.all(
        jobs.map((job) =>
          window.electronAPI.agentRuntime
            .sendCommand({ type: 'cron:runs', id: job.id, limit: 50 } as const)
            .then((result) => result as { entries: Record<string, unknown>[] })
            .then((result) => {
              const entries = result?.entries ?? []
              return entries.map((r): CronRun => {
                const tsMs = typeof r.startedAt === 'number' ? r.startedAt
                  : typeof r.ts === 'number' ? r.ts
                  : typeof r.runAtMs === 'number' ? r.runAtMs
                  : typeof r.startedAt === 'string' ? new Date(r.startedAt).getTime()
                  : Date.now()
                return {
                  id: typeof r.id === 'string' ? r.id : `${job.id}-${tsMs}`,
                  jobId: job.id,
                  userId: typeof r.userId === 'string' ? r.userId : '',
                  status: (r.status as CronRun['status']) ?? 'ok',
                  startedAt: new Date(tsMs).toISOString(),
                  finishedAt: typeof r.finishedAt === 'number'
                    ? new Date(r.finishedAt).toISOString()
                    : typeof r.finishedAt === 'string'
                      ? r.finishedAt
                      : undefined,
                  durationMs: typeof r.durationMs === 'number' ? r.durationMs : undefined,
                  summary: typeof r.summary === 'string' ? r.summary : undefined,
                  error: typeof r.error === 'string' ? r.error : undefined,
                  model: typeof r.model === 'string' ? r.model : undefined,
                  provider: typeof r.provider === 'string' ? r.provider : undefined,
                  inputTokens: typeof r.inputTokens === 'number' ? r.inputTokens : undefined,
                  outputTokens: typeof r.outputTokens === 'number' ? r.outputTokens : undefined,
                  totalTokens: typeof r.totalTokens === 'number' ? r.totalTokens : undefined,
                }
              })
            })
            .catch(() => [] as CronRun[])
        )
      )
      const allRuns = results.flat()
      // 按时间降序
      allRuns.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      setRuns(allRuns)
    } catch (err) {
      setFetchError(`获取运行历史失败：${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      setLoading(false)
    }
  }, [jobs])

  useEffect(() => {
    fetchRuns()
  }, [fetchRuns])

  // 按时间范围过滤
  const filteredRuns = useMemo(() => {
    const now = new Date()
    let startTime: Date

    switch (timeRange) {
      case 'today':
        startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        break
      case 'week':
        startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        break
      case 'month':
        startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
        break
    }

    let filtered = runs.filter((r) => new Date(r.startedAt).getTime() >= startTime.getTime())

    // 按任务筛选
    if (filterJobId !== 'all') {
      filtered = filtered.filter((r) => r.jobId === filterJobId)
    }

    return filtered
  }, [runs, timeRange, filterJobId])

  // 统计
  const stats = useMemo(() => {
    const total = filteredRuns.length
    const ok = filteredRuns.filter((r) => r.status === 'ok').length
    const error = filteredRuns.filter((r) => r.status === 'error').length
    const totalTokens = filteredRuns.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0)
    return { total, ok, error, totalTokens }
  }, [filteredRuns])

  if (loading) {
    return <div className={styles.emptyHistory}>加载运行历史中...</div>
  }

  return (
    <div className={styles.historyTab}>
      {/* 错误提示 */}
      {fetchError && (
        <div className={styles.errorBanner}>
          <span>{fetchError}</span>
          <button className={styles.retryBtn} onClick={fetchRuns}>重试</button>
        </div>
      )}

      {/* 过滤栏 */}
      <div className={styles.filterBar}>
        <div className={styles.timeRange}>
          {TIME_RANGES.map((tr) => (
            <button
              key={tr.id}
              className={`${styles.timeBtn} ${timeRange === tr.id ? styles.timeBtnActive : ''}`}
              onClick={() => setTimeRange(tr.id)}
            >
              {tr.label}
            </button>
          ))}
        </div>

        {/* 按任务筛选 */}
        <select
          value={filterJobId}
          onChange={(e) => setFilterJobId(e.target.value)}
          className={styles.jobFilter}
        >
          <option value="all">全部任务</option>
          {jobs.map((job) => (
            <option key={job.id} value={job.id}>{job.name}</option>
          ))}
        </select>
      </div>

      {/* 表格 */}
      {filteredRuns.length === 0 ? (
        <div className={styles.emptyHistory}>该时段暂无运行记录</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>时间</th>
              <th>任务</th>
              <th>状态</th>
              <th>模型</th>
              <th>耗时</th>
              <th>Token 消耗</th>
            </tr>
          </thead>
          <tbody>
            {filteredRuns.map((run, idx) => {
              const runKey = run.id ?? `run-${idx}`
              const isExpanded = expandedRunId === runKey
              const hasError = run.status === 'error' && run.error
              return (
                <React.Fragment key={runKey}>
                  <tr
                    className={hasError ? styles.errorRow : undefined}
                    onClick={hasError ? () => setExpandedRunId(isExpanded ? null : runKey) : undefined}
                  >
                    <td>{new Date(run.startedAt).toLocaleString()}</td>
                    <td>{jobNameMap.get(run.jobId) ?? run.jobId}</td>
                    <td>
                      <span className={`${styles.statusBadge} ${
                        run.status === 'ok' ? styles.statusBadgeOk :
                        run.status === 'error' ? styles.statusBadgeError :
                        styles.statusBadgeRunning
                      }`}>
                        {run.status === 'ok' ? '成功' : run.status === 'error' ? '失败' : '运行中'}
                      </span>
                      {hasError && (
                        <span className={styles.expandToggle}>
                          {isExpanded ? '▾' : '▸'}
                        </span>
                      )}
                    </td>
                    <td className={styles.modelCell}>
                      {run.model ? `${run.provider ?? ''}/${run.model}`.replace(/^\//, '') : '-'}
                    </td>
                    <td>{run.durationMs != null ? formatDuration(run.durationMs) : '-'}</td>
                    <td>{run.totalTokens != null ? run.totalTokens.toLocaleString() : '-'}</td>
                  </tr>
                  {isExpanded && hasError && (
                    <tr className={styles.errorDetailRow}>
                      <td colSpan={6}>
                        <div className={styles.errorDetail}>
                          <span className={styles.errorDetailLabel}>错误详情：</span>
                          {run.error}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      )}

      {/* Token 趋势图 */}
      {filteredRuns.length > 0 && (
        <TokenTrendChart runs={filteredRuns} />
      )}

      {/* 汇总统计 */}
      <div className={styles.summary}>
        <div className={styles.summaryItem}>
          执行 <span className={styles.summaryValue}>{stats.total}</span> 次
        </div>
        <div className={styles.summaryItem}>
          成功 <span className={styles.summaryValue}>{stats.ok}</span>
        </div>
        <div className={styles.summaryItem}>
          失败 <span className={styles.summaryValue}>{stats.error}</span>
        </div>
        <div className={styles.summaryItem}>
          Token 消耗: <span className={styles.summaryValue}>{stats.totalTokens.toLocaleString()}</span>
        </div>
      </div>
    </div>
  )
}
