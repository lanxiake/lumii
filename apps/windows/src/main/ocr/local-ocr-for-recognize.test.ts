/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  mergeOcrTracks,
  shouldAskCloudForOcr,
  LOCAL_OCR_CLOUD_FALLBACK_CONFIDENCE,
} from './local-ocr-for-recognize.js'

describe('local-ocr-for-recognize merge', () => {
  it('本地高置信时用 local 且不要求云端 OCR', () => {
    const merged = mergeOcrTracks({
      includeOcr: true,
      local: { ok: true, ocrText: '本地字', confidence: 0.9 },
      cloudOcrText: '云端字',
    })
    expect(merged).toEqual({ ocrText: '本地字', ocrSource: 'local', needCloudOcr: false })
    expect(
      shouldAskCloudForOcr(true, { ok: true, ocrText: '本地字', confidence: 0.9 }),
    ).toBe(false)
  })

  it('本地低置信时用云端覆盖并标 mixed', () => {
    const conf = LOCAL_OCR_CLOUD_FALLBACK_CONFIDENCE - 0.1
    expect(shouldAskCloudForOcr(true, { ok: true, ocrText: '弱', confidence: conf })).toBe(true)
    const merged = mergeOcrTracks({
      includeOcr: true,
      local: { ok: true, ocrText: '弱', confidence: conf },
      cloudOcrText: '云端强',
    })
    expect(merged.ocrSource).toBe('mixed')
    expect(merged.ocrText).toBe('云端强')
  })

  it('本地失败仅云端时 ocrSource=cloud', () => {
    const merged = mergeOcrTracks({
      includeOcr: true,
      local: { ok: false, ocrText: '', confidence: 0 },
      cloudOcrText: '只有云',
    })
    expect(merged).toEqual({ ocrText: '只有云', ocrSource: 'cloud', needCloudOcr: true })
  })

  it('includeOcr=false 时全部为空', () => {
    expect(
      mergeOcrTracks({
        includeOcr: false,
        local: { ok: true, ocrText: 'x', confidence: 1 },
        cloudOcrText: 'y',
      }),
    ).toEqual({ ocrText: '', ocrSource: 'none', needCloudOcr: false })
  })
})
