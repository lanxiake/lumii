// @refresh reset
// 自定义 hook 的 hook 数量变化时，Fast Refresh 会保留调用方（ChatPage）的 hook 单元，
// 于是报 "Should have a queue"。hook 无法让调用方重挂载，只能整页重载。
if (import.meta.hot) {
  import.meta.hot.accept(() => window.location.reload())
}
/**
 * useVoiceCall Hook
 * 管理语音通话完整生命周期：麦克风采集 → IPC → 状态管理 → 播放
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { AudioPlaybackEngine } from './audio-playback.js'
import { DuckFloorTracker, DUCK_TIMEOUT_MS } from './voice-duck.js'
import { loadAudioWorkletModule } from './load-audio-worklet.js'
import { loadCaptureConfig, micConstraints } from './capture-constraints.js'
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
  /** 流式引擎的中间识别结果（说话途中不断更新） */
  partialTranscript: string
  /** 已认出、还在提交窗口里等用户说完（「记下了，继续补充…」） */
  pendingTranscript: string
  finalTranscript: string
  /** 最近一次定稿的时刻；状态条据此播一闪"已定稿"再复位（0 = 没有） */
  finalAt: number
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
  /**
   * 静默实时朗读是否激活（silent micless 通话进行中）。不驱动 VoiceCallPanel，
   * 仅供右上角「实时朗读」开关判断按钮态。
   */
  readAloudActive: boolean
  /** 静默实时朗读当前是否正在出声（speaking），供按钮波纹动画 */
  readAloudSpeaking: boolean
  /**
   * 朗读期间的打断策略（主进程权威，渲染侧只读）。
   * `two-stage` 时渲染侧才做压音；`direct` 交给主进程直接判，`mute` 不听。
   */
  interruptMode: 'mute' | 'two-stage' | 'direct'
}

export interface VoiceCallActions {
  startCall: (
    sessionKey: string,
    agentId?: string,
    opts?: { micless?: boolean; persistent?: boolean; silent?: boolean; composerOwned?: boolean },
  ) => Promise<void>
  stopCall: () => Promise<void>
  /** 消费最终转写（composer 自动发送后清空，避免 effect 重入） */
  clearFinalTranscript: () => void
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
    pendingTranscript: '',
    finalTranscript: '',
    finalAt: 0,
    isModelReady: false,
    error: null,
    analyserNode: null,
    playbackAnalyserNode: null,
    charPulsePoll: null,
    isAudioPlaying: null,
    volume: 1.0,
    speed: 1.2,
    speakerId: 0,
    ttsProvider: 'edge',
    edgeVoice: 'zh-CN-XiaoxiaoNeural',
    readAloudActive: false,
    readAloudSpeaking: false,
    interruptMode: 'two-stage',
  })

  // 静默实时朗读标志：事件处理器据此把状态写入 readAloud* 而非驱动 VoiceCallPanel 的 state
  const silentRef = useRef(false)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const playbackRef = useRef<AudioPlaybackEngine | null>(null)
  const callIdRef = useRef<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const volumeRef = useRef<number>(1.0)

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
        if (cfg?.interruptMode) {
          setState((s) => ({ ...s, interruptMode: cfg.interruptMode }))
        }
      })
      .catch(() => {})
  }, [])

  // ── 两段式打断：speaking 期间监听麦克风能量，疑似开口先压音 ──────────────
  //
  // 为什么不直接掐断：本地没有服务端 VAD，误判一次就是"AI 说到一半被打断"。
  // 压音只损失几百毫秒的音量，确认是真语音后主进程会推 interrupted 事件，
  // 那时才 flush() 真正停播并提交转写。
  //
  // 时长参考（2026-10 核对）：LiveKit interruption min_duration=500ms、
  // sherpa min_speech_duration=250ms、Pipecat start_secs=200ms。
  // 取 300ms 在中间——短于它的多半是"嗯/咳"这类语气或回声残留。
  //
  // 门槛不写死：按当前环境底噪估，夹在 0.015~0.06（见 voice-duck.ts 的 G3 说明）。
  // 压音后 DUCK_TIMEOUT_MS 内没等到主进程确认就自动回弹——否则嘈杂环境下
  // 渲染侧在 0.02~0.075 之间压着、主进程永远不认，用户听感是"AI 突然很小声"。
  useEffect(() => {
    // 压音只属于两段式：direct 档要的是最快响应（压音反而拖慢打断手感），
    // mute 档主进程根本不听，压不压都没意义。
    if (state.state !== 'speaking' || state.interruptMode !== 'two-stage') {
      playbackRef.current?.unduck()
      return
    }
    const analyser = analyserRef.current
    const playback = playbackRef.current
    if (!analyser || !playback) return

    const TICK_MS = 100
    const SPEECH_TICKS_TO_DUCK = 3 // 300ms
    const QUIET_TICKS_TO_UNDUCK = 5 // 500ms
    const floorTracker = new DuckFloorTracker()

    const buf = new Uint8Array(analyser.fftSize)
    let loudTicks = 0
    let quietTicks = 0
    let duckedAt = 0
    const timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i]! - 128) / 128
        sum += v * v
      }
      const rms = Math.sqrt(sum / buf.length)

      // 没压音时才更新底噪：把 AI 回采/用户说话的能量算进底噪会自我抬高门槛
      if (!playback.isDucked) floorTracker.push(rms)
      const threshold = floorTracker.threshold()

      if (rms > threshold) {
        loudTicks++
        quietTicks = 0
        if (loudTicks >= SPEECH_TICKS_TO_DUCK && !playback.isDucked) {
          playback.duck()
          duckedAt = Date.now()
        }
      } else {
        loudTicks = 0
        if (playback.isDucked && ++quietTicks >= QUIET_TICKS_TO_UNDUCK) {
          playback.unduck()
          quietTicks = 0
          duckedAt = 0
        }
      }

      // 兜底回弹：压了半天主进程也没确认（门槛口径不一致 / 只是环境噪声）
      if (playback.isDucked && duckedAt > 0 && Date.now() - duckedAt > DUCK_TIMEOUT_MS) {
        playback.unduck()
        duckedAt = 0
        quietTicks = 0
      }
    }, TICK_MS)

    return () => {
      window.clearInterval(timer)
      playback.unduck()
    }
  }, [state.state, state.interruptMode])

  // ── 订阅主进程语音事件 ──────────────────────────────────────────────────

  useEffect(() => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice?.onEvent) return

    const unsubscribe = electronAPI.voice.onEvent((event: any) => {
      switch (event.type) {
        case 'voice:call:state':
          // 静默实时朗读：不驱动 VoiceCallPanel 的 state，只映射到 readAloudSpeaking 供按钮波纹
          if (silentRef.current) {
            setState((s) => ({ ...s, readAloudSpeaking: event.state === 'speaking' }))
            break
          }
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
              pendingTranscript: '',
              finalAt: Date.now(),
            }))
          } else if (event.phase === 'pending') {
            // 认出来了但还在提交窗口里等用户说完：留在 pending，别覆盖成 partial
            setState((s) => ({ ...s, pendingTranscript: event.text, partialTranscript: '' }))
          } else {
            // 新的一句开始了：上一句的 pending 已经定稿或作废，别让状态条同时挂着两段
            setState((s) => ({ ...s, partialTranscript: event.text, pendingTranscript: '' }))
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
          if (silentRef.current) {
            silentRef.current = false
            setState((s) => ({ ...s, readAloudActive: false, readAloudSpeaking: false, callId: null }))
          } else {
            setState((s) => ({ ...s, state: 'idle', callId: null }))
          }
          callIdRef.current = null
          break

        case 'voice:error':
          setState((s) => ({ ...s, state: 'error', error: event.message }))
          break

        case 'voice:config:updated':
          // 配置更新推送：热更新音量（渲染侧 GainNode），同步速度/音色状态
          if (event.config?.interruptMode) {
            setState((s) => ({ ...s, interruptMode: event.config.interruptMode }))
          }
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

  const startCall = useCallback(async (
    sessionKey: string,
    agentId?: string,
    opts?: { micless?: boolean; persistent?: boolean; silent?: boolean; composerOwned?: boolean },
  ) => {
    const micless = opts?.micless === true
    const persistent = opts?.persistent === true
    const silent = opts?.silent === true
    const composerOwned = opts?.composerOwned === true
    silentRef.current = silent
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice) {
      setState((s) => ({ ...s, error: '语音 API 不可用' }))
      return
    }

    // 静默实时朗读不占用 VoiceCallPanel：不写 state，改标记 readAloudActive
    if (silent) {
      setState((s) => ({ ...s, readAloudActive: true, readAloudSpeaking: false, error: null }))
    } else {
      setState((s) => ({ ...s, state: 'initializing' as VoiceCallState, error: null }))
    }

    try {
      let source: MediaStreamAudioSourceNode | null = null
      let workletNode: AudioWorkletNode | null = null

      // micless 模式（文字回复出声）：不采麦，只建播放管线 + AnalyserNode 供真口型。
      if (!micless) {
        // 1. 请求麦克风权限（约束来自设置页；改动需重开通话，见 capture-constraints.ts）
        const stream = await navigator.mediaDevices.getUserMedia(micConstraints(await loadCaptureConfig()))
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
        persistent,
        ...(composerOwned ? { composerOwned: true } : {}),
      })

      if (result?.error === 'models_not_ready') {
        silentRef.current = false
        setState((s) => ({
          ...s,
          state: silent ? s.state : 'idle',
          readAloudActive: false,
          readAloudSpeaking: false,
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
      const wasSilent = silentRef.current
      silentRef.current = false

      // 清理资源
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      await audioCtxRef.current?.close().catch(() => {})
      audioCtxRef.current = null

      // 静默朗读失败不弹通话错误面板，只复位开关态
      if (wasSilent) {
        setState((s) => ({ ...s, readAloudActive: false, readAloudSpeaking: false }))
      } else {
        setState((s) => ({
          ...s,
          state: 'error',
          error: errorMessage.includes('Permission')
            ? '麦克风权限被拒绝，请在系统设置中允许访问麦克风'
            : `启动语音通话失败: ${errorMessage}`,
        }))
      }
    }
  }, [])

  // ── 结束通话 ──────────────────────────────────────────────────────────

  const stopCall = useCallback(async () => {
    const electronAPI = (window as any).electronAPI
    silentRef.current = false

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
      pendingTranscript: '',
      finalTranscript: '',
      finalAt: 0,
      analyserNode: null,
      playbackAnalyserNode: null,
      charPulsePoll: null,
      isAudioPlaying: null,
      readAloudActive: false,
      readAloudSpeaking: false,
    }))
  }, [])

  const clearFinalTranscript = useCallback(() => {
    setState((s) => (s.finalTranscript ? { ...s, finalTranscript: '' } : s))
  }, [])

  const actions: VoiceCallActions = {
    startCall,
    stopCall,
    clearFinalTranscript,
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
      const clamped = Math.max(0, Math.min(2, value))
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
