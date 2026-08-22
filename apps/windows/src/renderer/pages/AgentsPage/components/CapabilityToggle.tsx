import React from 'react'
import clsx from 'clsx'
import styles from '../AgentsPage.module.css'
import type { CapabilityOption } from '../AgentsPage.types'

export const CapabilityToggle: React.FC<{
  option: CapabilityOption
  enabled: boolean
  onChange: (id: string, enabled: boolean) => void
}> = ({ option, enabled, onChange }) => (
  <div
    className={clsx(styles['capability-item'], enabled && styles['capability-item--on'])}
    onClick={() => onChange(option.id, !enabled)}
    role="checkbox"
    aria-checked={enabled}
    tabIndex={0}
    onKeyDown={(e) => e.key === ' ' && onChange(option.id, !enabled)}
  >
    <div className={styles['capability-info']}>
      <span className={styles['capability-label']}>{option.icon && <span style={{ marginRight: 4, display: 'inline-flex', verticalAlign: 'middle' }}>{option.icon}</span>}{option.label}</span>
      <span className={styles['capability-desc']}>{option.description}</span>
    </div>
    <div className={clsx(styles['capability-switch'], enabled && styles['capability-switch--on'])} />
  </div>
)
