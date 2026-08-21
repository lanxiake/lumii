import React, { useState, useEffect, useRef } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Button } from '../../../../components/ui/Button/Button'
import { Input } from '../../../../components/ui/Input/Input'
import { Checkbox } from '../../../../components/ui/Checkbox/Checkbox'
import { Select } from '../../../../components/ui/Select/Select'
import { VoiceModelsPanel } from '../VoiceModelsPanel'
import { VoiceProfilesPanel } from '../VoiceProfilesPanel'
import { AsrLiveTestPanel } from '../AsrLiveTestPanel'
import styles from '../../SettingsPage.module.css'

export function VoiceSettingsSection() {
  const [voiceConfig, setVoiceConfig] = useState<{
    asr: { provider: string; language?: string; apiKey?: string }
    tts: {
      provider: string
      speed: number
      volume: number
      speakerId?: number
      voice?: string
      qwen3Variant?: string
      qwen3Speaker?: string
      qwen3Instruct?: string
      qwen3CloneEnabled?: boolean
      qwen3CloneVariant?: '0.6b-base' | '1.7b-base'
      qwen3ProfileId?: string
      qwen3Device?: 'auto' | 'cpu' | 'cuda'
      language?: string
    }
    vad: { threshold: number; minSpeechMs: number; minSilenceMs: number; energyGateMultiplier: number }
    autoMuteMicWhileSpeaking: boolean
  } | null>(null)
  const [voiceSaving, setVoiceSaving] = useState(false)
  const [voicePreviewing, setVoicePreviewing] = useState(false)
  const [voicePreviewText, setVoicePreviewText] = useState('你好，我叫 Lumii。I’m your best partner，是你的最佳伙伴呀。')
  const [voiceRuntimeStatus, setVoiceRuntimeStatus] = useState<{
    phase: string
    message: string
    detail?: string
  } | null>(null)
  const [vitsModelReady, setVitsModelReady] = useState(false)
  const [qwen3CustomReady, setQwen3CustomReady] = useState(false)
  const [qwen3Custom06Ready, setQwen3Custom06Ready] = useState(false)
  const [qwen3Custom17Ready, setQwen3Custom17Ready] = useState(false)
  const [qwen3CloneReady, setQwen3CloneReady] = useState(false)
  const [qwen3Clone06Ready, setQwen3Clone06Ready] = useState(false)
  const [qwen3Clone17Ready, setQwen3Clone17Ready] = useState(false)
  const [showVoiceApiKey, setShowVoiceApiKey] = useState(false)
  const previewAudioCtxRef = useRef<AudioContext | null>(null)
  const previewGainRef = useRef<GainNode | null>(null)
  const previewVolumeRef = useRef(1.0)
  const previewIdRef = useRef<string | null>(null)

  useEffect(() => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice?.sendCommand) return
    electronAPI.voice.sendCommand({ type: 'voice:config:get' }).then((cfg: any) => {
      if (cfg?.asr && cfg?.tts) {
        setVoiceConfig(cfg)
        const vol = typeof cfg.tts?.volume === 'number' ? cfg.tts.volume : 1.0
        previewVolumeRef.current = Math.max(0, Math.min(2, vol))
      }
    }).catch(() => {
      console.warn('[VoiceSettingsSection] 获取语音配置失败')
    })
    const applyModelReady = (list: any[]) => {
      setVitsModelReady(Boolean(list.find((m: any) => m.id === 'tts-melo-zh-en')?.downloaded))
      const tok = Boolean(list.find((m: any) => m.id === 'tts-qwen3-tokenizer-12hz')?.downloaded)
      const c06 = Boolean(list.find((m: any) => m.id === 'tts-qwen3-0.6b-custom')?.downloaded)
      const c17 = Boolean(list.find((m: any) => m.id === 'tts-qwen3-1.7b-custom')?.downloaded)
      const b06 = Boolean(list.find((m: any) => m.id === 'tts-qwen3-0.6b-base')?.downloaded)
      const b17 = Boolean(list.find((m: any) => m.id === 'tts-qwen3-1.7b-base')?.downloaded)
      setQwen3Custom06Ready(tok && c06)
      setQwen3Custom17Ready(tok && c17)
      setQwen3CustomReady(tok && (c06 || c17))
      setQwen3Clone06Ready(tok && b06)
      setQwen3Clone17Ready(tok && b17)
      setQwen3CloneReady(tok && (b06 || b17))
    }
    electronAPI.voice.sendCommand({ type: 'voice:models:get' }).then((list: any) => {
      if (!Array.isArray(list)) return
      applyModelReady(list)
    }).catch(() => undefined)

    const unsub = electronAPI.voice.onEvent?.((event: any) => {
      if (event.type === 'voice:models:status' && Array.isArray(event.models)) {
        applyModelReady(event.models)
      }
    })
    return () => {
      if (typeof unsub === 'function') unsub()
    }
  }, [])

  useEffect(() => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice?.onEvent) return
    let nextStartTime = 0
    const unsubscribe = electronAPI.voice.onEvent((event: any) => {
      if (event.type === 'voice:runtime:status') {
        setVoiceRuntimeStatus({
          phase: String(event.phase || ''),
          message: String(event.message || ''),
          detail: event.detail ? String(event.detail) : undefined,
        })
        return
      }
      if (event.type === 'voice:tts:preview:ended') {
        if (previewIdRef.current && event.previewId !== previewIdRef.current) return
        setVoicePreviewing(false)
        if (!event.ok && event.message) {
          setVoiceRuntimeStatus({
            phase: 'error',
            message: `预览失败：${event.message}`,
          })
        }
        return
      }
      if (event.type !== 'voice:tts:preview:chunk') return
      if (previewIdRef.current && event.previewId !== previewIdRef.current) return
      const ctx = previewAudioCtxRef.current
      if (!ctx) return
      if (event.isFinal && (!event.samples || event.samples.length === 0)) {
        setVoicePreviewing(false)
        return
      }
      if (!event.samples || event.samples.length === 0) return
      try {
        if (!previewGainRef.current || previewGainRef.current.context !== ctx) {
          const gain = ctx.createGain()
          gain.gain.value = Math.max(0, Math.min(2, previewVolumeRef.current))
          gain.connect(ctx.destination)
          previewGainRef.current = gain
        } else {
          previewGainRef.current.gain.value = Math.max(0, Math.min(2, previewVolumeRef.current))
        }
        const dest = previewGainRef.current
        if (event.sampleRate === -1) {
          const buf = new Uint8Array(event.samples).buffer
          ctx.decodeAudioData(buf).then((decoded) => {
            const source = ctx.createBufferSource()
            source.buffer = decoded
            source.connect(dest)
            const now = ctx.currentTime
            const start = Math.max(now + 0.04, nextStartTime)
            source.start(start)
            nextStartTime = start + decoded.duration
            if (event.isFinal) source.addEventListener('ended', () => setVoicePreviewing(false))
          }).catch(() => setVoicePreviewing(false))
        } else {
          const samples = new Float32Array(event.samples)
          const buffer = ctx.createBuffer(1, samples.length, event.sampleRate)
          buffer.copyToChannel(samples, 0)
          const source = ctx.createBufferSource()
          source.buffer = buffer
          source.connect(dest)
          const now = ctx.currentTime
          const start = Math.max(now + 0.04, nextStartTime)
          source.start(start)
          nextStartTime = start + buffer.duration
        }
      } catch (e) {
        console.warn('[VoiceSettingsSection] 预览音频播放失败:', e)
        setVoicePreviewing(false)
      }
    })
    return () => {
      unsubscribe?.()
      previewGainRef.current = null
      previewAudioCtxRef.current?.close().catch(() => {})
      previewAudioCtxRef.current = null
    }
  }, [])

  const saveVoiceConfig = async (partial: {
    asr?: { provider?: string; language?: string; apiKey?: string }
    tts?: {
      provider?: string
      speed?: number
      volume?: number
      speakerId?: number
      voice?: string
      qwen3Variant?: string
      qwen3Speaker?: string
      qwen3Instruct?: string
      qwen3CloneEnabled?: boolean
      qwen3CloneVariant?: '0.6b-base' | '1.7b-base'
      qwen3ProfileId?: string
      qwen3Device?: 'auto' | 'cpu' | 'cuda'
      language?: string
    }
    vad?: { threshold?: number; minSpeechMs?: number; minSilenceMs?: number; energyGateMultiplier?: number }
    autoMuteMicWhileSpeaking?: boolean
  }) => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice?.sendCommand || !voiceConfig) return
    const next = {
      ...voiceConfig,
      asr: { ...voiceConfig.asr, ...partial.asr },
      tts: { ...voiceConfig.tts, ...partial.tts },
      vad: { ...voiceConfig.vad, ...partial.vad },
      autoMuteMicWhileSpeaking:
        partial.autoMuteMicWhileSpeaking ?? voiceConfig.autoMuteMicWhileSpeaking,
    }
    setVoiceConfig(next)
    setVoiceSaving(true)
    try {
      await electronAPI.voice.sendCommand({ type: 'voice:config:set', config: partial })
    } finally {
      setVoiceSaving(false)
    }
  }

  const handlePreview = async () => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice?.sendCommand) return
    if (!previewAudioCtxRef.current || previewAudioCtxRef.current.state === 'closed') {
      previewAudioCtxRef.current = new AudioContext()
    }
    if (previewAudioCtxRef.current.state === 'suspended') {
      await previewAudioCtxRef.current.resume()
    }
    setVoicePreviewing(true)
    const previewId = `settings-${Date.now()}`
    previewIdRef.current = previewId
    const text = voicePreviewText.trim().slice(0, 100) || '你好，我叫 Lumii。I’m your best partner，是你的最佳伙伴呀。'
    await electronAPI.voice
      .sendCommand({ type: 'voice:tts:preview', text, maxChars: 100, previewId })
      .catch(() => setVoicePreviewing(false))
  }

  const handlePreviewProfile = async (profileId: string) => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice?.sendCommand) return
    if (!previewAudioCtxRef.current || previewAudioCtxRef.current.state === 'closed') {
      previewAudioCtxRef.current = new AudioContext()
    }
    if (previewAudioCtxRef.current.state === 'suspended') {
      await previewAudioCtxRef.current.resume()
    }
    setVoicePreviewing(true)
    const previewId = `settings-clone-${profileId}-${Date.now()}`
    previewIdRef.current = previewId
    const text = voicePreviewText.trim().slice(0, 100) || '你好，我叫 Lumii。I’m your best partner，是你的最佳伙伴呀。'
    await electronAPI.voice
      .sendCommand({
        type: 'voice:tts:preview',
        text,
        maxChars: 100,
        previewId,
        override: {
          provider: 'qwen3',
          cloneEnabled: true,
          qwen3ProfileId: profileId,
        },
      })
      .catch(() => setVoicePreviewing(false))
  }

  const selectCloneProfile = (id: string | undefined) => {
    if (id) {
      const prefer = qwen3Clone06Ready ? '0.6b-base' : '1.7b-base'
      void saveVoiceConfig({
        tts: {
          provider: 'qwen3',
          qwen3CloneEnabled: true,
          qwen3ProfileId: id,
          qwen3CloneVariant: voiceConfig?.tts.qwen3CloneVariant ?? prefer,
        },
      })
    } else {
      void saveVoiceConfig({ tts: { qwen3CloneEnabled: false, qwen3ProfileId: undefined } })
    }
  }

  const selectBuiltinSpeaker = (speaker: string) => {
    void saveVoiceConfig({ tts: { qwen3Speaker: speaker, qwen3CloneEnabled: false } })
  }

  const vitsDownloaded = vitsModelReady
  const qwenVariant = voiceConfig?.tts.qwen3Variant ?? '0.6b-custom'
  const cloneEnabled = voiceConfig?.tts.qwen3CloneEnabled === true
  const cloneVariant = voiceConfig?.tts.qwen3CloneVariant ?? '0.6b-base'
  const previewDisabled =
    !voiceConfig ||
    voicePreviewing ||
    (voiceConfig.tts.provider === 'local-vits' && !vitsDownloaded) ||
    (voiceConfig.tts.provider === 'qwen3' &&
      (cloneEnabled
        ? !qwen3CloneReady || !voiceConfig.tts.qwen3ProfileId
        : !qwen3CustomReady))

  const runtimePhaseLabel = (phase: string): string => {
    switch (phase) {
      case 'checking_python':
        return '检查环境'
      case 'installing_deps':
        return '安装依赖'
      case 'starting_engine':
        return '启动引擎'
      case 'loading_model':
        return '加载模型'
      case 'synthesizing':
        return '合成中'
      case 'playing':
        return '播放中'
      case 'ready':
        return '就绪'
      case 'error':
        return '出错'
      case 'idle':
        return '空闲'
      default:
        return phase || '状态'
    }
  }

  const runtimeBusy =
    !!voiceRuntimeStatus &&
    !['idle', 'ready', 'error'].includes(voiceRuntimeStatus.phase)

  const renderRuntimeStatus = () => {
    if (!voiceRuntimeStatus?.message) return null
    const phase = voiceRuntimeStatus.phase
    const cls = [
      styles['voice-runtime-status'],
      phase === 'error'
        ? styles['voice-runtime-status-error']
        : phase === 'ready' || phase === 'idle'
          ? styles['voice-runtime-status-ready']
          : styles['voice-runtime-status-busy'],
    ].join(' ')
    return (
      <div className={cls} role="status" aria-live="polite">
        <span className={styles['voice-runtime-phase']}>{runtimePhaseLabel(phase)}</span>
        {voiceRuntimeStatus.message}
        {voiceRuntimeStatus.detail ? (
          <div className={styles['voice-runtime-detail']}>{voiceRuntimeStatus.detail}</div>
        ) : null}
      </div>
    )
  }

  const previewButtonLabel = (() => {
    if (!voicePreviewing && !runtimeBusy) return '▶ 预览合成声音'
    const phase = voiceRuntimeStatus?.phase
    if (phase === 'installing_deps') return '安装依赖中…'
    if (phase === 'loading_model') return '加载模型中…'
    if (phase === 'checking_python' || phase === 'starting_engine') return '启动引擎中…'
    if (phase === 'synthesizing') return '合成中…'
    if (phase === 'playing') return '播放中…'
    return voicePreviewing ? '处理中…' : '▶ 预览合成声音'
  })()

  return (
    <div className={styles['settings-section']}>
      <h3 data-app-ui-section-title>语音设置</h3>
      <p className={styles['settings-note']}>
        分为三块独立能力：语音识别、语音合成、声音克隆。各自下载与测试，互不强制。
      </p>

      {!voiceConfig ? (
        <p className={styles['settings-note']}>加载语音配置中...</p>
      ) : (
        <>
          {/* ═══ 1. 语音识别 ═══ */}
          <div className={styles['voice-block']}>
            <h4 className={styles['voice-block-title']}>一、语音识别</h4>
            <p className={styles['voice-block-desc']}>
              把你的说话转成文字。通话听懂你需要下载 VAD + ASR；与是否克隆声音无关。
            </p>

            <VoiceModelsPanel
              groups={['asr-core']}
              title="下载"
              hint="建议两项都下载。仅用文字输入可不下。"
            />

            <div className={styles['setting-group']}>
              <h5 className={styles['voice-block-subtitle']}>设置</h5>
              <div className={styles['setting-item']}>
                <label className={styles['setting-label']} data-app-ui-label>识别引擎</label>
                <Select
                  value={voiceConfig.asr.provider}
                  options={[
                    { label: '本地 Paraformer（离线）', value: 'local-paraformer' },
                    { label: 'OpenAI Whisper（云端）', value: 'openai-whisper' },
                  ]}
                  onChange={(e) => saveVoiceConfig({ asr: { provider: e.target.value } })}
                />
              </div>
              {voiceConfig.asr.provider === 'openai-whisper' && (
                <div className={styles['setting-item']}>
                  <label className={styles['setting-label']} data-app-ui-label>OpenAI API Key</label>
                  <Input
                    type={showVoiceApiKey ? 'text' : 'password'}
                    placeholder="sk-..."
                    value={voiceConfig.asr.apiKey ?? ''}
                    onChange={(e) => saveVoiceConfig({ asr: { apiKey: e.target.value } })}
                    style={{ width: '280px' }}
                    suffix={
                      <button
                        type="button"
                        aria-label={showVoiceApiKey ? '隐藏 API Key' : '显示 API Key'}
                        onClick={() => setShowVoiceApiKey((v) => !v)}
                        style={{ display: 'inline-flex', alignItems: 'center', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
                      >
                        {showVoiceApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    }
                  />
                </div>
              )}
              <div className={styles['setting-item']}>
                <Checkbox
                  checked={voiceConfig.autoMuteMicWhileSpeaking ?? true}
                  onChange={(checked) => saveVoiceConfig({ autoMuteMicWhileSpeaking: checked })}
                >
                  AI 朗读时自动闭麦
                </Checkbox>
              </div>
              <div className={styles['setting-item']}>
                <label className={styles['setting-label']} data-app-ui-label>
                  语音识别阈值：{(voiceConfig.vad?.threshold ?? 0.5).toFixed(2)}
                </label>
                <input
                  type="range"
                  min={0.1}
                  max={0.9}
                  step={0.05}
                  value={voiceConfig.vad?.threshold ?? 0.5}
                  onChange={(e) => saveVoiceConfig({ vad: { threshold: parseFloat(e.target.value) } })}
                  style={{ width: '200px' }}
                />
              </div>
              <div className={styles['setting-item']}>
                <label className={styles['setting-label']} data-app-ui-label>
                  负面语音阈值：{(voiceConfig.vad?.energyGateMultiplier ?? 1.5).toFixed(1)}x
                </label>
                <input
                  type="range"
                  min={1.0}
                  max={4.0}
                  step={0.1}
                  value={voiceConfig.vad?.energyGateMultiplier ?? 1.5}
                  onChange={(e) =>
                    saveVoiceConfig({ vad: { energyGateMultiplier: parseFloat(e.target.value) } })
                  }
                  style={{ width: '200px' }}
                />
              </div>
            </div>

            <div className={styles['setting-group']}>
              <h5 className={styles['voice-block-subtitle']}>测试</h5>
              <AsrLiveTestPanel />
            </div>
          </div>

          {/* ═══ 2. AI 声音（合成引擎 + 音色，含克隆） ═══ */}
          <div className={styles['voice-block']}>
            <h4 className={styles['voice-block-title']}>二、AI 声音</h4>
            <p className={styles['voice-block-desc']}>
              让 AI 出声。先选合成引擎，再在下方选一个音色即生效。
              Qwen3 下「内置音色」与「我的音色（克隆）」在同一列表里，选谁用谁。
            </p>

            <VoiceModelsPanel
              groups={['tts-synth', 'tts-clone']}
              title="下载"
              hint="内置音色：先下 Tokenizer 12Hz，再下 0.6B CustomVoice（9 种音色）。声音克隆额外需要 0.6B Base（或 1.7B）。权重下完后台预装依赖，进度见下方「测试」状态条。"
            />

            <div className={styles['setting-group']}>
              <h5 className={styles['voice-block-subtitle']}>设置</h5>
              <div className={styles['setting-item']}>
                <label className={styles['setting-label']} data-app-ui-label>合成引擎</label>
                <Select
                  value={voiceConfig.tts.provider}
                  options={[
                    { label: 'Edge TTS（联网，免下载）', value: 'edge' },
                    {
                      label: vitsDownloaded
                        ? '本地 MeloTTS 中英混读（离线）'
                        : '本地 MeloTTS 中英混读（需先下载）',
                      value: 'local-vits',
                      disabled: !vitsDownloaded,
                    },
                    {
                      label: qwen3CustomReady
                        ? 'Qwen3（本地多音色 + 声音克隆）'
                        : 'Qwen3（需先下载 Tokenizer+CustomVoice）',
                      value: 'qwen3',
                      disabled: !qwen3CustomReady,
                    },
                  ]}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === 'local-vits' && !vitsDownloaded) return
                    if (v === 'qwen3' && !qwen3CustomReady) return
                    if (v === 'qwen3') {
                      const prefer = qwen3Custom06Ready ? '0.6b-custom' : '1.7b-custom'
                      saveVoiceConfig({
                        tts: { provider: 'qwen3', qwen3Variant: prefer, qwen3CloneEnabled: false },
                      })
                      return
                    }
                    saveVoiceConfig({ tts: { provider: v, qwen3CloneEnabled: false } })
                  }}
                />
              </div>
              {voiceConfig.tts.provider === 'qwen3' && (
                <div className={styles['setting-item']}>
                  <label className={styles['setting-label']} data-app-ui-label>推理设备</label>
                  <Select
                    value={voiceConfig.tts.qwen3Device ?? 'auto'}
                    options={[
                      {
                        label: '自动（有 NVIDIA 显卡则用 GPU）',
                        value: 'auto',
                      },
                      {
                        label: 'GPU（CUDA，需 NVIDIA 驱动）',
                        value: 'cuda',
                      },
                      {
                        label: 'CPU（兼容性最好，较慢）',
                        value: 'cpu',
                      },
                    ]}
                    onChange={(e) => {
                      const v = e.target.value as 'auto' | 'cpu' | 'cuda'
                      void saveVoiceConfig({ tts: { qwen3Device: v } })
                    }}
                  />
                  <span className={styles['setting-hint']}>
                    GPU 需先在下方模型列表下载「PyTorch CUDA 运行时」（可暂停/续传/取消，约
                    2.3GB）；下载完成后自动安装。
                  </span>
                </div>
              )}
              <div className={styles['setting-item']}>
                <label className={styles['setting-label']} data-app-ui-label>
                  语速：{voiceConfig.tts.speed.toFixed(1)}x
                </label>
                <input
                  type="range"
                  min={0.8}
                  max={1.5}
                  step={0.1}
                  value={voiceConfig.tts.speed}
                  onChange={(e) => saveVoiceConfig({ tts: { speed: parseFloat(e.target.value) } })}
                  style={{ width: '200px' }}
                />
              </div>
              <div className={styles['setting-item']}>
                <label className={styles['setting-label']} data-app-ui-label>
                  音量：{Math.round((voiceConfig.tts.volume ?? 1.0) * 100)}%
                  {(voiceConfig.tts.volume ?? 1.0) > 1 ? '（增强）' : ''}
                </label>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={voiceConfig.tts.volume ?? 1.0}
                  onChange={(e) => {
                    const vol = parseFloat(e.target.value)
                    previewVolumeRef.current = vol
                    if (previewGainRef.current) {
                      previewGainRef.current.gain.value = Math.max(0, Math.min(2, vol))
                    }
                    saveVoiceConfig({ tts: { volume: vol } })
                  }}
                  style={{ width: '200px' }}
                />
              </div>
              {voiceConfig.tts.provider === 'edge' && (
                <div className={styles['setting-item']}>
                  <label className={styles['setting-label']} data-app-ui-label>Edge 音色</label>
                  <Select
                    value={voiceConfig.tts.voice ?? 'zh-CN-XiaoxiaoNeural'}
                    options={[
                      { label: '晓晓 - 女声·温暖亲切', value: 'zh-CN-XiaoxiaoNeural' },
                      { label: '晓伊 - 女声·活泼可爱', value: 'zh-CN-XiaoyiNeural' },
                      { label: '云健 - 男声·沉稳大气', value: 'zh-CN-YunjianNeural' },
                      { label: '云希 - 男声·阳光少年', value: 'zh-CN-YunxiNeural' },
                      { label: '云夏 - 男声·少年音', value: 'zh-CN-YunxiaNeural' },
                      { label: '云扬 - 男声·新闻播报', value: 'zh-CN-YunyangNeural' },
                      { label: '晓北 - 女声·东北方言', value: 'zh-CN-liaoning-XiaobeiNeural' },
                      { label: '晓妮 - 女声·陕西方言', value: 'zh-CN-shaanxi-XiaoniNeural' },
                    ]}
                    onChange={(e) => saveVoiceConfig({ tts: { voice: e.target.value } })}
                  />
                </div>
              )}
              {voiceConfig.tts.provider === 'qwen3' && (
                <>
                  <div className={styles['setting-item']}>
                    <label className={styles['setting-label']} data-app-ui-label>合成语言</label>
                    <Select
                      value={voiceConfig.tts.language ?? 'Auto'}
                      options={[
                        { label: '自动检测', value: 'Auto' },
                        { label: '中文', value: 'Chinese' },
                        { label: 'English', value: 'English' },
                        { label: '日本語', value: 'Japanese' },
                        { label: '한국어', value: 'Korean' },
                        { label: 'Deutsch', value: 'German' },
                        { label: 'Français', value: 'French' },
                        { label: 'Русский', value: 'Russian' },
                        { label: 'Português', value: 'Portuguese' },
                        { label: 'Español', value: 'Spanish' },
                        { label: 'Italiano', value: 'Italian' },
                      ]}
                      onChange={(e) => saveVoiceConfig({ tts: { language: e.target.value } })}
                    />
                  </div>

                  <div className={styles['setting-item']} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <label className={styles['setting-label']} data-app-ui-label>音色（选中即生效）</label>
                    <div className={styles['voice-speaker-list']}>
                      {[
                        { id: 'Vivian', desc: '女 · 明亮 · 中文' },
                        { id: 'Serena', desc: '女 · 温暖 · 中文' },
                        { id: 'Uncle_Fu', desc: '男 · 沉稳 · 中文', name: 'Uncle Fu' },
                        { id: 'Dylan', desc: '男 · 北京话' },
                        { id: 'Eric', desc: '男 · 四川话' },
                        { id: 'Ryan', desc: '男 · English' },
                        { id: 'Aiden', desc: '男 · English' },
                        { id: 'Ono_Anna', desc: '女 · 日本語', name: 'Ono Anna' },
                        { id: 'Sohee', desc: '女 · 한국어' },
                      ].map((sp) => {
                        const active = !cloneEnabled && (voiceConfig.tts.qwen3Speaker ?? 'Vivian') === sp.id
                        return (
                          <label
                            key={sp.id}
                            className={styles['voice-speaker-item']}
                            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                          >
                            <input
                              type="radio"
                              name="qwen3-active-voice"
                              checked={active}
                              onChange={() => selectBuiltinSpeaker(sp.id)}
                            />
                            <span>
                              内置 · {sp.name ?? sp.id}
                              <span className={styles['settings-note']} style={{ marginLeft: 6 }}>
                                {sp.desc}
                              </span>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  </div>

                  {qwenVariant === '1.7b-custom' && !cloneEnabled && (
                    <div className={styles['setting-item']}>
                      <label className={styles['setting-label']} data-app-ui-label>风格指令（可选）</label>
                      <Input
                        placeholder="例如：用特别开心的语气说"
                        value={voiceConfig.tts.qwen3Instruct ?? ''}
                        onChange={(e) => saveVoiceConfig({ tts: { qwen3Instruct: e.target.value } })}
                        style={{ width: '320px' }}
                      />
                    </div>
                  )}

                  <VoiceProfilesPanel
                    selectedProfileId={cloneEnabled ? voiceConfig.tts.qwen3ProfileId : undefined}
                    onSelectProfile={selectCloneProfile}
                    onPreviewProfile={(id) => void handlePreviewProfile(id)}
                    previewing={voicePreviewing || runtimeBusy}
                    cloneReady={qwen3CloneReady}
                  />

                  {qwen3CloneReady && (
                    <div className={styles['setting-item']} style={{ marginTop: 12 }}>
                      <label className={styles['setting-label']} data-app-ui-label>克隆模型规格</label>
                      <Select
                        value={cloneVariant}
                        options={[
                          {
                            label: qwen3Clone06Ready ? '0.6B Base' : '0.6B Base（未下载）',
                            value: '0.6b-base',
                            disabled: !qwen3Clone06Ready,
                          },
                          {
                            label: qwen3Clone17Ready ? '1.7B Base' : '1.7B Base（未下载）',
                            value: '1.7b-base',
                            disabled: !qwen3Clone17Ready,
                          },
                        ]}
                        onChange={(e) =>
                          saveVoiceConfig({
                            tts: {
                              qwen3CloneVariant: e.target.value as '0.6b-base' | '1.7b-base',
                            },
                          })
                        }
                      />
                    </div>
                  )}
                </>
              )}
            </div>

            <div className={styles['setting-group']}>
              <h5 className={styles['voice-block-subtitle']}>测试</h5>
              {renderRuntimeStatus()}
              <div className={styles['setting-item']}>
                <label className={styles['setting-label']} data-app-ui-label>
                  测试文案（最多 100 字）剩余 {100 - voicePreviewText.length}
                </label>
                <input
                  className={styles['voice-preview-input']}
                  type="text"
                  value={voicePreviewText}
                  maxLength={100}
                  onChange={(e) => setVoicePreviewText(e.target.value.slice(0, 100))}
                  placeholder="你好，我叫 Lumii。I’m your best partner，是你的最佳伙伴呀。"
                />
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={handlePreview}
                disabled={previewDisabled || runtimeBusy}
              >
                {previewButtonLabel}
              </Button>
              <p className={styles['settings-note']} style={{ marginTop: 6 }}>
                {cloneEnabled
                  ? '当前生效：克隆音色。试听将使用你选中的「我的音色」。'
                  : '当前生效：内置/引擎音色。要试听某条克隆音色，用列表里每条的「试听」。'}
              </p>
            </div>
          </div>

          {voiceSaving && <p className={styles['settings-note']}>保存中...</p>}
        </>
      )}
    </div>
  )
}
