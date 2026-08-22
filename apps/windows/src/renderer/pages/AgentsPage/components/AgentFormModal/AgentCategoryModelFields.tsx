import React from 'react'
import styles from '../../AgentsPage.module.css'
import { MODEL_TIER_OPTIONS } from '../../AgentsPage.const'
import type { AgentFormData } from '../../AgentsPage.types'
import type { ModelTier } from '../../../../services/agent-service'

export interface AgentCategoryModelFieldsProps {
  value: Pick<AgentFormData, 'category' | 'modelTier'>
  onChange: (patch: Partial<AgentFormData>) => void
}

/** 分类 (category) + 模型级别 (modelTier)，编辑与新建 Modal 共用 */
export const AgentCategoryModelFields: React.FC<AgentCategoryModelFieldsProps> = ({ value, onChange }) => (
  <>
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
    <div className={styles['form-field']}>
      <label className={styles['form-label']}>
        模型级别
        <span className={styles['form-hint-inline']}>决定子任务使用的 AI 模型能力</span>
      </label>
      <select
        className={styles['form-select']}
        value={value.modelTier}
        onChange={(e) => onChange({ modelTier: e.target.value as ModelTier })}
      >
        {MODEL_TIER_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label} — {opt.description}
          </option>
        ))}
      </select>
    </div>
  </>
)
