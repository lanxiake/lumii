/**
 * 本地 OCR 公共类型（主进程与 utility worker 共享契约）。
 */

/** 本地 OCR 一次识别请求 */
export type OcrRecognizeRequest = {
  path: string
  /** 长边上限，默认 1600 */
  maxSide?: number
  timeoutMs?: number
  /** 强制 CPU，跳过 DirectML */
  forceCpu?: boolean
}

/** 单行识别结果 */
export type OcrLine = {
  text: string
  score: number
  /** 轴对齐框：[left, top, width, height] */
  box: [number, number, number, number]
}

/** 本地 OCR 识别成功结果 */
export type OcrRecognizeResult = {
  text: string
  lines: OcrLine[]
  /** 行置信度均值，用于是否触发云端补 OCR */
  confidence: number
  backend: 'dml' | 'cpu'
  source: 'local'
  durationMs: number
}

/** OCR 算力偏好 */
export type OcrPreferredBackend = 'auto' | 'dml' | 'cpu'

/** OCR 服务就绪状态 */
export type OcrServiceStatus = {
  platformSupported: boolean
  modelsReady: boolean
  runtimeReady: boolean
  preferredBackend: OcrPreferredBackend
  workerAlive: boolean
}

/** 主进程 ↔ worker 的 RPC 消息 */
export type OcrWorkerRequest =
  | { type: 'ping'; id: string }
  | { type: 'recognize'; id: string; payload: OcrRecognizeRequest & { modelDir: string; preferredBackend: OcrPreferredBackend } }
  | { type: 'shutdown'; id: string }

export type OcrWorkerResponse =
  | { type: 'pong'; id: string }
  | { type: 'recognize_ok'; id: string; result: OcrRecognizeResult }
  | { type: 'recognize_err'; id: string; error: string }
  | { type: 'shutdown_ok'; id: string }
  | { type: 'ready' }

/** OCR 文本来源（聊天识图双轨） */
export type OcrSource = 'local' | 'cloud' | 'mixed' | 'none'
