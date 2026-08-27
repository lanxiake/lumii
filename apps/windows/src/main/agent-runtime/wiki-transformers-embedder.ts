/**
 * Wiki 宿主侧多语言嵌入：优先 Transformers.js（multilingual-e5-small），失败回退 bigram 哈希。
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

const log = createLogger('WikiEmbedder')

/**
 * 从应用根 package.json 解析外部依赖。
 * 打包后主进程 chunk 位于 out/main/chunks，Node 默认无法从该目录 bare import node_modules。
 */
function requireFromAppRoot<T = unknown>(specifier: string): T {
  const appPackageJson = path.join(__dirname, '../../../package.json')
  return createRequire(appPackageJson)(specifier) as T
}

export const TRANSFORMERS_E5_MODEL_ID = 'Xenova/multilingual-e5-small'
export const TRANSFORMERS_E5_DIMS = 384

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
  if (cacheDir) {
    await fs.promises.mkdir(cacheDir, { recursive: true })
    process.env.TRANSFORMERS_CACHE = cacheDir
  }

  const { pipeline, env } = requireFromAppRoot<typeof import('@xenova/transformers')>('@xenova/transformers')
  // Electron/Node：允许本地缓存，避免重复下载
  env.allowLocalModels = true
  if (cacheDir) env.cacheDir = cacheDir

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extractor: any = await pipeline('feature-extraction', TRANSFORMERS_E5_MODEL_ID, {
    quantized: true,
  })

  return {
    modelId: TRANSFORMERS_E5_MODEL_ID,
    dims: TRANSFORMERS_E5_DIMS,
    async embed(text: string): Promise<Float32Array> {
      const trimmed = text.trim()
      if (!trimmed) return new Float32Array(TRANSFORMERS_E5_DIMS)
      // 检索查询与文档统一用 passage 前缀亦可；短查询用 query 前缀更贴 E5
      const prefixed = trimmed.length < 200 ? `query: ${trimmed}` : `passage: ${trimmed}`
      const output = await extractor(prefixed, { pooling: 'mean', normalize: true })
      if (output?.data && output.dims) {
        // 部分版本已做 pooling；若 dims 为 [1, hidden] 直接拷贝
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
  if (options.enabled === false || process.env.LUMII_WIKI_VECTOR === '0') {
    return {
      embedder: createBigramHashEmbedder(),
      backend: 'bigram-hash',
      notice: '向量检索已关闭，仅全文检索（可设 LUMII_WIKI_VECTOR=1 启用）',
    }
  }

  const cacheDir =
    options.cacheDir ??
    path.join(process.env.LUMII_CLIENT_DATA_DIR ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.lumii'), 'models', 'wiki-embeddings')

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
