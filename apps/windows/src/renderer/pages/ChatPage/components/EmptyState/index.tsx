import React, { useMemo, useState } from 'react'
import { Bot } from 'lucide-react'
import { ALL_SCENARIOS, pickRandom } from '../../../../data/preset-scenarios'
import { ScenarioBrowser } from '../../../../components/ScenarioBrowser'
import styles from './EmptyState.module.css'

interface EmptyStateProps {
  onSuggestionClick?: (suggestion: string) => void
}

const EmptyState: React.FC<EmptyStateProps> = ({ onSuggestionClick }) => {
  const displayed = useMemo(() => pickRandom(ALL_SCENARIOS, 6), [])
  const [browserOpen, setBrowserOpen] = useState(false)

  return (
    <div className={styles['empty-state']}>
      <div className={styles['empty-icon-large']}>
        <Bot size={40} strokeWidth={1.5} />
      </div>
      <h3 className={styles['empty-title']}>有什么我可以帮你的？</h3>
      <p className={styles['empty-description']}>
        选择一个场景快速开始，或直接输入你的需求
      </p>

      <div className={styles['empty-suggestions']}>
        {displayed.map((item, index) => {
          const Icon = item.icon
          return (
            <button
              key={index}
              className={styles['suggestion-btn']}
              onClick={() => onSuggestionClick?.(item.prompt)}
              title={item.category}
            >
              <span className={styles['suggestion-icon']}>
                <Icon size={15} strokeWidth={1.8} />
              </span>
              <span className={styles['suggestion-text']}>{item.label}</span>
              <span className={styles['suggestion-category']}>{item.category}</span>
            </button>
          )
        })}
      </div>

      <button
        type="button"
        className={styles['more-btn']}
        onClick={() => setBrowserOpen(true)}
      >
        更多场景
      </button>

      <div className={styles['empty-shortcuts']}>
        <div className={styles['shortcut-hint']}>
          <kbd>Ctrl</kbd> + <kbd>N</kbd> <span>新建对话</span>
        </div>
        <div className={styles['shortcut-hint']}>
          <kbd>Enter</kbd> <span>发送消息</span>
        </div>
        <div className={styles['shortcut-hint']}>
          <kbd>/</kbd> <span>斜杠命令</span>
        </div>
      </div>

      <ScenarioBrowser
        open={browserOpen}
        onClose={() => setBrowserOpen(false)}
        onSelect={(scenario) => onSuggestionClick?.(scenario.prompt)}
      />
    </div>
  )
}

export { EmptyState }
