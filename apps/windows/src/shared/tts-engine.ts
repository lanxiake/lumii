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
  /**
   * 一次合成多段（可选能力）。
   *
   * 自回归模型逐段独立采样时音色会漂，且每段都要重新走一遍 denoise 流程。
   * 能批量推理的引擎实现这个方法后，调用方可以在拿到整篇文本时一次算完：
   * 同样的参考音 + 同一次 forward，音色一致且显著更快。
   *
   * 返回每段的 PCM 采样，顺序与入参一致；返回 null 表示当前状态下批量不划算，
   * 调用方应走逐句合成。
   */
  synthesizeBatch?(
    texts: string[],
    signal?: AbortSignal,
  ): Promise<Array<{ samples: number[]; sampleRate: number }> | null>
  /**
   * 单次合成请求能可靠处理的最长文本（字符）。声明了它的引擎，长文由调用方按句切段后
   * 逐段合成；未声明则整段直接交给引擎（引擎自己能处理长文）。
   */
  readonly maxCharsPerRequest?: number
  /**
   * 音色锚点（可选能力，Breeze）：一段参考音 + 对应文本。合成时用它克隆，
   * 跨段、跨次调用都是同一个声音。没有固定音色 ID 的引擎靠它保证一致性。
   * get 返回当前锚点（首段合成后自动生成）；set 注入外部保存的锚点，传 null 清除。
   */
  getVoiceAnchor?(): TtsVoiceAnchor | null
  setVoiceAnchor?(anchor: TtsVoiceAnchor | null): void
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

/**
 * 音色锚点：参考音 + 它的逐字文本（必须一致，否则克隆会跑偏）。
 * `instruction` 记录生成它时用的音色描述：之后同样描述（或不给描述）就纯克隆；
 * 给了不同描述则在这个声音上按描述调整（如「更激动一些」）。
 */
export interface TtsVoiceAnchor {
  audioPath: string
  text: string
  instruction?: string
}

/** 引擎输出格式：决定 voice-service 怎么打包 chunk、怎么落文件 */
export type TtsOutputFormat = 'pcm' | 'mp3'
