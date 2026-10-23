/**
 * 后台任务里程碑列表。
 *
 * 按上报顺序展示步骤、状态和耗时。没有里程碑时不占位。
 */

import React from 'react'
import type { Milestone, MilestoneStatus } from '../../../../../shared/agent-runtime-events'
import styles from './TaskMilestones.module.css'

export interface TaskMilestonesProps {
  milestones?: readonly Milestone[]
}

const STATUS_ICON: Record<MilestoneStatus, string> = {
  pending: '⏳',
  'in-progress': '🔄',
  completed: '✓',
  failed: '❌',
}

/** 把毫秒耗时格式化成一位小数的秒 */
export function formatMilestoneDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`
}

/** 里程碑列表：状态图标、步骤名、耗时和失败原因 */
export const TaskMilestones: React.FC<TaskMilestonesProps> = ({ milestones = [] }) => {
  if (milestones.length === 0) return null
  const completedCount = milestones.filter((milestone) => milestone.status === 'completed').length

  return (
    <div className={styles.container}>
      <div className={styles.header}>里程碑 ({completedCount}/{milestones.length})</div>
      <ol className={styles.list}>
        {milestones.map((milestone, index) => (
          <li
            key={`${milestone.step}-${index}`}
            className={styles[milestone.status === 'in-progress' ? 'inProgress' : milestone.status]}
          >
            <span className={styles.icon} aria-hidden="true">{STATUS_ICON[milestone.status]}</span>
            <span className={styles.step}>{milestone.step}</span>
            {milestone.duration !== undefined && (
              <span className={styles.duration}>{formatMilestoneDuration(milestone.duration)}</span>
            )}
            {milestone.error && (
              <span className={styles.error} title={milestone.error}>{milestone.error}</span>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
