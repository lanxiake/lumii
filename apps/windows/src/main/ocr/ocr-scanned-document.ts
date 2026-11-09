/**
 * 扫描文档 OCR 编排：图片直出；稀疏 PDF 按页渲染后串行识别。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLogger } from '../logger.js'
import { ensureOcrModelsReady } from './ocr-model-downloader.js'
import {
  isOcrableImagePath,
  shouldOcrSparseDocument,
} from './document-ocr-heuristics.js'
import type { OcrService } from './ocr-service.js'

const log = createLogger('OcrScannedDocument')

/** 单页渲染结果 */
export type RenderedPdfPage = {
  pageIndex: number
  /** PNG/JPEG 临时文件路径 */
  imagePath: string
}

export type PdfPageRenderer = (input: {
  pdfPath: string
  outputDir: string
  maxPages?: number
}) => Promise<RenderedPdfPage[]>

export type OcrScannedDocumentResult = {
  text: string
  pagesOcr: number
  via: 'image' | 'pdf-ocr' | 'skipped'
  errors: string[]
}

export type OcrScannedDocumentOptions = {
  filePath: string
  /** 已有文字层解析结果（PDF） */
  existingText?: string
  existingPages?: number
  parseOk?: boolean
  ocrService: Pick<OcrService, 'recognize' | 'getStatus'>
  renderPdfPages?: PdfPageRenderer
  ensureModels?: () => Promise<string>
  maxPages?: number
  concurrency?: number
}

/**
 * 对扫描图或稀疏 PDF 跑本地 OCR。
 */
export async function ocrScannedDocument(
  options: OcrScannedDocumentOptions,
): Promise<OcrScannedDocumentResult> {
  const errors: string[] = []
  if (options.ocrService.getStatus().platformSupported !== true) {
    return { text: '', pagesOcr: 0, via: 'skipped', errors: ['platform_unsupported'] }
  }

  if (isOcrableImagePath(options.filePath)) {
    try {
      const ensureModels = options.ensureModels ?? (() => ensureOcrModelsReady())
      await ensureModels()
      const result = await options.ocrService.recognize({
        path: options.filePath,
        maxSide: 1600,
      })
      return { text: result.text, pagesOcr: 1, via: 'image', errors }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { text: '', pagesOcr: 0, via: 'image', errors: [message] }
    }
  }

  if (!/\.pdf$/i.test(options.filePath)) {
    return { text: '', pagesOcr: 0, via: 'skipped', errors: ['unsupported_type'] }
  }

  if (
    !shouldOcrSparseDocument({
      text: options.existingText ?? '',
      pages: options.existingPages,
      parseOk: options.parseOk,
    })
  ) {
    return { text: '', pagesOcr: 0, via: 'skipped', errors: [] }
  }

  if (!options.renderPdfPages) {
    return {
      text: '',
      pagesOcr: 0,
      via: 'skipped',
      errors: ['pdf_renderer_unavailable'],
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-pdf-ocr-'))
  try {
    const ensureModels = options.ensureModels ?? (() => ensureOcrModelsReady())
    await ensureModels()
    const pages = await options.renderPdfPages({
      pdfPath: options.filePath,
      outputDir: tmpDir,
      maxPages: options.maxPages ?? 30,
    })
    const texts: string[] = []
    const concurrency = Math.max(1, Math.min(2, options.concurrency ?? 1))
    let cursor = 0
    async function worker(): Promise<void> {
      while (cursor < pages.length) {
        const index = cursor
        cursor += 1
        const page = pages[index]
        try {
          const result = await options.ocrService.recognize({
            path: page.imagePath,
            maxSide: 1600,
          })
          texts[index] = result.text?.trim() ? `--- 第 ${page.pageIndex + 1} 页 ---\n${result.text}` : ''
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          errors.push(`page ${page.pageIndex + 1}: ${message}`)
          texts[index] = ''
          log.warn(`PDF 页 OCR 失败 p=${page.pageIndex + 1}: ${message}`)
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    return {
      text: texts.filter(Boolean).join('\n\n'),
      pagesOcr: pages.length,
      via: 'pdf-ocr',
      errors,
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}
