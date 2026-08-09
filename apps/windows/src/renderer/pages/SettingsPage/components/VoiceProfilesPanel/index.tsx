/**
 * Qwen3 克隆音色档案管理面板（含麦克风朗读录制样本）
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { Input } from '../../../../components/ui/Input/Input'
import type { VoiceCloneProfile } from '../../../../../shared/voice-events'
import styles from '../VoiceModelsPanel/VoiceModelsPanel.module.css'
import {
  CLONE_REF_PROMPT_ZH,
  MAX_CLONE_RECORD_MS,
  MIN_CLONE_RECORD_MS,
  resolveCloneRefText,
  type CloneSampleSource,
} from './clone-ref-prompt'
import { arrayBufferToBase64, encodePcmToWav } from './encode-wav'
import { WaveformVisualizer } from '../../../ChatPage/components/VoiceCallPanel/WaveformVisualizer'

interface Props {
  /** 当前选中的克隆音色（用于高亮）；由父组件统一音色选择器传入 */
  selectedProfileId?: string
  /** 选中某条克隆音色（父组件负责写入 qwen3CloneEnabled + qwen3ProfileId） */
  onSelectProfile: (id: string | undefined) => void
  /** 试听某条克隆音色（走 override，不改全局配置） */
  onPreviewProfile?: (id: string) => void
  /** 是否有试听正在进行（禁用试听按钮） */
  previewing?: boolean
  /** 克隆 Base 模型是否就绪（未就绪时试听/选中禁用并提示下载） */
  cloneReady?: boolean
  disabled?: boolean
}

/**
 * 将一段 Float32 块 RMS 映射为 0–100 音量
 */
function pcmChunkLevel(chunk: Float32Array): number {
  let sum = 0
  for (let i = 0; i < chunk.length; i++) {
    const v = chunk[i]!
    sum += v * v
  }
  const rms = Math.sqrt(sum / Math.max(1, chunk.length))
  return Math.min(100, Math.round(rms * 280))
}

/**
 * 格式化录音时长 mm:ss
 */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * 列出 / 新建 / 删除克隆音色，并支持麦克风朗读录制参考样本
 */
export function VoiceProfilesPanel({
  selectedProfileId,
  onSelectProfile,
  onPreviewProfile,
  previewing,
  cloneReady = true,
  disabled,
}: Props): React.ReactElement {
  const [profiles, setProfiles] = useState<VoiceCloneProfile[]>([])
  const [name, setName] = useState('我的音色')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [refText, setRefText] = useState('')
  const [refPath, setRefPath] = useState('')
  const [sampleSource, setSampleSource] = useState<CloneSampleSource>('file')
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [micLevel, setMicLevel] = useState(0)
  const [waveAnalyser, setWaveAnalyser] = useState<AnalyserNode | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const startedAtRef = useRef(0)
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stoppingRef = useRef(false)
  const previewUrlRef = useRef<string | null>(null)
  const stopRecordingRef = useRef<(opts?: { skipMinCheck?: boolean }) => Promise<void>>(
    async () => undefined,
  )

  previewUrlRef.current = previewUrl

  const refresh = useCallback(async () => {
    const api = (window as any).electronAPI
    if (!api?.voice?.sendCommand) return
    const list = await api.voice.sendCommand({ type: 'voice:profiles:list' })
    if (Array.isArray(list)) setProfiles(list as VoiceCloneProfile[])
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  /**
   * 释放麦克风与 AudioContext
   */
  const teardownCapture = useCallback(() => {
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current)
      elapsedTimerRef.current = null
    }
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current)
      maxTimerRef.current = null
    }
    try {
      processorRef.current?.disconnect()
    } catch {
      /* ignore */
    }
    processorRef.current = null
    try {
      void audioCtxRef.current?.close()
    } catch {
      /* ignore */
    }
    audioCtxRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setMicLevel(0)
    setWaveAnalyser(null)
  }, [])

  useEffect(() => () => teardownCapture(), [teardownCapture])

  /**
   * 通过系统对话框选择参考音频
   */
  const pickAudio = async () => {
    const api = (window as any).electronAPI
    if (!api?.dialog?.showOpenDialog) {
      setError('当前环境不支持文件选择')
      return
    }
    try {
      const result = await api.dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a'] }],
      })
      const filePath = result?.filePaths?.[0]
      if (filePath) {
        setRefPath(filePath)
        setSampleSource('file')
        if (previewUrl) {
          URL.revokeObjectURL(previewUrl)
          setPreviewUrl(null)
        }
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /**
   * 停止录音：校验最短时长后编码 WAV 并写入临时文件
   */
  const stopRecording = useCallback(async (opts?: { skipMinCheck?: boolean }) => {
    if (stoppingRef.current) return
    stoppingRef.current = true
    setError(null)

    const elapsed = Date.now() - startedAtRef.current
    const chunks = chunksRef.current
    const sampleRate = audioCtxRef.current?.sampleRate ?? 48000
    teardownCapture()
    setRecording(false)
    setElapsedMs(elapsed)

    try {
      if (!opts?.skipMinCheck && elapsed < MIN_CLONE_RECORD_MS) {
        setError(`录音太短，请至少录制 ${Math.round(MIN_CLONE_RECORD_MS / 1000)} 秒`)
        chunksRef.current = []
        return
      }

      let total = 0
      for (const c of chunks) total += c.length
      if (total === 0) {
        setError('未采集到有效音频，请重试')
        return
      }
      const merged = new Float32Array(total)
      let offset = 0
      for (const c of chunks) {
        merged.set(c, offset)
        offset += c.length
      }
      chunksRef.current = []

      const wav = encodePcmToWav(merged, sampleRate)
      const blob = new Blob([wav], { type: 'audio/wav' })
      const prevUrl = previewUrlRef.current
      if (prevUrl) URL.revokeObjectURL(prevUrl)
      setPreviewUrl(URL.createObjectURL(blob))

      const api = (window as any).electronAPI
      if (!api?.voice?.sendCommand) {
        setError('语音接口不可用')
        return
      }
      setBusy(true)
      const res = await api.voice.sendCommand({
        type: 'voice:profiles:save-temp-ref',
        audioBase64: arrayBufferToBase64(wav),
        ext: 'wav',
      })
      if (res?.error || !res?.filePath) {
        setError(String(res?.error || '写入临时音频失败'))
        return
      }
      setRefPath(String(res.filePath))
      setRefText(CLONE_REF_PROMPT_ZH)
      setSampleSource('record')
    } catch (e) {
      const msg = (e as Error).message || '录音失败'
      if (/NotAllowedError|Permission denied|permission/i.test(msg)) {
        setError('麦克风权限被拒绝，请在系统设置中允许后重试')
      } else if (/NotFoundError|DevicesNotFound/i.test(msg)) {
        setError('未检测到麦克风')
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
      stoppingRef.current = false
    }
  }, [teardownCapture])

  stopRecordingRef.current = stopRecording

  /**
   * 开始麦克风录制
   */
  const startRecording = async () => {
    setError(null)
    if (recording || busy || disabled) return
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('当前环境不支持麦克风录音')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      })
      streamRef.current = stream
      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx
      if (audioCtx.state === 'suspended') await audioCtx.resume()

      const source = audioCtx.createMediaStreamSource(stream)
      const processor = audioCtx.createScriptProcessor(4096, 1, 1)
      processorRef.current = processor
      chunksRef.current = []
      processor.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0)
        chunksRef.current.push(new Float32Array(input))
        setMicLevel(pcmChunkLevel(input))
      }
      const mute = audioCtx.createGain()
      mute.gain.value = 0
      source.connect(processor)
      processor.connect(mute)
      mute.connect(audioCtx.destination)

      // 波形可视化 analyser（旁路，不影响录音数据）
      const waveNode = audioCtx.createAnalyser()
      source.connect(waveNode)
      setWaveAnalyser(waveNode)

      startedAtRef.current = Date.now()
      setElapsedMs(0)
      setRecording(true)
      elapsedTimerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startedAtRef.current)
      }, 200)
      maxTimerRef.current = setTimeout(() => {
        void stopRecordingRef.current()
      }, MAX_CLONE_RECORD_MS)
    } catch (e) {
      teardownCapture()
      setRecording(false)
      const msg = (e as Error).message || '无法访问麦克风'
      if (/NotAllowedError|Permission denied|permission/i.test(msg)) {
        setError('麦克风权限被拒绝，请在系统设置中允许后重试')
      } else if (/NotFoundError|DevicesNotFound/i.test(msg)) {
        setError('未检测到麦克风')
      } else if (/NotReadableError|Could not start/i.test(msg)) {
        setError('麦克风被占用，请先结束语音通话或其他录音后再试')
      } else {
        setError(msg)
      }
    }
  }

  /**
   * 预听最近一次录制
   */
  const playPreview = () => {
    if (!previewUrl) return
    const audio = new Audio(previewUrl)
    void audio.play().catch((e) => setError((e as Error).message))
  }

  /**
   * 清空录制结果并准备重录
   */
  const clearRecordingSample = () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl)
      setPreviewUrl(null)
    }
    if (sampleSource === 'record') {
      setRefPath('')
      setRefText('')
      setSampleSource('file')
    }
    setElapsedMs(0)
  }

  /**
   * 保存新档案
   */
  const handleCreate = async () => {
    setError(null)
    if (!refPath) {
      setError('请先选择参考音频或完成麦克风录制（建议 ≥3 秒）')
      return
    }
    const text = resolveCloneRefText(sampleSource, refText)
    if (!text) {
      setError('请填写参考音频对应的转写文本')
      return
    }
    const api = (window as any).electronAPI
    if (!api?.voice?.sendCommand) return
    setBusy(true)
    try {
      const res = await api.voice.sendCommand({
        type: 'voice:profiles:upsert',
        profile: {
          name: name.trim() || '我的音色',
          refAudioPath: refPath,
          refText: text,
          language: 'Auto',
          qwen3Variant: '0.6b-base',
        },
      })
      if (res?.error) {
        setError(String(res.error))
        return
      }
      const profile = res?.profile as VoiceCloneProfile | undefined
      await refresh()
      // 新建后自动选中（父组件负责写入 qwen3ProfileId + 启用克隆）
      if (profile?.id) onSelectProfile(profile.id)
      setRefText('')
      setRefPath('')
      setSampleSource('file')
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl)
        setPreviewUrl(null)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /**
   * 进入重命名编辑态
   */
  const startRename = (p: VoiceCloneProfile) => {
    setRenamingId(p.id)
    setRenameValue(p.name)
    setError(null)
  }

  /**
   * 提交重命名
   */
  const commitRename = async (id: string) => {
    const next = renameValue.trim()
    if (!next) {
      setRenamingId(null)
      return
    }
    const api = (window as any).electronAPI
    if (!api?.voice?.sendCommand) return
    setBusy(true)
    try {
      const res = await api.voice.sendCommand({
        type: 'voice:profiles:rename',
        profileId: id,
        name: next,
      })
      if (res?.error) {
        setError(String(res.error))
        return
      }
      await refresh()
      setRenamingId(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /**
   * 删除档案
   */
  const handleDelete = async (id: string) => {
    const api = (window as any).electronAPI
    if (!api?.voice?.sendCommand) return
    setBusy(true)
    try {
      await api.voice.sendCommand({ type: 'voice:profiles:delete', profileId: id })
      // 删除的是当前选中音色时，通知父组件清空（父组件会关闭克隆出声）
      if (selectedProfileId === id) onSelectProfile(undefined)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const controlsDisabled = busy || disabled || recording

  return (
    <div className={styles.panel} style={{ marginTop: 12 }}>
      <h4 className={styles.title}>我的音色</h4>
      <p className={styles.hint}>
        在这里管理你克隆的音色：上传 ≥3 秒清晰人声或对着麦克风朗读文案创建，可试听、重命名、删除。
        创建后到上方「AI 声音」列表选中它即生效。
      </p>
      {!cloneReady && (
        <p className={styles.hint} style={{ color: 'var(--color-warning, #d97706)' }}>
          克隆 Base 模型尚未下载，试听与出声不可用。请先在上方「下载」区下载 Base 模型。
        </p>
      )}

      {profiles.length === 0 ? (
        <p className={styles.hint}>暂无音色档案</p>
      ) : (
        <ul className={styles.list}>
          {profiles.map((p) => {
            const isSelected = selectedProfileId === p.id
            const rowDisabled = disabled || busy || recording
            return (
              <li
                key={p.id}
                className={[styles.card, isSelected ? styles.cardActive : ''].join(' ')}
              >
                <div className={styles.cardHead}>
                  {renamingId === p.id ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                      <Input
                        autoFocus
                        value={renameValue}
                        disabled={busy}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename(p.id)
                          if (e.key === 'Escape') setRenamingId(null)
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void commitRename(p.id)}
                      >
                        确定
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRenamingId(null)}>
                        取消
                      </Button>
                    </div>
                  ) : (
                    <>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                        <input
                          type="radio"
                          name="qwen3-profile"
                          checked={isSelected}
                          disabled={rowDisabled || !cloneReady}
                          onChange={() => onSelectProfile(p.id)}
                        />
                        <span className={styles.name}>
                          {p.name}
                          <span className={styles.meta}> · {p.qwen3Variant}</span>
                          {isSelected && <span className={styles.readyBadge}> 使用中</span>}
                        </span>
                      </label>
                      <div className={styles.actions}>
                        {onPreviewProfile && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={rowDisabled || !cloneReady || previewing}
                            onClick={() => onPreviewProfile(p.id)}
                          >
                            ▶ 试听
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={rowDisabled}
                          onClick={() => startRename(p)}
                        >
                          重命名
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={rowDisabled}
                          onClick={() => void handleDelete(p.id)}
                        >
                          删除
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        <Input
          placeholder="音色名称"
          value={name}
          disabled={controlsDisabled}
          onChange={(e) => setName(e.target.value)}
        />

        <div className={styles.promptCard}>
          <p className={styles.promptLabel}>请用自然语速朗读（建议不少于 3 秒）</p>
          <p className={styles.promptText}>{CLONE_REF_PROMPT_ZH}</p>
        </div>

        <div className={styles.recordRow}>
          {!recording ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || disabled}
              onClick={() => void startRecording()}
            >
              开始录制
            </Button>
          ) : (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void stopRecording()}>
              停止录制
            </Button>
          )}
          <Button variant="secondary" size="sm" disabled={controlsDisabled} onClick={() => void pickAudio()}>
            选择参考音频
          </Button>
          {previewUrl && !recording && (
            <>
              <Button variant="ghost" size="sm" disabled={busy || disabled} onClick={playPreview}>
                预听
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || disabled}
                onClick={clearRecordingSample}
              >
                重录
              </Button>
            </>
          )}
          <span className={styles.meta} style={{ fontSize: 12 }}>
            {recording
              ? `录音中 ${formatElapsed(elapsedMs)}`
              : refPath
                ? refPath.split(/[/\\]/).pop()
                : '未选择样本'}
          </span>
        </div>

        {recording && (
          <div className={styles.volumeRow} aria-label="麦克风音量">
            <span className={styles.volumeLabel}>麦克风</span>
            <WaveformVisualizer state="listening" analyserNode={waveAnalyser} />
            <div className={styles.volumeBarTrack}>
              <div className={styles.volumeBarFill} style={{ width: `${micLevel}%` }} />
            </div>
            <span className={styles.meta}>{formatElapsed(elapsedMs)}</span>
          </div>
        )}

        {sampleSource === 'record' ? (
          <p className={styles.hint} style={{ margin: 0 }}>
            转写文本（自动）：{CLONE_REF_PROMPT_ZH}
          </p>
        ) : (
          <Input
            placeholder="参考音频转写文本（必填）"
            value={refText}
            disabled={controlsDisabled}
            onChange={(e) => setRefText(e.target.value)}
          />
        )}

        <Button
          variant="primary"
          size="sm"
          disabled={controlsDisabled}
          onClick={() => void handleCreate()}
        >
          {busy ? '保存中...' : '保存音色'}
        </Button>
        {error && <p className={styles.error}>{error}</p>}
      </div>
    </div>
  )
}
