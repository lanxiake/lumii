/**
 * Qwen3-TTS Provider —— 本地多音色 + 声音克隆，走 Python sidecar。
 *
 * sidecar 进程管理在 `main/voice/qwen3-tts-client.ts`（voice 插件的模型下载与
 * IPC 也要用它预装 Python 依赖），这里只负责把配置翻译成 RPC 调用。
 */
import type { TtsChunk, TtsProvider } from '../../../shared/tts-engine.js'
import {
  getSharedQwen3TtsClient,
  borrowQwen3TtsClient,
  releaseQwen3TtsClient,
} from '../../../main/voice/qwen3-tts-client.js'
import { resolveQwen3TtsLanguage, sanitizeTtsPlainText } from '../../../shared/tts-text-utils.js'

const log = {
  info: (...args: unknown[]) => console.log('[TtsQwen3]', ...args),
  debug: (...args: unknown[]) => console.log('[TtsQwen3:DEBUG]', ...args),
  warn: (...args: unknown[]) => console.warn('[TtsQwen3]', ...args),
  error: (...args: unknown[]) => console.error('[TtsQwen3]', ...args),
}

export class Qwen3TtsProvider implements TtsProvider {
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
