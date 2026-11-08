/**
 * Edge TTS Provider —— 在线合成，无需下载任何模型。
 *
 * 使用 msedge-tts 直接调用 Microsoft Edge Read Aloud API，通过 `toStream`
 * 在内存中收集 mp3 字节，不写临时文件。
 *
 * 这是**内置默认引擎**：其他引擎都需要下载模型或外部部署，Edge 是永远可用的兜底。
 */
import type { TtsChunk, TtsProvider } from '../../../shared/tts-engine'

const log = {
  info: (...args: unknown[]) => console.log('[TtsEdge]', ...args),
  debug: (...args: unknown[]) => console.log('[TtsEdge:DEBUG]', ...args),
  warn: (...args: unknown[]) => console.warn('[TtsEdge]', ...args),
  error: (...args: unknown[]) => console.error('[TtsEdge]', ...args),
}

export class EdgeTtsProvider implements TtsProvider {
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
    log.info(`[setSpeed] 语速热更新: ${speed}`)
  }

  async setVoice(voice: string): Promise<void> {
    this.voice = voice
    if (this.ttsInstance) {
      const { OUTPUT_FORMAT } = await import('msedge-tts')
      await this.ttsInstance.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {})
    }
    log.info(`[setVoice] 音色热更新: ${voice}`)
  }

  async initialize(): Promise<void> {
    const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts')
    this.ttsInstance = new MsEdgeTTS()
    await this.ttsInstance.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {})
    log.info(`[initialize] Edge TTS 已就绪, voice=${this.voice}`)
  }

  async synthesize(
    text: string,
    onChunk: (chunk: TtsChunk) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!text.trim()) return
    if (signal?.aborted) return
    if (!this.ttsInstance) throw new Error('Edge TTS 未初始化')

    log.debug(`[synthesize] text="${text.slice(0, 60)}"`)

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
          log.info('[synthesize] abort 后已重建 WebSocket 连接')
        } catch (e) {
          log.warn(`[synthesize] abort 后重建连接失败: ${(e as Error).message}`)
        }
        return
      }

      const audioBuffer = Buffer.concat(chunks)
      log.info(`[synthesize] 音频数据收集完成: ${audioBuffer.length} bytes`)

      // 通过 onChunk 发送 mp3 原始字节（特殊标记 sampleRate=-1 表示编码音频）
      onChunk({
        samples: Array.from(new Uint8Array(audioBuffer)),
        sampleRate: -1, // 标记为编码音频（非 PCM），渲染端需解码
        isFinal: false,
      })
    } catch (e) {
      if ((e as Error).name !== 'AbortError' && !signal?.aborted) {
        log.error(`[synthesize] 合成失败: ${(e as Error).message}`)
        throw e
      }
    }

    // isFinal 标记
    if (!signal?.aborted) {
      onChunk({ samples: [], sampleRate: this.sampleRate, isFinal: true })
    }
  }

  destroy(): void {
    log.info('[destroy] Edge TTS 资源已释放')
  }
}
