/**
 * 按句 TTS 缓存与并行流水线单测
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildTtsPreviewCacheKey,
  getTtsSynthConcurrency,
  mapPoolOrdered,
  normalizeSentenceChunks,
  runOrderedSynthPipeline,
  splitTextForTtsCache,
  ttsPreviewCache,
  TTS_SENTENCE_CACHE_MAX_CHARS,
} from './tts-preview-cache.js'
import type { VoiceTtsConfig } from '../../shared/voice-events.js'

/** 构造最小 TTS 配置 */
function makeTts(partial: Partial<VoiceTtsConfig> = {}): VoiceTtsConfig {
  return {
    provider: 'qwen3',
    speed: 1,
    voice: 'Vivian',
    volume: 1,
    ...partial,
  } as VoiceTtsConfig
}

describe('buildTtsPreviewCacheKey', () => {
  it('同句同配置键相同，音量变化不影响键', () => {
    const a = buildTtsPreviewCacheKey('你好。', makeTts({ volume: 0.5 }), 'Chinese')
    const b = buildTtsPreviewCacheKey('你好。', makeTts({ volume: 2 }), 'Chinese')
    expect(a).toBe(b)
    expect(a.startsWith('s2|')).toBe(true)
  })

  it('不同句子键不同', () => {
    const a = buildTtsPreviewCacheKey('你好。', makeTts(), 'Chinese')
    const b = buildTtsPreviewCacheKey('再见。', makeTts(), 'Chinese')
    expect(a).not.toBe(b)
  })

  it('锁定语种不同则键不同（避免中英缓存串味）', () => {
    const a = buildTtsPreviewCacheKey('OK.', makeTts({ language: 'Auto' }), 'Chinese')
    const b = buildTtsPreviewCacheKey('OK.', makeTts({ language: 'Auto' }), 'English')
    expect(a).not.toBe(b)
  })
})

describe('splitTextForTtsCache', () => {
  it('按中文硬标点分句', () => {
    expect(splitTextForTtsCache('你好。世界！吗？')).toEqual(['你好。', '世界！', '吗？'])
  })

  it('过长句按逗号再切', () => {
    const long = `${'特别'.repeat(80)}长的话，中间有逗号可以切开继续说下去而且后面还很长很长。`
    const parts = splitTextForTtsCache(long)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((p) => p.length <= 120)).toBe(true)
  })
})

describe('ttsPreviewCache LRU', () => {
  beforeEach(() => {
    ttsPreviewCache.clear()
  })

  it('按句存取并深拷贝', () => {
    const key = buildTtsPreviewCacheKey('缓存句。', makeTts())
    ttsPreviewCache.set(key, [
      { samples: [0.1, 0.2], sampleRate: 24000, isFinal: false },
      { samples: [], sampleRate: 24000, isFinal: true },
    ])
    const hit = ttsPreviewCache.get(key)!
    expect(hit.length).toBe(1)
    expect(hit[0]!.samples).toEqual([0.1, 0.2])
    hit[0]!.samples[0] = 9
    expect(ttsPreviewCache.get(key)![0]!.samples[0]).toBe(0.1)
  })

  it('超长句常量与 normalize', () => {
    expect(TTS_SENTENCE_CACHE_MAX_CHARS).toBe(200)
    expect(normalizeSentenceChunks([{ samples: [], sampleRate: 1, isFinal: true }])).toEqual([])
  })
})

describe('mapPoolOrdered / runOrderedSynthPipeline', () => {
  it('mapPoolOrdered 保持顺序且限制并发', async () => {
    let inflight = 0
    let maxInflight = 0
    const out = await mapPoolOrdered([1, 2, 3, 4], 2, async (n) => {
      inflight++
      maxInflight = Math.max(maxInflight, inflight)
      await new Promise((r) => setTimeout(r, 20))
      inflight--
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40])
    expect(maxInflight).toBeLessThanOrEqual(2)
  })

  it('runOrderedSynthPipeline 按序完成并可并行预取', async () => {
    const finished: number[] = []
    let inflight = 0
    let maxInflight = 0
    await runOrderedSynthPipeline(
      [0, 1, 2, 3],
      2,
      async (_item, index) => {
        inflight++
        maxInflight = Math.max(maxInflight, inflight)
        await new Promise((r) => setTimeout(r, 15))
        finished.push(index)
        inflight--
      },
    )
    expect(finished).toEqual([0, 1, 2, 3])
    expect(maxInflight).toBeGreaterThan(1)
  })

  it('getTtsSynthConcurrency 按 provider 区分', () => {
    expect(getTtsSynthConcurrency('qwen3', 2)).toBe(2)
    expect(getTtsSynthConcurrency('edge')).toBe(3)
    expect(getTtsSynthConcurrency('local-vits')).toBe(1)
  })
})
