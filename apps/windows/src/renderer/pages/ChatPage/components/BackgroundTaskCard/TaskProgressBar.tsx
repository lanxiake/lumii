/**
 * 后台任务进度条。
 *
 * 百分比来自工具上报；展示已用、本步已等待与预计剩余。
 * 整块可点（由父级传入 onActivate）以展开卡片详情。
 */

import React from 'react'
import type { BackgroundTaskStatus } from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'
import { formatTaskElapsed } from './format'
import styles from './TaskProgressBar.module.css'

export interface TaskProgressBarProps {
  /** 0–100，缺省按 0（不确定进度）显示 */
  progress?: number
  currentStep?: string
  startTime: number
  /** 本步等待计时起点；缺省等同 startTime */
  stepWaitStart?: number
  /** 任务结束时间；已结束时固定「已用」 */
  endedAt?: number
  /** 暂停时间点；paused 时「已用」与「本步」都停在这一刻 */
  pausedAt?: number
  status: BackgroundTaskStatus
  /** 便于测试注入时钟 */
  now?: number
  /** 点击进度区时回调（展开/收起） */
  onActivate?: () => void
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
function progressLabel(status: BackgroundTaskStatus, progress: number, indeterminate: boolean): string {
  if (status === 'succeeded') return `已完成 (${progress}%)`
  if (status === 'failed') return `失败 (${progress}%)`
  if (status === 'cancelled') return `已取消 (${progress}%)`
  if (status === 'paused') return `已暂停 (${progress}%)`
  if (indeterminate) return '进行中（排队/未开始计时）'
  return `进行中 (${progress}%)`
}

/** 任务进度条：百分比、已用/本步等待/预计剩余、当前步骤 */
export const TaskProgressBar: React.FC<TaskProgressBarProps> = ({
  progress = 0,
  currentStep,
  startTime,
  stepWaitStart,
  endedAt,
  pausedAt,
  status,
  now = Date.now(),
  onActivate,
}) => {
  const displayProgress = Math.min(100, Math.max(0, progress || 0))
  const running = status === 'running'
  const paused = status === 'paused'
  const indeterminate = running && displayProgress === 0
  // 暂停时计时停在暂停那一刻，否则「已用」会继续涨，看起来像还在跑
  const clock = paused ? (pausedAt ?? now) : now
  const remaining = running ? estimateRemainingSeconds(startTime, displayProgress, now) : null
  const stepStart = stepWaitStart ?? startTime
  const frozenEnd = running ? undefined : (endedAt ?? clock)
  const elapsedLabel = formatTaskElapsed(startTime, frozenEnd, clock)
  const stepWaitLabel = running ? formatTaskElapsed(stepStart, undefined, now) : null

  const timingBits: string[] = [`已用 ${elapsedLabel}`]
  if (stepWaitLabel !== null) timingBits.push(`本步 ${stepWaitLabel}`)
  if (paused) {
    timingBits.push('计时已停')
  } else if (running && indeterminate) {
    timingBits.push('预计 —')
  } else if (remaining !== null) {
    timingBits.push(`预计 ${formatRemainingSeconds(remaining)}`)
  }

  const interactive = typeof onActivate === 'function'

  /** 激活展开/收起，并阻止冒泡以免误触父级 */
  const handleActivate = (event: React.SyntheticEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    onActivate?.()
  }

  return (
    <div
      className={interactive ? styles.containerClickable : styles.container}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? '展开或收起任务详情' : undefined}
      onClick={interactive ? handleActivate : undefined}
      onKeyDown={interactive ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          handleActivate(event)
        }
      } : undefined}
    >
      <div className={styles.header}>
        <span className={styles.text}>{progressLabel(status, displayProgress, indeterminate)}</span>
        <span className={styles.timing}>{timingBits.join(' · ')}</span>
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
