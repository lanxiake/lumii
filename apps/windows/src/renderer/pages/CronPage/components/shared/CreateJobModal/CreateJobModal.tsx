import type { FC } from 'react'
import { useMemo, useState } from 'react'
import { Modal } from '../../../../../components/ui/Modal'
import type { CreateCronJobParams, CronJob, CronScheduleType } from '../../../../../hooks/business/useCron/types'
import type { Agent } from '../../../../../services/agent-service'
import {
  getDefaultDatetime,
  intervalToMs,
  msToDatetimeLocal,
  msToInterval,
  type IntervalUnit,
  validateSchedule,
} from './schedule-helpers'
import { NextRunPreview } from './NextRunPreview'
import styles from './CreateJobModal.module.css'

type ScheduleMode = 'daily' | 'weekdays' | 'weekly' | 'interval' | 'once' | 'keep'

interface CreateJobModalProps {
  agents: Agent[]
  editingJob?: CronJob
  onSubmit: (data: CreateCronJobParams) => Promise<void>
  onUpdate?: (id: string, data: CreateCronJobParams) => Promise<void>
  onClose: () => void
}

function getScheduleMode(job?: CronJob): ScheduleMode {
  if (!job) return 'daily'
  if (job.scheduleType === 'every') return 'interval'
  if (job.scheduleType === 'at') return 'once'
  if (/^\d+ \d+ \* \* \*$/.test(job.scheduleExpr)) return 'daily'
  if (/^\d+ \d+ \* \* 1-5$/.test(job.scheduleExpr)) return 'weekdays'
  if (/^\d+ \d+ \* \* [0-6]$/.test(job.scheduleExpr)) return 'weekly'
  return 'keep'
}

function getTimeFromCron(expr?: string): string {
  const match = expr?.match(/^(\d+) (\d+) /)
  if (!match) return '08:00'
  return `${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')}`
}

function getWeekdayFromCron(expr?: string): string {
  return expr?.match(/^\d+ \d+ \* \* ([0-6])$/)?.[1] ?? '1'
}

export const CreateJobModal: FC<CreateJobModalProps> = ({ agents, editingJob, onSubmit, onUpdate, onClose }) => {
  const initialInterval = editingJob?.scheduleType === 'every'
    ? msToInterval(Number(editingJob.scheduleExpr))
    : { amount: 1, unit: 'hours' as IntervalUnit['value'] }
  const [name, setName] = useState(editingJob?.name ?? '')
  const [taskText, setTaskText] = useState(editingJob?.taskText ?? '')
  const [mode, setMode] = useState<ScheduleMode>(getScheduleMode(editingJob))
  const [time, setTime] = useState(getTimeFromCron(editingJob?.scheduleExpr))
  const [weekday, setWeekday] = useState(getWeekdayFromCron(editingJob?.scheduleExpr))
  const [intervalAmount, setIntervalAmount] = useState(initialInterval.amount)
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit['value']>(initialInterval.unit)
  const [onceAt, setOnceAt] = useState(
    editingJob?.scheduleType === 'at' ? msToDatetimeLocal(Number(editingJob.scheduleExpr)) : getDefaultDatetime(),
  )
  const [submitting, setSubmitting] = useState(false)

  const schedule = useMemo((): { type: CronScheduleType; expr: string } => {
    if (mode === 'keep' && editingJob) {
      return { type: editingJob.scheduleType, expr: editingJob.scheduleExpr }
    }

    const [hour = '08', minute = '00'] = time.split(':')
    if (mode === 'weekdays') return { type: 'cron', expr: `${Number(minute)} ${Number(hour)} * * 1-5` }
    if (mode === 'weekly') return { type: 'cron', expr: `${Number(minute)} ${Number(hour)} * * ${weekday}` }
    if (mode === 'interval') {
      return { type: 'every', expr: String(intervalToMs(Math.max(1, intervalAmount), intervalUnit)) }
    }
    if (mode === 'once') return { type: 'at', expr: String(new Date(onceAt).getTime()) }
    return { type: 'cron', expr: `${Number(minute)} ${Number(hour)} * * *` }
  }, [editingJob, intervalAmount, intervalUnit, mode, onceAt, time, weekday])

  const scheduleError = validateSchedule(schedule.type, schedule.expr)
  const canSubmit = Boolean(name.trim() && taskText.trim() && !scheduleError && !submitting)

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const data: CreateCronJobParams = {
        name: name.trim(),
        taskText: taskText.trim(),
        agentId: editingJob?.agentId || agents[0]?.id || 'assistant',
        scheduleType: schedule.type,
        scheduleExpr: schedule.expr,
      }
      if (editingJob && onUpdate) await onUpdate(editingJob.id, data)
      else await onSubmit(data)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal open title={editingJob ? '编辑定时任务' : '新建定时任务'} onClose={onClose} width={520} layer="aboveHub">
      <div className={styles.formContainer}>
        <p className={styles.intro}>填好要做的事和时间，到点后会自动执行。</p>

        <div className={styles.formGroup}>
          <label className={styles.label} htmlFor="cron-job-name">任务名称</label>
          <input
            id="cron-job-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：每天整理工作日报"
            className={styles.input}
            autoFocus
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.label} htmlFor="cron-job-task">让助手做什么</label>
          <textarea
            id="cron-job-task"
            value={taskText}
            onChange={(event) => setTaskText(event.target.value)}
            placeholder="例如：汇总今天的工作进度，生成一份简短日报"
            rows={4}
            className={styles.textarea}
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.label} htmlFor="cron-job-mode">什么时候执行</label>
          <select
            id="cron-job-mode"
            value={mode}
            onChange={(event) => setMode(event.target.value as ScheduleMode)}
            className={styles.select}
          >
            <option value="daily">每天</option>
            <option value="weekdays">工作日（周一至周五）</option>
            <option value="weekly">每周一次</option>
            <option value="interval">按固定间隔</option>
            <option value="once">只执行一次</option>
            {getScheduleMode(editingJob) === 'keep' && <option value="keep">保持当前规则</option>}
          </select>
        </div>

        {(mode === 'daily' || mode === 'weekdays' || mode === 'weekly') && (
          <div className={styles.inlineFields}>
            {mode === 'weekly' && (
              <div className={styles.inlineField}>
                <label className={styles.fieldLabel} htmlFor="cron-job-weekday">星期</label>
                <select id="cron-job-weekday" value={weekday} onChange={(event) => setWeekday(event.target.value)} className={styles.select}>
                  <option value="1">周一</option><option value="2">周二</option><option value="3">周三</option>
                  <option value="4">周四</option><option value="5">周五</option><option value="6">周六</option><option value="0">周日</option>
                </select>
              </div>
            )}
            <div className={styles.inlineField}>
              <label className={styles.fieldLabel} htmlFor="cron-job-time">时间</label>
              <input id="cron-job-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} className={styles.input} />
            </div>
          </div>
        )}

        {mode === 'interval' && (
          <div className={styles.inlineFields}>
            <div className={styles.inlineField}>
              <label className={styles.fieldLabel} htmlFor="cron-job-interval">每隔</label>
              <input id="cron-job-interval" type="number" min="1" value={intervalAmount} onChange={(event) => setIntervalAmount(Number(event.target.value))} className={styles.input} />
            </div>
            <div className={styles.inlineField}>
              <label className={styles.fieldLabel} htmlFor="cron-job-unit">单位</label>
              <select id="cron-job-unit" value={intervalUnit} onChange={(event) => setIntervalUnit(event.target.value as IntervalUnit['value'])} className={styles.select}>
                <option value="minutes">分钟</option><option value="hours">小时</option><option value="days">天</option>
              </select>
            </div>
          </div>
        )}

        {mode === 'once' && (
          <div className={styles.formGroup}>
            <label className={styles.fieldLabel} htmlFor="cron-job-once">执行时间</label>
            <input id="cron-job-once" type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} className={styles.input} />
          </div>
        )}

        {mode === 'keep' && <div className={styles.currentRule}>当前规则：{editingJob?.scheduleExpr}</div>}
        <NextRunPreview scheduleType={schedule.type} scheduleExpr={schedule.expr} />

        <div className={styles.footer}>
          <button type="button" onClick={onClose} className={styles.btnSecondary}>取消</button>
          <button type="button" onClick={handleSubmit} disabled={!canSubmit} className={styles.btnPrimary}>
            {submitting ? '保存中...' : editingJob ? '保存修改' : '创建任务'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
