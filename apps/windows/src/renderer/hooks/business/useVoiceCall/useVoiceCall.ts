// @refresh reset
/**
 * useVoiceCall Hook
 * 管理语音通话完整生命周期：麦克风采集 → IPC → 状态管理 → 播放
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { AudioPlaybackEngine } from './audio-playback.js'
import { loadAudioWorkletModule } from './load-audio-worklet.js'
import pcmProcessorSource from './worklets/pcm-processor.js?raw'
import type { VoiceCallState } from '../../../../shared/voice-events.js'

/**
 * 通知渲染层：语音模型未就绪，应引导用户前往设置下载
 */
function notifyModelsNeedDownload(): void {
  window.dispatchEvent(new CustomEvent('voice:models:need-download'))
}

export interface VoiceCallHookState {
  state: VoiceCallState | 'idle'
  callId: string | null
  partialTranscript: string
  finalTranscript: string
  isModelReady: boolean
  error: string | null
  /** 实时波形分析节点（可选，供 WaveformVisualizer 使用） */
  analyserNode: AnalyserNode | null
  /** TTS 播放输出分析节点（供宠物口型同步 PetLipSync 使用） */
  playbackAnalyserNode: AnalyserNode | null
  /**
   * 逐字脉冲口型回调：调用方（PetOrchestrator）注入闭包，消费 AudioPlaybackEngine 的
   * 逐字边界事件（对齐 AudioContext 时钟），替代 RMS 连续振幅，实现一字一合。
   */
  charPulsePoll: (() => number) | null
  /**
   * 音频是否仍在播放（含已调度未播的后续块）。口型收尾据此判定：只要还有音频在播就不闭嘴，
   * 避免 TTS 合成断流（逐字事件出现间隙）时口型提前停止，而音频还在放。
   */
  isAudioPlaying: (() => boolean) | null
  /** 当前播放音量（0.0 ~ 1.0，仅渲染侧） */
  volume: number
  /** 当前语速（0.8 ~ 1.5） */
  speed: number
  /** 当前说话人 ID（仅 local-vits 有效） */
  speakerId: number
  /** 当前 TTS provider */
  ttsProvider: 'local-vits' | 'edge'
  /** Edge TTS 音色 ID */
  edgeVoice: string
}

export interface VoiceCallActions {
  startCall: (sessionKey: string, agentId?: string, opts?: { micless?: boolean }) => Promise<void>
  stopCall: () => Promise<void>
  getModelsStatus: () => Promise<unknown>
  downloadModel: (modelId: string) => Promise<void>
  /** 实时调整播放音量（0.0 ~ 1.0，仅渲染侧，不持久化） */
  setVolume: (value: number) => void
  /** 实时调整语速（0.8 ~ 1.5，通知主进程，支持热更新） */
  setSpeed: (value: number) => Promise<void>
  /** 实时切换说话人 ID（仅 local-vits，通知主进程，热更新） */
  setSpeakerId: (id: number) => Promise<void>
  /** 实时切换 Edge TTS 音色 */
  setEdgeVoice: (voice: string) => Promise<void>
}

export function useVoiceCall(): [VoiceCallHookState, VoiceCallActions] {
  const [state, setState] = useState<VoiceCallHookState>({
    state: 'idle',
    callId: null,
    partialTranscript: '',
    finalTranscript: '',
    isModelReady: false,
    error: null,
    analyserNode: null,
    playbackAnalyserNode: null,
    charPulsePoll: null,
    isAudioPlaying: null,
    volume: 0.8,
    speed: 1.2,
    speakerId: 0,
    ttsProvider: 'edge',
    edgeVoice: 'zh-CN-XiaoxiaoNeural',
  })

  const audioCtxRef = useRef<AudioContext | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const playbackRef = useRef<AudioPlaybackEngine | null>(null)
  const callIdRef = useRef<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const volumeRef = useRef<number>(0.8)

  // ── 加载初始配置（语速、音量、音色） ─────────────────────────────────────

  useEffect(() => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice?.sendCommand) return
    electronAPI.voice.sendCommand({ type: 'voice:config:get' })
      .then((cfg: any) => {
        if (cfg?.tts) {
          const vol = cfg.tts.volume ?? 0.8
          volumeRef.current = vol
          setState((s) => ({
            ...s,
            volume: vol,
            speed: cfg.tts.speed ?? s.speed,
            speakerId: cfg.tts.speakerId ?? s.speakerId,
            ttsProvider: cfg.tts.provider ?? s.ttsProvider,
            edgeVoice: cfg.tts.voice ?? s.edgeVoice,
          }))
        }
      })
      .catch(() => {})
  }, [])

  // ── 订阅主进程语音事件 ──────────────────────────────────────────────────

  useEffect(() => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice?.onEvent) return

    const unsubscribe = electronAPI.voice.onEvent((event: any) => {
      switch (event.type) {
        case 'voice:call:state':
          if (event.state === 'listening' && event.interrupted) {
            // 用户打断：立即清空播放缓冲并切换状态
            setState((s) => ({ ...s, state: event.state }))
            playbackRef.current?.flush()
          } else if (event.state === 'listening' && !event.interrupted) {
            // 正常 TTS 完成：等音频播完再切换到 listening
            if (playbackRef.current) {
              playbackRef.current.onIdle(() => {
                setState((s) => ({ ...s, state: 'listening' }))
                // 通知主进程音频已完全播放完毕，缩短回声冷却期
                const callId = callIdRef.current
                if (callId) {
                  const api = (window as any).electronAPI
                  api?.voice?.sendCommand({ type: 'voice:playback:finished', callId }).catch(() => {})
                }
              })
            } else {
              setState((s) => ({ ...s, state: event.state }))
            }
          } else if (event.state === 'recognizing') {
            // 用户开始说话 → 停止所有 AI 音频（无论来自打断还是正常对话轮次）
            setState((s) => ({ ...s, state: event.state }))
            playbackRef.current?.flush()
          } else {
            setState((s) => ({ ...s, state: event.state }))
          }
          break

        case 'voice:transcript':
          if (event.isFinal) {
            setState((s) => ({
              ...s,
              finalTranscript: event.text,
              partialTranscript: '',
            }))
          } else {
            setState((s) => ({ ...s, partialTranscript: event.text }))
          }
          break

        case 'voice:tts:chunk':
          if (event.samples && event.samples.length > 0) {
            console.log(`[useVoiceCall] tts:chunk sampleRate=${event.sampleRate} samples=${event.samples.length} isFinal=${event.isFinal} text=${(event as { text?: string }).text?.slice(0, 30) ?? '(none)'}`)
            if (event.sampleRate === -1 && audioCtxRef.current) {
              // 编码音频（mp3）：Edge TTS 发送的原始字节，需要解码
              void (async () => {
                try {
                  const buffer = new Uint8Array(event.samples).buffer
                  const decoded = await audioCtxRef.current!.decodeAudioData(buffer)
                  playbackRef.current?.enqueue(
                    decoded.getChannelData(0),
                    decoded.sampleRate,
                    event.isFinal,
                    (event as { text?: string }).text,
                  )
                } catch (e) {
                  console.error('[useVoiceCall] Edge TTS 音频解码失败:', e)
                }
              })()
            } else {
              // PCM 音频：本地 VITS 发送的原始采样
              const samples = event.samples instanceof Float32Array
                ? event.samples
                : new Float32Array(event.samples)
              playbackRef.current?.enqueue(samples, event.sampleRate, event.isFinal, (event as { text?: string }).text)
            }
          }
          break

        case 'voice:tts:audio-file':
        case 'voice:tts:audio-data':
          // 兼容旧路径：主进程发送原始音频字节
          if (event.audioData && audioCtxRef.current) {
            void (async () => {
              try {
                const buffer = new Uint8Array(event.audioData).buffer
                const decoded = await audioCtxRef.current!.decodeAudioData(buffer)
                playbackRef.current?.enqueue(
                  decoded.getChannelData(0),
                  decoded.sampleRate,
                  event.isFinal,
                )
              } catch (e) {
                console.error('[useVoiceCall] Edge TTS 音频解码失败:', e)
              }
            })()
          }
          break

        case 'voice:call:ended':
          setState((s) => ({ ...s, state: 'idle', callId: null }))
          callIdRef.current = null
          break

        case 'voice:error':
          setState((s) => ({ ...s, state: 'error', error: event.message }))
          break

        case 'voice:config:updated':
          // 配置更新推送：热更新音量（渲染侧 GainNode），同步速度/音色状态
          if (event.config?.tts) {
            const cfg = event.config.tts
            if (cfg.volume !== undefined) {
              volumeRef.current = cfg.volume
              playbackRef.current?.setVolume(cfg.volume)
            }
            setState((s) => ({
              ...s,
              volume: cfg.volume ?? s.volume,
              speed: cfg.speed ?? s.speed,
              speakerId: cfg.speakerId ?? s.speakerId,
              ttsProvider: cfg.provider ?? s.ttsProvider,
              edgeVoice: cfg.voice ?? s.edgeVoice,
            }))
          }
          break

        default:
          break
      }
    })

    return unsubscribe
  }, [])

  // 消息朗读等场景：TTS 模型未就绪 → 引导去设置页下载
  useEffect(() => {
    const handler = () => notifyModelsNeedDownload()
    window.addEventListener('voice:tts:models-not-ready', handler)
    return () => window.removeEventListener('voice:tts:models-not-ready', handler)
  }, [])

  // ── 开始通话 ──────────────────────────────────────────────────────────

  const startCall = useCallback(async (sessionKey: string, agentId?: string, opts?: { micless?: boolean }) => {
    const micless = opts?.micless === true
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice) {
      setState((s) => ({ ...s, error: '语音 API 不可用' }))
      return
    }

    setState((s) => ({ ...s, state: 'initializing' as VoiceCallState, error: null }))

    try {
      let source: MediaStreamAudioSourceNode | null = null
      let workletNode: AudioWorkletNode | null = null

      // micless 模式（文字回复出声）：不采麦，只建播放管线 + AnalyserNode 供真口型。
      if (!micless) {
        // 1. 请求麦克风权限
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
        streamRef.current = stream
      }

      // 2. 创建 AudioContext 并确保处于 running 状态
      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume()
      }

      if (!micless && streamRef.current) {
        // 3. 加载 AudioWorklet（Blob URL，兼容 Electron 生产环境的 file:// 协议）
        await loadAudioWorkletModule(audioCtx, pcmProcessorSource)

        // 4. 创建音频管道
        source = audioCtx.createMediaStreamSource(streamRef.current)
        workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor')
        workletNodeRef.current = workletNode

        // 创建 AnalyserNode 用于波形可视化（连接到 source 但不连接 destination）
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 64
        analyser.smoothingTimeConstant = 0.6
        source.connect(analyser)
        analyserRef.current = analyser
        setState((s) => ({ ...s, analyserNode: analyser }))
      }

      // 5. 初始化播放引擎（应用当前音量）
      playbackRef.current = new AudioPlaybackEngine(audioCtx)
      playbackRef.current.setVolume(volumeRef.current)
      // 暴露播放输出分析节点（供宠物口型同步）+ 逐字脉冲口型回调
      const engine = playbackRef.current!
      setState((s) => ({
        ...s,
        playbackAnalyserNode: engine.getAnalyserNode(),
        charPulsePoll: () => engine.pollCharEvents(audioCtx.currentTime),
        isAudioPlaying: () => engine.isPlaying(),
      }))

      // 6. 通知主进程开始通话（micless 时主进程不会收到音频帧，仅做 TTS 出声）
      const result = await electronAPI.voice.sendCommand({
        type: 'voice:call:start',
        sessionKey,
        agentId,
        micless,
      })

      if (result?.error === 'models_not_ready') {
        setState((s) => ({
          ...s,
          state: 'idle',
        }))
        notifyModelsNeedDownload()
        // 清理已创建的音频资源
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        await audioCtxRef.current?.close().catch(() => {})
        audioCtxRef.current = null
        return
      }

      if (result?.error) {
        throw new Error(result.error)
      }

      const callId = result?.callId
      callIdRef.current = callId
      setState((s) => ({ ...s, callId }))

      // 7. 开始推送 PCM 帧（micless 无采集，跳过）
      if (!micless && workletNode && source) {
        workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
          if (callIdRef.current) {
            // 直接传 Float32Array，preload 负责转换为 Buffer
            electronAPI.voice.sendAudioChunk(callIdRef.current, e.data)
          }
        }

        source.connect(workletNode)
        // 不连接 destination，避免回声
      }
    } catch (e) {
      const errorMessage = (e as Error).message
      console.error('[useVoiceCall] startCall 失败:', e)

      // 清理资源
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      await audioCtxRef.current?.close().catch(() => {})
      audioCtxRef.current = null

      setState((s) => ({
        ...s,
        state: 'error',
        error: errorMessage.includes('Permission')
          ? '麦克风权限被拒绝，请在系统设置中允许访问麦克风'
          : `启动语音通话失败: ${errorMessage}`,
      }))
    }
  }, [])

  // ── 结束通话 ──────────────────────────────────────────────────────────

  const stopCall = useCallback(async () => {
    const electronAPI = (window as any).electronAPI

    if (callIdRef.current && electronAPI?.voice) {
      await electronAPI.voice
        .sendCommand({ type: 'voice:call:stop', callId: callIdRef.current })
        .catch(() => {})
    }

    // 清理音频资源
    workletNodeRef.current?.disconnect()
    workletNodeRef.current = null
    analyserRef.current?.disconnect()
    analyserRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    playbackRef.current?.destroy()
    playbackRef.current = null
    await audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
    callIdRef.current = null

    setState((s) => ({
      ...s,
      state: 'idle',
      callId: null,
      partialTranscript: '',
      finalTranscript: '',
      analyserNode: null,
      playbackAnalyserNode: null,
      charPulsePoll: null,
      isAudioPlaying: null,
    }))
  }, [])

  const actions: VoiceCallActions = {
    startCall,
    stopCall,
    getModelsStatus: () => {
      const electronAPI = (window as any).electronAPI
      return electronAPI?.voice?.sendCommand({ type: 'voice:models:get' }) ?? Promise.resolve([])
    },
    downloadModel: (modelId: string) => {
      const electronAPI = (window as any).electronAPI
      return (
        electronAPI?.voice?.sendCommand({ type: 'voice:models:download', modelId }) ??
        Promise.resolve()
      )
    },
    setVolume: (value: number) => {
      const clamped = Math.max(0, Math.min(1, value))
      volumeRef.current = clamped
      playbackRef.current?.setVolume(clamped)
      setState((s) => ({ ...s, volume: clamped }))
      // 持久化到主进程配置（异步，不阻塞 UI）
      const electronAPI = (window as any).electronAPI
      electronAPI?.voice?.sendCommand({
        type: 'voice:config:set',
        config: { tts: { volume: clamped } },
      }).catch(() => {})
    },
    setSpeed: async (value: number) => {
      const electronAPI = (window as any).electronAPI
      setState((s) => ({ ...s, speed: value }))
      await electronAPI?.voice?.sendCommand({
        type: 'voice:config:set',
        config: { tts: { speed: value } },
      }).catch(() => {})
    },
    setSpeakerId: async (id: number) => {
      const electronAPI = (window as any).electronAPI
      setState((s) => ({ ...s, speakerId: id }))
      await electronAPI?.voice?.sendCommand({
        type: 'voice:config:set',
        config: { tts: { speakerId: id } },
      }).catch(() => {})
    },
    setEdgeVoice: async (voice: string) => {
      const electronAPI = (window as any).electronAPI
      setState((s) => ({ ...s, edgeVoice: voice }))
      await electronAPI?.voice?.sendCommand({
        type: 'voice:config:set',
        config: { tts: { voice } },
      }).catch(() => {})
    },
  }

  return [state, actions]
}
