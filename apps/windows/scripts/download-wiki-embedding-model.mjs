#!/usr/bin/env node
/**
 * 手动预下载 Wiki 嵌入模型到 ~/.lumii/models/wiki-embeddings（与运行时缓存路径一致）。
 *
 * 用法：
 *   node scripts/download-wiki-embedding-model.mjs
 *   node scripts/download-wiki-embedding-model.mjs --mirror https://hf-mirror.com
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import http from 'node:http'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODEL_ID = 'Xenova/multilingual-e5-small'
const CACHE_SUBDIR = path.join('models', 'wiki-embeddings')
const OUTPUT_ROOT = path.join(
  process.env.LUMII_CLIENT_DATA_DIR?.trim()
    ? path.resolve(process.env.LUMII_CLIENT_DATA_DIR.replace(/^~(?=$|[/\\])/, os.homedir()))
    : path.join(os.homedir(), '.lumii'),
  CACHE_SUBDIR,
  MODEL_ID,
)
const COMPLETE_MARKER = path.join(path.dirname(OUTPUT_ROOT), '.lumii-complete')

const DEFAULT_MIRROR = process.env.HF_ENDPOINT?.replace(/\/$/, '') ?? 'https://hf-mirror.com'

const MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'sentencepiece.bpe.model',
  'quant_config.json',
  'onnx/model_quantized.onnx',
]

/** 解析 CLI 镜像参数 */
function parseMirror(argv) {
  const idx = argv.indexOf('--mirror')
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1].replace(/\/$/, '')
  return DEFAULT_MIRROR
}

/** 带重定向的 HTTP(S) 下载 */
function downloadFile(url, destPath, redirectCount = 0) {
  if (redirectCount > 8) return Promise.reject(new Error(`重定向次数过多: ${url}`))
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https:') ? https : http
    const request = proto.get(url, { timeout: 180_000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
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
      const total = Number(response.headers['content-length'] ?? 0)
      let received = 0
      response.on('data', (chunk) => {
        received += chunk.length
        if (total > 0) {
          const pct = ((received / total) * 100).toFixed(1)
          process.stdout.write(`\r  ${path.basename(destPath)} ${pct}%`)
        }
      })
      response.pipe(file)
      file.on('finish', () => {
        file.close(() => {
          process.stdout.write('\n')
          resolve(undefined)
        })
      })
      file.on('error', reject)
    })
    request.on('error', reject)
    request.on('timeout', () => request.destroy(new Error(`下载超时: ${url}`)))
  })
}

function isCompleteLocally() {
  return MODEL_FILES.every((rel) => fs.existsSync(path.join(OUTPUT_ROOT, rel)))
}

async function main() {
  const mirror = parseMirror(process.argv.slice(2))
  console.log(`[wiki-embedding-model] 目标: ${OUTPUT_ROOT}`)
  console.log(`[wiki-embedding-model] 镜像: ${mirror}`)

  if (isCompleteLocally()) {
    console.log('[wiki-embedding-model] 本地缓存已就绪，跳过下载')
    fs.writeFileSync(COMPLETE_MARKER, `${MODEL_ID}\n${new Date().toISOString()}\n`)
    return
  }

  for (const rel of MODEL_FILES) {
    const url = `${mirror}/${MODEL_ID}/resolve/main/${rel}`
    const dest = path.join(OUTPUT_ROOT, rel)
    if (fs.existsSync(dest)) {
      console.log(`  跳过: ${rel}`)
      continue
    }
    console.log(`  下载: ${rel}`)
    await downloadFile(url, dest)
  }

  if (!isCompleteLocally()) throw new Error('模型文件不完整')
  fs.mkdirSync(path.dirname(COMPLETE_MARKER), { recursive: true })
  fs.writeFileSync(COMPLETE_MARKER, `${MODEL_ID}\n${new Date().toISOString()}\n`)
  console.log('[wiki-embedding-model] 完成')
}

main().catch((err) => {
  console.error('[wiki-embedding-model] 失败:', err instanceof Error ? err.message : err)
  process.exit(1)
})
