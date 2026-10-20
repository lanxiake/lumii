/**
 * 任务完成卡 —— task_complete 的用户可见出口。
 *
 * Agent 常在最后一步才调 task_complete 并 terminate，不会再吐正文；
 * 若不把本卡拣出折叠区，summary 会被埋进「工作过程」。
 */

import React, { useMemo } from 'react'
import clsx from 'clsx'
import { parseTaskCompletePart } from './parse-task-complete'
import styles from './TaskCompleteCard.module.css'

interface TaskCompleteToolPart {
  id: string
  args?: Record<string, unknown>
  result?: unknown
  status?: string
  isError?: boolean
}

interface TaskCompleteCardProps {
  part: TaskCompleteToolPart
}

/** 渲染任务完成 / 验证门 / 失败状态卡片 */
export const TaskCompleteCard: React.FC<TaskCompleteCardProps> = ({ part }) => {
  const parsed = useMemo(() => parseTaskCompletePart(part), [part])

  const badgeLabel =
    parsed.phase === 'completed'
      ? '任务已完成'
      : parsed.phase === 'gate'
        ? '待确认完成'
        : parsed.phase === 'failed'
          ? '完成信号失败'
          : '正在收尾…'

  return (
    <div
      className={clsx(
        styles.card,
        parsed.phase === 'gate' && styles.cardGate,
        parsed.phase === 'failed' && styles.cardFailed,
        parsed.phase === 'running' && styles.cardRunning,
      )}
      data-testid="task-complete-card"
      data-phase={parsed.phase}
    >
      <div className={styles.header}>
        <span
          className={clsx(
            styles.badge,
            parsed.phase === 'gate' && styles.badgeGate,
            parsed.phase === 'failed' && styles.badgeFailed,
            parsed.phase === 'running' && styles.badgeRunning,
          )}
        >
          {badgeLabel}
        </span>
      </div>
      {parsed.summary && <div className={styles.summary}>{parsed.summary}</div>}
      {parsed.message && parsed.phase !== 'completed' && (
        <div className={styles.hint}>{parsed.message}</div>
      )}
      {parsed.phase === 'completed' && !parsed.summary && (
        <div className={styles.hint}>任务已标记完成。</div>
      )}
    </div>
  )
}
