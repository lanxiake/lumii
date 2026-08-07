/**
 * ASR 实时识别测试会话（设置页用，不拉起 Agent）
 * 使用现有离线 Paraformer + VAD；说话过程中周期性重识别以模拟流式出字。
 */
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { createAsrProvider, type AsrProvider, type AsrStream } from './asr-engine.js'
import { VadEngine } from './vad-engine.js'
import type { VoiceModelManager } from './model-manager.js'
import type { VoiceEngineConfig } from '../../shared/voice-events.js'

const log = {
  info: (...args: unknown[]) => console.log('[AsrTestSession]', ...args),
  warn: (...args: unknown[]) => console.warn('[AsrTestSession]', ...args),
  error: (...args: unknown[]) => console.error('[AsrTestSession]', ...args),
}

const PARTIAL_INTERVAL_MS = 450

/**
 * 轻量 ASR 测试会话
 */
export class AsrTestSession {
  private callId: string | null = null
  private asr: AsrProvider | null = null
  private asrStream: AsrStream | null = null
  private vad: VadEngine | null = null
  private win: BrowserWindow | null = null
  private pending: Float32Array[] = []
  private lastPartial = ''
  private lastPartialAt = 0
  private speaking = false

  constructor(
    private modelManager: VoiceModelManager,
    private getConfig: () => VoiceEngineConfig,
  ) {}

  /** 当前是否在测试中 */
  isActive(): boolean {
    return this.callId !== null
  }

  getCallId(): string | null {
    return this.callId
  }

  /**
   * 启动测试：初始化 ASR/VAD
   */
  async start(win: BrowserWindow): Promise<{ callId: string } | { error: string; models?: unknown }> {
    if (this.callId) {
      return { error: 'asr_test_already_active' }
    }
    if (!this.modelManager.isModelDownloaded('asr-paraformer-zh')) {
      return {
        error: 'models_not_ready',
        models: this.modelManager.getModelsStatus(),
      }
    }
    // VAD 强烈建议有；没有时仍可用能量启发式，但本实现要求 VAD
    if (!this.modelManager.isModelDownloaded('vad')) {
      return {
        error: 'models_not_ready',
        models: this.modelManager.getModelsStatus(),
      }
    }

    const paths = await this.modelManager.getModelPaths()
    const config = this.getConfig()

    try {
      this.asr = createAsrProvider({
        provider: config.asr.provider,
        modelDir: paths.asr,
        apiKey: config.asr.apiKey,
      })
      await this.asr.initialize()
      this.asrStream = this.asr.createStream()

      this.vad = new VadEngine(paths.vad)
      await this.vad.initialize(
        config.vad.threshold,
        config.vad.minSpeechMs,
        config.vad.minSilenceMs,
      )
    } catch (e) {
      this.asr?.destroy()
      this.asr = null
      this.asrStream = null
      this.vad?.destroy()
      this.vad = null
      const message = e instanceof Error ? e.message : String(e)
      log.error(`[start] 初始化失败: ${message}`)
      return { error: message }
    }

    this.callId = `asr-test-${randomUUID()}`
    this.win = win
    this.pending = []
    this.lastPartial = ''
    this.lastPartialAt = 0
    this.speaking = false

    log.info(`[start] ASR 测试已启动 callId=${this.callId}`)
    this.push({
      type: 'voice:call:state',
      callId: this.callId,
      state: 'listening',
    })
    return { callId: this.callId }
  }

  /**
   * 停止并释放资源
   */
  async stop(): Promise<void> {
    const id = this.callId
    this.callId = null
    this.asrStream?.destroy()
    this.asrStream = null
    this.asr?.destroy()
    this.asr = null
    this.vad?.destroy()
    this.vad = null
    this.pending = []
    if (id && this.win && !this.win.isDestroyed()) {
      this.push({
        type: 'voice:call:ended',
        callId: id,
        reason: 'user_hangup',
      })
    }
    this.win = null
    log.info('[stop] ASR 测试已停止')
  }

  /**
   * 处理麦克风 PCM 帧
   */
  handleAudioChunk(samples: Float32Array): void {
    if (!this.callId || !this.vad || !this.asrStream) return

    const segments = this.vad.push(samples)
    const isSpeaking = this.vad.isSpeechDetected()

    if (isSpeaking) {
      if (!this.speaking) {
        this.speaking = true
        this.push({
          type: 'voice:call:state',
          callId: this.callId,
          state: 'recognizing',
        })
      }
      this.pending.push(samples)

      const now = Date.now()
      if (now - this.lastPartialAt >= PARTIAL_INTERVAL_MS) {
        this.lastPartialAt = now
        const partial = this.recognizePending()
        if (partial && partial !== this.lastPartial) {
          this.lastPartial = partial
          this.push({
            type: 'voice:transcript',
            callId: this.callId,
            text: partial,
            isFinal: false,
          })
        }
      }
    }

    for (const segment of segments) {
      // 完整语音段：用段本身做最终识别更准
      const stream = this.asr!.createStream()
      stream.feed(segment)
      const finalText = stream.resetAndGetResult().trim()
      stream.destroy()
      this.pending = []
      this.lastPartial = ''
      this.speaking = false

      if (finalText) {
        this.push({
          type: 'voice:transcript',
          callId: this.callId,
          text: finalText,
          isFinal: true,
        })
      }
      this.push({
        type: 'voice:call:state',
        callId: this.callId,
        state: 'listening',
      })
    }

    if (!isSpeaking && this.speaking && segments.length === 0) {
      this.speaking = false
      this.push({
        type: 'voice:call:state',
        callId: this.callId,
        state: 'listening',
      })
    }
  }

  /**
   * 对已累计帧做一次离线识别，产出伪流式中间结果
   */
  private recognizePending(): string {
    if (!this.asr || this.pending.length === 0) return ''
    const totalLen = this.pending.reduce((s, b) => s + b.length, 0)
    const merged = new Float32Array(totalLen)
    let offset = 0
    for (const seg of this.pending) {
      merged.set(seg, offset)
      offset += seg.length
    }
    const stream = this.asr.createStream()
    stream.feed(merged)
    const text = stream.resetAndGetResult().trim()
    stream.destroy()
    return text
  }

  private push(event: Record<string, unknown>): void {
    if (!this.win || this.win.isDestroyed()) return
    try {
      this.win.webContents.send('voice:event', event)
    } catch (e) {
      log.warn(`[push] 发送失败: ${(e as Error).message}`)
    }
  }
}
