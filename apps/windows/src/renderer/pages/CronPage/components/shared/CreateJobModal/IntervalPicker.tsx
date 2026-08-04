/**
 * IntervalPicker — 人性化间隔选择（数字 + 单位下拉）
 *
 * 替代毫秒输入
 */

import type { FC } from 'react'
import { useState, useEffect, useCallback } from 'react'
import { INTERVAL_UNITS, intervalToMs, msToInterval } from './schedule-helpers'
import type { IntervalUnit } from './schedule-helpers'
import styles from './CreateJobModal.module.css'

interface IntervalPickerProps {
  value: string  // 毫秒字符串
  onChange: (msString: string) => void
}

export const IntervalPicker: FC<IntervalPickerProps> = ({ value, onChange }) => {
  const initial = value ? msToInterval(parseInt(value, 10) || 3_600_000) : { amount: 1, unit: 'hours' as const }
  const [amount, setAmount] = useState(initial.amount)
  const [unit, setUnit] = useState<IntervalUnit['value']>(initial.unit)

  const emitChange = useCallback((a: number, u: IntervalUnit['value']) => {
    if (a > 0) {
      onChange(String(intervalToMs(a, u)))
    }
  }, [onChange])

  useEffect(() => {
    emitChange(amount, unit)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleAmountChange = (val: string) => {
    const n = parseInt(val, 10)
    if (!isNaN(n) && n > 0) {
      setAmount(n)
      emitChange(n, unit)
    } else {
      setAmount(0)
    }
  }

  const handleUnitChange = (val: string) => {
    const u = val as IntervalUnit['value']
    setUnit(u)
    emitChange(amount, u)
  }

  return (
    <div className={styles.intervalPicker}>
      <span className={styles.fieldLabel}>每隔</span>
      <input
        type="number"
        min={1}
        value={amount || ''}
        onChange={(e) => handleAmountChange(e.target.value)}
        className={styles.numberInput}
        placeholder="1"
      />
      <select
        value={unit}
        onChange={(e) => handleUnitChange(e.target.value)}
        className={styles.unitSelect}
      >
        {INTERVAL_UNITS.map((u) => (
          <option key={u.value} value={u.value}>{u.label}</option>
        ))}
      </select>
      <span className={styles.fieldLabel}>执行一次</span>
    </div>
  )
}
