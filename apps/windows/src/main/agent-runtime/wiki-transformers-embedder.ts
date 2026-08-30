/**
 * Wiki 宿主侧多语言嵌入：优先本地缓存（hf-mirror 预下载），失败回退 bigram 哈希。
 *
 * 设计：P2 §9.1 — 须支持中文；可关闭；失败显式降级无静默。
 * agent-runtime 保持零模型依赖，本模块仅在 Electron 主进程加载。
 */

import {
  createBigramHashEmbedder,
  type WikiEmbedder,
} from '@mtbot/agent-runtime'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { createLogger } from '../logger'
import { isWikiVectorEnabled } from './wiki-embedding-config'
import { ensureWikiEmbeddingModelReady } from './wiki-embedding-model-downloader'
import {
  resolveWikiEmbeddingCacheDir,
  TRANSFORMERS_E5_MODEL_ID,
} from './wiki-embedding-model-path'

const log = createLogger('WikiEmbedder')

/**
 * 从应用根 package.json 解析外部依赖。
 * 打包后主进程 chunk 位于 out/main/chunks，Node 默认无法从该目录 bare import node_modules。
 */
function requireFromAppRoot<T = unknown>(specifier: string): T {
  const appPackageJson = path.join(__dirname, '../../../package.json')
  return createRequire(appPackageJson)(specifier) as T
}

export { TRANSFORMERS_E5_MODEL_ID } from './wiki-embedding-model-path'

export const TRANSFORMERS_E5_DIMS = 384

const DEFAULT_HF_REMOTE_HOST = 'https://huggingface.co/'
const HF_MIRROR_REMOTE_HOST = 'https://hf-mirror.com/'

/**
 * 规范化 Transformers.js remoteHost（须带尾部斜杠）。
 */
export function normalizeTransformersRemoteHost(host: string): string {
  const trimmed = host.trim()
  if (!trimmed) return HF_MIRROR_REMOTE_HOST
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

/**
 * 解析模型下载 host 候选列表：优先用户配置，默认国内 hf-mirror，官方 Hub 作回退。
 */
export function resolveTransformersRemoteHosts(): readonly string[] {
  const configured = process.env.HF_ENDPOINT ?? process.env.LUMII_HF_ENDPOINT
  const hosts = configured
    ? [normalizeTransformersRemoteHost(configured)]
    : [HF_MIRROR_REMOTE_HOST, DEFAULT_HF_REMOTE_HOST]
  return [...new Set(hosts)]
}

export type WikiEmbedBackend = 'transformers' | 'bigram-hash'

export interface WikiHostEmbedderResult {
  readonly embedder: WikiEmbedder
  readonly backend: WikiEmbedBackend
  /** 非空时 UI/IPC 应展示给用户（关闭或降级原因） */
  readonly notice: string | null
}

export interface WikiHostEmbedderOptions {
  /** false 时强制 bigram，并给出 notice */
  readonly enabled?: boolean
  /** 模型缓存目录（默认 ~/.lumii/models/wiki-embeddings） */
  readonly cacheDir?: string
}

/**
 * 平均池化 + L2 归一化（e5 / sentence-transformers 常用后处理）。
 */
export function meanPoolAndNormalize(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output: { data: Float32Array | number[]; dims: number[] },
): Float32Array {
  const [seqLen, hidden] = output.dims.length === 3
    ? [output.dims[1]!, output.dims[2]!]
    : [output.dims[0]!, output.dims[1]!]
  const data = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data)
  const pooled = new Float32Array(hidden)
  for (let i = 0; i < seqLen; i += 1) {
    for (let j = 0; j < hidden; j += 1) {
      pooled[j]! += data[i * hidden + j]!
    }
  }
  for (let j = 0; j < hidden; j += 1) pooled[j]! /= seqLen
  let norm = 0
  for (let j = 0; j < hidden; j += 1) norm += pooled[j]! * pooled[j]!
  norm = Math.sqrt(norm) || 1
  for (let j = 0; j < hidden; j += 1) pooled[j]! /= norm
  return pooled
}

/**
 * 懒加载 Transformers.js pipeline，构造 E5 嵌入器。
 * 查询加 `query:` 前缀，文档加 `passage:` 前缀（E5 约定）。
 */
export async function createTransformersE5Embedder(cacheDir?: string): Promise<WikiEmbedder> {
  const localRoot = cacheDir ?? resolveWikiEmbeddingCacheDir()
  await fs.promises.mkdir(localRoot, { recursive: true })
  process.env.TRANSFORMERS_CACHE = localRoot

  const { pipeline, env } = requireFromAppRoot<typeof import('@xenova/transformers')>('@xenova/transformers')
  env.allowLocalModels = true
  env.cacheDir = localRoot

  let lastError: unknown = new Error('未尝试加载嵌入模型')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let extractor: any

  try {
    await ensureWikiEmbeddingModelReady()
    env.localModelPath = localRoot
    env.allowRemoteModels = false
    log.info(`[wiki-embedder] 从本地缓存加载 ${TRANSFORMERS_E5_MODEL_ID} (${localRoot})`)
    extractor = await pipeline('feature-extraction', TRANSFORMERS_E5_MODEL_ID, {
      quantized: true,
      local_files_only: true,
    })
    log.info(`[wiki-embedder] 已从本地缓存加载 ${TRANSFORMERS_E5_MODEL_ID}`)
  } catch (err) {
    lastError = err
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`[wiki-embedder] 本地缓存加载失败，尝试镜像在线拉取：${message}`)
    env.allowRemoteModels = true
  }

  if (!extractor) {
    const remoteHosts = resolveTransformersRemoteHosts()
    for (const remoteHost of remoteHosts) {
      try {
        env.remoteHost = remoteHost
        log.info(`[wiki-embedder] 尝试从 ${remoteHost} 加载 ${TRANSFORMERS_E5_MODEL_ID}`)
        extractor = await pipeline('feature-extraction', TRANSFORMERS_E5_MODEL_ID, {
          quantized: true,
        })
        log.info(`[wiki-embedder] 已从 ${remoteHost} 加载 ${TRANSFORMERS_E5_MODEL_ID}`)
        break
      } catch (err) {
        lastError = err
        const message = err instanceof Error ? err.message : String(err)
        log.warn(`[wiki-embedder] ${remoteHost} 加载失败：${message}`)
      }
    }
  }

  if (!extractor) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  return {
    modelId: TRANSFORMERS_E5_MODEL_ID,
    dims: TRANSFORMERS_E5_DIMS,
    async embed(text: string): Promise<Float32Array> {
      const trimmed = text.trim()
      if (!trimmed) return new Float32Array(TRANSFORMERS_E5_DIMS)
      const prefixed = trimmed.length < 200 ? `query: ${trimmed}` : `passage: ${trimmed}`
      const output = await extractor(prefixed, { pooling: 'mean', normalize: true })
      if (output?.data && output.dims) {
        if (output.dims.length === 2 && output.dims[0] === 1) {
          const data = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data)
          return data.length === TRANSFORMERS_E5_DIMS ? data : meanPoolAndNormalize(output)
        }
        return meanPoolAndNormalize(output)
      }
      throw new Error('Transformers embedding 输出格式异常')
    },
  }
}

/**
 * 解析宿主嵌入后端：优先 E5，失败或关闭时回退 bigram 并带 notice。
 */
export async function resolveWikiHostEmbedder(
  options: WikiHostEmbedderOptions = {},
): Promise<WikiHostEmbedderResult> {
  if (!options.enabled || !isWikiVectorEnabled()) {
    return {
      embedder: createBigramHashEmbedder(),
      backend: 'bigram-hash',
      notice: '向量检索已关闭，仅全文检索（可设 LUMII_WIKI_VECTOR=1 启用）',
    }
  }

  const cacheDir = options.cacheDir ?? resolveWikiEmbeddingCacheDir()

  try {
    const embedder = await createTransformersE5Embedder(cacheDir)
    log.info(`[wiki-embedder] 已加载 ${TRANSFORMERS_E5_MODEL_ID}`)
    return { embedder, backend: 'transformers', notice: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`[wiki-embedder] Transformers 加载失败，回退 bigram：${message}`)
    return {
      embedder: createBigramHashEmbedder(),
      backend: 'bigram-hash',
      notice: `多语言嵌入模型加载失败，已降级本地哈希向量：${message}`,
    }
  }
}
