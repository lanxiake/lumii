/**
 * TTS 预览音频内存缓存（LRU）
 *
 * 同一文本 + 同一 TTS 参数下重复朗读时复用已合成的 chunk，避免再次调用 Edge / 本地合成，降低 API 用量与 CPU。
 */
import { createHash } from 'node:crypto'
import type { VoiceTtsConfig } from '../../shared/voice-events.js'
import type { TtsChunk } from './tts-engine.js'

const log = {
  debug: (...args: unknown[]) => console.log('[TtsPreviewCache:DEBUG]', ...args),
  info: (...args: unknown[]) => console.log('[TtsPreviewCache]', ...args),
}

/** 参与缓存的最大文本长度（字符），过长只做实时合成不落缓存，避免超大 Map 值 */
export const TTS_PREVIEW_CACHE_MAX_TEXT_CHARS = 80_000

/** LRU 最大条数 */
const MAX_ENTRIES = 80

/** 单条缓存估算字节上限（number[] 粗略按 8 字节计），防止整段 MP3 撑爆内存 */
const MAX_ENTRY_ESTIMATED_BYTES = 32 * 1024 * 1024

/**
 * 生成缓存键：TTS 参数 + 正文 SHA256，避免 Map 键过长。
 * 必须包含会影响音色/合成结果的字段，否则换内置音色会误命中旧缓存。
 */
export function buildTtsPreviewCacheKey(text: string, tts: VoiceTtsConfig): string {
  const normalized = text.trim().replace(/\s+/g, ' ')
  const hash = createHash('sha256').update(normalized, 'utf8').digest('hex')
  const cloneOn = tts.qwen3CloneEnabled === true && Boolean(tts.qwen3ProfileId)
  return [
    tts.provider,
    String(tts.speed),
    tts.voice ?? '',
    String(tts.speakerId ?? 0),
    String(tts.volume ?? 1),
    tts.qwen3Variant ?? '',
    tts.qwen3Speaker ?? '',
    tts.qwen3Instruct ?? '',
    tts.language ?? '',
    cloneOn ? '1' : '0',
    tts.qwen3CloneVariant ?? '',
    tts.qwen3ProfileId ?? '',
    tts.qwen3Device ?? 'auto',
    hash,
  ].join('|')
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

class TtsPreviewLruCache {
  private readonly map = new Map<string, TtsChunk[]>()

  /**
   * 取出缓存的 chunk 列表（已深拷贝），并刷新 LRU 顺序。
   */
  get(key: string): TtsChunk[] | undefined {
    const v = this.map.get(key)
    if (!v?.length) return undefined
    this.map.delete(key)
    this.map.set(key, v)
    return cloneChunks(v)
  }

  /**
   * 写入完整一轮预览的 chunk（合成成功且未中止时调用）。
   */
  set(key: string, chunks: readonly TtsChunk[]): void {
    if (chunks.length === 0) return
    const bytes = estimateChunksBytes(chunks)
    if (bytes > MAX_ENTRY_ESTIMATED_BYTES) {
      log.debug(`skip cache: estimated ${bytes} bytes > limit`)
      return
    }
    const frozen = cloneChunks(chunks)
    if (this.map.has(key)) this.map.delete(key)
    while (this.map.size >= MAX_ENTRIES) {
      const first = this.map.keys().next().value as string | undefined
      if (!first) break
      this.map.delete(first)
    }
    this.map.set(key, frozen)
    log.debug(`store entries=${this.map.size} chunks=${frozen.length} ~${bytes}b`)
  }
}

export const ttsPreviewCache = new TtsPreviewLruCache()
