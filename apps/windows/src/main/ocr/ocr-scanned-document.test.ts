/**
 * @vitest-environment node
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ocrScannedDocument } from './ocr-scanned-document.js'

describe('ocrScannedDocument', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  const statusOk = {
    platformSupported: true,
    modelsReady: true,
    runtimeReady: true,
    preferredBackend: 'cpu' as const,
    workerAlive: false,
  }

  it('图片路径直接 OCR', async () => {
    const result = await ocrScannedDocument({
      filePath: 'C:\\scan.png',
      ensureModels: async () => 'm',
      ocrService: {
        getStatus: () => statusOk,
        recognize: async () => ({
          text: '扫描字',
          lines: [],
          confidence: 0.9,
          backend: 'cpu',
          source: 'local',
          durationMs: 1,
        }),
      },
    })
    expect(result.via).toBe('image')
    expect(result.text).toBe('扫描字')
  })

  it('密文 PDF 跳过 OCR', async () => {
    const renderPdfPages = vi.fn()
    const result = await ocrScannedDocument({
      filePath: 'C:\\doc.pdf',
      existingText: '甲'.repeat(400),
      existingPages: 2,
      parseOk: true,
      renderPdfPages,
      ocrService: {
        getStatus: () => statusOk,
        recognize: async () => {
          throw new Error('no')
        },
      },
    })
    expect(result.via).toBe('skipped')
    expect(renderPdfPages).not.toHaveBeenCalled()
  })

  it('稀疏 PDF 按页 OCR 并拼接', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-ocr-pg-'))
    dirs.push(tmp)
    const p0 = path.join(tmp, 'p0.png')
    const p1 = path.join(tmp, 'p1.png')
    fs.writeFileSync(p0, 'x')
    fs.writeFileSync(p1, 'x')

    const result = await ocrScannedDocument({
      filePath: 'C:\\scan.pdf',
      existingText: '',
      existingPages: 2,
      parseOk: false,
      ensureModels: async () => 'm',
      renderPdfPages: async () => [
        { pageIndex: 0, imagePath: p0 },
        { pageIndex: 1, imagePath: p1 },
      ],
      ocrService: {
        getStatus: () => statusOk,
        recognize: async ({ path: img }) => ({
          text: img.endsWith('p0.png') ? '第一页' : '第二页',
          lines: [],
          confidence: 0.8,
          backend: 'cpu',
          source: 'local',
          durationMs: 1,
        }),
      },
    })
    expect(result.via).toBe('pdf-ocr')
    expect(result.pagesOcr).toBe(2)
    expect(result.text).toContain('第一页')
    expect(result.text).toContain('第二页')
  })

  it('单页 OCR 失败不阻断整份文档', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-ocr-pg-'))
    dirs.push(tmp)
    const p0 = path.join(tmp, 'p0.png')
    const p1 = path.join(tmp, 'p1.png')
    fs.writeFileSync(p0, 'x')
    fs.writeFileSync(p1, 'x')

    const result = await ocrScannedDocument({
      filePath: 'C:\\scan.pdf',
      existingText: '',
      parseOk: false,
      ensureModels: async () => 'm',
      renderPdfPages: async () => [
        { pageIndex: 0, imagePath: p0 },
        { pageIndex: 1, imagePath: p1 },
      ],
      ocrService: {
        getStatus: () => statusOk,
        recognize: async ({ path: img }) => {
          if (img.endsWith('p0.png')) throw new Error('boom')
          return {
            text: '存活页',
            lines: [],
            confidence: 0.8,
            backend: 'cpu',
            source: 'local',
            durationMs: 1,
          }
        },
      },
    })
    expect(result.text).toContain('存活页')
    expect(result.errors.some((e) => /boom/.test(e))).toBe(true)
  })
})
