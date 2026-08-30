/**
 * meanPoolAndNormalize / remote host 解析单测（不加载真实模型）
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  meanPoolAndNormalize,
  normalizeTransformersRemoteHost,
  resolveTransformersRemoteHosts,
} from './wiki-transformers-embedder'

describe('meanPoolAndNormalize', () => {
  it('对 [seq, hidden] 做均值池化并 L2 归一化', () => {
    const data = new Float32Array([1, 0, 3, 0])
    const out = meanPoolAndNormalize({ data, dims: [2, 2] })
    expect(out.length).toBe(2)
    const norm = Math.sqrt(out[0]! * out[0]! + out[1]! * out[1]!)
    expect(norm).toBeCloseTo(1, 5)
    expect(out[0]).toBeGreaterThan(out[1]!)
  })
})

describe('resolveTransformersRemoteHosts', () => {
  const originalHfEndpoint = process.env.HF_ENDPOINT
  const originalLumiiHfEndpoint = process.env.LUMII_HF_ENDPOINT

  afterEach(() => {
    if (originalHfEndpoint === undefined) delete process.env.HF_ENDPOINT
    else process.env.HF_ENDPOINT = originalHfEndpoint
    if (originalLumiiHfEndpoint === undefined) delete process.env.LUMII_HF_ENDPOINT
    else process.env.LUMII_HF_ENDPOINT = originalLumiiHfEndpoint
  })

  it('normalizeTransformersRemoteHost 补全尾部斜杠', () => {
    expect(normalizeTransformersRemoteHost('https://hf-mirror.com')).toBe('https://hf-mirror.com/')
    expect(normalizeTransformersRemoteHost('https://hf-mirror.com/')).toBe('https://hf-mirror.com/')
  })

  it('未配置时 hf-mirror 优先于官方 Hub', () => {
    delete process.env.HF_ENDPOINT
    delete process.env.LUMII_HF_ENDPOINT
    expect(resolveTransformersRemoteHosts()).toEqual([
      'https://hf-mirror.com/',
      'https://huggingface.co/',
    ])
  })

  it('HF_ENDPOINT 优先且去重', () => {
    process.env.HF_ENDPOINT = 'https://hf-mirror.com'
    expect(resolveTransformersRemoteHosts()).toEqual(['https://hf-mirror.com/'])
  })
})
