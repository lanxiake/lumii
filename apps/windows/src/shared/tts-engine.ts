/**
 * TTS Provider 的共享契约。
 *
 * 放在 `shared/` 而不是 voice 插件里：四种引擎各自住在自己的插件目录，
 * 但都要实现同一个 `TtsProvider`，而插件之间**不得运行期互相 import**（守卫 ⑫）。
 * 共享类型是这个约束下唯一合法的公共落点。
 */

export interface TtsChunk {
  /** 普通 JS 数字数组，确保 IPC 传输不携带外部 ArrayBuffer */
  samples: number[]
  /**
   * 采样率。**`-1` 是协议约定**：表示 `samples` 是编码音频字节（MP3），
   * 渲染端据此解码而不是当 Float32 PCM 播。
   *
   * 引擎自己不要硬编码这个值——用 `TtsEngineEntry.outputFormat` 驱动，
   * 由 voice-service 统一标注。
   */
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
  /** 热更新 CustomVoice 说话人名（Qwen3 专用） */
  setSpeakerName?(speaker: string): void
  /**
   * 热更新「自然语言音色描述」（Breeze 专用）。
   *
   * Breeze 没有固定音色列表：想要什么声音就用一句话描述（如「一位温柔自信的
   * 年轻女声，语速偏快，像体育播报」）。传 null 清除，回到模型默认音色。
   */
  setInstruction?(instruction: string | null): void
  /** 热更新音色（Edge TTS 专用，需重建 WebSocket） */
  setVoice?(voice: string): Promise<void>
  /**
   * 锁定本次合成语种（Qwen3）：避免按句 Auto 判定导致中英音色交替
   * 传 null 清除锁定
   */
  setLanguageOverride?(language: string | null): void
  destroy(): void
}

/** 引擎输出格式：决定 voice-service 怎么打包 chunk、怎么落文件 */
export type TtsOutputFormat = 'pcm' | 'mp3'
