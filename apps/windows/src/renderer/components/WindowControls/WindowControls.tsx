/**
 * WindowControls Component - 窗口控制按钮
 *
 * 提供最小化、最大化、关闭按钮
 */

import React from 'react'
import styles from './WindowControls.module.css'

export const WindowControls: React.FC = () => {
  const handleMinimize = () => {
    window.electronAPI.window.minimize()
  }

  const handleMaximize = () => {
    window.electronAPI.window.maximize()
  }

  const handleClose = () => {
    window.electronAPI.window.close()
  }

  return (
    <div className={styles['window-controls']}>
      <button
        className={styles['window-control-button']}
        onClick={handleMinimize}
        title="最小化"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <path d="M0 5h10v1H0z" />
        </svg>
      </button>

      <button
        className={styles['window-control-button']}
        onClick={handleMaximize}
        title="最大化"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <path d="M0 0v10h10V0H0zm1 1h8v8H1V1z" />
        </svg>
      </button>

      <button
        className={`${styles['window-control-button']} ${styles['close-button']}`}
        onClick={handleClose}
        title="关闭"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <path d="M1.41 0L5 3.59 8.59 0 10 1.41 6.41 5 10 8.59 8.59 10 5 6.41 1.41 10 0 8.59 3.59 5 0 1.41z" />
        </svg>
      </button>
    </div>
  )
}
