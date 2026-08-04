/**
 * ASR (Automatic Speech Recognition) Provider 抽象层
 * 支持本地 Paraformer 流式识别和云端降级
 */
import path from 'node:path'

const log = {
  info: (...args: unknown[]) => console.log('[AsrEngine]', ...args),
  debug: (...args: unknown[]) => console.log('[AsrEngine:DEBUG]', ...args),
  warn: (...args: unknown[]) => console.warn('[AsrEngine]', ...args),
  error: (...args: unknown[]) => console.error('[AsrEngine]', ...args),
}

// ─── 接口定义 ─────────────────────────────────────────────────────────────

export interface AsrStream {
  feed(samples: Float32Array): void
  getPartialText(): string
  isEndpoint(): boolean
  /** 重置流，返回当前最终识别结果（含尾部填充） */
  resetAndGetResult(): string
  destroy(): void
}

export interface AsrProvider {
  readonly name: string
  readonly isLocal: boolean
  initialize(): Promise<void>
  createStream(): AsrStream
  destroy(): void
}

// ─── 本地 Paraformer 流式 ASR ──────────────────────────────────────────────

export class LocalStreamingParaformerAsr implements AsrProvider {
  readonly name = 'local-paraformer-streaming'
  readonly isLocal = true
  private recognizer: any = null

  constructor(private modelDir: string) {}

  async initialize(): Promise<void> {
    log.info(`[initialize] 加载 Streaming Paraformer: ${this.modelDir}`)

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SherpaOnnx = require('sherpa-onnx-node') as any

    this.recognizer = new SherpaOnnx.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        paraformer: {
          encoder: path.join(this.modelDir, 'encoder.int8.onnx'),
          decoder: path.join(this.modelDir, 'decoder.int8.onnx'),
        },
        tokens: path.join(this.modelDir, 'tokens.txt'),
        numThreads: 4,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: true,
      rule1MinTrailingSilence: 1.8,
      rule2MinTrailingSilence: 1.0,
      rule3MinUtteranceLength: 20,
    })

    log.info('[initialize] Streaming Paraformer 初始化完成')
  }

  createStream(): AsrStream {
    if (!this.recognizer) throw new Error('ASR 未初始化，请先调用 initialize()')

    const recognizer = this.recognizer
    const stream = recognizer.createStream()

    return {
      feed(samples: Float32Array): void {
        stream.acceptWaveform({ sampleRate: 16000, samples })
        while (recognizer.isReady(stream)) {
          recognizer.decode(stream)
        }
      },
      getPartialText(): string {
        return recognizer.getResult(stream).text ?? ''
      },
      isEndpoint(): boolean {
        return recognizer.isEndpoint(stream)
      },
      resetAndGetResult(): string {
        // Paraformer 需要尾部静音填充，确保最后一个词被识别
        const tailPadding = new Float32Array(Math.round(16000 * 0.4))
        stream.acceptWaveform({ samples: tailPadding, sampleRate: 16000 })
        while (recognizer.isReady(stream)) {
          recognizer.decode(stream)
        }
        const text = recognizer.getResult(stream).text ?? ''
        recognizer.reset(stream)
        return text
      },
      destroy(): void {
        // stream 由 GC 回收
      },
    }
  }

  destroy(): void {
    this.recognizer = null
  }
}

// ─── 本地 Paraformer 离线 ASR ──────────────────────────────────────────────

export class LocalOfflineParaformerAsr implements AsrProvider {
  readonly name = 'local-paraformer-offline'
  readonly isLocal = true
  private recognizer: any = null

  constructor(private modelDir: string) {}

  async initialize(): Promise<void> {
    log.info(`[initialize] 加载 Offline Paraformer: ${this.modelDir}`)

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SherpaOnnx = require('sherpa-onnx-node') as any

    this.recognizer = new SherpaOnnx.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        paraformer: {
          model: path.join(this.modelDir, 'model.int8.onnx'),
        },
        tokens: path.join(this.modelDir, 'tokens.txt'),
        numThreads: 4,
        provider: 'cpu',
        debug: 0,
      },
    })

    log.info('[initialize] Offline Paraformer 初始化完成')
  }

  createStream(): AsrStream {
    if (!this.recognizer) throw new Error('ASR 未初始化，请先调用 initialize()')

    const recognizer = this.recognizer
    let pendingSegments: Float32Array[] = []

    return {
      feed(samples: Float32Array): void {
        pendingSegments.push(samples)
      },
      getPartialText(): string {
        return '' // 离线模式无中间结果
      },
      isEndpoint(): boolean {
        return false // VAD 负责端点检测
      },
      resetAndGetResult(): string {
        if (pendingSegments.length === 0) return ''

        // 合并所有音频帧
        const totalLen = pendingSegments.reduce((s, b) => s + b.length, 0)
        const merged = new Float32Array(totalLen)
        let offset = 0
        for (const seg of pendingSegments) {
          merged.set(seg, offset)
          offset += seg.length
        }
        pendingSegments = []

        const stream = recognizer.createStream()
        stream.acceptWaveform({ sampleRate: 16000, samples: merged })
        recognizer.decode(stream)
        return recognizer.getResult(stream).text ?? ''
      },
      destroy(): void {
        pendingSegments = []
      },
    }
  }

  destroy(): void {
    this.recognizer = null
  }
}

// ─── 工厂函数 ─────────────────────────────────────────────────────────────

export function createAsrProvider(config: {
  provider: string
  modelDir?: string
  apiKey?: string
}): AsrProvider {
  switch (config.provider) {
    case 'local-paraformer':
      if (!config.modelDir) throw new Error('local-paraformer 需要 modelDir')
      return new LocalOfflineParaformerAsr(config.modelDir)
    default:
      if (config.modelDir) {
        log.warn(`[createAsrProvider] 未知 provider "${config.provider}"，回退到 local-paraformer-offline`)
        return new LocalOfflineParaformerAsr(config.modelDir)
      }
      throw new Error(`未知 ASR Provider: ${config.provider}`)
  }
}
