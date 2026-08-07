/**
 * 语音模型下载面板：按「识别 / 合成 / 克隆」分区，显示速度与新手引导
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
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

const GROUP_META: Record<string, { title: string; hint: string }> = {
  'asr-core': {
    title: '① 基础识别（通话听懂你说话）',
    hint: '建议先下载 VAD + ASR。仅用 Edge TTS 出声时，这两项仍建议下载以便语音通话。',
  },
  'tts-synth': {
    title: '② 语音合成（出声，无需声音克隆）',
    hint: 'VITS 或 Qwen3 CustomVoice 二选一即可本地出声。Qwen3 请先下 Tokenizer，再下 CustomVoice（内置北京话/四川话等音色）。',
  },
  'tts-clone': {
    title: '③ 声音克隆（可选，非必须）',
    hint: '只有需要「用自己的声音说话」时才下载 Base 模型，并在下方「声音克隆」区创建音色。普通合成请用上一区的 CustomVoice。',
  },
}

/**
 * 推断模型分组（兼容旧状态无 group 字段）
 */
function resolveGroup(m: VoiceModelStatus): string {
  if (m.group) return m.group
  if (m.id === 'vad' || m.id.startsWith('asr-')) return 'asr-core'
  if (m.id.includes('base')) return 'tts-clone'
  return 'tts-synth'
}

/**
 * 语音模型本地下载管理 UI
 */
export function VoiceModelsPanel(): React.ReactElement {
  const [models, setModels] = useState<VoiceModelStatus[]>([])
  const [progress, setProgress] = useState<Record<string, ProgressInfo>>({})
  const [loading, setLoading] = useState(true)
  const [guideOpen, setGuideOpen] = useState(true)

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
            bytesPerSecond: event.bytesPerSecond,
          },
        }))
        if (event.state === 'ready' || event.state === 'paused' || event.progress >= 1) {
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

  const grouped = useMemo(() => {
    const order = ['asr-core', 'tts-synth', 'tts-clone']
    const map = new Map<string, VoiceModelStatus[]>()
    for (const g of order) map.set(g, [])
    for (const m of models) {
      const g = resolveGroup(m)
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(m)
    }
    return order.map((id) => ({ id, models: map.get(id) || [] })).filter((x) => x.models.length > 0)
  }, [models])

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

    return (
      <div key={m.id} className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <div className={styles.name}>{m.name}</div>
            <div className={styles.meta}>
              {formatBytes(m.sizeBytes)}
              {m.description ? ` · ${m.description}` : ''}
              {' · '}
              {m.downloaded
                ? '已就绪'
                : state === 'downloading'
                  ? `下载中 ${pct}%${speedText ? ` · ${speedText}` : ''}`
                  : state === 'paused'
                    ? `已暂停 ${pct}%（可继续）`
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
        {(state === 'downloading' || state === 'paused' || state === 'extracting') && !m.downloaded && (
          <div className={styles.progressWrap}>
            <div className={styles.progressBar}>
              <div className={styles.progressFill} style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
            <div className={styles.progressText}>
              {formatBytes(downloadedBytes)} / {formatBytes(totalBytes)}
              {speedText ? ` · ${speedText}` : ''}
              {state === 'paused' ? ' · 已暂停' : ''}
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
        <h4 className={styles.title}>语音模型</h4>
        <p className={styles.hint}>加载模型状态...</p>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <h4 className={styles.title}>语音模型下载</h4>

      <div className={styles.guide}>
        <button type="button" className={styles.guideToggle} onClick={() => setGuideOpen((v) => !v)}>
          {guideOpen ? '收起使用说明' : '展开使用说明（新手必读）'}
        </button>
        {guideOpen && (
          <ol className={styles.guideList}>
            <li>
              <strong>声音克隆不是必须的。</strong>
              日常对话出声：下载「② 语音合成」里的 VITS，或 Qwen3 Tokenizer + CustomVoice 即可。
            </li>
            <li>
              <strong>推荐路径（Qwen3 内置音色）</strong>：Tokenizer → 0.6B CustomVoice → 下方 TTS 选
              Qwen3 → 选说话人（含北京话 Dylan、四川话 Eric 等）→ 预览。
            </li>
            <li>
              <strong>可选：声音克隆</strong>：仅当你要用自己的声音时，再下「③ Base」并创建「我的音色」。
            </li>
            <li>
              <strong>最省事</strong>：不下本地 TTS，引擎选 Edge TTS（需联网）。
            </li>
          </ol>
        )}
      </div>

      <p className={styles.hint}>模型目录：用户数据根下 models/voice（默认 ~/.lumii）。国内优先魔搭。</p>

      {grouped.map((g) => {
        const meta = GROUP_META[g.id] || { title: g.id, hint: '' }
        return (
          <div key={g.id} className={styles.group}>
            <h5 className={styles.groupTitle}>{meta.title}</h5>
            {meta.hint && <p className={styles.groupHint}>{meta.hint}</p>}
            <div className={styles.list}>{g.models.map(renderCard)}</div>
          </div>
        )
      })}
    </div>
  )
}

export default VoiceModelsPanel
