/**
 * 语音通话核心服务
 * 协调 VAD / ASR / TTS / 状态机，与 AgentRuntime 对接
 */
import { type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { VadEngine } from './vad-engine.js'
import { createAsrProvider, type AsrProvider, type AsrStream } from './asr-engine.js'
import { createTtsProvider, type TtsProvider } from './tts-engine.js'
import { SentenceSplitter } from './sentence-splitter.js'
import { VoiceCallStateMachine } from './voice-state-machine.js'
import { type VoiceModelManager } from './model-manager.js'
import { voiceEventBus } from './voice-event-bus.js'
import type { VoiceEngineConfig, VoiceRuntimePhase } from '../../shared/voice-events.js'
import type { TtsChunk } from './tts-engine.js'
import { VoiceProfileStore } from './voice-profile-store.js'
import {
  buildTtsPreviewCacheKey,
  ttsPreviewCache,
  TTS_PREVIEW_CACHE_MAX_TEXT_CHARS,
} from './tts-preview-cache.js'
import { stripVirtualHumanTags } from '../../shared/virtual-human.js'
import { setQwen3TtsStatusCallback, resolveQwen3LoadDevice, prepareQwen3TtsRuntime } from './qwen3-tts-client.js'

const log = {
  info: (...args: unknown[]) => console.log('[VoiceService]', ...args),
  debug: (...args: unknown[]) => console.log('[VoiceService:DEBUG]', ...args),
  warn: (...args: unknown[]) => console.warn('[VoiceService]', ...args),
  error: (...args: unknown[]) => console.error('[VoiceService]', ...args),
}

/**
 * voice:event 镜像目标（除主窗口外的额外接收者）。
 * 宠物模式独立窗口需收到 voice:tts:chunk / voice:call:state 等事件做口型与动画，
 * 但不在主窗口渲染上下文，故注册其 WebContents 到此处接收同样的广播。
 */
const mirrorWebContents = new Set<Electron.WebContents>()

/** 注册一个额外的 voice:event 接收者（如宠物窗口），返回注销函数 */
export function addVoiceEventMirror(wc: Electron.WebContents): () => void {
  mirrorWebContents.add(wc)
  wc.once('destroyed', () => mirrorWebContents.delete(wc))
  return () => mirrorWebContents.delete(wc)
}

export class VoiceCallService {
  private callId: string | null = null
  private sessionKey: string | null = null
  private vad: VadEngine | null = null
  private asrProvider: AsrProvider | null = null
  private asrStream: AsrStream | null = null
  private ttsProvider: TtsProvider | null = null
  private stateMachine = new VoiceCallStateMachine()
  private splitter = new SentenceSplitter()
  private ttsAbort: AbortController | null = null
  private agentEventUnsubscribe: (() => void) | null = null
  private ttsQueue: Array<{ text: string }> = []
  private isTtsBusy = false
  private ttsGeneration = 0
  private initialized = false
  /** TTS 引擎是否已单独初始化（预览/生成文件可不依赖 VAD/ASR） */
  private ttsInitialized = false
  private config: VoiceEngineConfig
  /** 上一次推送的 partial ASR 文字，用于去重 */
  private _lastPartial = ''
  /** 噪声基线（RMS），通话开始后前 N 帧估算 */
  private noiseBaseline = 0.01
  private noiseFrameCount = 0
  private readonly NOISE_ESTIMATE_FRAMES = 30 // 约 1s 的静音帧估算噪声基线
  /** 打断冷却 */
  private lastInterruptTime = 0
  private readonly INTERRUPT_COOLDOWN_MS = 600
  /**
   * speaking 状态下，语音段 RMS 超过此倍数才做 ASR 打断检测（过滤回声）
   * 降低到 2.5x：浏览器 echoCancellation 已做了一层，RMS 门槛不需要太高
   */
  private readonly INTERRUPT_RMS_MULTIPLIER = 2.5
  /**
   * TTS 播放后冷却期（防止 TTS 音频被麦克风拾取后误识别为用户语音）
   * 主进程合成完成时设为 2500ms；渲染侧通知播放完毕后缩短至 600ms
   */
  private postSpeechCooldownUntil = 0
  private readonly POST_SPEECH_COOLDOWN_MS = 2500
  /** 最近一次 ASR 识别所用的原始语音段（PCM Float32, 16kHz），用于回放 */
  private _lastSpeechSegment: Float32Array | null = null
  /** micless 模式：文字回复出声（不采麦），仅做 TTS 播放，结束回 idle 而非 listening */
  private micless = false
  private profileStore = new VoiceProfileStore()

  constructor(
    private win: BrowserWindow,
    /** 提交用户消息给 Agent 的回调（由 agent-runtime-ipc 注入） */
    private submitAgentMessage: (sessionKey: string, content: string, audioWavBase64?: string) => Promise<void>,
    private modelManager: VoiceModelManager,
    config?: Partial<VoiceEngineConfig>,
  ) {
    this.config = {
      asr: {
        provider: 'local-paraformer',
        language: 'zh',
        ...config?.asr,
      },
      tts: {
        provider: 'edge',
        speed: 1.0,
        volume: 0.8,
        ...config?.tts,
      },
      vad: {
        threshold: 0.6,
        minSpeechMs: 300,
        minSilenceMs: 500,
        energyGateMultiplier: 1.5,
        ...config?.vad,
      },
      autoMuteMicWhileSpeaking: config?.autoMuteMicWhileSpeaking ?? true,
    }

    this.stateMachine.on('state', ({ to }: { from: string; to: string }) => {
      this.pushVoiceEvent({
        type: 'voice:call:state',
        callId: this.callId ?? '',
        state: to as any,
        timestamp: Date.now(),
      })
    })

    // 将 Qwen3 安装/加载等长耗时步骤推到设置页等 UI
    setQwen3TtsStatusCallback((phase, message, detail) => {
      this.emitRuntimeStatus(phase, message, detail)
    })
  }

  /**
   * 推送运行时状态（依赖安装、模型加载等）给渲染进程
   */
  private emitRuntimeStatus(phase: VoiceRuntimePhase, message: string, detail?: string): void {
    this.pushVoiceEvent({
      type: 'voice:runtime:status',
      phase,
      message,
      detail,
    })
  }

  // ── 惰性初始化 ─────────────────────────────────────────────────────────

  /**
   * 仅初始化 TTS 引擎（消息朗读预览、生成音频文件等场景）
   * 不依赖 VAD/ASR 本地模型，Edge TTS 可直接联网合成
   */
  async ensureTtsInitialized(): Promise<void> {
    if (this.ttsInitialized && this.ttsProvider) return

    const cloneOn =
      this.config.tts.qwen3CloneEnabled === true && Boolean(this.config.tts.qwen3ProfileId)
    const variant = cloneOn
      ? (this.config.tts.qwen3CloneVariant ?? '0.6b-base')
      : (() => {
          const v = this.config.tts.qwen3Variant ?? '0.6b-custom'
          return v === '0.6b-base' || v === '1.7b-base' ? '0.6b-custom' : v
        })()

    if (!this.modelManager.isTtsReady(this.config.tts.provider, variant)) {
      throw new Error('TTS 模型未下载，请前往「设置 → 语音」下载本地模型，或切换为 Edge TTS')
    }

    this.emitRuntimeStatus(
      'starting_engine',
      this.config.tts.provider === 'qwen3'
        ? '正在初始化本地语音合成（可能包含依赖安装与模型加载）…'
        : '正在初始化语音合成引擎…',
    )
    log.info(`[ensureTtsInitialized] 初始化 TTS 引擎... clone=${cloneOn} variant=${variant}`)
    const paths = await this.modelManager.getModelPaths()

    let refAudio: string | undefined
    let refText: string | undefined
    let xVectorOnly: boolean | undefined
    let language = this.config.tts.language ?? 'Auto'
    let mode: 'custom' | 'clone' = 'custom'
    let speaker = this.config.tts.qwen3Speaker ?? 'Vivian'
    const instruct = this.config.tts.qwen3Instruct

    if (this.config.tts.provider === 'qwen3' && cloneOn) {
      mode = 'clone'
      const profileId = this.config.tts.qwen3ProfileId!
      const profile = this.profileStore.get(profileId)
      if (!profile) {
        throw new Error(`克隆音色不存在: ${profileId}`)
      }
      refAudio = this.profileStore.getRefAudioPath(profile)
      refText = profile.refText
      xVectorOnly = profile.xVectorOnly
      language = this.config.tts.language || profile.language || 'Auto'
    }

    const qwenModelDir = (() => {
      switch (variant) {
        case '1.7b-custom':
          return paths.qwen3Custom17
        case '0.6b-base':
          return paths.qwen3Base06
        case '1.7b-base':
          return paths.qwen3Base17
        case '0.6b-custom':
        default:
          return paths.qwen3Custom06
      }
    })()

    this.ttsProvider = createTtsProvider({
      provider: this.config.tts.provider,
      modelDir: this.config.tts.provider === 'qwen3' ? qwenModelDir : paths.tts,
      tokenizerDir: paths.qwen3Tokenizer,
      speed: this.config.tts.speed,
      voice: this.config.tts.voice,
      language,
      mode,
      speaker,
      instruct,
      refAudio,
      refText,
      xVectorOnly,
      device: resolveQwen3LoadDevice(this.config.tts.qwen3Device ?? 'auto'),
    })
    if (this.config.tts.provider === 'qwen3') {
      await prepareQwen3TtsRuntime(this.config.tts.qwen3Device ?? 'auto')
    }
    await this.ttsProvider.initialize()
    this.ttsInitialized = true
    this.emitRuntimeStatus('ready', '语音合成引擎就绪')
    log.info('[ensureTtsInitialized] TTS 引擎就绪')
  }

  /**
   * 解析当前应加载的 Qwen3 变体（克隆开关开启且有档案时用 Base）
   */
  resolveActiveQwen3Variant(): string {
    const tts = this.config.tts
    if (tts.qwen3CloneEnabled === true && tts.qwen3ProfileId) {
      return tts.qwen3CloneVariant ?? '0.6b-base'
    }
    const v = tts.qwen3Variant ?? '0.6b-custom'
    if (v === '0.6b-base' || v === '1.7b-base') return '0.6b-custom'
    return v
  }

  /** 暴露音色档案存储给 IPC */
  getProfileStore(): VoiceProfileStore {
    return this.profileStore
  }

  /** 初始化完整语音通话链路（VAD + ASR + TTS） */
  async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    log.info('[ensureInitialized] 初始化语音引擎...')

    if (!this.modelManager.areRequiredModelsReady(
      this.config.tts.provider,
      this.resolveActiveQwen3Variant(),
    )) {
      throw new Error('语音模型未就绪，请先下载所需本地模型（设置 → 语音设置）')
    }

    const paths = await this.modelManager.getModelPaths()

    // VAD
    this.vad = new VadEngine(paths.vad)
    await this.vad.initialize(
      this.config.vad.threshold,
      this.config.vad.minSpeechMs,
      this.config.vad.minSilenceMs,
    )

    // ASR
    this.asrProvider = createAsrProvider({
      provider: this.config.asr.provider,
      modelDir: paths.asr,
      apiKey: this.config.asr.apiKey,
    })
    await this.asrProvider.initialize()

    await this.ensureTtsInitialized()

    this.initialized = true
    log.info('[ensureInitialized] 语音引擎全部就绪')
  }

  // ── 开始通话 ────────────────────────────────────────────────────────────

  async startCall(sessionKey: string, agentId?: string, opts?: { micless?: boolean }): Promise<string> {
    const micless = opts?.micless === true
    this.micless = micless
    log.info(`[startCall] sessionKey=${sessionKey}, agentId=${agentId}, micless=${micless}`)

    // 文字回复出声（micless）仅需 TTS；完整语音通话需要 VAD + ASR + TTS
    if (micless) {
      await this.ensureTtsInitialized()
    } else {
      await this.ensureInitialized()
    }

    // 宠物模式：激活该会话的 VH Prompt 上下文（表情/动作/persona 注入）
    await this.activateVirtualHumanContextIfPetMode(sessionKey)

    this.callId = randomUUID()
    this.sessionKey = sessionKey
    // micless 不采麦，无需 ASR 流；普通通话才创建
    this.asrStream = micless ? null : this.asrProvider!.createStream()
    this.splitter.reset()
    this.noiseBaseline = 0.01
    this.noiseFrameCount = 0
    this.lastInterruptTime = 0
    this.postSpeechCooldownUntil = 0
    this._lastPartial = ''

    this.stateMachine.reset()
    // micless 起始即 thinking（等待文字回复 TTS），普通通话进 listening 等用户说话
    this.stateMachine.transition(micless ? 'thinking' : 'listening')
    this.subscribeAgentEvents()

    log.info(`[startCall] 通话开始, callId=${this.callId}`)
    return this.callId
  }

  /**
   * 若当前处于虚拟人（pet）模式，解析并激活该会话的 VH Prompt 上下文。
   * 委托共享实现（virtual-human-context），与文字发送链路共用激活逻辑。
   */
  private async activateVirtualHumanContextIfPetMode(sessionKey: string): Promise<void> {
    try {
      const { activateVirtualHumanContextForSession } = await import('../pet/virtual-human-context')
      await activateVirtualHumanContextForSession(sessionKey)
    } catch (err) {
      log.warn(`[activateVirtualHumanContextIfPetMode] 跳过: ${(err as Error).message}`)
    }
  }

  /** 清除会话的虚拟人 Prompt 上下文 */
  private async clearVirtualHumanContext(sessionKey: string): Promise<void> {
    try {
      const { clearVirtualHumanContext } = await import('../pet/virtual-human-activation')
      clearVirtualHumanContext(sessionKey)
    } catch {
      // 忽略
    }
  }

  /** 非宠物模式才清除 VH 上下文；宠物模式连续对话需保持注入态 */
  private async clearVirtualHumanContextIfNotPetMode(sessionKey: string): Promise<void> {
    try {
      const { getPetWindowManager } = await import('../pet/pet-mode-ipc')
      if (getPetWindowManager()?.getMode() === 'pet') return
      await this.clearVirtualHumanContext(sessionKey)
    } catch {
      await this.clearVirtualHumanContext(sessionKey)
    }
  }

  // ── 处理音频帧 ──────────────────────────────────────────────────────────

  async handleAudioChunk(samples: Float32Array): Promise<void> {
    if (!this.callId || !this.asrStream) return

    // VAD 处理，返回已完成的语音段（静音后才返回）
    const speechSegments = this.vad!.push(samples)
    const isSpeaking = this.vad!.isSpeechDetected()

    // 噪声基线：初始阶段前 N 帧做均值估算，之后在 listening 时持续 EMA 更新
    if (!isSpeaking) {
      const rms = this._calcRms(samples)
      if (this.noiseFrameCount < this.NOISE_ESTIMATE_FRAMES) {
        this.noiseBaseline = (this.noiseBaseline * this.noiseFrameCount + rms) / (this.noiseFrameCount + 1)
        this.noiseFrameCount++
      } else if (this.stateMachine.is('listening')) {
        this.noiseBaseline = this.noiseBaseline * 0.95 + rms * 0.05
      }
    }

    // ── AI 说话时，通过 ASR 检测用户打断 ──────────────────────────────────
    // 不用 RMS 能量检测（易被噪声/回声误触发），
    // 而是对 VAD 返回的完整语音段做 ASR，识别出有意义文字才打断。
    // 这也能防止 TTS 回声触发打断：
    //   - 浏览器 echoCancellation 是第一道防线
    //   - 回声能量低于直接说话，RMS 门槛过滤大部分回声段
    //   - 即使回声段通过，ASR 在短段回声上往往返回空文本
    if (this.stateMachine.is('speaking')) {
      // 自动闭麦：AI 朗读期间不做任何用户语音检测/打断，避免 TTS 回采成输入（需求4）。
      // 朗读结束状态机回 listening 后自动恢复，无需显式解麦。
      if (this.config.autoMuteMicWhileSpeaking) {
        return
      }
      for (const segment of speechSegments) {
        // 能量门槛：过滤低能量回声（回声经过扬声器→空气→麦克风衰减较大）
        const segRms = this._calcSegmentRms(segment)
        if (segRms < this.noiseBaseline * this.INTERRUPT_RMS_MULTIPLIER) {
          log.debug(`[handleAudioChunk] speaking 阶段语音段能量不足 (rms=${segRms.toFixed(4)}, baseline=${this.noiseBaseline.toFixed(4)})，跳过`)
          continue
        }

        // 冷却检查
        if (Date.now() - this.lastInterruptTime < this.INTERRUPT_COOLDOWN_MS) continue

        // 用临时 ASR 流识别该语音段
        const tempStream = this.asrProvider!.createStream()
        tempStream.feed(segment)
        const interruptText = tempStream.resetAndGetResult().trim()
        tempStream.destroy()

        if (interruptText.length >= 2) {
          log.info(`[handleAudioChunk] 检测到用户打断语音: "${interruptText}"`)
          this.lastInterruptTime = Date.now()
          await this.handleInterrupt()

          // 将打断时识别的文字提交给 Agent
          this._lastSpeechSegment = segment  // 保存原始语音段用于回放
          this.pushVoiceEvent({
            type: 'voice:transcript',
            callId: this.callId!,
            text: interruptText,
            isFinal: true,
          })
          await this.submitToAgent(interruptText)

          // 重建 ASR 流
          this.asrStream?.destroy()
          this.asrStream = this.asrProvider!.createStream()
          return
        }
      }
      return // speaking 期间不做常规 ASR 处理
    }

    // ── listening / recognizing 常规流程 ──────────────────────────────────

    // TTS 后冷却期：跳过 ASR，防止 TTS 回声被误识别为用户语音
    if (Date.now() < this.postSpeechCooldownUntil) {
      log.debug(`[handleAudioChunk] TTS 冷却期内，跳过 ASR (剩余 ${this.postSpeechCooldownUntil - Date.now()}ms)`)
      return
    }

    // 检测到语音 → 切换到 recognizing
    if (isSpeaking && this.stateMachine.is('listening')) {
      this.stateMachine.transition('recognizing')
    }

    // 流式 partial ASR：VAD 检测到语音时，实时推送中间识别结果（仅 Streaming 引擎有效）
    if (isSpeaking && this.asrStream && this.stateMachine.isOneOf('listening', 'recognizing')) {
      const partial = this.asrStream.getPartialText()
      if (partial && partial !== this._lastPartial) {
        this._lastPartial = partial
        this.pushVoiceEvent({
          type: 'voice:transcript',
          callId: this.callId,
          text: partial,
          isFinal: false,
        })
      }
    }

    // 处理 VAD 返回的完整语音段（离线 ASR 模式）
    for (const segment of speechSegments) {
      if (!this.stateMachine.isOneOf('listening', 'recognizing')) break

      // 轻量能量门槛（"负面语音阈值"）：过滤低能量噪音段，避免背景噪声/回声误触发 ASR。
      // 倍率可配（energyGateMultiplier），越大越严格。
      const segRms = this._calcSegmentRms(segment)
      if (segRms < this.noiseBaseline * this.config.vad.energyGateMultiplier) {
        log.debug(`[handleAudioChunk] listening 阶段能量不足 (rms=${segRms.toFixed(4)}, baseline=${this.noiseBaseline.toFixed(4)})，跳过`)
        if (this.stateMachine.is('recognizing')) {
          this.stateMachine.transition('listening')
        }
        continue
      }

      this.asrStream.feed(segment)
      const finalText = this.asrStream.resetAndGetResult()
      this._lastPartial = ''
      log.info(`[handleAudioChunk] ASR 识别结果: "${finalText}"`)

      if (finalText.trim().length > 0) {
        this._lastSpeechSegment = segment  // 保存原始语音段用于回放
        this.pushVoiceEvent({
          type: 'voice:transcript',
          callId: this.callId,
          text: finalText,
          isFinal: true,
        })
        await this.submitToAgent(finalText)
      } else {
        if (this.stateMachine.is('recognizing')) {
          this.stateMachine.transition('listening')
        }
      }

      // 重建 ASR 流准备下一轮
      this.asrStream.destroy()
      this.asrStream = this.asrProvider!.createStream()
    }

    // 没有完整段且静音 + 正在识别 → 回到 listening
    if (speechSegments.length === 0 && !isSpeaking && this.stateMachine.is('recognizing')) {
      this.stateMachine.transition('listening')
    }
  }

  // ── 提交 ASR 结果给 Agent ──────────────────────────────────────────────

  private async submitToAgent(text: string): Promise<void> {
    if (!this.sessionKey) {
      log.warn('[submitToAgent] sessionKey 为空，语音识别结果已丢弃，请确保宠物模式已绑定会话')
      if (this.stateMachine.is('recognizing')) {
        this.stateMachine.transition('listening')
      }
      return
    }
    this.stateMachine.transition('thinking')

    // 每条语音消息末尾追加上下文注释，让 Agent 感知当前是语音输入
    // 使用括号格式避免 Agent 将其误判为链接或附件
    const content = `${text}（语音输入）`

    // 将最近语音段编码为 WAV base64，用于 UI 回放
    const audioWavBase64 = this._lastSpeechSegment
      ? this._encodePcmToWavBase64(this._lastSpeechSegment, 16000)
      : undefined
    this._lastSpeechSegment = null

    log.info(`[submitToAgent] 发送给 Agent: "${text}"`)
    await this.submitAgentMessage(this.sessionKey, content, audioWavBase64)
  }

  /** 将 Float32 PCM 数据编码为 WAV 格式并返回 base64 字符串 */
  private _encodePcmToWavBase64(samples: Float32Array, sampleRate: number): string {
    const numChannels = 1
    const bitsPerSample = 16
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
    const blockAlign = (numChannels * bitsPerSample) / 8
    const dataSize = samples.length * 2 // Int16
    const headerSize = 44
    const buf = Buffer.allocUnsafe(headerSize + dataSize)
    // RIFF header
    buf.write('RIFF', 0)
    buf.writeUInt32LE(36 + dataSize, 4)
    buf.write('WAVE', 8)
    buf.write('fmt ', 12)
    buf.writeUInt32LE(16, 16) // PCM chunk size
    buf.writeUInt16LE(1, 20)  // PCM format
    buf.writeUInt16LE(numChannels, 22)
    buf.writeUInt32LE(sampleRate, 24)
    buf.writeUInt32LE(byteRate, 28)
    buf.writeUInt16LE(blockAlign, 32)
    buf.writeUInt16LE(bitsPerSample, 34)
    buf.write('data', 36)
    buf.writeUInt32LE(dataSize, 40)
    // PCM samples
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]!))
      buf.writeInt16LE(Math.round(s * 32767), headerSize + i * 2)
    }
    return buf.toString('base64')
  }

  // ── 订阅 Agent 输出，驱动 TTS ─────────────────────────────────────────

  /** 判断 Agent 事件是否属于当前通话会话（兼容 rootSessionKey / sessionKey 双键） */
  private eventMatchesSession(event: { sessionKey?: string; rootSessionKey?: string }): boolean {
    if (!this.sessionKey) return false
    const root = event.rootSessionKey ?? event.sessionKey
    const sk = event.sessionKey
    return root === this.sessionKey || sk === this.sessionKey
  }

  private subscribeAgentEvents(): void {
    log.info(`[subscribeAgentEvents] 开始订阅 Agent 事件, sessionKey=${this.sessionKey}`)

    const onDelta = (event: any) => {
      if (event.type !== 'agent:message:delta') return
      if (!this.eventMatchesSession(event)) return
      if (!this.callId) return

      if (this.stateMachine.is('thinking')) {
        log.info('[onDelta] thinking → speaking, 开始 TTS')
        this.stateMachine.transition('speaking')
      }

      // 剥离虚拟人标签（[emotion] / <vh_action>），保证标签不进入朗读（ADR-13）
      const sentences = this.splitter.feed(stripVirtualHumanTags(event.delta ?? ''))
      for (const sentence of sentences) {
        log.info(`[onDelta] 入队 TTS 句子: "${sentence.slice(0, 40)}"`)
        this.enqueueTts(sentence)
      }
    }

    const onEnd = (event: any) => {
      if (event.type !== 'agent:message:end') return
      if (!this.eventMatchesSession(event)) return
      if (!this.callId) return

      const remaining = this.splitter.flush()
      log.info(`[onEnd] agent:message:end, 剩余文本="${remaining.slice(0, 40)}"`)
      if (remaining.length > 0) {
        this.enqueueTts(remaining)
      }
    }

    voiceEventBus.on('agent-event', onDelta)
    voiceEventBus.on('agent-event', onEnd)

    this.agentEventUnsubscribe = () => {
      voiceEventBus.off('agent-event', onDelta)
      voiceEventBus.off('agent-event', onEnd)
    }
  }

  // ── TTS 合成队列 ────────────────────────────────────────────────────────

  private enqueueTts(text: string): void {
    const cleaned = this._cleanTtsText(text)
    if (!cleaned) return

    this.ttsQueue.push({ text: cleaned })
    if (!this.isTtsBusy) {
      this.processTtsQueue().catch((e) => {
        log.error(`[enqueueTts] processTtsQueue 未捕获错误: ${(e as Error).message}`)
      })
    }
  }

  private async processTtsQueue(): Promise<void> {
    const gen = this.ttsGeneration
    this.isTtsBusy = true
    let chunkIndex = 0

    while (this.ttsQueue.length > 0 && gen === this.ttsGeneration) {
      const { text } = this.ttsQueue.shift()!
      this.ttsAbort = new AbortController()

      log.info(`[processTtsQueue] 合成句子: "${text}"`)

      try {
        await this.ttsProvider!.synthesize(
          text,
          (chunk) => {
            if (!this.callId || gen !== this.ttsGeneration) return
            const samples = Array.from(chunk.samples)
            log.info(`[processTtsQueue] 发送 TTS 音频块 chunkIdx=${chunkIndex} samples=${samples.length} isFinal=${chunk.isFinal}`)
            this.pushVoiceEvent({
              type: 'voice:tts:chunk',
              callId: this.callId,
              samples,
              sampleRate: chunk.sampleRate,
              chunkIndex: chunkIndex++,
              isFinal: chunk.isFinal,
              /** 本句清洁文字，每个 chunk 都带，供渲染侧按字数+音频时长计算逐字口型脉冲间隔。 */
              text,
            })
          },
          this.ttsAbort.signal,
        )
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          log.error(`[processTtsQueue] TTS 合成失败: ${(e as Error).message}`)
        }
      }
    }

    // 仅当 generation 未变（没有被打断）时才更新状态
    if (gen === this.ttsGeneration) {
      this.isTtsBusy = false
      // TTS 合成完成，设置冷却期防回声（渲染侧音频仍在播放）
      this.postSpeechCooldownUntil = Date.now() + this.POST_SPEECH_COOLDOWN_MS
      log.info(`[processTtsQueue] TTS 合成完成，冷却期 ${this.POST_SPEECH_COOLDOWN_MS}ms`)
      // TTS 队列清空：micless（文字回复）无需回 listening，结束通话回 idle；
      // 普通语音通话回 listening 继续等用户说话。
      if (this.stateMachine.is('speaking')) {
        if (this.micless) {
          this.stateMachine.transition('ending')
          void this.stopCall()
        } else {
          this.stateMachine.transition('listening')
        }
      }
    }
  }

  // ── 打断处理 ───────────────────────────────────────────────────────────

  private async handleInterrupt(): Promise<void> {
    log.info('[handleInterrupt] 用户打断 AI 说话')
    this.ttsGeneration++ // 使旧的 processTtsQueue 自动退出
    this.ttsAbort?.abort()
    this.ttsQueue = []
    this.isTtsBusy = false
    this.splitter.reset()
    this.postSpeechCooldownUntil = 0 // 用户主动说话，立即解除冷却
    // 推送打断事件，通知渲染进程清空播放缓冲
    if (this.callId) {
      this.pushVoiceEvent({
        type: 'voice:call:state',
        callId: this.callId,
        state: 'listening',
        timestamp: Date.now(),
        interrupted: true,
      })
    }
    this.stateMachine.transition('recognizing')
  }

  // ── 结束通话 ───────────────────────────────────────────────────────────

  async stopCall(): Promise<void> {
    if (!this.callId) return
    const callId = this.callId
    log.info(`[stopCall] 结束通话 ${callId}`)

    this.stateMachine.transition('ending')
    this.ttsGeneration++ // 使旧的 processTtsQueue 自动退出
    this.ttsAbort?.abort()
    this.ttsQueue = []
    this.isTtsBusy = false
    this.agentEventUnsubscribe?.()
    this.agentEventUnsubscribe = null
    this.asrStream?.destroy()
    this.asrStream = null
    this.splitter.flush()

    // 清除虚拟人 Prompt 上下文，避免污染普通 Chat（宠物模式下保持激活，供连续文字/语音对话）
    if (this.sessionKey) {
      void this.clearVirtualHumanContextIfNotPetMode(this.sessionKey)
    }

    this.callId = null
    this.sessionKey = null
    this.micless = false

    this.pushVoiceEvent({
      type: 'voice:call:ended',
      callId,
      durationMs: 0,
      reason: 'user_hangup',
    })
  }

  // ── 渲染侧播放完毕通知 ─────────────────────────────────────────────────

  /** 渲染进程通知：TTS 音频已完全播放完毕，可以缩短冷却期 */
  onPlaybackFinished(): void {
    const remaining = this.postSpeechCooldownUntil - Date.now()
    if (remaining > 600) {
      this.postSpeechCooldownUntil = Date.now() + 600
      log.info(`[onPlaybackFinished] 音频播放完毕，冷却缩短至 600ms（原剩余 ${remaining}ms）`)
    }
  }

  // ── TTS 预览（设置页 / 消息朗读） ─────────────────────────────────────────────────

  private previewAbort: AbortController | null = null

  /** 停止当前进行中的 TTS 预览/朗读 */
  stopPreview(): void {
    if (this.previewAbort) {
      this.previewAbort.abort()
      this.previewAbort = null
      log.info('[stopPreview] 预览已中止')
    }
  }

  /**
   * 合成一段试听音频并推送 voice:tts:preview:chunk 事件到渲染进程。
   * 相同文本 + 当前 TTS 配置会命中内存 LRU 缓存，跳过再次调用 TTS（降低 Edge API 等用量）。
   */
  async previewTts(text: string, win: import('electron').BrowserWindow): Promise<void> {
    // 停止上一次预览（如果有）
    this.stopPreview()

    const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text
    log.info(`[previewTts] 开始预览: "${preview}"`)
    const abort = new AbortController()
    this.previewAbort = abort

    /** 通知渲染进程预览结束 */
    const endPreview = (ok: boolean, message?: string) => {
      try {
        if (!win.isDestroyed()) {
          win.webContents.send('voice:event', {
            type: 'voice:tts:preview:ended',
            ok,
            message,
          })
        }
      } catch (e) {
        log.warn(`[previewTts] 推送 preview:ended 失败: ${(e as Error).message}`)
      }
      this.pushVoiceEvent({
        type: 'voice:runtime:status',
        phase: ok ? 'ready' : 'error',
        message: message ?? (ok ? '预览完成，正在播放…' : '预览失败'),
      })
    }

    try {
      this.emitRuntimeStatus('starting_engine', '正在准备语音预览…')
      await this.ensureTtsInitialized()

      const trimmed = text.trim()
      if (!trimmed) {
        endPreview(false, '测试文案为空')
        return
      }

      const cacheKey = buildTtsPreviewCacheKey(text, this.config.tts)
      if (trimmed.length <= TTS_PREVIEW_CACHE_MAX_TEXT_CHARS) {
        const cached = ttsPreviewCache.get(cacheKey)
        if (cached && cached.length > 0) {
          log.info('[previewTts] 缓存命中，跳过 TTS 合成')
          this.emitRuntimeStatus('playing', '正在播放预览（缓存）…')
          let chunkIndex = 0
          for (const chunk of cached) {
            if (win.isDestroyed() || abort.signal.aborted) {
              endPreview(false, '预览已取消')
              return
            }
            try {
              win.webContents.send('voice:event', {
                type: 'voice:tts:preview:chunk',
                samples: chunk.samples,
                sampleRate: chunk.sampleRate,
                chunkIndex: chunkIndex++,
                isFinal: chunk.isFinal,
              })
            } catch (e) {
              log.warn(`[previewTts] IPC 发送失败: ${(e as Error).message}`)
            }
            await new Promise<void>((r) => setImmediate(r))
          }
          endPreview(true)
          return
        }
      }

      this.emitRuntimeStatus('synthesizing', '正在合成预览语音…')
      const recorded: TtsChunk[] = []
      let chunkIndex = 0
      await this.ttsProvider!.synthesize(
        text,
        (chunk) => {
          if (win.isDestroyed() || abort.signal.aborted) return
          if (chunkIndex === 0) {
            this.emitRuntimeStatus('playing', '正在播放预览…')
          }
          recorded.push({
            samples: chunk.samples.slice(),
            sampleRate: chunk.sampleRate,
            isFinal: chunk.isFinal,
          })
          try {
            win.webContents.send('voice:event', {
              type: 'voice:tts:preview:chunk',
              samples: chunk.samples,
              sampleRate: chunk.sampleRate,
              chunkIndex: chunkIndex++,
              isFinal: chunk.isFinal,
            })
          } catch (e) {
            log.warn(`[previewTts] IPC 发送失败: ${(e as Error).message}`)
          }
        },
        abort.signal,
      )

      if (abort.signal.aborted) {
        endPreview(false, '预览已取消')
        return
      }

      if (
        recorded.length > 0
        && trimmed.length <= TTS_PREVIEW_CACHE_MAX_TEXT_CHARS
      ) {
        ttsPreviewCache.set(cacheKey, recorded)
      }
      endPreview(true)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        const msg = (e as Error).message || '预览合成失败'
        log.error(`[previewTts] 预览合成失败: ${msg}`)
        this.emitRuntimeStatus('error', `预览失败：${msg}`)
        endPreview(false, msg)
      } else {
        endPreview(false, '预览已取消')
      }
    } finally {
      if (this.previewAbort === abort) {
        this.previewAbort = null
      }
    }
  }

  // ── 生成语音文件（Agent 消息 → 音频附件） ───────────────────────────────────

  /**
   * 将文本合成为音频文件并保存到 destDir，返回文件绝对路径。
   * VITS（PCM）→ WAV；Edge TTS（mp3 bytes）→ MP3
   */
  async generateAudioFile(text: string, destDir: string): Promise<string> {
    await this.ensureTtsInitialized()

    const abort = new AbortController()
    const pcmChunks: Float32Array[] = []
    const mp3Chunks: Uint8Array[] = []
    let detectedSampleRate = 22050
    let isEdgeTts = false

    log.info(`[generateAudioFile] 开始合成文本: "${text.slice(0, 40)}"`)

    await this.ttsProvider!.synthesize(
      text,
      (chunk) => {
        if (chunk.sampleRate === -1) {
          // Edge TTS: mp3 bytes
          isEdgeTts = true
          mp3Chunks.push(new Uint8Array(chunk.samples))
        } else {
          // VITS: PCM Float32
          if (chunk.sampleRate > 0) detectedSampleRate = chunk.sampleRate
          pcmChunks.push(new Float32Array(chunk.samples))
        }
      },
      abort.signal,
    )

    const fileId = randomUUID()
    fs.mkdirSync(destDir, { recursive: true })

    if (isEdgeTts) {
      // 合并所有 mp3 chunks 写文件
      const totalLen = mp3Chunks.reduce((s, c) => s + c.length, 0)
      const merged = new Uint8Array(totalLen)
      let offset = 0
      for (const c of mp3Chunks) { merged.set(c, offset); offset += c.length }
      const filePath = path.join(destDir, `${fileId}.mp3`)
      fs.writeFileSync(filePath, Buffer.from(merged))
      log.info(`[generateAudioFile] MP3 文件已生成: ${filePath} (${merged.length} bytes)`)
      return filePath
    } else {
      // 合并 PCM，写 WAV
      const totalSamples = pcmChunks.reduce((s, c) => s + c.length, 0)
      const pcmData = new Float32Array(totalSamples)
      let offset = 0
      for (const c of pcmChunks) { pcmData.set(c, offset); offset += c.length }

      const filePath = path.join(destDir, `${fileId}.wav`)
      this._writeWavFile(filePath, pcmData, detectedSampleRate)
      log.info(`[generateAudioFile] WAV 文件已生成: ${filePath} (${totalSamples} samples)`)
      return filePath
    }
  }

  /** 将 PCM Float32Array 写入 WAV 文件（单声道，16-bit PCM） */
  private _writeWavFile(filePath: string, samples: Float32Array, sampleRate: number): void {
    const numSamples = samples.length
    const byteRate = sampleRate * 2 // 16-bit mono
    const dataSize = numSamples * 2
    const buf = Buffer.alloc(44 + dataSize)

    // RIFF header
    buf.write('RIFF', 0, 'ascii')
    buf.writeUInt32LE(36 + dataSize, 4)
    buf.write('WAVE', 8, 'ascii')
    buf.write('fmt ', 12, 'ascii')
    buf.writeUInt32LE(16, 16)       // chunk size
    buf.writeUInt16LE(1, 20)        // PCM = 1
    buf.writeUInt16LE(1, 22)        // mono
    buf.writeUInt32LE(sampleRate, 24)
    buf.writeUInt32LE(byteRate, 28)
    buf.writeUInt16LE(2, 32)        // block align
    buf.writeUInt16LE(16, 34)       // bits per sample
    buf.write('data', 36, 'ascii')
    buf.writeUInt32LE(dataSize, 40)

    // PCM data: Float32 → Int16
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]))
      buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
    }

    fs.writeFileSync(filePath, buf)
  }

  getConfig(): VoiceEngineConfig {
    return this.config
  }

  // ── 音频文件 ASR 转录（附件导入时调用） ─────────────────────────────────────

  /**
   * 对 Float32 PCM 数据直接进行 ASR 转录，返回识别文字。
   * 供 SILK 等原始 PCM 数据的直接识别（无需写临时文件）。
   */
  async transcribePcm(samples: Float32Array, sampleRate: number): Promise<string> {
    await this.ensureInitialized()
    try {
      log.info(`[transcribePcm] 开始转录 PCM, sampleRate=${sampleRate}, samples=${samples.length}`)
      // 如果 sampleRate 不是 16000，做简单降采样（线性插值）
      let pcm = samples
      if (sampleRate !== 16000 && sampleRate > 0) {
        const ratio = sampleRate / 16000
        const outLen = Math.floor(samples.length / ratio)
        pcm = new Float32Array(outLen)
        for (let i = 0; i < outLen; i++) {
          const srcIdx = i * ratio
          const lo = Math.floor(srcIdx)
          const hi = Math.min(lo + 1, samples.length - 1)
          const frac = srcIdx - lo
          pcm[i] = samples[lo] * (1 - frac) + samples[hi] * frac
        }
        log.info(`[transcribePcm] 重采样 ${sampleRate}Hz → 16000Hz, outLen=${outLen}`)
      }
      const stream = this.asrProvider!.createStream()
      stream.feed(pcm)
      const text = stream.resetAndGetResult().trim()
      stream.destroy()
      log.info(`[transcribePcm] 转录结果: "${text}"`)
      return text
    } catch (e) {
      log.error(`[transcribePcm] 转录失败: ${(e as Error).message}`)
      return ''
    }
  }

  /**
   * 对 base64 编码的 WAV 文件进行 ASR 转录，返回识别文字。
   * 仅支持 WAV（PCM），其他格式返回空字符串。
   * @param base64Data base64 编码的音频文件内容
   * @param mimeType 文件 MIME 类型
   */
  async transcribeAudioBuffer(base64Data: string, mimeType: string): Promise<string> {
    const isWav = mimeType === 'audio/wav' || mimeType === 'audio/x-wav' || mimeType === 'audio/wave'
    if (!isWav) {
      log.warn(`[transcribeAudioBuffer] 当前仅支持 WAV 格式，跳过 mimeType=${mimeType}`)
      return ''
    }

    await this.ensureInitialized()

    // 写临时 WAV 文件
    const tmpFile = path.join(os.tmpdir(), `mtbot-asr-${randomUUID()}.wav`)
    try {
      const buf = Buffer.from(base64Data, 'base64')
      fs.writeFileSync(tmpFile, buf)
      log.info(`[transcribeAudioBuffer] 临时文件写入: ${tmpFile} (${buf.length} bytes)`)

      // 使用 sherpa-onnx readWave 解码
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const SherpaOnnx = require('sherpa-onnx-node') as any
      const wave = SherpaOnnx.readWave(tmpFile) as { sampleRate: number; samples: Float32Array }
      log.info(`[transcribeAudioBuffer] WAV 解码完成, sampleRate=${wave.sampleRate}, samples=${wave.samples.length}`)

      // 送入 ASR 流识别
      const stream = this.asrProvider!.createStream()
      stream.feed(wave.samples)
      const text = stream.resetAndGetResult().trim()
      stream.destroy()
      log.info(`[transcribeAudioBuffer] 转录结果: "${text}"`)
      return text
    } catch (e) {
      log.error(`[transcribeAudioBuffer] 转录失败: ${(e as Error).message}`)
      return ''
    } finally {
      try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
    }
  }

  async setConfig(partial: Partial<VoiceEngineConfig>): Promise<void> {
    this.config = {
      ...this.config,
      asr: { ...this.config.asr, ...partial.asr },
      tts: { ...this.config.tts, ...partial.tts },
      vad: { ...this.config.vad, ...partial.vad },
      autoMuteMicWhileSpeaking:
        partial.autoMuteMicWhileSpeaking ?? this.config.autoMuteMicWhileSpeaking,
    }

    // 仅 tts.speed 和/或 tts.speakerId 变化时，热更新不重置引擎
    const changedKeys = Object.keys(partial)
    const isTtsParamOnlyUpdate =
      this.initialized &&
      this.ttsProvider &&
      changedKeys.length === 1 &&
      changedKeys[0] === 'tts' &&
      partial.tts !== undefined &&
      Object.keys(partial.tts).every((k) => k === 'speed' || k === 'speakerId' || k === 'voice')

    if (isTtsParamOnlyUpdate) {
      if (partial.tts?.speed !== undefined) {
        this.ttsProvider!.setSpeed?.(partial.tts.speed)
      }
      if (partial.tts?.speakerId !== undefined) {
        this.ttsProvider!.setSpeakerId?.(partial.tts.speakerId)
      }
      if (partial.tts?.voice !== undefined) {
        void this.ttsProvider!.setVoice?.(partial.tts.voice)
      }
      log.info(`[setConfig] TTS 参数热更新，引擎保持运行`)
      return
    }

    // 能量门倍率 / 自动闭麦 / VAD 阈值：运行时即读，无需重建引擎（仅这些变化时热更新）。
    // 注意 VAD threshold/minSpeechMs/minSilenceMs 传给 silero 初始化，变化仍需重置引擎；
    // 此处仅当 vad 变更只含 energyGateMultiplier 时视为热更新。
    const vadKeys = partial.vad ? Object.keys(partial.vad) : []
    const isRuntimeOnlyUpdate =
      changedKeys.every((k) => k === 'autoMuteMicWhileSpeaking' || k === 'vad') &&
      (vadKeys.length === 0 || vadKeys.every((k) => k === 'energyGateMultiplier'))
    if (isRuntimeOnlyUpdate) {
      log.info('[setConfig] 能量门/自动闭麦热更新，引擎保持运行')
      return
    }

    // 配置变更后重置初始化，下次通话时重新加载
    if (this.initialized || this.ttsInitialized) {
      this.vad?.destroy()
      this.asrProvider?.destroy()
      this.ttsProvider?.destroy()
      this.vad = null
      this.asrProvider = null
      this.ttsProvider = null
      this.initialized = false
      this.ttsInitialized = false
    }
  }

  // ── 工具方法 ───────────────────────────────────────────────────────────

  /** 计算音频帧的 RMS 能量 */
  private _calcRms(samples: Float32Array): number {
    if (samples.length === 0) return 0
    let sum = 0
    for (const s of samples) sum += s * s
    return Math.sqrt(sum / samples.length)
  }

  /** 计算完整语音段的 RMS 能量（复用 _calcRms） */
  private _calcSegmentRms(segment: Float32Array): number {
    return this._calcRms(segment)
  }

  /** 清洗 TTS 输入文本：移除 markdown/emoji/OOV 字符，使日志与实际语音一致 */
  private _cleanTtsText(text: string): string {
    const cleaned = stripVirtualHumanTags(text)
      // 0. 兜底剥离虚拟人标签（[emotion] / [motion:xxx] / <vh_action>）；
      //    onDelta 按分片 strip 时标签可能跨 delta 被切断，此处对已聚合的整句再剥一次
      // 1. 移除 markdown 格式标记
      .replace(/\*{1,3}([^*]*)\*{1,3}/g, '$1')   // **bold** / *italic*
      .replace(/~~([^~]*)~~/g, '$1')               // ~~strikethrough~~
      .replace(/^#{1,6}\s+/gm, '')                 // ## headings
      .replace(/^[-*+]\s+/gm, '')                  // - list items
      .replace(/^>\s+/gm, '')                      // > blockquotes
      .replace(/`([^`]*)`/g, '$1')                 // `code`
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')     // [link](url)
      .replace(/\*+/g, '')                         // 残留的 *
      // 2. 替换 VITS OOV 字符为等价形式
      .replace(/[—–]/g, '，')                       // em/en dash → 逗号停顿
      .replace(/—/g, '，')                       // em/en dash → 逗号停顿
      .replace(/[\u201C\u201D]/g, '')               // "" 弯引号 → 移除
      .replace(/[\u2018\u2019]/g, '')               // '' 弯引号 → 移除
      // 3. 移除 emoji
      .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '')
      .trim()

    // 清洗后若仅剩标点/空白，返回空串
    if (/^[\s。！？…，；、：《》【】（）.!?,;:\n\r\t-]*$/u.test(cleaned)) {
      return ''
    }

    return cleaned
  }

  private pushVoiceEvent(event: any): void {
    if (!this.win.isDestroyed()) {
      try {
        this.win.webContents.send('voice:event', event)
      } catch (e) {
        log.error(`[pushVoiceEvent] IPC 发送失败 type=${event?.type}: ${(e as Error).message}`)
      }
    }
    // 镜像到额外接收者（如宠物窗口）
    for (const wc of mirrorWebContents) {
      if (wc.isDestroyed()) {
        mirrorWebContents.delete(wc)
        continue
      }
      try {
        wc.send('voice:event', event)
      } catch (e) {
        log.error(`[pushVoiceEvent] 镜像发送失败 type=${event?.type}: ${(e as Error).message}`)
      }
    }
  }
}
