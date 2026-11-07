/**
 * UpdaterView - 软件更新组件（接入主进程 electron-updater）
 */

import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '../../../../renderer/components/ui/Button/Button'
import { Loading } from '../../../../renderer/components/ui/Loading/Loading'
import { useToast } from '../../../../renderer/components/ui/Toast/useToast'
import { readStoredSettings } from '../../../../renderer/hooks/business/useSettings'
import clsx from 'clsx'
import styles from './UpdaterView.module.css'

interface UpdaterViewProps {
  standalone?: boolean
}

/** 渲染层状态：把主进程 `not-available` 映射为 `up-to-date` */
type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'up-to-date'

interface UpdaterApiState {
  status: string
  currentVersion: string
  availableVersion?: string
  downloadProgress?: number
  error?: string
}

/**
 * 把主进程 UpdateState 映射到视图状态
 */
function mapApiState(state: UpdaterApiState): {
  status: UpdateStatus
  currentVersion: string
  latestVersion: string
  downloadProgress: number
  errorMessage: string
} {
  const statusMap: Record<string, UpdateStatus> = {
    idle: 'idle',
    checking: 'checking',
    available: 'available',
    'not-available': 'up-to-date',
    downloading: 'downloading',
    downloaded: 'downloaded',
    error: 'error',
  }
  return {
    status: statusMap[state.status] ?? 'idle',
    currentVersion: state.currentVersion || '',
    latestVersion: state.availableVersion || state.currentVersion || '',
    downloadProgress: Math.round(state.downloadProgress ?? 0),
    errorMessage: state.error || '',
  }
}

export const UpdaterView: React.FC<UpdaterViewProps> = ({ standalone = false }) => {
  const { success, error: toastError } = useToast()
  const [status, setStatus] = useState<UpdateStatus>('idle')
  const [currentVersion, setCurrentVersion] = useState<string>('')
  const [latestVersion, setLatestVersion] = useState<string>('')
  const [downloadProgress, setDownloadProgress] = useState<number>(0)
  const [errorMessage, setErrorMessage] = useState<string>('')

  /**
   * 应用主进程推送的更新状态
   */
  const applyState = useCallback((state: UpdaterApiState) => {
    const mapped = mapApiState(state)
    setStatus(mapped.status)
    setCurrentVersion(mapped.currentVersion)
    setLatestVersion(mapped.latestVersion)
    setDownloadProgress(mapped.downloadProgress)
    setErrorMessage(mapped.errorMessage)
  }, [])

  /**
   * 订阅更新状态，并同步「启动时检查更新」偏好到主进程
   */
  useEffect(() => {
    const api = window.electronAPI?.updater
    if (!api) {
      setStatus('error')
      setErrorMessage('更新服务不可用')
      return
    }

    let cancelled = false
    void api.getState().then((state) => {
      if (!cancelled) applyState(state as UpdaterApiState)
    })

    // 设置存在渲染层；进关于页时把偏好推给主进程，避免与插件默认值脱节
    const stored = readStoredSettings()
    if (typeof stored?.checkUpdateOnStartup === 'boolean') {
      void api.updateConfig({ autoCheck: stored.checkUpdateOnStartup }).then((cfg) => {
        if (cancelled) return
        if (cfg.autoCheck) api.startAutoCheck()
        else api.stopAutoCheck()
      })
    }

    const unsubscribe = api.onStateChange((state) => {
      applyState(state as UpdaterApiState)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [applyState])

  /**
   * 检查更新
   */
  const handleCheckUpdate = useCallback(async () => {
    const api = window.electronAPI?.updater
    if (!api) {
      setStatus('error')
      setErrorMessage('更新服务不可用')
      return
    }

    setStatus('checking')
    setErrorMessage('')

    try {
      const state = (await api.checkForUpdates()) as UpdaterApiState
      applyState(state)
      if (state.status === 'not-available') {
        success('当前已是最新版本')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '检查更新失败'
      setStatus('error')
      setErrorMessage(message)
      toastError(message)
    }
  }, [applyState, success, toastError])

  /**
   * 下载更新
   */
  const handleDownloadUpdate = useCallback(async () => {
    const api = window.electronAPI?.updater
    if (!api) {
      setStatus('error')
      setErrorMessage('更新服务不可用')
      return
    }

    setStatus('downloading')
    setDownloadProgress(0)

    try {
      const state = (await api.downloadUpdate()) as UpdaterApiState
      applyState(state)
    } catch (err) {
      const message = err instanceof Error ? err.message : '下载失败'
      setStatus('error')
      setErrorMessage(message)
      toastError(message)
    }
  }, [applyState, toastError])

  /**
   * 安装更新并重启
   */
  const handleInstallUpdate = useCallback(() => {
    const api = window.electronAPI?.updater
    if (!api) {
      toastError('更新服务不可用')
      return
    }
    success('正在安装更新并重启…')
    api.installUpdate()
  }, [success, toastError])

  return (
    <div className={clsx(styles['updater-view'], standalone && styles['standalone'])}>
      <div className={styles['updater-info']}>
        <div className={styles['version-info']}>
          <span className={styles['version-label']}>当前版本</span>
          <span className={styles['version-value']}>{currentVersion || '—'}</span>
        </div>

        {latestVersion && status !== 'idle' && status !== 'checking' && (
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
          <p className={clsx(styles['status-text'], styles['success'])}>已是最新版本</p>
        )}

        {status === 'available' && (
          <p className={clsx(styles['status-text'], styles['info'])}>
            发现新版本 {latestVersion}
          </p>
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
          <p className={clsx(styles['status-text'], styles['success'])}>更新已下载，可以安装</p>
        )}

        {status === 'error' && (
          <p className={clsx(styles['status-text'], styles['error'])}>{errorMessage || '更新失败'}</p>
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
          <Button onClick={handleDownloadUpdate}>下载更新</Button>
        )}

        {status === 'downloaded' && (
          <Button onClick={handleInstallUpdate}>安装并重启</Button>
        )}
      </div>
    </div>
  )
}
