/**
 * 性能诊断（设置中心 › 隐私与数据）
 *
 * 展示 PerformanceMonitor 生成的诊断报告：IPC 调用耗时、启动阶段、内存占用、
 * 综合健康状态；支持手动触发一次内存快照与打开性能日志文件夹。
 */

import React, { useState, useEffect, useCallback } from 'react'
import { Activity, Folder } from 'lucide-react'
import { Button } from '../../../../components/ui/Button/Button'
import { useToast } from '../../../../components/ui/Toast/useToast'
import type { PerformanceReport } from '../../../../../main/perf/performance-types'
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

export const PerformanceDiagnostics: React.FC = () => {
  const toast = useToast()
  const [report, setReport] = useState<PerformanceReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadReport = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await window.electronAPI.performance.getReport()
      setReport(data)
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
