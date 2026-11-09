/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  OCR_MODEL_FILES,
  OCR_ORT_NODE_VERSION,
  OCR_REQUIRED_LOCAL_FILES,
  buildOcrModelFileUrl,
} from './ocr-model-manifest.js'

describe('ocr-model-manifest', () => {
  it('包含 det/rec/字典三类文件', () => {
    const names = OCR_MODEL_FILES.map((f) => f.localName)
    expect(names).toEqual(expect.arrayContaining([...OCR_REQUIRED_LOCAL_FILES]))
  })

  it('钉住 utility ORT 主版本 1.22', () => {
    expect(OCR_ORT_NODE_VERSION.startsWith('1.22')).toBe(true)
  })

  it('buildOcrModelFileUrl 去掉尾斜杠并拼 HF resolve 路径', () => {
    expect(buildOcrModelFileUrl('https://hf-mirror.com/', 'PP-OCRv4/det.onnx')).toBe(
      'https://hf-mirror.com/SWHL/RapidOCR/resolve/main/PP-OCRv4/det.onnx',
    )
  })
})
