/**
 * NextRunPreview — 下次执行时间预览
 */

import type { FC } from 'react'
import { useMemo } from 'react'
import type { CronScheduleType } from '../../../../../hooks/business/useCron/types'
import { getNextRunTime, formatRelativeTime, validateSchedule } from './schedule-helpers'
import styles from './CreateJobModal.module.css'

interface NextRunPreviewProps {
  scheduleType: CronScheduleType
  scheduleExpr: string
  timezone?: string
}

export const NextRunPreview: FC<NextRunPreviewProps> = ({ scheduleType, scheduleExpr, timezone }) => {
  const result = useMemo(() => {
    if (!scheduleExpr) return null

    const error = validateSchedule(scheduleType, scheduleExpr)
    if (error) return { error }

    const nextRun = getNextRunTime(scheduleType, scheduleExpr, timezone)
    if (!nextRun) return { error: '无法计算下次执行时间' }

    return {
      time: nextRun.toLocaleString(),
      relative: formatRelativeTime(nextRun),
    }
  }, [scheduleType, scheduleExpr, timezone])

  if (!result) return null

  if (result.error) {
    return (
      <div className={styles.nextRunPreview}>
        <span className={styles.nextRunError}>{result.error}</span>
      </div>
    )
  }

  return (
    <div className={styles.nextRunPreview}>
      <span className={styles.nextRunLabel}>下次执行：</span>
      <span className={styles.nextRunTime}>{result.time}</span>
      <span className={styles.nextRunRelative}>（{result.relative}）</span>
    </div>
  )
}
