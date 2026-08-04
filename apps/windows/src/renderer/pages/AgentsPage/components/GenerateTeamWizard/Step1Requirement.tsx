/**
 * Step1Requirement — 输入需求描述
 */

import React, { useState } from 'react'
import { QUICK_TEMPLATES } from './utils'
import type { QuickTemplate } from './types'
import styles from './GenerateTeamWizard.module.css'

interface Step1RequirementProps {
  initialRequirement?: string
  onNext: (requirement: string) => void
}

export const Step1Requirement: React.FC<Step1RequirementProps> = ({
  initialRequirement = '',
  onNext,
}) => {
  const [requirement, setRequirement] = useState(initialRequirement)

  const handleTemplateClick = (template: QuickTemplate) => {
    setRequirement(template.content)
  }

  return (
    <div className={styles.stepContainer}>
      <div className={styles.stepHeader}>
        <h3 className={styles.stepTitle}>描述你的团队需求</h3>
        <p className={styles.stepDesc}>告诉 AI 你想组建什么样的团队</p>
      </div>

      <div className={styles.stepContent}>
        <textarea
          className={styles.requirementTextarea}
          value={requirement}
          onChange={(e) => setRequirement(e.target.value)}
          placeholder={'例如：\n我需要一个软件开发团队，包含产品经理、前端工程师和测试工程师\n\n或者：\n帮我组建一个内容创作团队，负责公众号运营'}
          rows={6}
          autoFocus
        />

        <div className={styles.templateSection}>
          <div className={styles.templateTitle}>快速模板</div>
          <div className={styles.templateList}>
            {QUICK_TEMPLATES.map((t) => (
              <button
                key={t.id}
                className={styles.templateCard}
                onClick={() => handleTemplateClick(t)}
                type="button"
              >
                <span className={styles.templateCardTitle}>{t.label}</span>
                <span className={styles.templateCardDesc}>{t.description}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.stepFooter}>
        <span className={styles.stepIndicator}>1 / 3</span>
        <button
          className={styles.nextButton}
          onClick={() => onNext(requirement.trim())}
          disabled={!requirement.trim()}
        >
          下一步：让 AI 规划
        </button>
      </div>
    </div>
  )
}
