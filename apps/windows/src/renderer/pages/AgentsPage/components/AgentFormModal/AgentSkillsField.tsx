import React from 'react'
import clsx from 'clsx'
import styles from '../AgentsPage.module.css'
import type { AgentFormData, UserSkill } from '../../AgentsPage.types'

export interface AgentSkillsFieldProps {
  value: Pick<AgentFormData, 'selectedSkills'>
  onChange: (patch: Partial<AgentFormData>) => void
  userSkills: UserSkill[]
  mode: 'edit' | 'create'
  /** 编辑模式专用：关闭编辑 Modal 并跳转技能商店时调用 */
  onNavigateToStoreAndClose?: (skillName: string) => void
}

/** 专属技能勾选列表；编辑模式额外展示"本机缺少技能"警告块 */
export const AgentSkillsField: React.FC<AgentSkillsFieldProps> = ({
  value,
  onChange,
  userSkills,
  mode,
  onNavigateToStoreAndClose,
}) => {
  const missing = React.useMemo(() => {
    if (mode !== 'edit') return []
    const localSkillNames = new Set(userSkills.map((s) => s.name))
    return value.selectedSkills.filter((name) => !localSkillNames.has(name))
  }, [mode, userSkills, value.selectedSkills])

  const toggleSkill = (skillName: string, checked: boolean) => {
    const next = checked
      ? value.selectedSkills.filter((s) => s !== skillName)
      : [...value.selectedSkills, skillName]
    onChange({ selectedSkills: next })
  }

  return (
    <div className={styles['form-field']}>
      <label className={styles['form-label']}>
        专属技能
        <span className={styles['form-hint-inline']}>
          {mode === 'edit' ? '为 Agent 配备自定义技能' : '选择这个 Agent 可以使用哪些功能'}
        </span>
      </label>
      {mode === 'edit' && missing.length > 0 && (
        <div className={styles['skill-missing-warning']}>
          <span className={styles['skill-missing-title']}>
            ⚠ 本机缺少以下技能，Agent 在此设备上将无法使用它们
          </span>
          <div className={styles['skill-missing-list']}>
            {missing.map((name) => (
              <span key={name} className={styles['skill-missing-item']}>· {name}</span>
            ))}
          </div>
          <div className={styles['skill-missing-actions']}>
            <span className={styles['skill-missing-hint']}>
              前往技能商店搜索并安装，或从原始设备导出后导入。
            </span>
            <button
              type="button"
              className={styles['skill-missing-btn']}
              onClick={() => onNavigateToStoreAndClose?.(missing[0])}
            >
              🏪 去商店下载
            </button>
          </div>
        </div>
      )}
      {userSkills.length === 0 ? (
        <div className={styles['skill-empty-hint']}>暂无自定义技能，可在技能页面创建</div>
      ) : (
        <div className={styles['skill-list']}>
          {userSkills.map((skill) => {
            const checked = value.selectedSkills.includes(skill.name)
            return (
              <label
                key={skill.id}
                className={clsx(styles['skill-item'], checked && styles['skill-item--checked'])}
              >
                <input
                  type="checkbox"
                  className={styles['skill-checkbox']}
                  checked={checked}
                  onChange={() => toggleSkill(skill.name, checked)}
                />
                <div className={styles['skill-info']}>
                  <span className={styles['skill-name']}>{skill.name}</span>
                  {skill.description && (
                    <span className={styles['skill-desc']}>{skill.description}</span>
                  )}
                </div>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}
