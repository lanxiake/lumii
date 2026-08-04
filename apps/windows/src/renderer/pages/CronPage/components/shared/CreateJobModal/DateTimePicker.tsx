/**
 * DateTimePicker — 日期时间选择器
 *
 * 替代时间戳输入，使用 datetime-local
 */

import type { FC } from 'react'
import { useState, useEffect } from 'react'
import { getDefaultDatetime, datetimeLocalToMs, msToDatetimeLocal } from './schedule-helpers'
import styles from './CreateJobModal.module.css'

interface DateTimePickerProps {
  value: string  // 毫秒字符串
  onChange: (msString: string) => void
}

export const DateTimePicker: FC<DateTimePickerProps> = ({ value, onChange }) => {
  // 如果传入的时间戳已过期（包括 AI Agent 创建的历史任务），自动重置为明天9:00
  const valueMsRaw = value ? parseInt(value, 10) : NaN
  const valueIsExpired = !isNaN(valueMsRaw) && valueMsRaw < Date.now() - 60_000
  const initDatetime = (!value || valueIsExpired)
    ? getDefaultDatetime()
    : msToDatetimeLocal(valueMsRaw)

  const [datetime, setDatetime] = useState(initDatetime)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // 初始化时发射有效的默认值（新建或原值已过期的场景）
    if (!value || valueIsExpired) {
      const ms = datetimeLocalToMs(initDatetime)
      if (!isNaN(ms) && ms > Date.now()) {
        onChange(String(ms))
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleChange = (val: string) => {
    setDatetime(val)
    const ms = datetimeLocalToMs(val)
    if (isNaN(ms)) {
      setError('请选择有效的日期时间')
      return
    }
    if (ms <= Date.now()) {
      setError('执行时间必须在未来')
      return
    }
    setError(null)
    onChange(String(ms))
  }

  // 最小值：当前本地时间（datetime-local 使用本地时区，不能用 toISOString 的 UTC 字符串）
  const minDatetime = msToDatetimeLocal(Date.now())

  return (
    <div className={styles.dateTimePicker}>
      <label className={styles.fieldLabel}>执行时间</label>
      <input
        type="datetime-local"
        value={datetime}
        min={minDatetime}
        onChange={(e) => handleChange(e.target.value)}
        className={styles.dateTimeInput}
      />
      {valueIsExpired && !error && (
        <span className={styles.fieldHint}>
          原定时间（{new Date(valueMsRaw).toLocaleString()}）已过期，已重置为默认时间
        </span>
      )}
      {error && <span className={styles.fieldError}>{error}</span>}
    </div>
  )
}
