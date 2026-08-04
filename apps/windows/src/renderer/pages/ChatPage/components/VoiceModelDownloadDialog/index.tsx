/**
 * 语音模型下载对话框
 * 首次使用语音通话时，引导用户下载所需模型
 */
import React, { useEffect, useState, useCallback } from 'react'
import styles from './VoiceModelDownloadDialog.module.css'

interface ModelInfo {
  id: string
  name: string
  sizeBytes: number
  downloaded: boolean
}

interface DownloadProgress {
  progress: number
  bytesDownloaded: number
  totalBytes: number
}

interface VoiceModelDownloadDialogProps {
  models: ModelInfo[]
  onClose: () => void
  onAllReady: () => void
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function VoiceModelDownloadDialog({
  models: initialModels,
  onClose,
  onAllReady,
}: VoiceModelDownloadDialogProps) {
  const [models, setModels] = useState<ModelInfo[]>(initialModels)
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({})
  const [downloading, setDownloading] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})

  const pendingModels = models.filter((m) => !m.downloaded)

  // 订阅下载进度事件
  useEffect(() => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice?.onEvent) return

    const unsubscribe = electronAPI.voice.onEvent((event: any) => {
      if (event.type === 'voice:models:progress') {
        setProgress((prev) => ({
          ...prev,
          [event.modelId]: {
            progress: event.progress,
            bytesDownloaded: event.bytesDownloaded,
            totalBytes: event.totalBytes,
          },
        }))
        if (event.progress >= 1) {
          setDownloading((prev) => {
            const next = new Set(prev)
            next.delete(event.modelId)
            return next
          })
        }
      }
      if (event.type === 'voice:models:status') {
        setModels(event.models)
      }
      if (event.type === 'voice:models:error') {
        setErrors((prev) => ({ ...prev, [event.modelId]: event.message ?? '下载失败' }))
        setDownloading((prev) => {
          const next = new Set(prev)
          next.delete(event.modelId)
          return next
        })
      }
    })

    return unsubscribe
  }, [])

  // 检查是否全部就绪
  useEffect(() => {
    if (models.length > 0 && models.every((m) => m.downloaded)) {
      onAllReady()
    }
  }, [models, onAllReady])

  const downloadAll = useCallback(async () => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice) return

    for (const model of pendingModels) {
      if (downloading.has(model.id)) continue
      setDownloading((prev) => new Set(prev).add(model.id))
      setErrors((prev) => {
        const next = { ...prev }
        delete next[model.id]
        return next
      })
      try {
        const result = await electronAPI.voice.sendCommand({
          type: 'voice:models:download',
          modelId: model.id,
        })
        if (result?.error) {
          setErrors((prev) => ({ ...prev, [model.id]: result.error }))
          setDownloading((prev) => {
            const next = new Set(prev)
            next.delete(model.id)
            return next
          })
        }
      } catch (e) {
        setErrors((prev) => ({ ...prev, [model.id]: (e as Error).message }))
        setDownloading((prev) => {
          const next = new Set(prev)
          next.delete(model.id)
          return next
        })
      }
    }
  }, [pendingModels, downloading])

  const isAllDownloading = pendingModels.every((m) => downloading.has(m.id))

  return (
    <div className={styles.overlay}>
      <div className={styles.dialog}>
        <div className={styles.header}>
          <span className={styles.icon}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V23h2v-2.06A9 9 0 0 0 21 12v-2h-2z" />
            </svg>
          </span>
          <h3 className={styles.title}>首次使用语音通话</h3>
        </div>

        <p className={styles.desc}>需要下载本地 AI 语音模型（约 350MB），下载完成后可在本地离线运行，无需联网。</p>

        <div className={styles.modelList}>
          {models.map((model) => {
            const prog = progress[model.id]
            const isDownloading = downloading.has(model.id)
            const hasError = errors[model.id]

            return (
              <div key={model.id} className={styles.modelItem}>
                <div className={styles.modelInfo}>
                  <span className={styles.modelName}>{model.name}</span>
                  <span className={styles.modelSize}>{formatBytes(model.sizeBytes)}</span>
                </div>

                {model.downloaded ? (
                  <div className={styles.statusReady}>✓ 已就绪</div>
                ) : isDownloading ? (
                  <div className={styles.progressArea}>
                    <div className={styles.progressBar}>
                      <div
                        className={styles.progressFill}
                        style={{ width: `${((prog?.progress ?? 0) * 100).toFixed(0)}%` }}
                      />
                    </div>
                    <span className={styles.progressText}>
                      {prog
                        ? `${formatBytes(prog.bytesDownloaded)} / ${formatBytes(prog.totalBytes || model.sizeBytes)}`
                        : '准备中...'}
                    </span>
                  </div>
                ) : hasError ? (
                  <div className={styles.statusError}>{hasError}</div>
                ) : (
                  <div className={styles.statusPending}>待下载</div>
                )}
              </div>
            )
          })}
        </div>

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onClose}>
            稍后再说
          </button>
          <button
            className={styles.downloadBtn}
            onClick={downloadAll}
            disabled={isAllDownloading || pendingModels.length === 0}
          >
            {isAllDownloading ? '下载中...' : `下载全部（${formatBytes(pendingModels.reduce((s, m) => s + m.sizeBytes, 0))}）`}
          </button>
        </div>
      </div>
    </div>
  )
}
