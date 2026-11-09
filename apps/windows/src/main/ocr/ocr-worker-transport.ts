/**
 * OCR worker 传输抽象：便于单测注入 mock，主进程真实实现走 child_process.fork。
 */
import type { OcrWorkerRequest, OcrWorkerResponse } from './types.js'

/** worker 进程传输接口 */
export interface OcrWorkerTransport {
  /** 发送请求帧 */
  send(message: OcrWorkerRequest): void
  /** 订阅响应；返回取消订阅函数 */
  onMessage(handler: (message: OcrWorkerResponse) => void): () => void
  /** 订阅异常退出 */
  onExit(handler: (code: number | null) => void): () => void
  /** 终止进程 */
  kill(): void
  /** 是否仍存活 */
  alive(): boolean
}

/** 创建 transport 的工厂 */
export type OcrWorkerTransportFactory = () => OcrWorkerTransport
