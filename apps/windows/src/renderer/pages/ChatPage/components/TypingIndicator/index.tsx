import React from 'react'
import styles from './TypingIndicator.module.css'

interface TypingIndicatorProps {
  /** 可选文案，传入时在动点右侧展示（如「正在思考…」） */
  label?: string
}

const TypingIndicator: React.FC<TypingIndicatorProps> = ({ label }) => {
  return (
    <div className={styles['typing-indicator']}>
      <span className={styles['typing-dots']}>
        <span></span>
        <span></span>
        <span></span>
      </span>
      {label && <span className={styles['typing-label']}>{label}</span>}
    </div>
  )
}

export default TypingIndicator
export { TypingIndicator }
