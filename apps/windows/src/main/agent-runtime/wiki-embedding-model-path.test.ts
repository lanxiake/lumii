/**
 * Wiki 嵌入模型路径 / 镜像 / 下载单测
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../client-data-root', () => ({
  resolveWindowsClientDataRoot: () => path.join(os.tmpdir(), 'lumii-test-data'),
}))

import {
  buildWikiEmbeddingFileUrl,
  DEFAULT_WIKI_EMBEDDING_MIRROR,
  resolveWikiEmbeddingMirrorBase,
} from './wiki-embedding-model-downloader'
import {
  isWikiEmbeddingModelReady,
  resolveWikiEmbeddingModelDir,
  TRANSFORMERS_E5_MODEL_ID,
  WIKI_EMBEDDING_QUANTIZED_ONNX,
} from './wiki-embedding-model-path'
import { resolveTransformersRemoteHosts } from './wiki-transformers-embedder'

describe('wiki-embedding-model-path', () => {
  let tempRoot: string

  afterEach(async () => {
    if (tempRoot) {
      await fs.promises.rm(tempRoot, { recursive: true, force: true })
      tempRoot = ''
    }
  })

  it('resolveWikiEmbeddingModelDir 拼接模型 ID', () => {
    expect(resolveWikiEmbeddingModelDir('/tmp/models')).toBe(
      path.join('/tmp/models', TRANSFORMERS_E5_MODEL_ID),
    )
  })

  it('isWikiEmbeddingModelReady 核心文件齐全时返回 true', async () => {
    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wiki-embed-'))
    const modelDir = resolveWikiEmbeddingModelDir(tempRoot)
    await fs.promises.mkdir(path.join(modelDir, 'onnx'), { recursive: true })
    await fs.promises.writeFile(path.join(modelDir, 'config.json'), '{}')
    await fs.promises.writeFile(path.join(modelDir, 'tokenizer.json'), '{}')
    await fs.promises.writeFile(path.join(modelDir, WIKI_EMBEDDING_QUANTIZED_ONNX), 'onnx')
    expect(await isWikiEmbeddingModelReady(tempRoot)).toBe(true)
  })
})

describe('wiki-embedding-model-downloader', () => {
  const originalHf = process.env.HF_ENDPOINT

  afterEach(() => {
    if (originalHf === undefined) delete process.env.HF_ENDPOINT
    else process.env.HF_ENDPOINT = originalHf
  })

  it('默认镜像为 hf-mirror', () => {
    delete process.env.HF_ENDPOINT
    delete process.env.LUMII_HF_ENDPOINT
    expect(resolveWikiEmbeddingMirrorBase()).toBe(DEFAULT_WIKI_EMBEDDING_MIRROR)
  })

  it('buildWikiEmbeddingFileUrl 生成 resolve/main 链接', () => {
    const url = buildWikiEmbeddingFileUrl('https://hf-mirror.com', 'config.json')
    expect(url).toBe(`https://hf-mirror.com/${TRANSFORMERS_E5_MODEL_ID}/resolve/main/config.json`)
  })
})

describe('resolveTransformersRemoteHosts', () => {
  const originalHf = process.env.HF_ENDPOINT

  afterEach(() => {
    if (originalHf === undefined) delete process.env.HF_ENDPOINT
    else process.env.HF_ENDPOINT = originalHf
  })

  it('未配置时 hf-mirror 优先于官方 Hub', () => {
    delete process.env.HF_ENDPOINT
    delete process.env.LUMII_HF_ENDPOINT
    expect(resolveTransformersRemoteHosts()[0]).toBe('https://hf-mirror.com/')
  })
})
