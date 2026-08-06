/**
 * CreateJobModal — 创建定时任务弹窗（完全重构版）
 *
 * 使用预设卡片 + 可视化子组件替代原始输入
 */

import type { FC } from 'react'
import { useState, useCallback } from 'react'
import { Modal } from '../../../../../components/ui/Modal'
import type { CreateCronJobParams, CronJob, CronScheduleType } from '../../../../../hooks/business/useCron/types'
import type { Agent } from '../../../../../services/agent-service'
import type { SchedulePreset } from './schedule-helpers'
import { PRESETS, validateSchedule, getSystemTimezone, getTimezoneOptions, matchPreset } from './schedule-helpers'
import { SchedulePresets } from './SchedulePresets'
import { IntervalPicker } from './IntervalPicker'
import { DateTimePicker } from './DateTimePicker'
import { CronBuilder } from './CronBuilder'
import { NextRunPreview } from './NextRunPreview'
import styles from './CreateJobModal.module.css'

interface CreateJobModalProps {
  agents: Agent[]
  editingJob?: CronJob
  onSubmit: (data: CreateCronJobParams) => Promise<void>
  onUpdate?: (id: string, data: CreateCronJobParams) => Promise<void>
  onClose: () => void
}

export const CreateJobModal: FC<CreateJobModalProps> = ({ agents, editingJob, onSubmit, onUpdate, onClose }) => {
  const [name, setName] = useState(editingJob?.name ?? '')
  const [description, setDescription] = useState(editingJob?.description ?? '')
  const [agentId, setAgentId] = useState(editingJob?.agentId ?? agents[0]?.id ?? '')
  const [selectedPreset, setSelectedPreset] = useState<SchedulePreset>(
    editingJob ? matchPreset(editingJob.scheduleType, editingJob.scheduleExpr) : PRESETS[0]
  )
  const [scheduleType, setScheduleType] = useState<CronScheduleType>(editingJob?.scheduleType ?? PRESETS[0].scheduleType)
  const [scheduleExpr, setScheduleExpr] = useState(editingJob?.scheduleExpr ?? PRESETS[0].defaultExpr)
  const [scheduleTz, setScheduleTz] = useState(editingJob?.scheduleTz ?? getSystemTimezone())
  const [taskText, setTaskText] = useState(editingJob?.taskText ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)

  const handlePresetSelect = useCallback((preset: SchedulePreset) => {
    setSelectedPreset(preset)
    setScheduleType(preset.scheduleType)
    if (!preset.needsInput) {
      setScheduleExpr(preset.defaultExpr)
      setValidationError(null)
    } else {
      setScheduleExpr('')
    }
  }, [])

  const handleExprChange = useCallback((expr: string) => {
    setScheduleExpr(expr)
    const error = validateSchedule(scheduleType, expr)
    setValidationError(error)
  }, [scheduleType])

  const canSubmit = name.trim() && agentId && scheduleExpr.trim() && taskText.trim() && !submitting && !validationError

  const handleSubmit = async () => {
    // 最终校验
    const error = validateSchedule(scheduleType, scheduleExpr)
    if (error) {
      setValidationError(error)
      return
    }
    if (!canSubmit) return

    setSubmitting(true)
    try {
      const data: CreateCronJobParams = {
        name: name.trim(),
        description: description.trim() || undefined,
        agentId,
        scheduleType,
        scheduleExpr: scheduleExpr.trim(),
        scheduleTz: scheduleType === 'cron' ? scheduleTz : undefined,
        taskText: taskText.trim(),
      }
      if (editingJob && onUpdate) {
        await onUpdate(editingJob.id, data)
      } else {
        await onSubmit(data)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const tzOptions = getTimezoneOptions()

  return (
    <Modal open title={editingJob ? '编辑定时任务' : '新建定时任务'} onClose={onClose} width={560} layer="aboveHub">
      <div className={styles.formContainer}>
        {/* 任务名称 */}
        <div className={styles.formGroup}>
          <label className={styles.label}>
            任务名称 <span className={styles.required}>*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：每日数据汇总"
            className={styles.input}
          />
        </div>

        {/* 执行 Agent */}
        <div className={styles.formGroup}>
          <label className={styles.label}>
            执行 Agent <span className={styles.required}>*</span>
          </label>
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className={styles.select}
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name}</option>
            ))}
          </select>
        </div>

        {/* 执行频率 */}
        <div className={styles.formGroup}>
          <label className={styles.label}>执行频率</label>
          <SchedulePresets
            selectedId={selectedPreset.id}
            onSelect={handlePresetSelect}
          />
        </div>

        {/* 条件渲染：自定义输入区 */}
        {selectedPreset.needsInput && (
          <div className={styles.formGroup}>
            <label className={styles.label}>调度设置</label>
            {selectedPreset.id === 'custom-interval' && (
              <IntervalPicker value={scheduleExpr} onChange={handleExprChange} />
            )}
            {selectedPreset.id === 'once' && (
              <DateTimePicker value={scheduleExpr} onChange={handleExprChange} />
            )}
            {selectedPreset.id === 'custom' && (
              <CronBuilder value={scheduleExpr} onChange={handleExprChange} />
            )}
            {validationError && (
              <span className={styles.fieldError}>{validationError}</span>
            )}
          </div>
        )}

        {/* 下次执行时间预览 */}
        {scheduleExpr && (
          <NextRunPreview
            scheduleType={scheduleType}
            scheduleExpr={scheduleExpr}
            timezone={scheduleTz}
          />
        )}

        {/* 时区（cron 类型时显示） */}
        {scheduleType === 'cron' && (
          <div className={styles.formGroup}>
            <label className={styles.label}>时区</label>
            <select
              value={scheduleTz}
              onChange={(e) => setScheduleTz(e.target.value)}
              className={styles.select}
            >
              {tzOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        )}

        {/* 执行指令 */}
        <div className={styles.formGroup}>
          <label className={styles.label}>
            执行指令 <span className={styles.required}>*</span>
          </label>
          <textarea
            value={taskText}
            onChange={(e) => setTaskText(e.target.value)}
            placeholder="请描述你希望 Agent 做什么"
            rows={3}
            className={styles.textarea}
          />
        </div>

        {/* 描述 */}
        <div className={styles.formGroup}>
          <label className={styles.label}>描述（可选）</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="任务描述"
            className={styles.input}
          />
        </div>

        {/* 操作按钮 */}
        <div className={styles.footer}>
          <button
            type="button"
            onClick={onClose}
            className={styles.btnSecondary}
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={styles.btnPrimary}
          >
            {submitting ? (editingJob ? '保存中...' : '创建中...') : (editingJob ? '保存' : '创建')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
