/**
 * UpdaterView - 软件更新组件
 */

import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '../../ui/Button/Button'
import { Loading } from '../../ui/Loading/Loading'
import { useToast } from '../../ui/Toast/useToast'
import clsx from 'clsx'
import styles from './UpdaterView.module.css'

interface UpdaterViewProps {
  standalone?: boolean
}

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'up-to-date'

export const UpdaterView: React.FC<UpdaterViewProps> = ({ standalone = false }) => {
  const { success } = useToast()
  const [status, setStatus] = useState<UpdateStatus>('idle')
  const [currentVersion, setCurrentVersion] = useState<string>('0.1.3')
  const [latestVersion, setLatestVersion] = useState<string>('')
  const [downloadProgress, setDownloadProgress] = useState<number>(0)
  const [errorMessage, setErrorMessage] = useState<string>('')

  /**
   * 获取当前版本
   */
  useEffect(() => {
    window.electronAPI.app.getVersion().then(setCurrentVersion).catch(() => {
      console.warn('[UpdaterView] 获取版本失败')
    })
  }, [])

  /**
   * 检查更新
   */
  const handleCheckUpdate = useCallback(async () => {
    setStatus('checking')
    setErrorMessage('')

    try {
      // TODO: 实现更新检查逻辑
      await new Promise(resolve => setTimeout(resolve, 2000))
      
      // 模拟：无可用更新
      setStatus('up-to-date')
      setLatestVersion(currentVersion)
    } catch (err) {
      setStatus('error')
      setErrorMessage(err instanceof Error ? err.message : '检查更新失败')
    }
  }, [currentVersion])

  /**
   * 下载更新
   */
  const handleDownloadUpdate = useCallback(async () => {
    setStatus('downloading')
    setDownloadProgress(0)

    try {
      // TODO: 实现下载逻辑
      for (let i = 0; i <= 100; i += 10) {
        await new Promise(resolve => setTimeout(resolve, 200))
        setDownloadProgress(i)
      }
      setStatus('downloaded')
    } catch (err) {
      setStatus('error')
      setErrorMessage(err instanceof Error ? err.message : '下载失败')
    }
  }, [])

  /**
   * 安装更新
   */
  const handleInstallUpdate = useCallback(() => {
    // TODO: 实现安装逻辑
    success('将在退出应用后安装更新')
  }, [success])

  return (
    <div className={clsx(styles['updater-view'], standalone && styles['standalone'])}>
      <div className={styles['updater-info']}>
        <div className={styles['version-info']}>
          <span className={styles['version-label']}>当前版本</span>
          <span className={styles['version-value']}>{currentVersion}</span>
        </div>

        {latestVersion && status !== 'idle' && (
          <div className={styles['version-info']}>
            <span className={styles['version-label']}>最新版本</span>
            <span className={styles['version-value']}>{latestVersion}</span>
          </div>
        )}
      </div>

      <div className={styles['updater-status']}>
        {status === 'idle' && (
          <p className={styles['status-text']}>点击下方按钮检查更新</p>
        )}

        {status === 'checking' && (
          <div className={styles['status-loading']}>
            <Loading text="正在检查更新..." />
          </div>
        )}

        {status === 'up-to-date' && (
          <p className={clsx(styles['status-text'], styles['success'])}>✅ 已是最新版本</p>
        )}

        {status === 'available' && (
          <p className={clsx(styles['status-text'], styles['info'])}>🎉 发现新版本 {latestVersion}</p>
        )}

        {status === 'downloading' && (
          <div className={styles['download-progress']}>
            <p className={styles['status-text']}>正在下载更新...</p>
            <div className={styles['progress-bar']}>
              <div className={styles['progress-fill']} style={{ width: `${downloadProgress}%` }} />
            </div>
            <span className={styles['progress-text']}>{downloadProgress}%</span>
          </div>
        )}

        {status === 'downloaded' && (
          <p className={clsx(styles['status-text'], styles['success'])}>✅ 更新已下载，可以安装</p>
        )}

        {status === 'error' && (
          <p className={clsx(styles['status-text'], styles['error'])}>❌ {errorMessage}</p>
        )}
      </div>

      <div className={styles['updater-actions']}>
        {(status === 'idle' ||
          status === 'up-to-date' ||
          status === 'error' ||
          status === 'checking') && (
          <Button onClick={handleCheckUpdate} loading={status === 'checking'}>
            检查更新
          </Button>
        )}

        {status === 'available' && (
          <Button onClick={handleDownloadUpdate}>
            下载更新
          </Button>
        )}

        {status === 'downloaded' && (
          <Button onClick={handleInstallUpdate}>
            安装并重启
          </Button>
        )}
      </div>
    </div>
  )
}

export default UpdaterView
