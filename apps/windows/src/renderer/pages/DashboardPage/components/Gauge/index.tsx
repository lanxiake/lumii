/**
 * Gauge - 环形仪表（原型 .gauge）
 *
 * conic-gradient + `@property --mt-p` 插值实现指针动画，无 JS 动画、无 SVG。
 * value 为 undefined 时显示「—」，代表尚未采到数据而不是 0%。
 */

import React from 'react'
import styles from './Gauge.module.css'

export interface GaugeProps {
  /** 0-100；undefined 表示无数据 */
  value?: number
  label: string
  /** 悬停提示，用于补充「多少核」「多少 GB」这类细节 */
  title?: string
  /** 环的颜色，缺省用主色（三环并排时用于区分） */
  tone?: string
}

export const Gauge: React.FC<GaugeProps> = ({ value, label, title, tone }) => {
  const hasValue = typeof value === 'number' && Number.isFinite(value)
  const percent = hasValue ? Math.min(100, Math.max(0, value)) : 0
  return (
    <div
      className={styles.gauge}
      style={{ ['--mt-p' as string]: percent, ...(tone ? { ['--mt-tone' as string]: tone } : {}) }}
      title={title}
      role="img"
      aria-label={`${label} ${hasValue ? `${Math.round(percent)}%` : '暂无数据'}`}
    >
      <span className={styles.text}>{hasValue ? `${Math.round(percent)}%` : '—'}</span>
      <em className={styles.label}>{label}</em>
    </div>
  )
}

export default Gauge
