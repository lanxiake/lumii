/**
 * 语音模型下载面板（可按分组嵌入「识别 / 合成 / 克隆」各区块）
 * 支持下载 / 暂停 / 取消 / 卸载已就绪项。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { ConfirmModal } from '../../../../components/ui/Modal/ConfirmModal'
import type { VoiceModelDownloadState, VoiceModelStatus } from '../../../../../shared/voice-events'
import styles from './VoiceModelsPanel.module.css'

/**
 * 格式化字节大小
 */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * 格式化下载速度
 */
function formatSpeed(bytesPerSecond?: number): string {
  if (bytesPerSecond == null || bytesPerSecond <= 0) return ''
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`
  return `${(bytesPerSecond / 1024 / 1024).toFixed(2)} MB/s`
}

interface ProgressInfo {
  progress: number
  bytesDownloaded: number
  totalBytes: number
  state?: VoiceModelDownloadState
  bytesPerSecond?: number
}

/** 分组 ID */
export type VoiceModelGroupId = 'asr-core' | 'tts-synth' | 'tts-clone'

export interface VoiceModelsPanelProps {
  /** 只展示这些分组；不传则展示全部 */
  groups?: VoiceModelGroupId[]
  /** 是否显示顶部总说明（整页总览时用；分区内一般关闭） */
  showGuide?: boolean
  /** 区块内标题，如「下载模型」；传空则不显示外层大标题 */
  title?: string
  /** 区块内简短说明 */
  hint?: string
}

/**
 * 推断模型分组（兼容旧状态无 group 字段）
 */
function resolveGroup(m: VoiceModelStatus): VoiceModelGroupId {
  if (m.group === 'asr-core' || m.group === 'tts-synth' || m.group === 'tts-clone') {
    return m.group
  }
  const id = m.id || ''
  if (id === 'vad' || id.startsWith('asr-')) return 'asr-core'
  if (id.includes('-base') || id.endsWith('base')) return 'tts-clone'
  if (id.includes('custom') || id.includes('tokenizer') || id.includes('vits') || id.startsWith('runtime-'))
    return 'tts-synth'
  return 'tts-synth'
}

/**
 * 语音模型本地下载管理 UI
 */
export function VoiceModelsPanel({
  groups,
  showGuide = false,
  title = '模型下载',
  hint,
}: VoiceModelsPanelProps = {}): React.ReactElement {
  const [models, setModels] = useState<VoiceModelStatus[]>([])
  const [progress, setProgress] = useState<Record<string, ProgressInfo>>({})
  const [loading, setLoading] = useState(true)
  const [guideOpen, setGuideOpen] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  /** 正在卸载的 modelId */
  const [uninstallingId, setUninstallingId] = useState<string | null>(null)
  /** 待确认卸载的模型 */
  const [confirmUninstall, setConfirmUninstall] = useState<VoiceModelStatus | null>(null)

  const refresh = useCallback(async () => {
    const api = (window as any).electronAPI
    if (!api?.voice?.sendCommand) return
    try {
      const list = await api.voice.sendCommand({ type: 'voice:models:get' })
      if (Array.isArray(list)) setModels(list as VoiceModelStatus[])
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
            bytesPerSecond: event.bytesPerSecond,
          },
        }))
        if (event.state === 'ready' || event.state === 'paused' || event.progress >= 1) {
          void refresh()
        }
        if (event.state === 'ready') {
          setLastError(null)
        }
      }
      if (event.type === 'voice:models:error') {
        setLastError(
          `${event.modelId ? `[${event.modelId}] ` : ''}${event.message || '下载失败'}`,
        )
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

  /**
   * 执行模型/运行时卸载
   */
  const doUninstall = async (model: VoiceModelStatus) => {
    const api = (window as any).electronAPI
    if (!api?.voice?.sendCommand) return
    setUninstallingId(model.id)
    setLastError(null)
    try {
      const result = await api.voice.sendCommand({
        type: 'voice:models:uninstall',
        modelId: model.id,
      })
      if (result?.ok === false) {
        setLastError(
          `${model.name}：${result.error || '卸载失败'}`,
        )
      }
    } catch (e) {
      setLastError(`${model.name}：${(e as Error).message || '卸载失败'}`)
    } finally {
      setUninstallingId(null)
      void refresh()
    }
  }

  const filtered = useMemo(() => {
    const allow = groups && groups.length > 0 ? new Set(groups) : null
    return models.filter((m) => {
      const g = resolveGroup(m)
      return allow ? allow.has(g) : true
    })
  }, [models, groups])

  /**
   * 渲染单个模型卡片
   */
  const renderCard = (m: VoiceModelStatus) => {
    const p = progress[m.id]
    const state = (p?.state ?? m.downloadState ?? (m.downloaded ? 'ready' : 'idle')) as VoiceModelDownloadState
    const rawProgress = m.downloaded
      ? 1
      : (p?.progress ?? (m.sizeBytes > 0 ? (m.downloadedBytes ?? 0) / m.sizeBytes : 0))
    const pct = Math.round(Math.min(m.downloaded ? 100 : 99, Math.max(0, rawProgress * 100)))
    const downloadedBytes = p?.bytesDownloaded ?? m.downloadedBytes ?? 0
    const totalBytes = p?.totalBytes || m.sizeBytes
    const speedText =
      state === 'downloading' ? formatSpeed(p?.bytesPerSecond ?? m.bytesPerSecond) : ''

    const isUninstalling = uninstallingId === m.id
    const statusLabel = isUninstalling
      ? '卸载中…'
      : m.downloaded
        ? '已就绪'
        : state === 'downloading'
          ? `下载中 ${pct}%`
          : state === 'paused'
            ? `已暂停 ${pct}%`
            : state === 'extracting'
              ? '解压/安装中…'
              : state === 'error'
                ? '失败'
                : '未下载'

    const badgeClass =
      m.downloaded || state === 'ready'
        ? styles.stateReady
        : state === 'downloading' || state === 'extracting'
          ? styles.stateDownloading
          : state === 'paused'
            ? styles.statePaused
            : state === 'error'
              ? styles.stateError
              : styles.stateIdle

    const cardClass = [
      styles.card,
      m.downloaded || state === 'ready'
        ? styles.cardReady
        : state === 'downloading' || state === 'extracting'
          ? styles.cardActive
          : state === 'error'
            ? styles.cardError
            : '',
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <div key={m.id} className={cardClass}>
        <div className={styles.cardHead}>
          <div>
            <div className={styles.name}>{m.name}</div>
            <div className={styles.meta}>
              {formatBytes(m.sizeBytes)}
              {m.description ? ` · ${m.description}` : ''}
            </div>
            <div className={styles.statusLine}>
              <span className={`${styles.stateBadge} ${badgeClass}`}>{statusLabel}</span>
              {!m.downloaded && state === 'downloading' && speedText ? (
                <span className={styles.statusLineMuted}> · {speedText}</span>
              ) : null}
              {!m.downloaded && state === 'paused' ? (
                <span className={styles.statusLineMuted}> · 可点「继续」恢复</span>
              ) : null}
              {!m.downloaded && state === 'idle' ? (
                <span className={styles.statusLineMuted}> · 点击右侧下载</span>
              ) : null}
            </div>
          </div>
          <div className={styles.actions}>
            {m.downloaded || isUninstalling ? (
              <>
                {!isUninstalling && <span className={styles.readyBadge}>就绪</span>}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={Boolean(uninstallingId)}
                  onClick={() => setConfirmUninstall(m)}
                >
                  {isUninstalling ? '卸载中…' : '卸载'}
                </Button>
              </>
            ) : state === 'downloading' ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={Boolean(uninstallingId)}
                  onClick={() => void send('voice:models:pause', m.id)}
                >
                  暂停
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={Boolean(uninstallingId)}
                  onClick={() => void send('voice:models:cancel', m.id)}
                >
                  取消
                </Button>
              </>
            ) : state === 'extracting' ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={Boolean(uninstallingId)}
                onClick={() => void send('voice:models:cancel', m.id)}
              >
                取消安装
              </Button>
            ) : state === 'paused' ? (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={Boolean(uninstallingId)}
                  onClick={() => void send('voice:models:download', m.id)}
                >
                  继续
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={Boolean(uninstallingId)}
                  onClick={() => void send('voice:models:cancel', m.id)}
                >
                  取消
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={Boolean(uninstallingId)}
                onClick={() => void send('voice:models:download', m.id)}
              >
                {state === 'error' ? '重试' : '下载'}
              </Button>
            )}
          </div>
        </div>
        {(state === 'downloading' || state === 'paused' || state === 'extracting') && !m.downloaded && (
          <div className={styles.progressWrap}>
            <div className={styles.progressBar}>
              <div className={styles.progressFill} style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
            <div className={styles.progressText}>
              {formatBytes(downloadedBytes)} / {formatBytes(totalBytes)}
              {speedText ? ` · ${speedText}` : ''}
              {state === 'paused' ? ' · 已暂停' : ''}
              {state === 'extracting' ? ' · 正在安装到内置 Python' : ''}
            </div>
          </div>
        )}
        {state === 'error' && m.errorMessage && <p className={styles.error}>{m.errorMessage}</p>}
      </div>
    )
  }

  if (loading) {
    return (
      <div className={styles.panel}>
        {title ? <h4 className={styles.title}>{title}</h4> : null}
        <p className={styles.hint}>加载模型状态...</p>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      {title ? <h4 className={styles.title}>{title}</h4> : null}
      {hint ? <p className={styles.hint}>{hint}</p> : null}
      {lastError ? <p className={styles.error}>下载出错：{lastError}</p> : null}

      {showGuide && (
        <div className={styles.guide}>
          <button type="button" className={styles.guideToggle} onClick={() => setGuideOpen((v) => !v)}>
            {guideOpen ? '收起总说明' : '展开总说明'}
          </button>
          {guideOpen && (
            <ol className={styles.guideList}>
              <li>语音识别、语音合成、声音克隆彼此独立，按需下载即可。</li>
              <li>日常出声：合成区下载 Tokenizer + CustomVoice，不必做声音克隆。</li>
            </ol>
          )}
        </div>
      )}

      {filtered.length === 0 ? (
        <p className={styles.hint}>暂无该分组的模型条目（请确认应用已更新到最新版本并重启）。</p>
      ) : (
        <div className={styles.list}>{filtered.map(renderCard)}</div>
      )}

      <ConfirmModal
        open={Boolean(confirmUninstall)}
        title="确认卸载"
        content={
          confirmUninstall
            ? `确定卸载「${confirmUninstall.name}」？将删除本地文件（运行时还会卸掉相关依赖），可稍后重新下载。`
            : ''
        }
        confirmText="卸载"
        cancelText="取消"
        confirmVariant="danger"
        onCancel={() => {
          if (!uninstallingId) setConfirmUninstall(null)
        }}
        onConfirm={() => {
          if (!confirmUninstall || uninstallingId) return
          const target = confirmUninstall
          setConfirmUninstall(null)
          void doUninstall(target)
        }}
      />
    </div>
  )
}

export default VoiceModelsPanel
