/**
 * 聊天识图双轨：本地 OCR 优先，供 BridgeImageServices 注入调用。
 */
import { ensureOcrModelsReady } from './ocr-model-downloader.js'
import type { OcrService } from './ocr-service.js'
import type { OcrSource } from './types.js'

/** 低于该置信度时请求云端补 OCR */
export const LOCAL_OCR_CLOUD_FALLBACK_CONFIDENCE = 0.5

export type LocalOcrForRecognizeResult = {
  ocrText: string
  confidence: number
  ok: boolean
}

export type RunLocalOcrForRecognizeDeps = {
  imagePath: string
  ocrService: Pick<OcrService, 'recognize' | 'getStatus'>
  ensureModels?: () => Promise<string>
}

/**
 * 尝试本地 OCR；平台不支持或失败时返回 ok=false（不抛）。
 */
export async function runLocalOcrForRecognize(
  deps: RunLocalOcrForRecognizeDeps,
): Promise<LocalOcrForRecognizeResult> {
  if (deps.ocrService.getStatus().platformSupported !== true) {
    return { ocrText: '', confidence: 0, ok: false }
  }
  try {
    const ensureModels = deps.ensureModels ?? (() => ensureOcrModelsReady())
    await ensureModels()
    const result = await deps.ocrService.recognize({ path: deps.imagePath, maxSide: 1600 })
    return {
      ocrText: result.text ?? '',
      confidence: result.confidence,
      ok: true,
    }
  } catch {
    return { ocrText: '', confidence: 0, ok: false }
  }
}

/**
 * 根据本地结果与云端补抽决定最终 ocrText / ocrSource。
 */
export function mergeOcrTracks(input: {
  includeOcr: boolean
  local: LocalOcrForRecognizeResult | null
  cloudOcrText: string
}): { ocrText: string; ocrSource: OcrSource; needCloudOcr: boolean } {
  if (!input.includeOcr) {
    return { ocrText: '', ocrSource: 'none', needCloudOcr: false }
  }

  const localOk =
    input.local?.ok === true &&
    input.local.ocrText.trim().length > 0 &&
    input.local.confidence >= LOCAL_OCR_CLOUD_FALLBACK_CONFIDENCE

  if (localOk && input.local) {
    // 本地够用：不需要云端补 OCR；若云端仍返回了字，以本地为准（双轨约定）
    return { ocrText: input.local.ocrText, ocrSource: 'local', needCloudOcr: false }
  }

  const cloud = input.cloudOcrText.trim()
  if (cloud) {
    if (input.local?.ok && input.local.ocrText.trim()) {
      return { ocrText: cloud, ocrSource: 'mixed', needCloudOcr: true }
    }
    return { ocrText: cloud, ocrSource: 'cloud', needCloudOcr: true }
  }

  if (input.local?.ok && input.local.ocrText.trim()) {
    // 低置信但仍有本地结果，云端空
    return { ocrText: input.local.ocrText, ocrSource: 'local', needCloudOcr: true }
  }

  return { ocrText: '', ocrSource: 'none', needCloudOcr: true }
}

/**
 * 是否应在 vision prompt 中要求列出 OCR。
 */
export function shouldAskCloudForOcr(
  includeOcr: boolean,
  local: LocalOcrForRecognizeResult | null,
): boolean {
  if (!includeOcr) return false
  if (!local?.ok) return true
  if (!local.ocrText.trim()) return true
  return local.confidence < LOCAL_OCR_CLOUD_FALLBACK_CONFIDENCE
}
