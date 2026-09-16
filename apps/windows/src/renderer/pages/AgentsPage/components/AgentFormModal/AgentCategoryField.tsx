import React from 'react'
import styles from '../../AgentsPage.module.css'
import type { AgentFormData } from '../../AgentsPage.types'

export interface AgentCategoryFieldProps {
  value: Pick<AgentFormData, 'category'>
  onChange: (patch: Partial<AgentFormData>) => void
}

/** 分类 (category)，编辑与新建 Modal 共用 */
export const AgentCategoryField: React.FC<AgentCategoryFieldProps> = ({ value, onChange }) => (
  <div className={styles['form-field']}>
    <label className={styles['form-label']}>分类 (category)</label>
    <input
      type="text"
      className={styles['form-input']}
      value={value.category}
      onChange={(e) => onChange({ category: e.target.value })}
      placeholder="例：coding / writing / learning / life / general"
    />
  </div>
)
