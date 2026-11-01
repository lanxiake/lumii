/**
 * 语音唤醒：「灵栖灵栖」。
 *
 * ## 为什么不自己再加载一套模型
 *
 * 唤醒同样需要 VAD + 离线 ASR，而这两样 `VoiceCallService` 已经加载好了
 * （Paraformer 权重 78MB，加载两遍纯属浪费，且两套 VAD 的段缓冲还会各自漂移）。
 * 所以这里只负责**判定逻辑**（段筛选、冷却、文本匹配），引擎通过
 * `WakeEngineProvider` 借通话服务那一份。
 *
 * ## 为什么不走 sherpa 的关键词唤醒（KWS）
 *
 * KWS 要单独的 zipformer transducer 模型 + keywords.txt，本地得多下几百 MB 并
 * 新增一条下载链路；而空闲时"一句话说完跑一次离线 ASR"在 CPU 上只有几十毫秒。
 *
 * ponytail: 上限是唤醒词必须说清楚（连读/极小声会识别成别的词）。
 * 真要低功耗常驻待命，再换 KWS 模型。
 */

import { matchWakeWord } from './wake-word-matcher'

const log = {
  info: (...args: unknown[]) => console.log('[VoiceWake]', ...args),
  warn: (...args: unknown[]) => console.warn('[VoiceWake]', ...args),
  error: (...args: unknown[]) => console.error('[VoiceWake]', ...args),
}

/** 唤醒命中后的静默期：一句话里两次「灵栖灵栖」不该触发两次 */
const WAKE_COOLDOWN_MS = 3000
/** 太短的是语气词/噪声，太长的多半是环境人声，都不做唤醒判定 */
const MIN_SEGMENT_SEC = 0.45
const MAX_SEGMENT_SEC = 6

export type WakeWordHit = {
  /** 命中的规范化文本 */
  matched: string
  /** 该段 ASR 的原始文本，便于排查误触发 */
  rawText: string
}

/** 借来的引擎（由 VoiceCallService 实现），唤醒不自己持有模型 */
export interface WakeEngineProvider {
  /** 确保 VAD/ASR 就绪（可重复调用） */
  ensureWakeEngine(): Promise<void>
  /** 把帧喂给 VAD，返回已完成的语音段 */
  pushVad(samples: Float32Array): Float32Array[]
  /** 对一段 PCM 做离线识别 */
  transcribeSegment(samples: Float32Array, sampleRate: number): Promise<string>
}

export class VoiceWakeService {
  private attached = false
  private lastWakeAt = 0

  constructor(
    private engine: WakeEngineProvider,
    private onWake: (hit: WakeWordHit) => void,
  ) {}

  isAttached(): boolean {
    return this.attached
  }

  async attach(): Promise<void> {
    if (this.attached) return
    await this.engine.ensureWakeEngine()
    this.attached = true
    this.lastWakeAt = 0
    log.info('[attach] 唤醒监听已开启')
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    log.info('[detach] 唤醒监听已关闭')
  }

  feed(samples: Float32Array): void {
    if (!this.attached) return

    let segments: Float32Array[]
    try {
      segments = this.engine.pushVad(samples)
    } catch (e) {
      log.error(`[feed] VAD 处理失败: ${(e as Error).message}`)
      return
    }
    if (segments.length === 0) return

    const now = Date.now()
    if (now - this.lastWakeAt < WAKE_COOLDOWN_MS) return

    for (const segment of segments) {
      const seconds = segment.length / 16000
      if (seconds < MIN_SEGMENT_SEC || seconds > MAX_SEGMENT_SEC) {
        log.info(`[feed] 跳过 ${seconds.toFixed(2)}s 语音段（不在唤醒判定范围）`)
        continue
      }
      void this.detect(segment)
    }
  }

  private async detect(segment: Float32Array): Promise<void> {
    try {
      const text = (await this.engine.transcribeSegment(segment, 16000)).trim()
      if (!text) return
      const matched = matchWakeWord(text)
      if (!matched) {
        log.info(`[detect] 未命中：ASR="${text}"`)
        return
      }
      const now = Date.now()
      if (now - this.lastWakeAt < WAKE_COOLDOWN_MS) return
      this.lastWakeAt = now
      log.info(`[detect] 唤醒命中 "${matched}"（ASR="${text}"）`)
      this.onWake({ matched, rawText: text })
    } catch (e) {
      log.error(`[detect] 识别失败: ${(e as Error).message}`)
    }
  }
}
