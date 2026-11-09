/**
 * 截图工具结果附加本地 OCR（失败不影响截图成功）。
 *
 * 默认**不**触发模型下载：截图是热路径，首次联网拉模型会拖垮工具超时；
 * 聊天识图路径自行 `ensureOcrModelsReady`。模型已缓存时才跑推理。
 */
import { createLogger } from '../logger.js'
import { isOcrModelReady } from './ocr-model-paths.js'
import type { OcrService } from './ocr-service.js'
import type { OcrRecognizeResult } from './types.js'

const log = createLogger('AttachLocalOcr')

/** 附加 OCR 后的字段 */
export type LocalOcrAttachment = {
  ocrText?: string
  ocrConfidence?: number
  ocrBackend?: 'dml' | 'cpu'
  ocrError?: string
}

export type AttachLocalOcrOptions = {
  imagePath: string
  /** 默认 true；显式 false 跳过 */
  ocr?: boolean
  ocrService: Pick<OcrService, 'recognize' | 'getStatus'>
  /** 是否已就绪；默认读磁盘标记 */
  isModelReady?: () => boolean
  maxSide?: number
}

/**
 * 对已落盘截图尝试本地 OCR；任何异常都转为 ocrError，不抛出。
 */
export async function attachLocalOcr(options: AttachLocalOcrOptions): Promise<LocalOcrAttachment> {
  if (options.ocr === false) return {}
  if (options.ocrService.getStatus().platformSupported !== true) {
    return { ocrError: 'platform_unsupported' }
  }

  const ready = options.isModelReady ?? (() => isOcrModelReady())
  if (!ready()) {
    return { ocrError: 'models_not_ready' }
  }

  try {
    const result: OcrRecognizeResult = await options.ocrService.recognize({
      path: options.imagePath,
      maxSide: options.maxSide ?? 1600,
    })
    return {
      ocrText: result.text,
      ocrConfidence: result.confidence,
      ocrBackend: result.backend,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn(`截图 OCR 跳过: ${message}`)
    return { ocrError: message }
  }
}
