/**
 * TTS (Text-To-Speech) Provider 抽象层
 * 支持本地 VITS、Edge TTS、Qwen3-TTS（sidecar）
 */
import path from 'node:path'
import fs from 'node:fs'
import { getSharedQwen3TtsClient, borrowQwen3TtsClient, releaseQwen3TtsClient } from './qwen3-tts-client.js'
import { resolveQwen3TtsLanguage, sanitizeTtsPlainText } from './tts-text-utils.js'

const log = {
  info: (...args: unknown[]) => console.log('[TtsEngine]', ...args),
  debug: (...args: unknown[]) => console.log('[TtsEngine:DEBUG]', ...args),
  warn: (...args: unknown[]) => console.warn('[TtsEngine]', ...args),
  error: (...args: unknown[]) => console.error('[TtsEngine]', ...args),
}

// ─── 接口定义 ─────────────────────────────────────────────────────────────

export interface TtsChunk {
  /** 普通 JS 数字数组，确保 IPC 传输不携带外部 ArrayBuffer */
  samples: number[]
  sampleRate: number
  isFinal: boolean
}

export interface TtsProvider {
  readonly name: string
  readonly isLocal: boolean
  sampleRate: number
  initialize(): Promise<void>
  synthesize(
    text: string,
    onChunk: (chunk: TtsChunk) => void,
    signal?: AbortSignal,
    onAudioFile?: (audioPath: string, isFinal: boolean) => void,
  ): Promise<void>
  /** 热更新语速（不重建引擎） */
  setSpeed?(speed: number): void
  /** 热更新说话人 ID（不重建引擎） */
  setSpeakerId?(id: number): void
  /** 热更新音色（Edge TTS 专用，需重建 WebSocket） */
  setVoice?(voice: string): Promise<void>
  /**
   * 锁定本次合成语种（Qwen3）：避免按句 Auto 判定导致中英音色交替
   * 传 null 清除锁定
   */
  setLanguageOverride?(language: string | null): void
  destroy(): void
}

// ─── 本地 VITS 中文 TTS ────────────────────────────────────────────────────

export class LocalVitsTts implements TtsProvider {
  readonly name = 'local-vits-zh'
  readonly isLocal = true
  sampleRate = 22050
  private tts: any = null

  constructor(
    private modelDir: string,
    private speakerId = 0,
    private speed = 1.0,
  ) {}

  setSpeed(speed: number): void {
    this.speed = speed
    log.info(`[setSpeed] 语速热更新: ${speed}`)
  }

  setSpeakerId(id: number): void {
    this.speakerId = id
    log.info(`[setSpeakerId] 说话人 ID 热更新: ${id}`)
  }

  async initialize(): Promise<void> {
    log.info(`[initialize] 加载 VITS 中文 TTS: ${this.modelDir}`)

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SherpaOnnx = require('sherpa-onnx-node') as any

    // 收集可用的 FST 规范化文件（日期/数字/电话）
    const fstFiles = ['date.fst', 'phone.fst', 'number.fst']
      .map((f) => path.join(this.modelDir, f))
      .filter((p) => fs.existsSync(p))

    // MeloTTS 需 jieba 分词目录 dict/（中文分词/韵律）；Aishell3 无此目录时省略
    const dictDir = path.join(this.modelDir, 'dict')
    const hasDict = fs.existsSync(dictDir)

    this.tts = new SherpaOnnx.OfflineTts({
      model: {
        vits: {
          model: path.join(this.modelDir, 'model.onnx'),
          lexicon: path.join(this.modelDir, 'lexicon.txt'),
          tokens: path.join(this.modelDir, 'tokens.txt'),
          ...(hasDict ? { dictDir } : {}),
        },
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
      maxNumSentences: 1,
      ...(fstFiles.length > 0 ? { ruleFsts: fstFiles.join(',') } : {}),
    })

    this.sampleRate = this.tts.sampleRate
    log.info(
      `[initialize] VITS 加载完成，说话人数: ${this.tts.numSpeakers}，采样率: ${this.sampleRate}`,
    )
  }

  async synthesize(
    text: string,
    onChunk: (chunk: TtsChunk) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.tts) throw new Error('TTS 未初始化，请先调用 initialize()')
    if (signal?.aborted) return
    if (!text.trim()) return

    log.debug(`[synthesize] 合成文本: "${text.slice(0, 60)}"`)

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SherpaOnnx = require('sherpa-onnx-node') as any

    const generationConfig = new SherpaOnnx.GenerationConfig({
      sid: this.speakerId,
      speed: this.speed,
      silenceScale: 0.2,
    })

    // 整句先缓冲再归一化：MeloTTS 逐句响度有波动，统一峰值后听感一致
    // （单句约 120 字、RTF≈0.43，缓冲一整句的额外延迟可接受）
    const collected: number[] = []

    const result = await this.tts.generateAsync({
      text,
      generationConfig,
      // Electron V8 sandbox 禁止外部 ArrayBuffer，必须关闭零拷贝
      enableExternalBuffer: false,
      onProgress: ({ samples }: { samples: Float32Array; progress: number }) => {
        if (signal?.aborted) return 0 // 返回 0 中止生成
        try {
          for (let i = 0; i < samples.length; i++) collected.push(samples[i]!)
        } catch (e) {
          // 绝不允许 JS 异常逃逸进 native generateAsync，否则进程崩溃
          log.error(`[synthesize] onProgress 回调错误: ${(e as Error).message}`)
        }
        return 1 // 继续
      },
    })

    // 短句场景：onProgress 未产出音频，从 generateAsync 返回值取完整音频
    if (collected.length === 0 && result?.samples?.length > 0) {
      const ret = result.samples as Float32Array
      for (let i = 0; i < ret.length; i++) collected.push(ret[i]!)
    }

    if (signal?.aborted) return

    // 峰值归一化到 ~0.95：消除逐句忽大忽小；静音/极小段不放大避免噪声抬升
    if (collected.length > 0) {
      let peak = 0
      for (let i = 0; i < collected.length; i++) {
        const a = Math.abs(collected[i]!)
        if (a > peak) peak = a
      }
      if (peak > 0.02) {
        const gain = Math.min(4, 0.95 / peak)
        for (let i = 0; i < collected.length; i++) collected[i] = collected[i]! * gain
      }
      onChunk({ samples: collected, sampleRate: this.sampleRate, isFinal: false })
    }

    // 发送 isFinal 标记帧
    if (!signal?.aborted) {
      onChunk({
        samples: [],
        sampleRate: this.sampleRate,
        isFinal: true,
      })
    }
  }

  destroy(): void {
    this.tts = null
    log.info('[destroy] VITS 资源已释放')
  }
}

// ─── Edge TTS（客户端直接调用，无需网关） ─────────────────────────────────

/**
 * Edge TTS Provider
 * 使用 msedge-tts 包直接调用 Microsoft Edge Read Aloud API，
 * 通过 toStream 在内存中收集 mp3 字节，不写临时文件。
 */
export class EdgeTtsFallback implements TtsProvider {
  readonly name = 'edge-tts'
  readonly isLocal = false
  sampleRate = 24000
  private ttsInstance: any = null

  constructor(
    private voice = 'zh-CN-XiaoxiaoNeural',
    private speed = 1.0,
  ) {}

  setSpeed(speed: number): void {
    this.speed = speed
    log.info(`[EdgeTts.setSpeed] 语速热更新: ${speed}`)
  }

  async setVoice(voice: string): Promise<void> {
    this.voice = voice
    if (this.ttsInstance) {
      const { OUTPUT_FORMAT } = await import('msedge-tts')
      await this.ttsInstance.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {})
    }
    log.info(`[EdgeTts.setVoice] 音色热更新: ${voice}`)
  }

  async initialize(): Promise<void> {
    const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts')
    this.ttsInstance = new MsEdgeTTS()
    await this.ttsInstance.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {})
    log.info(`[EdgeTts.initialize] Edge TTS 已就绪, voice=${this.voice}`)
  }

  async synthesize(
    text: string,
    onChunk: (chunk: TtsChunk) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!text.trim()) return
    if (signal?.aborted) return
    if (!this.ttsInstance) throw new Error('Edge TTS 未初始化')

    log.debug(`[EdgeTts.synthesize] text="${text.slice(0, 60)}"`)

    const rate = this.speed

    try {
      const { audioStream } = this.ttsInstance.toStream(text, { rate })

      // 收集 mp3 流到内存 Buffer
      const chunks: Buffer[] = []

      await new Promise<void>((resolve, reject) => {
        // abort 时：将 _streams 中所有条目替换为 noop 哑对象，阻止 WS 残留消息写入已删除的流。
        // 注意：不调 audioStream.destroy()（会触发 delete _streams[requestId]，使 noop 立刻失效）；
        // 也不调 close()（WS 关闭期间仍可能有 in-flight 帧到达）。
        // resolve() 之后 signal.aborted === true，后续走重建 WS 逻辑。
        const onAbort = () => {
          try {
            const streams = (this.ttsInstance as any)?._streams as Record<string, unknown> | undefined
            if (streams) {
              const noop = { audio: { push: () => {}, destroy: () => {} }, metadata: null }
              for (const id of Object.keys(streams)) {
                streams[id] = noop
              }
            }
          } catch { /* ignore */ }
          resolve()
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        audioStream.on('data', (chunk: Buffer) => {
          if (signal?.aborted) return // 已 abort，忽略后续数据
          chunks.push(Buffer.from(chunk))
        })
        audioStream.on('end', () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        })
        audioStream.on('error', (err: Error) => {
          signal?.removeEventListener('abort', onAbort)
          if (signal?.aborted) resolve()
          else reject(err)
        })
      })

      // abort 后：重建 WebSocket，以备下次合成
      if (signal?.aborted) {
        try {
          const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts')
          this.ttsInstance = new MsEdgeTTS()
          await this.ttsInstance.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {})
          log.info('[EdgeTts.synthesize] abort 后已重建 WebSocket 连接')
        } catch (e) {
          log.warn(`[EdgeTts.synthesize] abort 后重建连接失败: ${(e as Error).message}`)
        }
        return
      }

      const audioBuffer = Buffer.concat(chunks)
      log.info(`[EdgeTts.synthesize] 音频数据收集完成: ${audioBuffer.length} bytes`)

      // 通过 onChunk 发送 mp3 原始字节（特殊标记 sampleRate=-1 表示编码音频）
      onChunk({
        samples: Array.from(new Uint8Array(audioBuffer)),
        sampleRate: -1, // 标记为编码音频（非 PCM），渲染端需解码
        isFinal: false,
      })
    } catch (e) {
      if ((e as Error).name !== 'AbortError' && !signal?.aborted) {
        log.error(`[EdgeTts.synthesize] 合成失败: ${(e as Error).message}`)
        throw e
      }
    }

    // isFinal 标记
    if (!signal?.aborted) {
      onChunk({ samples: [], sampleRate: this.sampleRate, isFinal: true })
    }
  }

  destroy(): void {
    log.info('[EdgeTts.destroy] Edge TTS 资源已释放')
  }
}

// ─── Qwen3-TTS（Python sidecar）──────────────────────────────────────────

export class Qwen3Tts implements TtsProvider {
  readonly name = 'qwen3-tts'
  readonly isLocal = true
  sampleRate = 24000

  private client = getSharedQwen3TtsClient()
  private initialized = false
  /** 整段/会话级语种锁定，优先于逐句 Auto */
  private languageOverride: string | null = null

  constructor(
    private modelDir: string,
    private tokenizerDir: string,
    private opts: {
      speed?: number
      language?: string
      /** custom=内置音色；clone=声音克隆 */
      mode?: 'custom' | 'clone'
      speaker?: string
      instruct?: string
      refAudio?: string
      refText?: string
      xVectorOnly?: boolean
      /** sidecar load device：auto / cpu / cuda:0 */
      device?: string
    } = {},
  ) {}

  /**
   * 热更新语速（sidecar 侧一期忽略，保留接口兼容）
   */
  setSpeed(speed: number): void {
    this.opts.speed = speed
  }

  /**
   * 热更新 CustomVoice 说话人
   */
  setSpeakerName(speaker: string): void {
    this.opts.speaker = speaker
  }

  /**
   * 锁定语种，消除按句 Auto 漂音色
   */
  setLanguageOverride(language: string | null): void {
    this.languageOverride = language && language.trim() ? language.trim() : null
  }

  /**
   * 更新克隆参考（切换音色档案时）
   */
  setCloneRef(ref: { refAudio: string; refText: string; language?: string; xVectorOnly?: boolean }): void {
    this.opts.mode = 'clone'
    this.opts.refAudio = ref.refAudio
    this.opts.refText = ref.refText
    if (ref.language) this.opts.language = ref.language
    if (ref.xVectorOnly !== undefined) this.opts.xVectorOnly = ref.xVectorOnly
  }

  async initialize(): Promise<void> {
    const device = this.opts.device ?? 'auto'
    log.info(`[Qwen3Tts.initialize] mode=${this.opts.mode ?? 'custom'} model=${this.modelDir} device=${device}`)
    await this.client.load(this.modelDir, this.tokenizerDir, device)
    this.initialized = true
    log.info('[Qwen3Tts.initialize] 就绪')
  }

  async synthesize(
    text: string,
    onChunk: (chunk: TtsChunk) => void,
    signal?: AbortSignal,
    onAudioFile?: (audioPath: string, isFinal: boolean) => void,
  ): Promise<void> {
    if (!this.initialized) throw new Error('Qwen3 TTS 未初始化')
    if (signal?.aborted) return
    if (!text.trim()) return

    const mode = this.opts.mode ?? 'custom'
    if (mode === 'clone' && !this.opts.refAudio) {
      throw new Error('未配置克隆音色：请在设置中创建并选择「我的音色」，或改用 CustomVoice 内置音色')
    }

    // 清洗 Markdown；语种优先用整段锁定，避免短句 Auto 漂到外语音色
    const plain = sanitizeTtsPlainText(text)
    if (!plain) return
    const language =
      this.languageOverride
      ?? resolveQwen3TtsLanguage(this.opts.language || 'Auto', plain)
    if (language !== (this.opts.language || 'Auto')) {
      log.info(`[Qwen3Tts.synthesize] language ${this.opts.language || 'Auto'} → ${language}`)
    }

    const client = await borrowQwen3TtsClient()
    try {
      await client.load(this.modelDir, this.tokenizerDir, this.opts.device ?? 'auto')
      const { sampleRate } = await client.synthesizeStream(
        {
          text: plain,
          language,
          mode,
          speaker: this.opts.speaker || 'Vivian',
          instruct: this.opts.instruct,
          refAudio: this.opts.refAudio,
          refText: this.opts.refText || '',
          xVectorOnly: this.opts.xVectorOnly === true,
        },
        (part) => {
          if (signal?.aborted) return
          this.sampleRate = part.sampleRate
          onChunk({ samples: part.samples, sampleRate: part.sampleRate, isFinal: false })
        },
      )

      if (signal?.aborted) return
      this.sampleRate = sampleRate
      void onAudioFile // 流式路径不写整段 wav，保留参数以兼容 TtsProvider 接口
      onChunk({ samples: [], sampleRate, isFinal: true })
    } finally {
      releaseQwen3TtsClient(client)
    }
  }

  destroy(): void {
    // 共享 sidecar 不在单次 destroy 时杀掉，避免频繁冷启动
    this.initialized = false
    log.info('[Qwen3Tts.destroy] 已释放实例引用（sidecar 保持共享）')
  }
}

// ─── 工厂函数 ─────────────────────────────────────────────────────────────

export function createTtsProvider(config: {
  provider: string
  modelDir?: string
  tokenizerDir?: string
  vocoderPath?: string
  speed?: number
  voice?: string
  language?: string
  mode?: 'custom' | 'clone'
  speaker?: string
  instruct?: string
  refAudio?: string
  refText?: string
  xVectorOnly?: boolean
  device?: string
}): TtsProvider {
  switch (config.provider) {
    case 'local-vits':
      if (!config.modelDir) throw new Error('local-vits 需要 modelDir')
      return new LocalVitsTts(config.modelDir, 0, config.speed ?? 1.2)
    case 'edge':
      return new EdgeTtsFallback(config.voice ?? 'zh-CN-XiaoxiaoNeural', config.speed ?? 1.2)
    case 'qwen3':
      if (!config.modelDir) throw new Error('qwen3 需要 modelDir')
      if (!config.tokenizerDir) throw new Error('qwen3 需要 tokenizerDir')
      return new Qwen3Tts(config.modelDir, config.tokenizerDir, {
        speed: config.speed,
        language: config.language,
        mode: config.mode ?? 'custom',
        speaker: config.speaker,
        instruct: config.instruct,
        refAudio: config.refAudio,
        refText: config.refText,
        xVectorOnly: config.xVectorOnly,
        device: config.device,
      })
    default:
      if (config.modelDir) {
        log.warn(`[createTtsProvider] 未知 provider "${config.provider}"，回退到 local-vits`)
        return new LocalVitsTts(config.modelDir, 0, config.speed ?? 1.2)
      }
      throw new Error(`未知 TTS Provider: ${config.provider}`)
  }
}
