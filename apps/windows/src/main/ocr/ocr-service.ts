/**
 * 主进程 OCR 编排：懒启动 worker、单飞队列、超时、崩溃重启、空闲退出。
 * 本模块不加载任何 onnxruntime。
 */
import { createLogger } from '../logger.js'
import { isOcrModelReady, resolveOcrModelDir } from './ocr-model-paths.js'
import type { OcrWorkerTransport, OcrWorkerTransportFactory } from './ocr-worker-transport.js'
import type {
  OcrPreferredBackend,
  OcrRecognizeRequest,
  OcrRecognizeResult,
  OcrServiceStatus,
  OcrWorkerRequest,
  OcrWorkerResponse,
} from './types.js'

const log = createLogger('OcrService')

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_IDLE_EXIT_MS = 5 * 60_000
const MAX_WORKER_RESTARTS = 2

export type OcrServiceOptions = {
  /** 仅 Windows 首版开启；其它平台直接报不支持 */
  platform?: NodeJS.Platform
  createTransport?: OcrWorkerTransportFactory
  resolveModelDir?: () => string
  isModelReady?: (dir: string) => boolean
  idleExitMs?: number
  now?: () => number
}

type QueueItem = {
  request: OcrRecognizeRequest
  resolve: (value: OcrRecognizeResult) => void
  reject: (error: Error) => void
}

/**
 * 创建本地 OCR 服务实例。
 */
export function createOcrService(options: OcrServiceOptions = {}) {
  const platform = options.platform ?? process.platform
  const idleExitMs = options.idleExitMs ?? DEFAULT_IDLE_EXIT_MS
  const now = options.now ?? Date.now
  const resolveModelDir = options.resolveModelDir ?? resolveOcrModelDir
  const isModelReady = options.isModelReady ?? isOcrModelReady

  let preferredBackend: OcrPreferredBackend = 'auto'
  let transport: OcrWorkerTransport | null = null
  let restartBudget = MAX_WORKER_RESTARTS
  let queue: QueueItem[] = []
  let pumping = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let seq = 0

  /**
   * 当前平台是否支持本地 OCR（P0 仅 Windows）。
   */
  function isPlatformSupported(): boolean {
    return platform === 'win32'
  }

  /**
   * 更新算力偏好。
   */
  function setPreferredBackend(backend: OcrPreferredBackend): void {
    preferredBackend = backend
  }

  /**
   * 读取服务状态快照。
   */
  function getStatus(): OcrServiceStatus {
    const modelDir = resolveModelDir()
    return {
      platformSupported: isPlatformSupported(),
      modelsReady: isModelReady(modelDir),
      runtimeReady: true,
      preferredBackend,
      workerAlive: transport?.alive() === true,
    }
  }

  /**
   * 确保 worker 已启动。
   */
  function ensureWorker(): OcrWorkerTransport {
    if (!isPlatformSupported()) {
      throw new Error('本地 OCR 仅支持 Windows（P0）')
    }
    if (transport?.alive()) return transport
    if (!options.createTransport) {
      throw new Error('OCR worker transport 未配置')
    }
    transport = options.createTransport()
    transport.onExit((code) => {
      log.warn('OCR worker 退出', { code })
      transport = null
      if (queue.length > 0 && restartBudget > 0) {
        restartBudget -= 1
        void pump()
      } else if (queue.length > 0) {
        const pending = queue
        queue = []
        for (const item of pending) {
          item.reject(new Error(`OCR worker 不可用（exit=${code ?? 'null'}）`))
        }
      }
    })
    return transport
  }

  /**
   * 重置空闲退出计时。
   */
  function touchIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (queue.length > 0 || pumping) return
      log.info('OCR worker 空闲退出')
      void shutdown()
    }, idleExitMs)
  }

  /**
   * 向 worker 发送一帧并等待匹配 id 的响应。
   */
  function rpc<T extends OcrWorkerResponse>(
    worker: OcrWorkerTransport,
    message: OcrWorkerRequest,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`OCR 超时（${timeoutMs}ms）`))
      }, timeoutMs)

      const off = worker.onMessage((msg) => {
        if (msg.type === 'ready') return
        if (!('id' in msg) || msg.id !== message.id) return
        clearTimeout(timer)
        off()
        resolve(msg as T)
      })

      try {
        worker.send(message)
      } catch (error) {
        clearTimeout(timer)
        off()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * 单飞泵：一次只处理一个识别任务。
   */
  async function pump(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      while (queue.length > 0) {
        const item = queue.shift()!
        try {
          const modelDir = resolveModelDir()
          if (!isModelReady(modelDir)) {
            throw new Error('OCR 模型未就绪')
          }
          const worker = ensureWorker()
          const id = `ocr-${++seq}`
          const timeoutMs = item.request.timeoutMs ?? DEFAULT_TIMEOUT_MS
          const forceCpu = item.request.forceCpu === true || preferredBackend === 'cpu'
          const response = await rpc<OcrWorkerResponse>(
            worker,
            {
              type: 'recognize',
              id,
              payload: {
                ...item.request,
                forceCpu,
                modelDir,
                preferredBackend: forceCpu ? 'cpu' : preferredBackend,
              },
            },
            timeoutMs,
          )
          if (response.type !== 'recognize_ok') {
            throw new Error(response.type === 'recognize_err' ? response.error : 'OCR 未知响应')
          }
          restartBudget = MAX_WORKER_RESTARTS
          item.resolve(response.result)
        } catch (error) {
          item.reject(error instanceof Error ? error : new Error(String(error)))
        } finally {
          touchIdleTimer()
        }
      }
    } finally {
      pumping = false
    }
  }

  /**
   * 识别图片中的文字。
   */
  function recognize(request: OcrRecognizeRequest): Promise<OcrRecognizeResult> {
    if (!isPlatformSupported()) {
      return Promise.reject(new Error('本地 OCR 仅支持 Windows（P0）'))
    }
    return new Promise<OcrRecognizeResult>((resolve, reject) => {
      queue.push({ request, resolve, reject })
      void pump()
    })
  }

  /**
   * 关闭 worker 并清空队列等待。
   */
  async function shutdown(): Promise<void> {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    const worker = transport
    transport = null
    if (!worker?.alive()) return
    const id = `ocr-shutdown-${++seq}`
    try {
      await rpc(worker, { type: 'shutdown', id }, 3_000)
    } catch {
      // 忽略关闭超时，强制杀进程
    }
    worker.kill()
  }

  return {
    recognize,
    getStatus,
    setPreferredBackend,
    shutdown,
    /** 测试用：当前队列长度 */
    _queueLength: () => queue.length,
    /** 测试用：推进时间相关逻辑时读取 now */
    _now: now,
  }
}

export type OcrService = ReturnType<typeof createOcrService>
