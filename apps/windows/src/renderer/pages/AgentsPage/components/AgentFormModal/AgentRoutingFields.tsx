import React from 'react'
import styles from '../../AgentsPage.module.css'
import type { AgentFormData } from '../../AgentsPage.types'

export interface AgentRoutingFieldsProps {
  value: Pick<AgentFormData, 'whenToUse' | 'triggerExamples' | 'bundledSkills'>
  onChange: (patch: Partial<AgentFormData>) => void
  mode: 'edit' | 'create'
}

/** Pre-LLM Router 路由信号字段（whenToUse / triggerExamples / bundledSkills），编辑与新建 Modal 共用 */
export const AgentRoutingFields: React.FC<AgentRoutingFieldsProps> = ({ value, onChange, mode }) => {
  const isCreate = mode === 'create'
  return (
    <>
      {/* ─── Pre-LLM Router 路由信号（v2） ─── */}
      <div className={styles['form-field']}>
        <label className={styles['form-label']}>
          🔀 何时使用 (whenToUse)
          <span className={styles['form-hint-inline']}>填写后可显著提升路由准确率</span>
        </label>
        <textarea
          className={styles['form-textarea']}
          value={value.whenToUse}
          onChange={(e) => onChange({ whenToUse: e.target.value })}
          placeholder={isCreate ? '例："用户想要写代码、调试或重构时"' : '用户视角描述。例："用户想要写代码、调试或重构时"'}
          rows={2}
        />
      </div>

      <div className={styles['form-field']}>
        <label className={styles['form-label']}>触发例子 (triggerExamples)</label>
        <textarea
          className={styles['form-textarea']}
          value={value.triggerExamples}
          onChange={(e) => onChange({ triggerExamples: e.target.value })}
          placeholder={
            isCreate
              ? '每行一个用户可能说的原话，例如：\n帮我写个函数\n这段代码有 bug'
              : '用户可能说的原话，每行一句。例如：\n帮我写个函数\n这段代码有 bug'
          }
          rows={3}
        />
        {!isCreate && <div className={styles['form-hint']}>每行一个例子，建议 3-10 条。</div>}
      </div>

      <div className={styles['form-field']}>
        <label className={styles['form-label']}>绑定技能 (bundledSkills)</label>
        <textarea
          className={styles['form-textarea']}
          value={value.bundledSkills}
          onChange={(e) => onChange({ bundledSkills: e.target.value })}
          placeholder={'技能 ID 列表，每行一个。例如：\ncode-review\ntranslate'}
          rows={3}
        />
        <div className={styles['form-hint']}>
          {isCreate
            ? 'Agent 启动时自动激活这些技能（"Agent = 能力包"模式）'
            : 'Agent 启动时自动激活这些技能，无需再 skill_search。'}
        </div>
      </div>
    </>
  )
}
