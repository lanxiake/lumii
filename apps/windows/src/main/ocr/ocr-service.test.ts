/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { createOcrService } from './ocr-service.js'
import type { OcrWorkerTransport } from './ocr-worker-transport.js'
import type { OcrWorkerRequest, OcrWorkerResponse, OcrRecognizeResult } from './types.js'

/**
 * 构造可脚本化的 mock transport。
 */
function createMockTransport(script: {
  onRecognize?: (req: OcrWorkerRequest) => OcrWorkerResponse | Promise<OcrWorkerResponse>
  exitAfter?: number
}): { transport: OcrWorkerTransport; sent: OcrWorkerRequest[] } {
  const sent: OcrWorkerRequest[] = []
  let alive = true
  const messageHandlers = new Set<(m: OcrWorkerResponse) => void>()
  const exitHandlers = new Set<(code: number | null) => void>()
  let callCount = 0

  const transport: OcrWorkerTransport = {
    send(message) {
      if (!alive) throw new Error('worker dead')
      sent.push(message)
      callCount += 1
      if (message.type === 'recognize') {
        void Promise.resolve(script.onRecognize?.(message)).then((response) => {
          if (!response) {
            for (const h of messageHandlers) {
              h({
                type: 'recognize_ok',
                id: message.id,
                result: {
                  text: 'hello',
                  lines: [{ text: 'hello', score: 0.9, box: [0, 0, 10, 10] }],
                  confidence: 0.9,
                  backend: 'cpu',
                  source: 'local',
                  durationMs: 12,
                },
              })
            }
            return
          }
          for (const h of messageHandlers) h(response)
        })
      }
      if (message.type === 'shutdown') {
        for (const h of messageHandlers) h({ type: 'shutdown_ok', id: message.id })
        alive = false
      }
      if (script.exitAfter !== undefined && callCount >= script.exitAfter) {
        alive = false
        for (const h of exitHandlers) h(1)
      }
    },
    onMessage(handler) {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    },
    onExit(handler) {
      exitHandlers.add(handler)
      return () => exitHandlers.delete(handler)
    },
    kill() {
      alive = false
    },
    alive() {
      return alive
    },
  }

  return { transport, sent }
}

describe('OcrService', () => {
  it('非 Windows 平台直接拒绝', async () => {
    const service = createOcrService({ platform: 'linux' })
    await expect(service.recognize({ path: 'a.png' })).rejects.toThrow(/Windows/)
    expect(service.getStatus().platformSupported).toBe(false)
  })

  it('模型未就绪时失败', async () => {
    const { transport } = createMockTransport({})
    const service = createOcrService({
      platform: 'win32',
      createTransport: () => transport,
      isModelReady: () => false,
      resolveModelDir: () => 'C:\\models',
    })
    await expect(service.recognize({ path: 'a.png' })).rejects.toThrow(/模型未就绪/)
  })

  it('单飞队列按序完成识别', async () => {
    const order: string[] = []
    const { transport } = createMockTransport({
      onRecognize: async (req) => {
        if (req.type !== 'recognize') throw new Error('bad')
        order.push(req.payload.path)
        await new Promise((r) => setTimeout(r, 20))
        const result: OcrRecognizeResult = {
          text: req.payload.path,
          lines: [],
          confidence: 1,
          backend: 'cpu',
          source: 'local',
          durationMs: 1,
        }
        return { type: 'recognize_ok', id: req.id, result }
      },
    })
    const service = createOcrService({
      platform: 'win32',
      createTransport: () => transport,
      isModelReady: () => true,
      resolveModelDir: () => 'C:\\models',
      idleExitMs: 60_000,
    })

    const [a, b] = await Promise.all([
      service.recognize({ path: 'a.png' }),
      service.recognize({ path: 'b.png' }),
    ])
    expect(order).toEqual(['a.png', 'b.png'])
    expect(a.text).toBe('a.png')
    expect(b.text).toBe('b.png')
  })

  it('forceCpu 或 preferredBackend=cpu 时下发 cpu', async () => {
    const { transport, sent } = createMockTransport({})
    const service = createOcrService({
      platform: 'win32',
      createTransport: () => transport,
      isModelReady: () => true,
      resolveModelDir: () => 'C:\\models',
      idleExitMs: 60_000,
    })
    service.setPreferredBackend('cpu')
    await service.recognize({ path: 'a.png' })
    const recognizeMsg = sent.find((m) => m.type === 'recognize')
    expect(recognizeMsg?.type).toBe('recognize')
    if (recognizeMsg?.type === 'recognize') {
      expect(recognizeMsg.payload.forceCpu).toBe(true)
      expect(recognizeMsg.payload.preferredBackend).toBe('cpu')
    }
  })

  it('超时后拒绝该任务', async () => {
    vi.useFakeTimers()
    const { transport } = createMockTransport({
      onRecognize: () => new Promise(() => {}),
    })
    const service = createOcrService({
      platform: 'win32',
      createTransport: () => transport,
      isModelReady: () => true,
      resolveModelDir: () => 'C:\\models',
      idleExitMs: 60_000,
    })
    const pending = service.recognize({ path: 'a.png', timeoutMs: 100 })
    const assertion = expect(pending).rejects.toThrow(/超时/)
    await vi.advanceTimersByTimeAsync(150)
    await assertion
    vi.useRealTimers()
  })

  it('空闲后调用 shutdown 结束 worker', async () => {
    vi.useFakeTimers()
    const { transport } = createMockTransport({})
    const service = createOcrService({
      platform: 'win32',
      createTransport: () => transport,
      isModelReady: () => true,
      resolveModelDir: () => 'C:\\models',
      idleExitMs: 1_000,
    })
    await service.recognize({ path: 'a.png' })
    expect(service.getStatus().workerAlive).toBe(true)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(service.getStatus().workerAlive).toBe(false)
    vi.useRealTimers()
  })
})
