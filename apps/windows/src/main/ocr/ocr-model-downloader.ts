/**
 * OCR 模型按需下载：默认 hf-mirror，失败可换官方 HF；字典另备 GitHub raw。
 */
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { createLogger } from '../logger.js'
import {
  DEFAULT_OCR_HF_MIRROR,
  OCR_HF_REPO,
  OCR_MODEL_COMPLETE_MARKER,
  OCR_MODEL_FILES,
  OCR_REQUIRED_LOCAL_FILES,
  buildOcrModelFileUrl,
  type OcrModelFileSpec,
} from './ocr-model-manifest.js'
import { isOcrModelReady, resolveOcrModelDir } from './ocr-model-paths.js'

const log = createLogger('OcrModelDownloader')

/** 下载函数注入点（单测 mock） */
export type OcrDownloadFileFn = (url: string, destPath: string) => Promise<void>

export type OcrDownloadOptions = {
  modelDir?: string
  mirrorBase?: string
  downloadFile?: OcrDownloadFileFn
}

/** 字典文件的额外直链（HF 路径偶发缺失时） */
const DICT_FALLBACK_URLS = [
  'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/release/2.7/ppocr/utils/ppocr_keys_v1.txt',
  'https://cdn.jsdelivr.net/gh/PaddlePaddle/PaddleOCR@release/2.7/ppocr/utils/ppocr_keys_v1.txt',
] as const

let inFlight: Promise<boolean> | null = null

/**
 * 解析 HF 镜像 base（无尾斜杠）。
 */
export function resolveOcrMirrorBase(): string {
  const configured = process.env.HF_ENDPOINT ?? process.env.LUMII_HF_ENDPOINT
  if (configured?.trim()) return configured.trim().replace(/\/$/, '')
  return DEFAULT_OCR_HF_MIRROR
}

/**
 * 带重定向的 HTTP(S) 下载。
 */
export async function downloadHttpFile(url: string, destPath: string, redirectCount = 0): Promise<void> {
  if (redirectCount > 8) throw new Error(`重定向次数过多: ${url}`)

  await new Promise<void>((resolve, reject) => {
    const parsed = new URL(url)
    const proto = parsed.protocol === 'https:' ? https : http
    const request = proto.get(url, { timeout: 180_000 }, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume()
        const nextUrl = new URL(response.headers.location, url).href
        downloadHttpFile(nextUrl, destPath, redirectCount + 1).then(resolve, reject)
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
 * 为单个模型文件构造候选 URL 列表。
 */
function candidateUrls(file: OcrModelFileSpec, mirrorBase: string): string[] {
  const urls = [buildOcrModelFileUrl(mirrorBase, file.remotePath)]
  if (mirrorBase !== 'https://huggingface.co') {
    urls.push(buildOcrModelFileUrl('https://huggingface.co', file.remotePath))
  }
  if (file.localName === 'ppocr_keys_v1.txt') {
    urls.push(...DICT_FALLBACK_URLS)
  }
  return urls
}

/**
 * 按候选 URL 依次尝试下载，全部失败则抛错。
 */
async function downloadWithFallback(
  urls: string[],
  destPath: string,
  downloadFile: OcrDownloadFileFn,
): Promise<void> {
  let lastError: unknown
  for (const url of urls) {
    try {
      await downloadFile(url, destPath)
      return
    } catch (error) {
      lastError = error
      log.warn(`下载失败，尝试下一源: ${url}`)
      if (fs.existsSync(destPath)) {
        try {
          fs.unlinkSync(destPath)
        } catch {
          // ignore
        }
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * 若模型未就绪则下载；已就绪返回 false。
 */
export async function downloadOcrModelsIfNeeded(options: OcrDownloadOptions = {}): Promise<boolean> {
  const modelDir = options.modelDir ?? resolveOcrModelDir()
  if (isOcrModelReady(modelDir)) return false

  if (inFlight) return inFlight

  const mirrorBase = options.mirrorBase ?? resolveOcrMirrorBase()
  const downloadFile = options.downloadFile ?? downloadHttpFile

  inFlight = (async () => {
    log.info(`开始下载 OCR 模型 → ${modelDir}（mirror=${mirrorBase} repo=${OCR_HF_REPO}）`)
    fs.mkdirSync(modelDir, { recursive: true })

    for (const file of OCR_MODEL_FILES) {
      const dest = path.join(modelDir, file.localName)
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue
      await downloadWithFallback(candidateUrls(file, mirrorBase), dest, downloadFile)
    }

    for (const name of OCR_REQUIRED_LOCAL_FILES) {
      const p = path.join(modelDir, name)
      if (!fs.existsSync(p) || fs.statSync(p).size === 0) {
        throw new Error(`OCR 模型文件下载后仍缺失: ${name}`)
      }
    }

    fs.writeFileSync(
      path.join(modelDir, OCR_MODEL_COMPLETE_MARKER),
      `ppocr-v4-mobile\n${mirrorBase}\n${new Date().toISOString()}\n`,
    )
    log.info(`OCR 模型已就绪: ${modelDir}`)
    return true
  })()

  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

/**
 * 确保模型可用；失败抛错供上层降级云端 OCR。
 */
export async function ensureOcrModelsReady(options: OcrDownloadOptions = {}): Promise<string> {
  const modelDir = options.modelDir ?? resolveOcrModelDir()
  await downloadOcrModelsIfNeeded(options)
  if (!isOcrModelReady(modelDir)) {
    throw new Error('OCR 模型未就绪')
  }
  return modelDir
}
