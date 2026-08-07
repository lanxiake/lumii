import type { FC } from 'react'
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Modal } from '../../../../../components/ui/Modal'
import type { CreateCronJobParams, CronJob, CronScheduleType } from '../../../../../hooks/business/useCron/types'
import type { Agent } from '../../../../../services/agent-service'
import { getDefaultDatetime, intervalToMs, msToDatetimeLocal, msToInterval, type IntervalUnit, validateSchedule } from './schedule-helpers'
import { NextRunPreview } from './NextRunPreview'
import styles from './CreateJobModal.module.css'

type ScheduleMode = 'repeat' | 'interval' | 'once' | 'keep'

type TaskTemplate = { id: string; name: string; taskText: string; keywords: string }

const TASK_TEMPLATES: TaskTemplate[] = [
  { id: 'news', name: '每日新闻资讯', taskText: '__lumii_workflow__:news', keywords: '新闻 资讯 科技 热点' },
  { id: 'daily-report', name: '工作日报提醒', taskText: '提醒我整理今天的工作进度，并生成一份简短日报。', keywords: '日报 工作 进度 提醒' },
  { id: 'weekly-review', name: '每周工作复盘', taskText: '汇总本周完成事项、待解决问题和下周计划，生成工作复盘。', keywords: '周报 复盘 计划 工作' },
  { id: 'focus', name: '专注提醒', taskText: '提醒我暂停手头事务，确认当前最重要的一件事。', keywords: '专注 提醒 效率' },
]

const DAYS = [
  ['1', '周一'], ['2', '周二'], ['3', '周三'], ['4', '周四'], ['5', '周五'], ['6', '周六'], ['0', '周日'],
] as const

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

function initialDays(expr?: string): string[] {
  const field = expr?.trim().split(/\s+/)[4]
  return !field || field === '*' ? DAYS.map(([id]) => id) : field.split(',')
}

function initialTime(expr?: string): string {
  const parts = expr?.trim().split(/\s+/)
  if (!parts || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return '09:00'
  return `${parts[1].padStart(2, '0')}:${parts[0].padStart(2, '0')}`
}

export const CreateJobModal: FC<CreateJobModalProps> = ({ agents, defaultAgentId, editingJob, onSubmit, onUpdate, onClose }) => {
  const [selectedTemplate, setSelectedTemplate] = useState<TaskTemplate | null>(null)
  const [search, setSearch] = useState('')
  const [name, setName] = useState(editingJob?.name ?? '')
  const [taskText, setTaskText] = useState(editingJob?.taskText ?? '')
  const [agentId, setAgentId] = useState(editingJob?.agentId || defaultAgentId || agents[0]?.id || '')
  const [mode, setMode] = useState<ScheduleMode>(initialMode(editingJob))
  const [time, setTime] = useState(initialTime(editingJob?.scheduleExpr))
  const [days, setDays] = useState<string[]>(initialDays(editingJob?.scheduleExpr))
  const initialInterval = editingJob?.scheduleType === 'every' ? msToInterval(Number(editingJob.scheduleExpr)) : { amount: 1, unit: 'hours' as IntervalUnit['value'] }
  const [intervalAmount, setIntervalAmount] = useState(initialInterval.amount)
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit['value']>(initialInterval.unit)
  const [onceAt, setOnceAt] = useState(editingJob?.scheduleType === 'at' ? msToDatetimeLocal(Number(editingJob.scheduleExpr)) : getDefaultDatetime())
  const [submitting, setSubmitting] = useState(false)

  const schedule = useMemo((): { type: CronScheduleType; expr: string } => {
    if (mode === 'keep' && editingJob) return { type: editingJob.scheduleType, expr: editingJob.scheduleExpr }
    if (mode === 'interval') return { type: 'every', expr: String(intervalToMs(Math.max(1, intervalAmount), intervalUnit)) }
    if (mode === 'once') return { type: 'at', expr: String(new Date(onceAt).getTime()) }
    const [hour = '09', minute = '00'] = time.split(':')
    return { type: 'cron', expr: `${Number(minute)} ${Number(hour)} * * ${days.length === 7 ? '*' : days.join(',')}` }
  }, [days, editingJob, intervalAmount, intervalUnit, mode, onceAt, time])

  const scheduleError = validateSchedule(schedule.type, schedule.expr)
  const isSystemWorkflow = taskText.trim().startsWith('__lumii_workflow__:')
  const canSubmit = Boolean(name.trim() && taskText.trim() && (agentId || isSystemWorkflow) && !scheduleError && !submitting)
  const filteredTemplates = TASK_TEMPLATES.filter((template) => `${template.name} ${template.keywords}`.includes(search.trim()))
  const showTemplatePicker = !editingJob && !selectedTemplate

  const chooseTemplate = (template: TaskTemplate) => {
    setSelectedTemplate(template)
    setName(template.name)
    setTaskText(template.taskText)
    if (template.id === 'news') setAgentId('')
  }

  const toggleDay = (day: string) => setDays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day])

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const data: CreateCronJobParams = { name: name.trim(), taskText: taskText.trim(), agentId, scheduleType: schedule.type, scheduleExpr: schedule.expr }
      if (editingJob && onUpdate) await onUpdate(editingJob.id, data)
      else await onSubmit(data)
    } finally { setSubmitting(false) }
  }

  return (
    <Modal open title={editingJob ? '编辑定时任务' : '新建定时任务'} onClose={onClose} width={560} layer="aboveHub">
      {showTemplatePicker ? (
        <div className={styles.templatePicker}>
          <p className={styles.intro}>选择一个示例，内容和时间都可以继续修改。</p>
          <label className={styles.searchBox}><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索任务示例" autoFocus /></label>
          <div className={styles.templateList}>
            {filteredTemplates.map((template) => <button key={template.id} type="button" className={styles.templateCard} onClick={() => chooseTemplate(template)}><strong>{template.name}</strong><span>{template.keywords}</span></button>)}
          </div>
          <button type="button" className={styles.blankButton} onClick={() => setSelectedTemplate({ id: 'blank', name: '', taskText: '', keywords: '' })}>从空白任务开始</button>
        </div>
      ) : (
        <div className={styles.formContainer}>
          <div className={styles.formGroup}><label className={styles.label} htmlFor="cron-job-name">任务名称</label><input id="cron-job-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：每天整理工作日报" className={styles.input} autoFocus /></div>
          <div className={styles.formGroup}><label className={styles.label} htmlFor="cron-job-agent">执行 Agent</label><select id="cron-job-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)} className={styles.select}>{isSystemWorkflow && <option value="">系统内置工作流</option>}{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.id === defaultAgentId ? `系统默认 Agent（${agent.name}）` : agent.name}</option>)}</select></div>
          <div className={styles.formGroup}><label className={styles.label} htmlFor="cron-job-task">任务指令</label><textarea id="cron-job-task" value={taskText} onChange={(event) => setTaskText(event.target.value)} placeholder="请输入希望 Agent 完成的内容" rows={4} className={styles.textarea} /></div>
          <div className={styles.formGroup}><label className={styles.label}>执行时间</label><div className={styles.segmented}>{([['repeat', '每天'], ['interval', '按间隔'], ['once', '按次']] as const).map(([id, label]) => <button key={id} type="button" className={mode === id ? styles.segmentActive : ''} onClick={() => setMode(id)}>{label}</button>)}</div></div>
          {mode === 'repeat' && <><div className={styles.inlineFields}><div className={styles.inlineField}><label className={styles.fieldLabel} htmlFor="cron-job-time">时间</label><input id="cron-job-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} className={styles.input} /></div></div><div className={styles.days}>{DAYS.map(([id, label]) => <button key={id} type="button" className={days.includes(id) ? styles.dayActive : ''} onClick={() => toggleDay(id)}>{label}</button>)}</div><p className={styles.hint}>默认全天有效，已选择的日期会在该时间执行。</p></>}
          {mode === 'interval' && <><div className={styles.inlineFields}><div className={styles.inlineField}><label className={styles.fieldLabel} htmlFor="cron-job-interval">每隔</label><input id="cron-job-interval" type="number" min="1" value={intervalAmount} onChange={(event) => setIntervalAmount(Number(event.target.value))} className={styles.input} /></div><div className={styles.inlineField}><label className={styles.fieldLabel} htmlFor="cron-job-unit">单位</label><select id="cron-job-unit" value={intervalUnit} onChange={(event) => setIntervalUnit(event.target.value as IntervalUnit['value'])} className={styles.select}><option value="minutes">分钟</option><option value="hours">小时</option><option value="days">天</option></select></div></div><p className={styles.hint}>默认全天有效，保存后立即开始计时。</p></>}
          {mode === 'once' && <div className={styles.formGroup}><label className={styles.fieldLabel} htmlFor="cron-job-once">执行时间</label><input id="cron-job-once" type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} className={styles.input} /></div>}
          {mode === 'keep' && <div className={styles.currentRule}>当前规则：{editingJob?.scheduleExpr}</div>}
          <NextRunPreview scheduleType={schedule.type} scheduleExpr={schedule.expr} />
          <div className={styles.footer}>{!editingJob && <button type="button" onClick={() => setSelectedTemplate(null)} className={styles.btnSecondary}>返回示例</button>}<button type="button" onClick={onClose} className={styles.btnSecondary}>取消</button><button type="button" onClick={handleSubmit} disabled={!canSubmit} className={styles.btnPrimary}>{submitting ? '保存中...' : editingJob ? '保存修改' : '创建任务'}</button></div>
        </div>
      )}
    </Modal>
  )
}
