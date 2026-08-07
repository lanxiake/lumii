/**
 * 语音模型下载面板：VAD / ASR / TTS 分项下载，支持进度、暂停、继续、取消
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import type { VoiceModelDownloadState, VoiceModelStatus } from '../../../../../shared/voice-events'
import styles from './VoiceModelsPanel.module.css'

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

interface ProgressInfo {
  progress: number
  bytesDownloaded: number
  totalBytes: number
  state?: VoiceModelDownloadState
}

/**
 * 语音模型本地下载管理 UI
 */
export function VoiceModelsPanel(): React.ReactElement {
  const [models, setModels] = useState<VoiceModelStatus[]>([])
  const [progress, setProgress] = useState<Record<string, ProgressInfo>>({})
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const api = (window as any).electronAPI
    if (!api?.voice?.sendCommand) return
    try {
      const list = await api.voice.sendCommand({ type: 'voice:models:get' })
      if (Array.isArray(list)) setModels(list)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const api = (window as any).electronAPI
    if (!api?.voice?.onEvent) return
    const unsub = api.voice.onEvent((event: any) => {
      if (event.type === 'voice:models:status' && Array.isArray(event.models)) {
        setModels(event.models)
      }
      if (event.type === 'voice:models:progress') {
        setProgress((prev) => ({
          ...prev,
          [event.modelId]: {
            progress: event.progress,
            bytesDownloaded: event.bytesDownloaded,
            totalBytes: event.totalBytes,
            state: event.state,
          },
        }))
        if (event.state === 'ready' || event.progress >= 1) {
          void refresh()
        }
      }
      if (event.type === 'voice:models:error') {
        void refresh()
      }
    })
    return () => {
      if (typeof unsub === 'function') unsub()
    }
  }, [refresh])

  const send = async (type: string, modelId: string) => {
    const api = (window as any).electronAPI
    if (!api?.voice?.sendCommand) return
    await api.voice.sendCommand({ type, modelId })
    void refresh()
  }

  if (loading) {
    return (
      <div className={styles.panel}>
        <h4 className={styles.title}>语音模型</h4>
        <p className={styles.hint}>加载模型状态...</p>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <h4 className={styles.title}>语音模型</h4>
      <p className={styles.hint}>
        本地 VAD / ASR / TTS 模型可分别下载。支持暂停、取消与断点续传。使用 Edge TTS 时可不下载 TTS 模型。
      </p>
      <div className={styles.list}>
        {models.map((m) => {
          const p = progress[m.id]
          const state = (p?.state ?? m.downloadState ?? (m.downloaded ? 'ready' : 'idle')) as VoiceModelDownloadState
          const pct = m.downloaded
            ? 100
            : Math.round((p?.progress ?? (m.sizeBytes > 0 ? (m.downloadedBytes ?? 0) / m.sizeBytes : 0)) * 100)
          const downloadedBytes = p?.bytesDownloaded ?? m.downloadedBytes ?? 0
          const totalBytes = p?.totalBytes || m.sizeBytes

          return (
            <div key={m.id} className={styles.card}>
              <div className={styles.cardHead}>
                <div>
                  <div className={styles.name}>{m.name}</div>
                  <div className={styles.meta}>
                    {formatBytes(m.sizeBytes)}
                    {' · '}
                    {m.downloaded
                      ? '已就绪'
                      : state === 'downloading'
                        ? `下载中 ${pct}%`
                        : state === 'paused'
                          ? `已暂停 ${pct}%`
                          : state === 'extracting'
                            ? '解压中...'
                            : state === 'error'
                              ? m.errorMessage || '下载失败'
                              : '未下载'}
                  </div>
                </div>
                <div className={styles.actions}>
                  {m.downloaded ? (
                    <span className={styles.readyBadge}>就绪</span>
                  ) : state === 'downloading' || state === 'extracting' ? (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => void send('voice:models:pause', m.id)}>
                        暂停
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => void send('voice:models:cancel', m.id)}>
                        取消
                      </Button>
                    </>
                  ) : state === 'paused' ? (
                    <>
                      <Button variant="primary" size="sm" onClick={() => void send('voice:models:download', m.id)}>
                        继续
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => void send('voice:models:cancel', m.id)}>
                        取消
                      </Button>
                    </>
                  ) : (
                    <Button variant="primary" size="sm" onClick={() => void send('voice:models:download', m.id)}>
                      {state === 'error' ? '重试' : '下载'}
                    </Button>
                  )}
                </div>
              </div>
              {(state === 'downloading' || state === 'paused' || state === 'extracting') && (
                <div className={styles.progressWrap}>
                  <div className={styles.progressBar}>
                    <div className={styles.progressFill} style={{ width: `${Math.min(100, pct)}%` }} />
                  </div>
                  <div className={styles.progressText}>
                    {formatBytes(downloadedBytes)} / {formatBytes(totalBytes)}
                  </div>
                </div>
              )}
              {state === 'error' && m.errorMessage && (
                <p className={styles.error}>{m.errorMessage}</p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default VoiceModelsPanel
