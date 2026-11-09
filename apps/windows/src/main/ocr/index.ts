/**
 * 本地 OCR 模块出口（主进程）。
 */
export { createOcrService, type OcrService, type OcrServiceOptions } from './ocr-service.js'
export { getDefaultOcrService, resetDefaultOcrServiceForTests } from './create-default-ocr-service.js'
export { createForkOcrWorkerTransport, resolveOcrWorkerScriptPath } from './ocr-fork-transport.js'
export { downloadOcrModelsIfNeeded, ensureOcrModelsReady } from './ocr-model-downloader.js'
export { attachLocalOcr } from './attach-local-ocr.js'
export {
  mergeOcrTracks,
  runLocalOcrForRecognize,
  shouldAskCloudForOcr,
  LOCAL_OCR_CLOUD_FALLBACK_CONFIDENCE,
} from './local-ocr-for-recognize.js'
export { ocrScannedDocument } from './ocr-scanned-document.js'
export { shouldOcrSparseDocument, isOcrableImagePath } from './document-ocr-heuristics.js'
export { tryCreatePdfPageRenderer } from './pdf-page-renderer.js'
export {
  OCR_MODEL_FILES,
  OCR_MODEL_PACKAGE_ID,
  OCR_ORT_NODE_VERSION,
  buildOcrModelFileUrl,
  DEFAULT_OCR_HF_MIRROR,
} from './ocr-model-manifest.js'
export { isOcrModelReady, resolveOcrModelDir, resolveOcrOrtRuntimeDir } from './ocr-model-paths.js'
export type {
  OcrLine,
  OcrPreferredBackend,
  OcrRecognizeRequest,
  OcrRecognizeResult,
  OcrServiceStatus,
  OcrSource,
} from './types.js'
