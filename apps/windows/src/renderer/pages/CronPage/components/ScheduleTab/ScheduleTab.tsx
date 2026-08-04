/**
 * ScheduleTab - 周计划网格视图
 *
 * 7天 × 活跃小时的时间网格，每个格子显示该时段的任务
 */

import type { FC } from 'react'
import { useMemo, Fragment } from 'react'
import styles from './ScheduleTab.module.css'
import type { CronJob } from '../../../../hooks/business/useCron/types'
import { parseScheduleSlots } from '../../utils/cron-utils'

interface ScheduleTabProps {
  jobs: CronJob[]
}

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export const ScheduleTab: FC<ScheduleTabProps> = ({ jobs }) => {
  // 检查启用的非 cron 任务
  const nonCronEnabledCount = useMemo(
    () => jobs.filter((j) => j.enabled && j.scheduleType !== 'cron').length,
    [jobs]
  )

  // 解析所有任务的时段
  const { grid, activeHours } = useMemo(() => {
    // grid[day][hour] = CronJob[]
    const g: Map<string, CronJob[]> = new Map()
    const hours = new Set<number>()

    for (const job of jobs) {
      if (!job.enabled) continue
      const slots = parseScheduleSlots(job)
      for (const { day, hour } of slots) {
        const key = `${day}-${hour}`
        const list = g.get(key) ?? []
        list.push(job)
        g.set(key, list)
        hours.add(hour)
      }
    }

    // 只显示有任务的小时行，排序
    const sortedHours = [...hours].sort((a, b) => a - b)

    return { grid: g, activeHours: sortedHours }
  }, [jobs])

  if (activeHours.length === 0) {
    return (
      <div className={styles.emptySchedule}>
        <div>周计划视图仅展示使用 Cron 表达式的定时任务。</div>
        {nonCronEnabledCount > 0 && (
          <div className={styles.nonCronHint}>
            当前有 {nonCronEnabledCount} 个启用的非 Cron 任务（固定间隔或一次性），不在此视图显示。
          </div>
        )}
        {jobs.filter((j) => j.enabled).length === 0 && (
          <div className={styles.nonCronHint}>暂无启用的定时任务，请先创建并启用任务。</div>
        )}
      </div>
    )
  }

  return (
    <div className={styles.scheduleTab}>
      {nonCronEnabledCount > 0 && (
        <div className={styles.infoBanner}>
          另有 {nonCronEnabledCount} 个非 Cron 任务（固定间隔或一次性）未在周计划视图中显示。
        </div>
      )}
      <div className={styles.grid}>
        {/* 表头 */}
        <div className={styles.headerCell} />
        {DAY_NAMES.map((name, i) => (
          <div key={i} className={styles.headerCell}>{name}</div>
        ))}

        {/* 数据行 */}
        {activeHours.map((hour) => (
          <Fragment key={hour}>
            <div className={styles.hourLabel}>
              {String(hour).padStart(2, '0')}:00
            </div>
            {Array.from({ length: 7 }, (_, day) => {
              const key = `${day}-${hour}`
              const cellJobs = grid.get(key) ?? []
              return (
                <div key={`${day}-${hour}`} className={styles.cell}>
                  {cellJobs.map((job) => (
                    <div key={job.id} className={styles.cellJob} title={job.name}>
                      {job.name}
                    </div>
                  ))}
                </div>
              )
            })}
          </Fragment>
        ))}
      </div>
    </div>
  )
}
