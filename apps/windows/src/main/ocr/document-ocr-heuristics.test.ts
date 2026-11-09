/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  isOcrableImagePath,
  shouldOcrSparseDocument,
} from './document-ocr-heuristics.js'

describe('document-ocr-heuristics', () => {
  it('解析失败或空文本需要 OCR', () => {
    expect(shouldOcrSparseDocument({ text: '', parseOk: false })).toBe(true)
    expect(shouldOcrSparseDocument({ text: '', pages: 3 })).toBe(true)
    expect(
      shouldOcrSparseDocument({
        text: '[PDF file: a.pdf - 此 PDF 不包含可提取的文本（可能是扫描版图片 PDF）]',
        pages: 2,
        parseOk: false,
      }),
    ).toBe(true)
  })

  it('密文 PDF 不触发 OCR', () => {
    const text = '甲'.repeat(500)
    expect(shouldOcrSparseDocument({ text, pages: 2, parseOk: true })).toBe(false)
  })

  it('多页但总字极少触发 OCR', () => {
    expect(shouldOcrSparseDocument({ text: 'hi', pages: 10, parseOk: true })).toBe(true)
  })

  it('识别常见图片扩展名', () => {
    expect(isOcrableImagePath('a.PNG')).toBe(true)
    expect(isOcrableImagePath('x.webp')).toBe(true)
    expect(isOcrableImagePath('a.pdf')).toBe(false)
  })
})
