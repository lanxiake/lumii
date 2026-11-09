/**
 * OCR utility worker 入口：只在子进程加载 ort / esearch-ocr。
 * 通过 IPC（process parentPort 或 process.send）与主进程通信。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createPpocrPipeline } from './ppocr-pipeline.js'
import type { OcrWorkerRequest, OcrWorkerResponse } from './types.js'

const require = createRequire(import.meta.url)

/**
 * 向父进程回写一帧。
 */
function post(message: OcrWorkerResponse): void {
  if (typeof process.send === 'function') {
    process.send(message)
    return
  }
  // Electron utilityProcess
  const parentPort = (process as NodeJS.Process & { parentPort?: { postMessage: (m: unknown) => void } }).parentPort
  parentPort?.postMessage(message)
}

/**
 * 解析 ort：优先 OCR_ORT_NODE_PATH（私有运行时），否则回退应用 node_modules。
 */
function loadOrt(): { ort: PpocrOrt } {
  const privatePath = process.env.OCR_ORT_NODE_PATH?.trim()
  if (privatePath && fs.existsSync(privatePath)) {
    return { ort: require(privatePath) as PpocrOrt }
  }
  return { ort: require('onnxruntime-node') as PpocrOrt }
}

type PpocrOrt = {
  InferenceSession: { create: (modelPath: string, options?: Record<string, unknown>) => Promise<unknown> }
}

/**
 * 加载 esearch-ocr.init。
 */
function loadInitOcr(): (options: Record<string, unknown>) => Promise<{ ocr: (input: string | Buffer) => Promise<unknown> }> {
  const mod = require('esearch-ocr') as { init?: unknown; default?: { init?: unknown } }
  const init = (mod.init ?? mod.default?.init) as
    | ((options: Record<string, unknown>) => Promise<{ ocr: (input: string | Buffer) => Promise<unknown> }>)
    | undefined
  if (typeof init !== 'function') {
    throw new Error('esearch-ocr.init 不可用')
  }
  return init
}

async function main(): Promise<void> {
  const { ort } = loadOrt()
  const initOcr = loadInitOcr()
  const pipeline = createPpocrPipeline({
    ort,
    initOcr: initOcr as Parameters<typeof createPpocrPipeline>[0]['initOcr'],
  })

  post({ type: 'ready' })

  /**
   * 处理一帧请求。
   */
  async function handle(message: OcrWorkerRequest): Promise<void> {
    if (message.type === 'ping') {
      post({ type: 'pong', id: message.id })
      return
    }
    if (message.type === 'shutdown') {
      pipeline.dispose()
      post({ type: 'shutdown_ok', id: message.id })
      setTimeout(() => process.exit(0), 10)
      return
    }
    if (message.type === 'recognize') {
      try {
        const result = await pipeline.run({
          imagePath: message.payload.path,
          modelDir: message.payload.modelDir,
          maxSide: message.payload.maxSide,
          preferredBackend: message.payload.preferredBackend,
          forceCpu: message.payload.forceCpu,
        })
        post({ type: 'recognize_ok', id: message.id, result })
      } catch (error) {
        post({
          type: 'recognize_err',
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  process.on('message', (message) => {
    void handle(message as OcrWorkerRequest)
  })

  const parentPort = (process as NodeJS.Process & {
    parentPort?: { on: (event: string, cb: (m: unknown) => void) => void }
  }).parentPort
  parentPort?.on('message', (message) => {
    void handle(message as OcrWorkerRequest)
  })

  // 避免未使用 path 告警（预留调试日志）
  void path
}

void main().catch((error) => {
  console.error('[ocr-worker]', error)
  process.exit(1)
})
