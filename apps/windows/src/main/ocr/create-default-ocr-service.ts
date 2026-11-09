/**
 * 组装生产用 OcrService：fork worker + 默认模型路径。
 */
import { createForkOcrWorkerTransport, resolveOcrWorkerScriptPath } from './ocr-fork-transport.js'
import { createOcrService, type OcrService } from './ocr-service.js'
import { resolveOcrOrtRuntimeDir } from './ocr-model-paths.js'
import fs from 'node:fs'
import path from 'node:path'

let singleton: OcrService | null = null

/**
 * 获取（或创建）默认 OCR 服务单例。
 */
export function getDefaultOcrService(): OcrService {
  if (singleton) return singleton
  singleton = createOcrService({
    createTransport: () => {
      const workerScriptPath = resolveOcrWorkerScriptPath(
        typeof process !== 'undefined' ? process.env.LUMII_OCR_APP_PATH : undefined,
        typeof process !== 'undefined' ? process.env.LUMII_OCR_RESOURCES_PATH : undefined,
      )
      const ortDir = resolveOcrOrtRuntimeDir()
      const ortEntry = path.join(ortDir, 'node_modules', 'onnxruntime-node')
      const env: NodeJS.ProcessEnv = {}
      if (fs.existsSync(ortEntry)) {
        env.OCR_ORT_NODE_PATH = ortEntry
      }
      return createForkOcrWorkerTransport({ workerScriptPath, env })
    },
  })
  return singleton
}

/**
 * 测试用：重置单例。
 */
export function resetDefaultOcrServiceForTests(): void {
  singleton = null
}
