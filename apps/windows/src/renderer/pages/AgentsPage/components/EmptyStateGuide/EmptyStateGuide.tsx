/**
 * EmptyStateGuide — 无 Agent 时的引导卡片
 */

import React from 'react'
import { Bot, Sparkles } from 'lucide-react'
import styles from './EmptyStateGuide.module.css'

interface EmptyStateGuideProps {
  onGenerate: () => void
  onCreateBlank: () => void
}

export const EmptyStateGuide: React.FC<EmptyStateGuideProps> = ({ onGenerate, onCreateBlank }) => {
  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyIcon}><Bot size={48} /></div>
      <h3 className={styles.emptyTitle}>你还没有创建任何 AI 助手</h3>
      <p className={styles.emptyDesc}>
        让 AI 帮你快速组建一支专业团队，或者手动创建第一个 Agent
      </p>
      <div className={styles.emptyActions}>
        <button className={styles.generateButton} onClick={onGenerate} type="button">
          <Sparkles size={16} /> 让 AI 帮我创建第一个团队
        </button>
        <button className={styles.manualButton} onClick={onCreateBlank} type="button">
          手动创建 Agent
        </button>
      </div>
    </div>
  )
}
