/**
 * Wiki 嵌入模型下载器：默认从 hf-mirror 拉取到 ~/.lumii/models/wiki-embeddings。
 */

import * as fs from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import * as path from 'node:path'
import { createLogger } from '../logger'
import { isWikiVectorEnabled } from './wiki-embedding-config'
import {
  isWikiEmbeddingModelReady,
  resolveWikiEmbeddingCacheDir,
  resolveWikiEmbeddingModelDir,
  TRANSFORMERS_E5_MODEL_ID,
  WIKI_EMBEDDING_COMPLETE_MARKER,
} from './wiki-embedding-model-path'

const log = createLogger('WikiEmbedDownloader')

/** 国内默认可达镜像（与语音模块 ASR/TTS 一致） */
export const DEFAULT_WIKI_EMBEDDING_MIRROR = 'https://hf-mirror.com'

/** 量化 feature-extraction 所需文件（合计约 140MB） */
export const WIKI_EMBEDDING_MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'sentencepiece.bpe.model',
  'quant_config.json',
  'onnx/model_quantized.onnx',
] as const

/** 下载中的互斥 Promise，避免并发重复拉取 */
let inFlightDownload: Promise<boolean> | null = null

/**
 * 解析 Hugging Face 镜像 base URL（无尾部斜杠）。
 * 优先 HF_ENDPOINT / LUMII_HF_ENDPOINT，否则默认 hf-mirror。
 */
export function resolveWikiEmbeddingMirrorBase(): string {
  const configured = process.env.HF_ENDPOINT ?? process.env.LUMII_HF_ENDPOINT
  if (configured?.trim()) return configured.trim().replace(/\/$/, '')
  return DEFAULT_WIKI_EMBEDDING_MIRROR
}

/**
 * 构造单个模型文件的镜像下载 URL。
 */
export function buildWikiEmbeddingFileUrl(mirrorBase: string, relativePath: string): string {
  return `${mirrorBase.replace(/\/$/, '')}/${TRANSFORMERS_E5_MODEL_ID}/resolve/main/${relativePath}`
}

/**
 * 带重定向的 HTTP(S) 下载。
 */
async function downloadFile(url: string, destPath: string, redirectCount = 0): Promise<void> {
  if (redirectCount > 8) throw new Error(`重定向次数过多: ${url}`)

  await new Promise<void>((resolve, reject) => {
    const parsed = new URL(url)
    const proto = parsed.protocol === 'https:' ? https : http
    const request = proto.get(url, { timeout: 180_000 }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        const nextUrl = new URL(response.headers.location, url).href
        downloadFile(nextUrl, destPath, redirectCount + 1).then(resolve, reject)
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`HTTP ${response.statusCode}: ${url}`))
        return
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      const file = fs.createWriteStream(destPath)
      response.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', reject)
    })
    request.on('error', reject)
    request.on('timeout', () => request.destroy(new Error(`下载超时: ${url}`)))
  })
}

/**
 * 从镜像下载缺失文件到用户缓存目录。
 * @returns 是否在本轮调用中完成了下载（false 表示此前已就绪）
 */
export async function downloadWikiEmbeddingModelIfNeeded(
  mirrorBase = resolveWikiEmbeddingMirrorBase(),
): Promise<boolean> {
  const cacheDir = resolveWikiEmbeddingCacheDir()
  if (await isWikiEmbeddingModelReady(cacheDir)) return false

  if (inFlightDownload) return inFlightDownload

  inFlightDownload = (async () => {
    const modelDir = resolveWikiEmbeddingModelDir(cacheDir)
    log.info(`[download] 开始从 ${mirrorBase} 下载 ${TRANSFORMERS_E5_MODEL_ID} → ${cacheDir}`)

    for (const rel of WIKI_EMBEDDING_MODEL_FILES) {
      const dest = path.join(modelDir, rel)
      if (fs.existsSync(dest)) continue
      const url = buildWikiEmbeddingFileUrl(mirrorBase, rel)
      log.info(`[download] ${rel}`)
      await downloadFile(url, dest)
    }

    if (!(await isWikiEmbeddingModelReady(cacheDir))) {
      throw new Error('模型文件下载后校验不完整')
    }

    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(
      path.join(cacheDir, WIKI_EMBEDDING_COMPLETE_MARKER),
      `${TRANSFORMERS_E5_MODEL_ID}\n${mirrorBase}\n${new Date().toISOString()}\n`,
    )
    log.info(`[download] ${TRANSFORMERS_E5_MODEL_ID} 已缓存到 ${cacheDir}`)
    return true
  })()

  try {
    return await inFlightDownload
  } finally {
    inFlightDownload = null
  }
}

/**
 * 应用初始化时预下载（失败仅打日志，不阻塞启动）。
 */
export async function prefetchWikiEmbeddingModelOnInit(): Promise<void> {
  if (!isWikiVectorEnabled()) return
  try {
    const downloaded = await downloadWikiEmbeddingModelIfNeeded()
    if (downloaded) {
      log.info('[init] Wiki 嵌入模型预下载完成')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`[init] Wiki 嵌入模型预下载失败（首次搜索时将重试或降级）：${message}`)
  }
}

/**
 * 加载 embedder 前确保模型已缓存；失败抛出供上层降级。
 */
export async function ensureWikiEmbeddingModelReady(): Promise<string> {
  await downloadWikiEmbeddingModelIfNeeded()
  const cacheDir = resolveWikiEmbeddingCacheDir()
  if (!(await isWikiEmbeddingModelReady(cacheDir))) {
    throw new Error('嵌入模型未就绪')
  }
  return cacheDir
}
