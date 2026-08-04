/**
 * CronBuilder — 可视化 cron 构建器（5 个下拉框）
 *
 * 替代手写 cron 表达式，提供下拉选择 + 中文描述 + 高级模式切换
 */

import type { FC } from 'react'
import { useState, useEffect, useCallback } from 'react'
import type { CronFields } from './schedule-helpers'
import { buildCronExpr, parseCronExpr, describeCronExpr } from './schedule-helpers'
import styles from './CreateJobModal.module.css'

interface CronBuilderProps {
  value: string  // cron 表达式
  onChange: (expr: string) => void
}

// 分钟选项
const MINUTE_OPTIONS = [
  { label: '00', value: '0' },
  { label: '15', value: '15' },
  { label: '30', value: '30' },
  { label: '45', value: '45' },
  { label: '每分钟 (*)', value: '*' },
]

// 小时选项
const HOUR_OPTIONS = [
  ...Array.from({ length: 24 }, (_, i) => ({
    label: String(i).padStart(2, '0'),
    value: String(i),
  })),
  { label: '每小时 (*)', value: '*' },
]

// 日期选项
const DOM_OPTIONS = [
  { label: '每天 (*)', value: '*' },
  ...Array.from({ length: 31 }, (_, i) => ({
    label: `${i + 1} 日`,
    value: String(i + 1),
  })),
]

// 月份选项
const MONTH_OPTIONS = [
  { label: '每月 (*)', value: '*' },
  ...[
    '1月', '2月', '3月', '4月', '5月', '6月',
    '7月', '8月', '9月', '10月', '11月', '12月',
  ].map((label, i) => ({ label, value: String(i + 1) })),
]

// 星期选项
const DOW_OPTIONS = [
  { label: '每天 (*)', value: '*' },
  { label: '工作日 (一至五)', value: '1-5' },
  { label: '周末 (六日)', value: '0,6' },
  { label: '周一', value: '1' },
  { label: '周二', value: '2' },
  { label: '周三', value: '3' },
  { label: '周四', value: '4' },
  { label: '周五', value: '5' },
  { label: '周六', value: '6' },
  { label: '周日', value: '0' },
]

export const CronBuilder: FC<CronBuilderProps> = ({ value, onChange }) => {
  const [advancedMode, setAdvancedMode] = useState(false)
  const [rawExpr, setRawExpr] = useState(value || '0 8 * * *')

  const parsed = parseCronExpr(rawExpr)
  const [fields, setFields] = useState<CronFields>(parsed ?? {
    minute: '0',
    hour: '8',
    dayOfMonth: '*',
    month: '*',
    dayOfWeek: '*',
  })

  const updateField = useCallback((key: keyof CronFields, val: string) => {
    const next = { ...fields, [key]: val }
    setFields(next)
    const expr = buildCronExpr(next)
    setRawExpr(expr)
    onChange(expr)
  }, [fields, onChange])

  useEffect(() => {
    // 初始化时发射
    if (!value) {
      const expr = buildCronExpr(fields)
      onChange(expr)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleRawChange = (val: string) => {
    setRawExpr(val)
    const p = parseCronExpr(val)
    if (p) {
      setFields(p)
    }
    onChange(val)
  }

  const description = describeCronExpr(rawExpr)

  return (
    <div className={styles.cronBuilder}>
      {/* 模式切换 */}
      <div className={styles.cronModeSwitch}>
        <label className={styles.switchLabel}>
          <input
            type="checkbox"
            checked={advancedMode}
            onChange={(e) => setAdvancedMode(e.target.checked)}
            className={styles.switchInput}
          />
          <span className={styles.switchText}>高级模式</span>
        </label>
      </div>

      {advancedMode ? (
        /* 高级模式 — 原始 cron 输入 */
        <input
          type="text"
          value={rawExpr}
          onChange={(e) => handleRawChange(e.target.value)}
          placeholder="0 8 * * *"
          className={styles.cronRawInput}
        />
      ) : (
        /* 可视化模式 — 5 个下拉框 */
        <div className={styles.cronFields}>
          <div className={styles.cronField}>
            <label className={styles.cronFieldLabel}>分钟</label>
            <select
              value={fields.minute}
              onChange={(e) => updateField('minute', e.target.value)}
              className={styles.cronFieldSelect}
            >
              {MINUTE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className={styles.cronField}>
            <label className={styles.cronFieldLabel}>小时</label>
            <select
              value={fields.hour}
              onChange={(e) => updateField('hour', e.target.value)}
              className={styles.cronFieldSelect}
            >
              {HOUR_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className={styles.cronField}>
            <label className={styles.cronFieldLabel}>日期</label>
            <select
              value={fields.dayOfMonth}
              onChange={(e) => updateField('dayOfMonth', e.target.value)}
              className={styles.cronFieldSelect}
            >
              {DOM_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className={styles.cronField}>
            <label className={styles.cronFieldLabel}>月份</label>
            <select
              value={fields.month}
              onChange={(e) => updateField('month', e.target.value)}
              className={styles.cronFieldSelect}
            >
              {MONTH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className={styles.cronField}>
            <label className={styles.cronFieldLabel}>星期</label>
            <select
              value={fields.dayOfWeek}
              onChange={(e) => updateField('dayOfWeek', e.target.value)}
              className={styles.cronFieldSelect}
            >
              {DOW_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* 中文描述 */}
      <div className={styles.cronDescription}>{description}</div>
    </div>
  )
}
