/**
 * MeloTTS 本地离线合成（sherpa-onnx，vits-melo-tts-zh_en）。
 *
 * 单音色中英混读，模型约 180MB，CPU 上 RTF≈0.43。逐句响度有波动，
 * 所以整句先缓冲再统一归一化到峰值 0.95。
 */
import path from 'node:path'
import fs from 'node:fs'
import type { TtsChunk, TtsProvider } from '../../../shared/tts-engine.js'

const log = {
  info: (...args: unknown[]) => console.log('[TtsMelo]', ...args),
  debug: (...args: unknown[]) => console.log('[TtsMelo:DEBUG]', ...args),
  warn: (...args: unknown[]) => console.warn('[TtsMelo]', ...args),
  error: (...args: unknown[]) => console.error('[TtsMelo]', ...args),
}

export class MeloTtsProvider implements TtsProvider {
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

    // silenceScale 放大句内标点(，、；)停顿时长，让朗读更从容（0.2 过于急促）
    const generationConfig = new SherpaOnnx.GenerationConfig({
      sid: this.speakerId,
      speed: this.speed,
      silenceScale: 0.8,
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
      // 句尾补静音：让句间/分段有呼吸停顿（播放引擎无缝拼接会吃掉句间空隙）。
      // 句末硬标点或换行 → 长停顿；软标点/无标点 → 短停顿。
      const tail = text.trimEnd().slice(-1)
      const isHardEnd = /[。！？…\n.!?]/.test(tail)
      const pauseMs = isHardEnd ? 320 : 160
      const silenceLen = Math.round((this.sampleRate * pauseMs) / 1000)
      for (let i = 0; i < silenceLen; i++) collected.push(0)
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
