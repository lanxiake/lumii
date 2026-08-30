/**
 * Wiki 嵌入默认环境配置单测
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyWikiEmbeddingEnvDefaults,
  DEFAULT_LUMII_WIKI_VECTOR,
  isWikiVectorEnabled,
} from './wiki-embedding-config'
import { DEFAULT_WIKI_EMBEDDING_MIRROR } from './wiki-embedding-model-downloader'

describe('applyWikiEmbeddingEnvDefaults', () => {
  const keys = ['HF_ENDPOINT', 'LUMII_HF_ENDPOINT', 'LUMII_WIKI_VECTOR'] as const
  const snapshot: Partial<Record<(typeof keys)[number], string | undefined>> = {}

  afterEach(() => {
    for (const key of keys) {
      if (snapshot[key] === undefined) delete process.env[key]
      else process.env[key] = snapshot[key]
    }
  })

  function saveEnv(): void {
    for (const key of keys) snapshot[key] = process.env[key]
  }

  it('未配置时写入 hf-mirror 并启用向量检索', () => {
    saveEnv()
    delete process.env.HF_ENDPOINT
    delete process.env.LUMII_HF_ENDPOINT
    delete process.env.LUMII_WIKI_VECTOR
    applyWikiEmbeddingEnvDefaults()
    expect(process.env.HF_ENDPOINT).toBe(DEFAULT_WIKI_EMBEDDING_MIRROR)
    expect(process.env.LUMII_HF_ENDPOINT).toBe(DEFAULT_WIKI_EMBEDDING_MIRROR)
    expect(process.env.LUMII_WIKI_VECTOR).toBe(DEFAULT_LUMII_WIKI_VECTOR)
    expect(isWikiVectorEnabled()).toBe(true)
  })

  it('LUMII_WIKI_VECTOR=0 时关闭向量检索', () => {
    saveEnv()
    process.env.LUMII_WIKI_VECTOR = '0'
    expect(isWikiVectorEnabled()).toBe(false)
  })
})
