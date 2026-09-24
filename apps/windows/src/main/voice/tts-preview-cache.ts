/**
 * TTS 预览/朗读音频内存缓存（按句 LRU）
 *
 * 整段文本拆成句子分别缓存，跨消息可复用相同句子，单条体积小、命中率更高。
 */
import { createHash } from 'node:crypto'
import type { VoiceTtsConfig } from '../../shared/voice-events.js'
import type { TtsChunk } from './tts-engine.js'

const log = {
  debug: (...args: unknown[]) => console.log('[TtsPreviewCache:DEBUG]', ...args),
  info: (...args: unknown[]) => console.log('[TtsPreviewCache]', ...args),
}

/** 单句参与缓存的最大字符数（超长句只合成不落库） */
export const TTS_SENTENCE_CACHE_MAX_CHARS = 200

/** 整段文本超过此长度仍可按句缓存，但不再整段键缓存 */
export const TTS_PREVIEW_CACHE_MAX_TEXT_CHARS = 80_000

/** LRU 最大句条数（按句存，可多一些） */
const MAX_ENTRIES = 240

/** 单句缓存估算字节上限 */
const MAX_ENTRY_ESTIMATED_BYTES = 4 * 1024 * 1024

/**
 * 生成「单句」缓存键：TTS 参数指纹 + 句文本哈希
 * @param resolvedLanguage 整段锁定后的语种（勿用逐句 Auto 结果，否则中英句会串味）
 */
export function buildTtsPreviewCacheKey(
  text: string,
  tts: VoiceTtsConfig,
  resolvedLanguage?: string,
): string {
  const normalized = text.trim().replace(/\s+/g, ' ')
  const hash = createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 24)
  const cloneOn = tts.qwen3CloneEnabled === true && Boolean(tts.qwen3ProfileId)
  return [
    's2', // schema：按句 + 锁定语种
    tts.provider,
    String(tts.speed),
    tts.voice ?? '',
    String(tts.speakerId ?? 0),
    // 音量只影响播放 Gain，不影响波形，不进键
    tts.qwen3Variant ?? '',
    tts.qwen3Speaker ?? '',
    tts.qwen3Instruct ?? '',
    // 配置里的 Auto 不足以区分实际语种，必须写入解析/锁定结果
    resolvedLanguage || tts.language || 'Chinese',
    cloneOn ? '1' : '0',
    tts.qwen3CloneVariant ?? '',
    tts.qwen3ProfileId ?? '',
    tts.qwen3Device ?? 'auto',
    hash,
  ].join('|')
}

/**
 * 将完整文本拆成适合缓存/合成的句子列表（硬标点优先，过长再切）
 * softMax 不宜过小：切太碎会导致每段独立采样，听感像换人朗读
 */
export function splitTextForTtsCache(text: string, softMax = 120): string[] {
  const src = text.trim().replace(/\s+/g, ' ')
  if (!src) return []

  const hard = /[。！？…\n]|[.!?](?=\s|$)/g
  const parts: string[] = []
  let start = 0
  let m: RegExpExecArray | null
  while ((m = hard.exec(src)) !== null) {
    const end = m.index + m[0].length
    const seg = src.slice(start, end).trim()
    if (seg) parts.push(seg)
    start = end
  }
  const rest = src.slice(start).trim()
  if (rest) parts.push(rest)

  const maxLen = Math.max(48, softMax)
  const out: string[] = []
  for (const p of parts) {
    if (p.length <= maxLen) {
      out.push(p)
      continue
    }
    let buf = p
    while (buf.length > maxLen) {
      let cut = maxLen
      const window = buf.slice(0, maxLen)
      for (let i = window.length - 1; i >= Math.floor(maxLen * 0.5); i--) {
        if (/[，；、,\s]/.test(window[i]!)) {
          cut = i + 1
          break
        }
      }
      const piece = buf.slice(0, cut).trim()
      if (piece) out.push(piece)
      buf = buf.slice(cut).trim()
    }
    if (buf) out.push(buf)
  }
  return out.length > 0 ? out : [src]
}

function cloneChunks(chunks: readonly TtsChunk[]): TtsChunk[] {
  return chunks.map((c) => ({
    samples: c.samples.slice(),
    sampleRate: c.sampleRate,
    isFinal: c.isFinal,
  }))
}

function estimateChunksBytes(chunks: readonly TtsChunk[]): number {
  let n = 0
  for (const c of chunks) n += c.samples.length
  return n * 8
}

/**
 * 去掉空的 isFinal 标记帧，避免缓存膨胀；播放时由调度方补最终帧
 */
export function normalizeSentenceChunks(chunks: readonly TtsChunk[]): TtsChunk[] {
  return chunks
    .filter((c) => c.samples.length > 0)
    .map((c) => ({
      samples: c.samples.slice(),
      sampleRate: c.sampleRate,
      isFinal: false,
    }))
}

class TtsPreviewLruCache {
  private readonly map = new Map<string, TtsChunk[]>()

  /** 取出单句缓存（深拷贝）并刷新 LRU */
  get(key: string): TtsChunk[] | undefined {
    const v = this.map.get(key)
    if (!v?.length) return undefined
    this.map.delete(key)
    this.map.set(key, v)
    return cloneChunks(v)
  }

  /** 写入单句音频 */
  set(key: string, chunks: readonly TtsChunk[]): void {
    const frozen = normalizeSentenceChunks(chunks)
    if (frozen.length === 0) return
    const bytes = estimateChunksBytes(frozen)
    if (bytes > MAX_ENTRY_ESTIMATED_BYTES) {
      log.debug(`skip cache: estimated ${bytes} bytes > limit`)
      return
    }
    if (this.map.has(key)) this.map.delete(key)
    while (this.map.size >= MAX_ENTRIES) {
      const first = this.map.keys().next().value as string | undefined
      if (!first) break
      this.map.delete(first)
    }
    this.map.set(key, frozen)
    log.debug(`store entries=${this.map.size} chunks=${frozen.length} ~${bytes}b`)
  }

  /** 当前缓存句条数（测试/诊断） */
  get size(): number {
    return this.map.size
  }

  /** 清空（测试用） */
  clear(): void {
    this.map.clear()
  }
}

export const ttsPreviewCache = new TtsPreviewLruCache()

/**
 * 按 TTS provider 给出建议合成并发度（Qwen3 受 sidecar 池大小限制）
 */
export function getTtsSynthConcurrency(provider: string, qwen3PoolSize = 2): number {
  if (provider === 'qwen3') return Math.max(1, qwen3PoolSize)
  if (provider === 'edge') return 3
  return 1
}

/**
 * 有限并发池：保持结果下标顺序，尽快完成未命中句的合成
 */
export async function mapPoolOrdered<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length
  if (n === 0) return []
  const results = new Array<R>(n)
  let next = 0
  const limit = Math.max(1, Math.min(concurrency, n))

  async function runWorker(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= n) return
      results[i] = await worker(items[i]!, i)
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()))
  return results
}

/**
 * 有序流水线：最多 concurrency 路并行合成，按句子下标顺序交付结果（首句 TTFA 不阻塞后续）
 */
export async function runOrderedSynthPipeline<T>(
  items: readonly T[],
  concurrency: number,
  synthesize: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const n = items.length
  if (n === 0) return
  const limit = Math.max(1, Math.min(concurrency, n))
  const slots: Array<Promise<void> | undefined> = new Array(n)
  let started = 0

  /** 启动下标 i 的合成任务（幂等） */
  const ensureStarted = (i: number): Promise<void> => {
    if (slots[i]) return slots[i]!
    slots[i] = synthesize(items[i]!, i)
    return slots[i]!
  }

  for (let emitIdx = 0; emitIdx < n; emitIdx++) {
    if (signal?.aborted) return
    while (started < n && started < emitIdx + limit) {
      void ensureStarted(started++)
    }
    await ensureStarted(emitIdx)
  }
}
