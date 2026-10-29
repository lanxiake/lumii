/**
 * 性能诊断服务 — 封装 window.electronAPI.performance 的薄层
 *
 * 错误向调用方抛出（原调用点负责 setError / toast 提示）。
 */
import type { PerfEvent, PerfSummary, RendererPerfEvent } from '@shared/performance'

/** 今日慢事件摘要（计数 / 最慢 / 启动阶段 / 内存 / 健康度） */
export async function getPerformanceSummary(): Promise<PerfSummary> {
  return window.electronAPI.performance.getSummary()
}

/** 今日全部慢事件（含重启前从磁盘回放的） */
export async function listPerformanceEvents(since?: number): Promise<PerfEvent[]> {
  return window.electronAPI.performance.listEvents(since === undefined ? undefined : { since })
}

/** 手动记录一次内存现场 */
export async function capturePerformanceSnapshot(): Promise<{ success: boolean; error?: string }> {
  return window.electronAPI.performance.capture()
}

/** 打开性能日志文件夹（跨天历史只能靠它） */
export async function openPerformanceLogFolder(): Promise<{ success: boolean; error?: string }> {
  return window.electronAPI.performance.openLogFolder()
}

/** 渲染层上报慢事件（长任务 / 关键交互 / 内存尖峰） */
export async function recordPerformanceEvent(event: RendererPerfEvent): Promise<{ success: boolean }> {
  return window.electronAPI.performance.recordEvent(event)
}
