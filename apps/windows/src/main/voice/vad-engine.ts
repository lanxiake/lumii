/**
 * VAD (Voice Activity Detection) 引擎封装
 * 使用 sherpa-onnx Silero VAD 模型
 */

const log = {
  info: (...args: unknown[]) => console.log('[VadEngine]', ...args),
  debug: (...args: unknown[]) => console.log('[VadEngine:DEBUG]', ...args),
  warn: (...args: unknown[]) => console.warn('[VadEngine]', ...args),
  error: (...args: unknown[]) => console.error('[VadEngine]', ...args),
}

export class VadEngine {
  private vad: any = null
  private buffer: any = null
  private readonly windowSize = 512 // Silero VAD: 512 samples @ 16kHz = 32ms

  constructor(private modelPath: string) {}

  async initialize(
    threshold = 0.5,
    minSpeechMs = 250,
    minSilenceMs = 500,
  ): Promise<void> {
    log.info(`[initialize] 加载 Silero VAD 模型: ${this.modelPath}`)

    // 延迟 require，避免 electron 打包问题
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SherpaOnnx = require('sherpa-onnx-node') as any

    this.vad = new SherpaOnnx.Vad(
      {
        sileroVad: {
          model: this.modelPath,
          threshold,
          minSpeechDuration: minSpeechMs / 1000,
          minSilenceDuration: minSilenceMs / 1000,
          windowSize: this.windowSize,
        },
        sampleRate: 16000,
        numThreads: 1,
        debug: 0,
      },
      60,
    )

    this.buffer = new SherpaOnnx.CircularBuffer(30 * 16000)
    log.info('[initialize] VAD 初始化完成')
  }

  /**
   * 推入音频帧，返回 VAD 检测到的完整语音段（如有）
   */
  push(samples: Float32Array): Float32Array[] {
    if (!this.vad || !this.buffer) return []

    this.buffer.push(samples)
    const segments: Float32Array[] = []

    while (this.buffer.size() > this.windowSize) {
      const frame = this.buffer.get(this.buffer.head(), this.windowSize, false)
      this.buffer.pop(this.windowSize)
      this.vad.acceptWaveform(frame)

      while (!this.vad.isEmpty()) {
        const segment = this.vad.front(false)
        this.vad.pop()
        segments.push(segment.samples)
      }
    }

    return segments
  }

  isSpeechDetected(): boolean {
    return this.vad?.isDetected() ?? false
  }

  destroy(): void {
    this.vad = null
    this.buffer = null
    log.info('[destroy] VAD 资源已释放')
  }
}
