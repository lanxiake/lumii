import React, { useCallback, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import styles from './InterruptBanner.module.css'

interface InterruptBannerProps {
  sessionKey: string
  onContinue: (sessionKey: string) => Promise<void>
  onDismiss: (sessionKey: string) => void
}

const InterruptBanner: React.FC<InterruptBannerProps> = ({ sessionKey, onContinue, onDismiss }) => {
  const [loading, setLoading] = useState(false)

  const handleContinue = useCallback(async () => {
    setLoading(true)
    try {
      await onContinue(sessionKey)
    } finally {
      setLoading(false)
    }
  }, [sessionKey, onContinue])

  const handleDismiss = useCallback(() => {
    onDismiss(sessionKey)
  }, [sessionKey, onDismiss])

  return (
    <div className={styles.banner} role="alert">
      <span className={styles.icon}>
        <AlertTriangle size={16} strokeWidth={2} />
      </span>
      <span className={styles.text}>
        上次对话被中断，Agent 可能有未完成的任务。
      </span>
      <div className={styles.actions}>
        <button
          className={styles.btnContinue}
          onClick={handleContinue}
          disabled={loading}
        >
          {loading ? '恢复中...' : '继续任务'}
        </button>
        <button
          className={styles.btnDismiss}
          onClick={handleDismiss}
        >
          忽略
        </button>
      </div>
    </div>
  )
}

export { InterruptBanner }
export default InterruptBanner
