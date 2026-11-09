/**
 * 基于 child_process.fork 的 OCR worker 传输（主进程侧）。
 * 使用 ELECTRON_RUN_AS_NODE，避免在主进程加载 ort。
 */
import { fork, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '../logger.js'
import type { OcrWorkerTransport } from './ocr-worker-transport.js'
import type { OcrWorkerRequest, OcrWorkerResponse } from './types.js'

const log = createLogger('OcrForkTransport')

export type CreateForkTransportOptions = {
  /** worker 脚本绝对路径（开发态 .ts / 打包态 .js） */
  workerScriptPath: string
  /** 传给 worker 的环境变量 */
  env?: NodeJS.ProcessEnv
  /** 可注入 fork 便于测试 */
  forkImpl?: typeof fork
}

/**
 * 解析 OCR worker 脚本路径。
 */
export function resolveOcrWorkerScriptPath(appPath?: string, resourcesPath?: string): string {
  const candidates = [
    // electron-vite 打包后与 main 同目录
    path.join(__dirname, 'ocr-worker-main.js'),
    path.join(__dirname, 'ocr-worker-main.ts'),
    appPath ? path.join(appPath, 'out/main/ocr-worker-main.js') : '',
    resourcesPath ? path.join(resourcesPath, 'app.asar.unpacked/out/main/ocr-worker-main.js') : '',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return candidates[0] ?? path.join(__dirname, 'ocr-worker-main.js')
}

/**
 * 创建 fork 传输。
 */
export function createForkOcrWorkerTransport(options: CreateForkTransportOptions): OcrWorkerTransport {
  const forkImpl = options.forkImpl ?? fork
  const child: ChildProcess = forkImpl(options.workerScriptPath, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      ...options.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
  })

  child.stderr?.on('data', (buf: Buffer) => {
    log.warn(String(buf))
  })

  let aliveFlag = true
  child.on('exit', () => {
    aliveFlag = false
  })

  return {
    send(message: OcrWorkerRequest) {
      if (!aliveFlag) throw new Error('OCR worker 已退出')
      child.send(message)
    },
    onMessage(handler) {
      const listener = (message: OcrWorkerResponse) => handler(message)
      child.on('message', listener)
      return () => child.off('message', listener)
    },
    onExit(handler) {
      const listener = (code: number | null) => handler(code)
      child.on('exit', listener)
      return () => child.off('exit', listener)
    },
    kill() {
      if (!aliveFlag) return
      aliveFlag = false
      child.kill()
    },
    alive() {
      return aliveFlag && child.connected
    },
  }
}
