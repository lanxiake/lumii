/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { attachLocalOcr } from './attach-local-ocr.js'

describe('attachLocalOcr', () => {
  it('ocr=false 时直接跳过', async () => {
    const recognize = vi.fn()
    const result = await attachLocalOcr({
      imagePath: 'a.png',
      ocr: false,
      ocrService: {
        recognize,
        getStatus: () => ({
          platformSupported: true,
          modelsReady: true,
          runtimeReady: true,
          preferredBackend: 'auto',
          workerAlive: false,
        }),
      },
    })
    expect(result).toEqual({})
    expect(recognize).not.toHaveBeenCalled()
  })

  it('成功时附带 ocrText / confidence', async () => {
    const result = await attachLocalOcr({
      imagePath: 'a.png',
      isModelReady: () => true,
      ocrService: {
        getStatus: () => ({
          platformSupported: true,
          modelsReady: true,
          runtimeReady: true,
          preferredBackend: 'cpu',
          workerAlive: true,
        }),
        recognize: async () => ({
          text: '你好',
          lines: [],
          confidence: 0.91,
          backend: 'cpu',
          source: 'local',
          durationMs: 10,
        }),
      },
    })
    expect(result).toEqual({
      ocrText: '你好',
      ocrConfidence: 0.91,
      ocrBackend: 'cpu',
    })
  })

  it('模型未就绪时不调用 recognize', async () => {
    const recognize = vi.fn()
    const result = await attachLocalOcr({
      imagePath: 'a.png',
      isModelReady: () => false,
      ocrService: {
        getStatus: () => ({
          platformSupported: true,
          modelsReady: false,
          runtimeReady: true,
          preferredBackend: 'auto',
          workerAlive: false,
        }),
        recognize,
      },
    })
    expect(result.ocrError).toBe('models_not_ready')
    expect(recognize).not.toHaveBeenCalled()
  })

  it('recognize 失败时返回 ocrError 且不抛错', async () => {
    const result = await attachLocalOcr({
      imagePath: 'a.png',
      isModelReady: () => true,
      ocrService: {
        getStatus: () => ({
          platformSupported: true,
          modelsReady: true,
          runtimeReady: true,
          preferredBackend: 'auto',
          workerAlive: false,
        }),
        recognize: async () => {
          throw new Error('worker 崩了')
        },
      },
    })
    expect(result.ocrError).toMatch(/worker 崩了/)
    expect(result.ocrText).toBeUndefined()
  })
})
