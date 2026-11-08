import React from 'react'
import clsx from 'clsx'
import styles from './Loading.module.css'

type LoadingSize = 'sm' | 'md' | 'lg'

interface LoadingProps {
  size?: LoadingSize
  text?: string
  className?: string
}

/**
 * 双环仪式加载：外青内琥珀反向旋转，中心呼吸光点。
 * 减少动效偏好下停转动画，只保留静态环。
 */
const Loading: React.FC<LoadingProps> = ({ size = 'md', text, className = '' }) => {
  return (
    <div
      className={clsx(styles.loading, styles[`loading-${size}`], className)}
      role="status"
      aria-live="polite"
      aria-label={text || '加载中'}
    >
      <div className={styles['loading-orbit']} aria-hidden>
        <span className={styles['loading-ring']} />
        <span className={clsx(styles['loading-ring'], styles['loading-ring-inner'])} />
        <span className={styles['loading-core']} />
      </div>
      {text && <span className={styles['loading-text']}>{text}</span>}
    </div>
  )
}

export { Loading }
export default Loading
