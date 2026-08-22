import React from 'react'
import styles from '../../AgentsPage.module.css'
import { CAPABILITY_OPTIONS } from '../../AgentsPage.const'
import { CapabilityToggle } from '../CapabilityToggle'

export interface AgentCapabilitiesFieldProps {
  enabledCapabilities: Set<string>
  onToggle: (id: string, enabled: boolean) => void
  mode: 'edit' | 'create'
}

/** 能力开关列表，编辑与新建 Modal 共用 */
export const AgentCapabilitiesField: React.FC<AgentCapabilitiesFieldProps> = ({
  enabledCapabilities,
  onToggle,
  mode,
}) => (
  <div className={styles['form-field']}>
    <label className={styles['form-label']}>
      可用能力
      <span className={styles['form-hint-inline']}>
        {mode === 'edit' ? '开启后 Agent 才能使用该能力' : '选择这个 Agent 可以使用哪些功能'}
      </span>
    </label>
    <div className={styles['capability-list']}>
      {CAPABILITY_OPTIONS.map((cap) => (
        <CapabilityToggle
          key={cap.id}
          option={cap}
          enabled={enabledCapabilities.has(cap.id)}
          onChange={onToggle}
        />
      ))}
    </div>
  </div>
)
