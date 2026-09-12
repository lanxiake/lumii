/**
 * 性能诊断服务 — 封装 window.electronAPI.performance 的薄层
 *
 * 错误向调用方抛出（原调用点负责 setError / toast 提示）。
 */
import type { PerformanceReport, IpcAggregateEvent, MemorySnapshotEvent } from '@main/perf/performance-types'

/** 获取性能诊断报告（IPC 耗时 / 启动阶段 / 内存占用 / 健康状态） */
export async function getPerformanceReport(): Promise<PerformanceReport> {
  return window.electronAPI.performance.getReport()
}

/** 获取运行时历史趋势（60 秒窗口 IPC 聚合序列 + 内存快照序列） */
export async function getPerformanceHistory(): Promise<{
  ipcAggregates: IpcAggregateEvent[]
  memorySnapshots: MemorySnapshotEvent[]
}> {
  return window.electronAPI.performance.getHistory()
}

/** 手动捕获一次内存快照 */
export async function capturePerformanceSnapshot(): Promise<{ success: boolean; error?: string }> {
  return window.electronAPI.performance.capture()
}

/** 打开性能日志文件夹 */
export async function openPerformanceLogFolder(): Promise<{ success: boolean; error?: string }> {
  return window.electronAPI.performance.openLogFolder()
}
