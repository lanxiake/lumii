import React from 'react'
import styles from '../../AgentsPage.module.css'
import type { AgentFormData } from '../../AgentsPage.types'

export interface AgentBasicFieldsProps {
  value: Pick<AgentFormData, 'name' | 'description' | 'systemPrompt'>
  onChange: (patch: Partial<AgentFormData>) => void
  mode: 'edit' | 'create'
}

/** 名称 / 描述 / 系统提示词三个基础字段，编辑与新建 Modal 共用 */
export const AgentBasicFields: React.FC<AgentBasicFieldsProps> = ({ value, onChange, mode }) => {
  const isCreate = mode === 'create'
  return (
    <>
      <div className={styles['form-field']}>
        <label className={styles['form-label']}>名称 *</label>
        <input
          type="text"
          className={styles['form-input']}
          value={value.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={isCreate ? '例如：代码审查专家' : 'Agent 名称'}
          autoFocus={isCreate}
        />
      </div>
      <div className={styles['form-field']}>
        <label className={styles['form-label']}>
          描述{isCreate ? <> <span className={styles['form-required']}>*</span></> : '（可选）'}
        </label>
        <input
          type="text"
          className={styles['form-input']}
          value={value.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder={isCreate ? '描述这个 Agent 的专长，协调者会据此选择 Agent' : '描述这个 Agent 的专长'}
        />
        {isCreate && (
          <div className={styles['form-hint']}>
            协调者 Agent 会根据名称和描述来决定何时调用此 Agent
          </div>
        )}
      </div>
      <div className={styles['form-field']}>
        <label className={styles['form-label']}>
          系统提示词{isCreate && <> <span className={styles['form-required']}>*</span></>}
        </label>
        <textarea
          className={styles['form-textarea']}
          value={value.systemPrompt}
          onChange={(e) => onChange({ systemPrompt: e.target.value })}
          placeholder={
            isCreate
              ? '例如：你是一个严格的代码审查专家，专注于代码质量、安全漏洞和性能问题，提供清晰的改进建议...'
              : '描述这个 Agent 的角色、能力和行为方式...'
          }
          rows={isCreate ? 4 : 5}
        />
        {!isCreate && (
          <div className={styles['form-hint']}>
            系统提示词定义了 Agent 的专业角色。协调者在分配任务时会根据名称、描述和提示词做决策。
          </div>
        )}
      </div>
    </>
  )
}
