import type { FC } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from '../../../../../components/ui/Modal'
import type { CreateCronJobParams, CronJob, CronScheduleType } from '../../../../../hooks/business/useCron/types'
import type { Agent } from '../../../../../services/agent-service'
import { getDefaultDatetime, intervalToMs, msToDatetimeLocal, msToInterval, type IntervalUnit, validateSchedule } from './schedule-helpers'
import { NextRunPreview } from './NextRunPreview'
import styles from './CreateJobModal.module.css'

type ScheduleMode = 'repeat' | 'interval' | 'once' | 'keep'

const DAYS = [
  ['1', '一'], ['2', '二'], ['3', '三'], ['4', '四'], ['5', '五'], ['6', '六'], ['0', '日'],
] as const

/** 通知目标。企微/微信的 SDK 只支持被动回复，故不可选 */
const NOTIFY_TARGETS = [
  { id: 'system', label: '系统通知', hint: '桌面弹窗提醒' },
  { id: 'news', label: '最近资讯', hint: '写入概览页资讯卡片' },
  { id: 'focus', label: '近期关注', hint: '写入概览页关注卡片' },
  { id: 'feishu', label: '飞书', hint: '推送到飞书私聊', needsFeishu: true },
] as const

const HOURS = Array.from({ length: 24 }, (_, i) => i)

interface CreateJobModalProps {
  agents: Agent[]
  defaultAgentId: string | null
  editingJob?: CronJob
  onSubmit: (data: CreateCronJobParams) => Promise<void>
  onUpdate?: (id: string, data: CreateCronJobParams) => Promise<void>
  onClose: () => void
}

function initialMode(job?: CronJob): ScheduleMode {
  if (!job) return 'repeat'
  if (job.scheduleType === 'every') return 'interval'
  if (job.scheduleType === 'at') return 'once'
  return /^\d+ \d+ \* \* (\*|[0-6](,[0-6])*)$/.test(job.scheduleExpr) ? 'repeat' : 'keep'
}

/** 周选择的初值：优先取 active_days，其次从 cron 表达式第 5 段推断，兜底全选 */
function initialDays(job?: CronJob): string[] {
  const stored = job?.activeDays?.trim()
  if (stored) return stored.split(',')
  const field = job?.scheduleExpr?.trim().split(/\s+/)[4]
  return !field || field === '*' ? DAYS.map(([id]) => id) : field.split(',')
}

function initialTime(expr?: string): string {
  const parts = expr?.trim().split(/\s+/)
  if (!parts || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return '09:00'
  return `${parts[1].padStart(2, '0')}:${parts[0].padStart(2, '0')}`
}

export const CreateJobModal: FC<CreateJobModalProps> = ({ agents, defaultAgentId, editingJob, onSubmit, onUpdate, onClose }) => {
  const [name, setName] = useState(editingJob?.name ?? '')
  const [taskText, setTaskText] = useState(editingJob?.taskText ?? '')
  const [agentId, setAgentId] = useState(editingJob?.agentId || defaultAgentId || agents[0]?.id || '')
  const [mode, setMode] = useState<ScheduleMode>(initialMode(editingJob))
  const [time, setTime] = useState(initialTime(editingJob?.scheduleExpr))
  const [days, setDays] = useState<string[]>(initialDays(editingJob))
  const initialInterval = editingJob?.scheduleType === 'every' ? msToInterval(Number(editingJob.scheduleExpr)) : { amount: 1, unit: 'hours' as IntervalUnit['value'] }
  const [intervalAmount, setIntervalAmount] = useState(initialInterval.amount)
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit['value']>(initialInterval.unit)
  const [hourStart, setHourStart] = useState(editingJob?.activeHourStart ?? 9)
  const [hourEnd, setHourEnd] = useState(editingJob?.activeHourEnd ?? 18)
  const [onceAt, setOnceAt] = useState(editingJob?.scheduleType === 'at' ? msToDatetimeLocal(Number(editingJob.scheduleExpr)) : getDefaultDatetime())
  const [notify, setNotify] = useState<string[]>(editingJob?.notifyTargets?.split(',').filter(Boolean) ?? ['system'])
  const [feishuReady, setFeishuReady] = useState(false)
  const [notifyOpen, setNotifyOpen] = useState(false)
  const notifyRef = useRef<HTMLDivElement>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    void window.feishuService?.getStatus().then((status) => setFeishuReady(status === 'connected')).catch(() => setFeishuReady(false))
  }, [])

  // 点外面收起下拉。渠道会越加越多，面板挡住下方表单时得能随手关掉。
  useEffect(() => {
    if (!notifyOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (!notifyRef.current?.contains(event.target as Node)) setNotifyOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNotifyOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [notifyOpen])

  const schedule = useMemo((): { type: CronScheduleType; expr: string } => {
    if (mode === 'keep' && editingJob) return { type: editingJob.scheduleType, expr: editingJob.scheduleExpr }
    if (mode === 'interval') return { type: 'every', expr: String(intervalToMs(Math.max(1, intervalAmount), intervalUnit)) }
    if (mode === 'once') return { type: 'at', expr: String(new Date(onceAt).getTime()) }
    const [hour = '09', minute = '00'] = time.split(':')
    return { type: 'cron', expr: `${Number(minute)} ${Number(hour)} * * ${days.length === 7 ? '*' : days.join(',')}` }
  }, [days, editingJob, intervalAmount, intervalUnit, mode, onceAt, time])

  const scheduleError = validateSchedule(schedule.type, schedule.expr)
  const isSystemWorkflow = taskText.trim().startsWith('__lumii_workflow__:')
  const noDaySelected = (mode === 'repeat' || mode === 'interval') && days.length === 0
  const canSubmit = Boolean(name.trim() && taskText.trim() && (agentId || isSystemWorkflow) && !scheduleError && !noDaySelected && !submitting)

  const toggleDay = (day: string) => setDays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day])
  const toggleNotify = (id: string) => setNotify((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])

  /** 收起状态下要能看出选了哪些渠道，所以按 NOTIFY_TARGETS 顺序拼名字而不是显示「已选 2 项」 */
  const notifySummary = notify.length === 0
    ? '不通知'
    : NOTIFY_TARGETS.filter((target) => notify.includes(target.id)).map((target) => target.label).join('、')

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const data: CreateCronJobParams = {
        name: name.trim(),
        taskText: taskText.trim(),
        agentId,
        scheduleType: schedule.type,
        scheduleExpr: schedule.expr,
        // 「按间隔」的星期靠 active_days 运行时过滤；「每天」已写进 cron 表达式，
        // 但同样落库，编辑时才能回显出用户勾了哪几天。
        activeDays: mode === 'once' || mode === 'keep' ? '' : days.length === 7 ? '' : days.join(','),
        // 生效时段只对「按间隔」有意义：每天/按次本身就是定点触发
        activeHourStart: mode === 'interval' ? hourStart : null,
        activeHourEnd: mode === 'interval' ? hourEnd : null,
        notifyTargets: notify.join(','),
      }
      if (editingJob && onUpdate) await onUpdate(editingJob.id, data)
      else await onSubmit(data)
    } finally { setSubmitting(false) }
  }

  return (
    <Modal open title={editingJob ? '编辑定时任务' : '新建定时任务'} onClose={onClose} width={560} layer="aboveHub">
      <div className={styles.formContainer}>
        <div className={styles.formGroup}>
          <label className={styles.label} htmlFor="cron-job-name">任务名称</label>
          <input id="cron-job-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：每天整理工作日报" className={styles.input} autoFocus />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.label} htmlFor="cron-job-agent">执行 Agent</label>
          <select id="cron-job-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)} className={styles.select}>
            {isSystemWorkflow && <option value="">系统内置工作流</option>}
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.id === defaultAgentId ? `系统默认 Agent（${agent.name}）` : agent.name}</option>)}
          </select>
        </div>

        <div className={styles.formGroup}>
          <label className={styles.label} htmlFor="cron-job-task">任务指令</label>
          <textarea id="cron-job-task" value={taskText} onChange={(event) => setTaskText(event.target.value)} placeholder="请输入希望 Agent 完成的内容" rows={4} className={styles.textarea} />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.label}>执行时间</label>
          <div className={styles.segmented}>
            {([['repeat', '每天'], ['interval', '按间隔'], ['once', '按次']] as const).map(([id, label]) => (
              <button key={id} type="button" className={mode === id ? styles.segmentActive : ''} onClick={() => setMode(id)}>{label}</button>
            ))}
          </div>
        </div>

        {/* 时间/间隔/生效时段 与 周选择同处一行，保持紧凑 */}
        {(mode === 'repeat' || mode === 'interval') && (
          <>
            <div className={styles.scheduleRow}>
              {mode === 'repeat' ? (
                <div className={styles.inlineField}>
                  <label className={styles.fieldLabel} htmlFor="cron-job-time">时间</label>
                  <input id="cron-job-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} className={styles.input} />
                </div>
              ) : (
                <>
                  <div className={styles.inlineField}>
                    <label className={styles.fieldLabel} htmlFor="cron-job-interval">每隔</label>
                    <input id="cron-job-interval" type="number" min="1" value={intervalAmount} onChange={(event) => setIntervalAmount(Number(event.target.value))} className={styles.input} />
                  </div>
                  <div className={styles.inlineField}>
                    <label className={styles.fieldLabel} htmlFor="cron-job-unit">单位</label>
                    <select id="cron-job-unit" value={intervalUnit} onChange={(event) => setIntervalUnit(event.target.value as IntervalUnit['value'])} className={styles.select}>
                      <option value="minutes">分钟</option>
                      <option value="hours">小时</option>
                      <option value="days">天</option>
                    </select>
                  </div>
                  <div className={styles.inlineField}>
                    <label className={styles.fieldLabel} htmlFor="cron-job-hour-start">生效时间</label>
                    <div className={styles.hourRange}>
                      <select id="cron-job-hour-start" value={hourStart} onChange={(event) => setHourStart(Number(event.target.value))} className={styles.select}>
                        {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                      </select>
                      <span className={styles.hourSep}>至</span>
                      <select id="cron-job-hour-end" value={hourEnd} onChange={(event) => setHourEnd(Number(event.target.value))} className={styles.select}>
                        {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                      </select>
                    </div>
                  </div>
                </>
              )}
              <div className={styles.inlineField}>
                <label className={styles.fieldLabel}>星期</label>
                <div className={styles.days}>
                  {DAYS.map(([id, label]) => (
                    <button key={id} type="button" className={days.includes(id) ? styles.dayActive : ''} onClick={() => toggleDay(id)}>{label}</button>
                  ))}
                </div>
              </div>
            </div>
            <p className={styles.hint}>
              {mode === 'repeat'
                ? '所选星期的该时间点执行一次。'
                : hourStart === hourEnd
                  ? '所选星期全天按间隔执行。'
                  : `所选星期的 ${String(hourStart).padStart(2, '0')}:00 至 ${String(hourEnd).padStart(2, '0')}:00 之间按间隔执行。`}
              {noDaySelected && <span className={styles.errorText}> 请至少选择一天。</span>}
            </p>
          </>
        )}

        {mode === 'once' && (
          <div className={styles.formGroup}>
            <label className={styles.fieldLabel} htmlFor="cron-job-once">执行时间</label>
            <input id="cron-job-once" type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} className={styles.input} />
          </div>
        )}

        {mode === 'keep' && <div className={styles.currentRule}>当前规则：{editingJob?.scheduleExpr}</div>}

        <div className={styles.formGroup}>
          <label className={styles.label} id="cron-job-notify-label">通知渠道</label>
          <div className={styles.notifySelect} ref={notifyRef}>
            <button
              type="button"
              className={styles.notifyTrigger}
              onClick={() => setNotifyOpen((open) => !open)}
              aria-haspopup="listbox"
              aria-expanded={notifyOpen}
              aria-labelledby="cron-job-notify-label"
            >
              <span className={notify.length ? styles.notifyValue : styles.notifyPlaceholder}>{notifySummary}</span>
              <span className={styles.notifyArrow} aria-hidden="true">▾</span>
            </button>
            {notifyOpen && (
              <div className={styles.notifyPanel} role="listbox" aria-multiselectable="true">
                {NOTIFY_TARGETS.map((target) => {
                  const disabled = 'needsFeishu' in target && target.needsFeishu === true && !feishuReady
                  return (
                    <label key={target.id} className={`${styles.notifyItem} ${disabled ? styles.notifyDisabled : ''}`}>
                      <input type="checkbox" checked={notify.includes(target.id)} disabled={disabled} onChange={() => toggleNotify(target.id)} />
                      <span className={styles.notifyLabel}>{target.label}</span>
                      <span className={styles.notifyHint}>{disabled ? '需先在设置中登录飞书' : target.hint}</span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>
          <p className={styles.hint}>企业微信与微信的机器人只能被动回复用户消息，暂不支持主动推送。</p>
        </div>

        <NextRunPreview scheduleType={schedule.type} scheduleExpr={schedule.expr} />

        <div className={styles.footer}>
          <button type="button" onClick={onClose} className={styles.btnSecondary}>取消</button>
          <button type="button" onClick={handleSubmit} disabled={!canSubmit} className={styles.btnPrimary}>{submitting ? '保存中...' : editingJob ? '保存修改' : '创建任务'}</button>
        </div>
      </div>
    </Modal>
  )
}
