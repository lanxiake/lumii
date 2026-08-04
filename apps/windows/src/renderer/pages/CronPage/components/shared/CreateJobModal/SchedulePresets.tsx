/**
 * SchedulePresets — 8 个常用调度预设卡片网格
 */

import type { FC } from 'react'
import type { SchedulePreset } from './schedule-helpers'
import { PRESETS } from './schedule-helpers'
import styles from './CreateJobModal.module.css'

interface SchedulePresetsProps {
  selectedId: string
  onSelect: (preset: SchedulePreset) => void
}

export const SchedulePresets: FC<SchedulePresetsProps> = ({ selectedId, onSelect }) => {
  return (
    <div className={styles.presetGrid}>
      {PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          className={`${styles.presetCard} ${selectedId === preset.id ? styles.presetCardActive : ''}`}
          onClick={() => onSelect(preset)}
        >
          <span className={styles.presetLabel}>{preset.label}</span>
          <span className={styles.presetDesc}>{preset.description}</span>
        </button>
      ))}
    </div>
  )
}
