/**
 * 性能诊断（设置中心 › 隐私与数据）
 *
 * 展示 PerformanceMonitor 生成的诊断报告：IPC 调用耗时、启动阶段、内存占用、
 * 综合健康状态；支持手动触发一次内存快照与打开性能日志文件夹。
 * 同时展示内存与 IPC 调用的运行时历史趋势图（recharts），
 * 数据来自 performance:getHistory（60秒窗口 IPC 聚合序列 + 内存快照序列）。
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Activity, Folder } from 'lucide-react'
import {
  ResponsiveContainer,
  ComposedChart,
  LineChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import { Button } from '../../../../components/ui/Button/Button'
import { useToast } from '../../../../components/ui/Toast/useToast'
import type {
  PerformanceReport,
  IpcAggregateEvent,
  MemorySnapshotEvent,
} from '../../../../../main/perf/performance-types'
import styles from './PerformanceDiagnostics.module.css'

const HEALTH_LABEL: Record<PerformanceReport['health'], string> = {
  good: '良好',
  warning: '警告',
  critical: '严重',
}

const HEALTH_COLOR: Record<PerformanceReport['health'], string> = {
  good: '#10b981',
  warning: '#f59e0b',
  critical: '#ef4444',
}

const MEMORY_COLOR = { rss: '#3b82f6', heapUsed: '#8b5cf6' } as const
const IPC_COLOR = { avgLatency: '#22c55e' } as const
/** IPC 通道分色调色板，多通道时循环取色 */
const CHANNEL_PALETTE = ['#06b6d4', '#f59e0b', '#ef4444', '#8b5cf6', '#3b82f6', '#ec4899'] as const

/** 本地时区 HH:mm:ss，与 file-logger.ts / logger.ts 的本地时区展示口径保持一致 */
function formatLocalTime(ts: number): string {
  const d = new Date(ts)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

function bytesToMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10
}

interface MemoryChartRow {
  label: string
  rss: number
  heapUsed: number
}

function buildMemoryChartData(snapshots: readonly MemorySnapshotEvent[]): MemoryChartRow[] {
  return snapshots.map((s) => ({
    label: formatLocalTime(s.timestamp),
    rss: bytesToMb(s.mainProcess.rss),
    heapUsed: bytesToMb(s.mainProcess.heapUsed),
  }))
}

interface IpcChartRow {
  label: string
  avgLatency: number
  [channelKey: string]: number | string
}

/** 按窗口起始时间分组聚合事件，每个通道展开为动态键，并计算该窗口的整体平均延迟 */
function buildIpcChartData(events: readonly IpcAggregateEvent[]): { rows: IpcChartRow[]; channels: string[] } {
  const byWindow = new Map<number, IpcAggregateEvent[]>()
  const channels = new Set<string>()
  for (const e of events) {
    channels.add(e.channel)
    const list = byWindow.get(e.windowStart) ?? []
    list.push(e)
    byWindow.set(e.windowStart, list)
  }

  const rows = [...byWindow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([windowStart, entries]) => {
      let totalCalls = 0
      let totalDuration = 0
      const row: IpcChartRow = { label: formatLocalTime(windowStart), avgLatency: 0 }
      for (const e of entries) {
        row[e.channel] = e.totalCalls
        totalCalls += e.totalCalls
        totalDuration += e.totalDuration
      }
      row.avgLatency = totalCalls > 0 ? Math.round((totalDuration / totalCalls) * 10) / 10 : 0
      return row
    })

  return { rows, channels: [...channels] }
}

export const PerformanceDiagnostics: React.FC = () => {
  const toast = useToast()
  const [report, setReport] = useState<PerformanceReport | null>(null)
  const [ipcAggregates, setIpcAggregates] = useState<IpcAggregateEvent[]>([])
  const [memorySnapshots, setMemorySnapshots] = useState<MemorySnapshotEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadReport = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const [reportData, historyData] = await Promise.all([
        window.electronAPI.performance.getReport(),
        window.electronAPI.performance.getHistory(),
      ])
      setReport(reportData)
      setIpcAggregates(historyData.ipcAggregates)
      setMemorySnapshots(historyData.memorySnapshots)
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载性能报告失败'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadReport()
  }, [loadReport])

  const handleCapture = useCallback(async () => {
    try {
      const result = await window.electronAPI.performance.capture()
      if (result.success) {
        toast.success('性能快照已捕获')
        await loadReport()
      } else {
        toast.error(result.error || '捕获失败')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '捕获失败')
    }
  }, [toast, loadReport])

  const handleOpenLogs = useCallback(async () => {
    try {
      const result = await window.electronAPI.performance.openLogFolder()
      if (!result.success) {
        toast.error(result.error || '打开日志失败')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '打开日志失败')
    }
  }, [toast])

  const memoryChartData = useMemo(() => buildMemoryChartData(memorySnapshots), [memorySnapshots])
  const ipcChart = useMemo(() => buildIpcChartData(ipcAggregates), [ipcAggregates])

  if (loading) {
    return <div className={styles['perf-loading']}>加载中...</div>
  }

  if (error || !report) {
    return <div className={styles['perf-error']}>{error || '无法加载性能报告'}</div>
  }

  return (
    <div className={styles['perf-container']}>
      <div className={styles['perf-summary']}>
        <div className={styles['perf-status']}>
          <div
            className={styles['perf-status-circle']}
            style={{ backgroundColor: HEALTH_COLOR[report.health] }}
          />
          <div className={styles['perf-status-text']}>
            <span className={styles['perf-status-label']}>健康状态</span>
            <span className={styles['perf-status-value']}>{HEALTH_LABEL[report.health]}</span>
          </div>
        </div>

        <div className={styles['perf-metrics']}>
          <div className={styles['perf-metric']}>
            <span className={styles['perf-metric-label']}>启动耗时</span>
            <span className={styles['perf-metric-value']}>{report.startupStats.totalDuration}ms</span>
          </div>
          <div className={styles['perf-metric']}>
            <span className={styles['perf-metric-label']}>总调用数</span>
            <span className={styles['perf-metric-value']}>{report.ipcStats.totalCalls}</span>
          </div>
          <div className={styles['perf-metric']}>
            <span className={styles['perf-metric-label']}>平均延迟</span>
            <span className={styles['perf-metric-value']}>
              {Math.round(report.ipcStats.averageLatency)}ms
            </span>
          </div>
          <div className={styles['perf-metric']}>
            <span className={styles['perf-metric-label']}>慢调用</span>
            <span className={styles['perf-metric-value']}>{report.ipcStats.slowCalls}</span>
          </div>
        </div>
      </div>

      <div className={styles['perf-charts']}>
        <div className={styles['perf-chart-section']}>
          <h5 className={styles['perf-section-title']}>内存趋势</h5>
          {memoryChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={memoryChartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }}
                  axisLine={{ stroke: 'var(--color-border)' }}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }}
                  axisLine={false}
                  tickLine={false}
                  width={44}
                  tickFormatter={(v: number) => `${v}MB`}
                />
                <Tooltip formatter={(v: number) => `${v}MB`} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  type="monotone"
                  dataKey="rss"
                  name="RSS"
                  stroke={MEMORY_COLOR.rss}
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="heapUsed"
                  name="堆内存"
                  stroke={MEMORY_COLOR.heapUsed}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className={styles['perf-chart-empty']}>暂无历史数据</div>
          )}
        </div>

        <div className={styles['perf-chart-section']}>
          <h5 className={styles['perf-section-title']}>IPC 调用趋势</h5>
          {ipcChart.rows.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={ipcChart.rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }}
                  axisLine={{ stroke: 'var(--color-border)' }}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  yAxisId="calls"
                  tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }}
                  axisLine={false}
                  tickLine={false}
                  width={36}
                />
                <YAxis
                  yAxisId="latency"
                  orientation="right"
                  tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }}
                  axisLine={false}
                  tickLine={false}
                  width={44}
                  tickFormatter={(v: number) => `${v}ms`}
                />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {ipcChart.channels.map((channel, i) => (
                  <Bar
                    key={channel}
                    yAxisId="calls"
                    dataKey={channel}
                    name={channel}
                    stackId="calls"
                    fill={CHANNEL_PALETTE[i % CHANNEL_PALETTE.length]}
                  />
                ))}
                <Line
                  yAxisId="latency"
                  type="monotone"
                  dataKey="avgLatency"
                  name="平均延迟"
                  stroke={IPC_COLOR.avgLatency}
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <div className={styles['perf-chart-empty']}>暂无历史数据</div>
          )}
        </div>
      </div>

      <div className={styles['perf-details']}>
        {Object.keys(report.startupStats.phases).length > 0 ? (
          <div className={styles['perf-section']}>
            <h5 className={styles['perf-section-title']}>启动阶段</h5>
            <div className={styles['perf-items']}>
              {Object.entries(report.startupStats.phases).map(([phase, duration]) => (
                <div key={phase} className={styles['perf-item']}>
                  <span className={styles['perf-item-label']}>{phase}</span>
                  <span className={styles['perf-item-value']}>{duration}ms</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {Object.keys(report.ipcStats.channelBreakdown).length > 0 ? (
          <div className={styles['perf-section']}>
            <h5 className={styles['perf-section-title']}>IPC 通道</h5>
            <div className={styles['perf-items']}>
              {Object.entries(report.ipcStats.channelBreakdown).map(([channel, stats]) => (
                <div key={channel} className={styles['perf-item']}>
                  <span className={styles['perf-item-label']}>{channel}</span>
                  <span className={styles['perf-item-meta']}>
                    {stats.totalCalls} 次 · 平均 {Math.round(stats.averageDuration)}ms
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className={styles['perf-section']}>
          <h5 className={styles['perf-section-title']}>内存使用</h5>
          <div className={styles['perf-items']}>
            <div className={styles['perf-item']}>
              <span className={styles['perf-item-label']}>当前堆内存</span>
              <span className={styles['perf-item-value']}>
                {(report.memoryStats.current.mainProcess.heapUsed / 1024 / 1024).toFixed(1)}MB
              </span>
            </div>
            <div className={styles['perf-item']}>
              <span className={styles['perf-item-label']}>峰值堆内存</span>
              <span className={styles['perf-item-value']}>
                {(report.memoryStats.peak.mainProcess.heapUsed / 1024 / 1024).toFixed(1)}MB
              </span>
            </div>
            <div className={styles['perf-item']}>
              <span className={styles['perf-item-label']}>当前 RSS</span>
              <span className={styles['perf-item-value']}>
                {(report.memoryStats.current.mainProcess.rss / 1024 / 1024).toFixed(1)}MB
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className={styles['perf-actions']}>
        <Button variant="secondary" size="sm" onClick={() => void handleCapture()}>
          <Activity size={16} style={{ marginRight: 6 }} />
          手动捕获
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void handleOpenLogs()}>
          <Folder size={16} style={{ marginRight: 6 }} />
          打开日志
        </Button>
      </div>
    </div>
  )
}

export default PerformanceDiagnostics
