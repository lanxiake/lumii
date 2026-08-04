import React, { useEffect } from 'react'
import clsx from 'clsx'
import styles from './Toast.module.css'

interface ToastProps {
  message: string
  type?: 'success' | 'error' | 'info'
  duration?: number
  onClose: () => void
}

const Toast: React.FC<ToastProps> = ({
  message,
  type = 'info',
  duration = 2000,
  onClose,
}) => {
  useEffect(() => {
    const timer = setTimeout(onClose, duration)
    return () => clearTimeout(timer)
  }, [duration, onClose])

  const getIcon = () => {
    switch (type) {
      case 'success':
        return '✓'
      case 'error':
        return '✕'
      default:
        return 'ℹ'
    }
  }

  return (
    <div className={clsx(styles.toast, styles[`toast--${type}`])}>
      <span className={styles['toast-icon']}>{getIcon()}</span>
      <span className={styles['toast-message']}>{message}</span>
    </div>
  )
}

export default Toast
export { Toast }
