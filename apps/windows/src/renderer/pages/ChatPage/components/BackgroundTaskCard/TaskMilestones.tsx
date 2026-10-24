/**
 * 后台任务里程碑列表。
 *
 * 按上报顺序展示步骤、状态和耗时。状态用 SVG/CSS，不用 emoji。
 */

import React from 'react'
import type { Milestone, MilestoneStatus } from '../../../../../shared/agent-runtime-events'
import styles from './TaskMilestones.module.css'

export interface TaskMilestonesProps {
  milestones?: readonly Milestone[]
}

/** 把毫秒耗时格式化成一位小数的秒 */
export function formatMilestoneDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`
}

/** 里程碑状态图标（SVG） */
const MilestoneIcon: React.FC<{ status: MilestoneStatus }> = ({ status }) => {
  if (status === 'completed') {
    return (
      <svg className={styles.iconSvg} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    )
  }
  if (status === 'failed') {
    return (
      <svg className={styles.iconSvg} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    )
  }
  if (status === 'in-progress') {
    return (
      <svg className={`${styles.iconSvg} ${styles.spin}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
        <path d="M12 3a9 9 0 1 0 9 9" />
      </svg>
    )
  }
  return <span className={styles.pendingDot} aria-hidden="true" />
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
            <span className={styles.icon} data-status={milestone.status}>
              <MilestoneIcon status={milestone.status} />
            </span>
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
