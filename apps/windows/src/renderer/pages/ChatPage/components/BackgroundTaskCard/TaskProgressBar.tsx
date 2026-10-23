/**
 * 后台任务进度条。
 *
 * 百分比来自工具上报；剩余时间按已用时间线性外推，进度为 0 或已结束时不估计。
 */

import React from 'react'
import type { BackgroundTaskStatus } from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'
import styles from './TaskProgressBar.module.css'

export interface TaskProgressBarProps {
  /** 0–100，缺省按 0（不确定进度）显示 */
  progress?: number
  currentStep?: string
  startTime: number
  status: BackgroundTaskStatus
  /** 便于测试注入时钟 */
  now?: number
}

/** 把剩余秒数格式化成「N秒」或「N分钟」 */
export function formatRemainingSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}秒`
  return `${Math.round(seconds / 60)}分钟`
}

/**
 * 按已用时间与当前百分比估算剩余秒数。
 * 进度尚未开始、已完成，或时钟没有前进时返回 null。
 */
export function estimateRemainingSeconds(startTime: number, progress: number, now: number): number | null {
  if (progress <= 0 || progress >= 100) return null
  const elapsed = (now - startTime) / 1000
  if (elapsed <= 0) return null
  const estimatedTotal = elapsed / (progress / 100)
  return Math.max(0, estimatedTotal - elapsed)
}

/** 按任务状态选择进度条文案 */
function progressLabel(status: BackgroundTaskStatus, progress: number): string {
  const percent = `${progress}%`
  if (status === 'succeeded') return `已完成 (${percent})`
  if (status === 'failed') return `失败 (${percent})`
  if (status === 'cancelled') return `已取消 (${percent})`
  return `进行中 (${percent})`
}

/** 任务进度条：百分比、剩余时间估计、当前步骤 */
export const TaskProgressBar: React.FC<TaskProgressBarProps> = ({
  progress = 0,
  currentStep,
  startTime,
  status,
  now = Date.now(),
}) => {
  const displayProgress = Math.min(100, Math.max(0, progress || 0))
  const running = status === 'running'
  const indeterminate = running && displayProgress === 0
  const remaining = running ? estimateRemainingSeconds(startTime, displayProgress, now) : null

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.text}>{progressLabel(status, displayProgress)}</span>
        {remaining !== null && remaining > 5 && (
          <span className={styles.remaining}>预计 {formatRemainingSeconds(remaining)}</span>
        )}
      </div>
      <progress
        className={indeterminate ? styles.indeterminate : styles.bar}
        max={100}
        value={indeterminate ? undefined : displayProgress}
        aria-label="任务进度"
      />
      {currentStep && <div className={styles.step}>{currentStep}</div>}
    </div>
  )
}
