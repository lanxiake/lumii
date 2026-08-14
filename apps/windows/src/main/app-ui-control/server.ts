/**
 * App UI 本机控制 HTTP 服务（127.0.0.1 + Bearer token）
 *
 * 供 lumii-ui CLI 与外部脚本调用 screenshot / goto / click。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { resizeImageIfNeeded } from '../agent-runtime/image-resizer'
import { resolveWindowsClientDataRoot } from '../client-data-root'
import { createAppUiController, type AppUiController, type ResizeImageFn } from './controller'

/** 浏览器控制相关端口（对照用，app-ui 控制口需避开） */
export const DEFAULT_BROWSER_CONTROL_PORT = 18790
export const DEFAULT_CDP_PORT = 18791
export const DEFAULT_EXTENSION_RELAY_PORT = 18793

/** App UI 控制口起始端口（避开 CDP / extension relay） */
export const APP_UI_CONTROL_PORT_START = 18795

const PORT_INCREMENT = 10
const PORT_MAX_RETRIES = 3
const LOOPBACK_HOST = '127.0.0.1'

const log = {
  info: (...args: unknown[]) => console.log('[AppUiControlServer]', ...args),
  warn: (...args: unknown[]) => console.warn('[AppUiControlServer]', ...args),
}

/** 运行时写入 ~/.lumii/runtime/app-ui.json 的结构 */
export interface AppUiRuntimeConfig {
  port: number
  token: string
  startedAt: string
}

/** startAppUiControlServer 依赖 */
export interface AppUiControlServerDeps {
  getMainWindow: () => BrowserWindow | null
  resizeImageIfNeeded?: ResizeImageFn
  /** 测试注入：跳过 createAppUiController */
  controller?: AppUiController
  /** 测试注入：固定 token */
  token?: string
  /** 测试注入：固定端口 */
  port?: number
}

let httpServer: http.Server | null = null
let activeToken: string | null = null
let activeController: AppUiController | null = null

/**
 * 从 startPort 起按 +10 步长探测空闲端口，最多 3 次；均占用则落到 startPort + 30。
 */
export async function findAvailablePort(startPort: number, label: string): Promise<number> {
  const { inspectPortUsage } = await import('../vendor/ports-inspect.js')

  for (let i = 0; i < PORT_MAX_RETRIES; i++) {
    const port = startPort + i * PORT_INCREMENT
    try {
      const usage = await inspectPortUsage(port)
      if (usage.status === 'free') {
        if (i > 0) {
          log.info(`[findAvailablePort:${label}] 端口 ${port} 可用（跳过 ${i} 个被占用的端口）`)
        }
        return port
      }
      log.warn(`[findAvailablePort:${label}] 端口 ${port} 被占用，尝试 ${port + PORT_INCREMENT}...`)
    } catch (err) {
      log.warn(`[findAvailablePort:${label}] 检查端口 ${port} 出错: ${String(err)}，尝试下一个...`)
    }
  }

  const fallback = startPort + PORT_MAX_RETRIES * PORT_INCREMENT
  log.warn(`[findAvailablePort:${label}] 所有端口均被占用，使用端口 ${fallback}`)
  return fallback
}

/**
 * 将控制口 port/token 写入数据根 runtime/app-ui.json。
 */
function writeRuntimeConfig(config: AppUiRuntimeConfig): void {
  const runtimeDir = path.join(resolveWindowsClientDataRoot(), 'runtime')
  fs.mkdirSync(runtimeDir, { recursive: true })
  const filePath = path.join(runtimeDir, 'app-ui.json')
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8')
}

/**
 * 删除 runtime/app-ui.json（服务停止时）。
 */
function removeRuntimeConfig(): void {
  try {
    const filePath = path.join(resolveWindowsClientDataRoot(), 'runtime', 'app-ui.json')
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch (err) {
    log.warn('删除 app-ui.json 失败:', err instanceof Error ? err.message : err)
  }
}

/**
 * 校验 Authorization: Bearer <token>。
 */
function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1] ?? null
}

/**
 * 读取 POST JSON body。
 */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const text = Buffer.concat(chunks).toString('utf-8').trim()
  if (!text) return {}
  return JSON.parse(text) as unknown
}

/**
 * 发送 JSON 响应。
 */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * 处理已鉴权的路由。
 */
async function handleRoute(
  controller: AppUiController,
  pathname: string,
  body: unknown,
  res: http.ServerResponse,
): Promise<void> {
  switch (pathname) {
    case '/screenshot': {
      const result = await controller.screenshot()
      sendJson(res, 200, result)
      return
    }
    case '/goto': {
      const result = await controller.goto(body)
      sendJson(res, 200, result)
      return
    }
    case '/click': {
      const clickBody =
        body != null && typeof body === 'object' && !('action' in (body as Record<string, unknown>))
          ? { action: 'click', ...(body as Record<string, unknown>) }
          : body
      const result = await controller.click(clickBody)
      sendJson(res, 200, result)
      return
    }
    default:
      sendJson(res, 404, { ok: false, error: 'not_found' })
  }
}

/**
 * 创建 HTTP 请求处理器。
 */
function createRequestHandler(controller: AppUiController, token: string): http.RequestListener {
  return async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
      return
    }

    const bearer = extractBearerToken(req.headers.authorization)
    if (!bearer || bearer !== token) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' })
      return
    }

    const pathname = req.url?.split('?')[0] ?? ''
    try {
      const body = await readJsonBody(req)
      await handleRoute(controller, pathname, body, res)
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        error: 'bad_request',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/**
 * 启动本机 App UI 控制 HTTP 服务（仅 127.0.0.1）。
 */
export async function startAppUiControlServer(
  deps: AppUiControlServerDeps,
): Promise<AppUiRuntimeConfig> {
  if (httpServer) {
    throw new Error('App UI control server already running')
  }

  const token = deps.token ?? randomUUID()
  const port = deps.port ?? (await findAvailablePort(APP_UI_CONTROL_PORT_START, 'app-ui'))
  const controller =
    deps.controller ??
    createAppUiController({
      getMainWindow: deps.getMainWindow,
      resizeImageIfNeeded: deps.resizeImageIfNeeded ?? resizeImageIfNeeded,
    })

  activeController = controller
  activeToken = token

  const config: AppUiRuntimeConfig = {
    port,
    token,
    startedAt: new Date().toISOString(),
  }

  httpServer = http.createServer(createRequestHandler(controller, token))

  await new Promise<void>((resolve, reject) => {
    httpServer!.once('error', reject)
    httpServer!.listen(port, LOOPBACK_HOST, () => {
      httpServer!.removeListener('error', reject)
      resolve()
    })
  })

  writeRuntimeConfig(config)
  log.info(`本机控制口已启动 http://${LOOPBACK_HOST}:${port}`)
  return config
}

/**
 * 停止本机 App UI 控制 HTTP 服务。
 */
export async function stopAppUiControlServer(): Promise<void> {
  if (!httpServer) return

  const server = httpServer
  httpServer = null
  activeToken = null
  activeController = null

  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })

  removeRuntimeConfig()
  log.info('本机控制口已停止')
}

/** 测试用：读取当前 token */
export function _getActiveTokenForTest(): string | null {
  return activeToken
}

/** 测试用：读取当前 controller */
export function _getActiveControllerForTest(): AppUiController | null {
  return activeController
}
