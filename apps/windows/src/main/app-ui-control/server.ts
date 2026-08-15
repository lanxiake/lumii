/**
 * App UI 本机控制 HTTP 服务（127.0.0.1 + Bearer token）
 *
 * 供 lumii-ui CLI 与外部脚本调用 screenshot / goto / click / act。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { getAgentRuntimeBridge, handleCommand } from '../ipc/agent-runtime-ipc'
import { resizeImageIfNeeded } from '../agent-runtime/image-resizer'
import { resolveWindowsClientDataRoot } from '../client-data-root'
import { isCommandExposed } from './command-allowlist'
import {
  createAppUiController,
  type AppUiController,
  type AppUiScreenshotOptions,
  type ResizeImageFn,
} from './controller'
import { isAppUiControlEnabled } from './enabled'
import { createSlidingWindowRateLimiter } from './rate-limit'

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
  getWindow: (target: 'main' | 'pet' | 'preview') => BrowserWindow | null
  resizeImageIfNeeded?: ResizeImageFn
  /** 测试注入：跳过 createAppUiController */
  controller?: AppUiController
  /** 测试注入：固定 token */
  token?: string
  /** 测试注入：固定端口 */
  port?: number
  /** B 层 skills：由 index 注入，避免 server↔index 循环依赖 */
  getSkillRuntime?: () => {
    listLocalInstalled: () => Promise<unknown>
    setLocalEnabled: (skillId: string, enabled: boolean) => Promise<unknown>
  } | null
  /** B 层 skills：技能变更后刷新（与 index.ts:2154 的 skills:setEnabled handler 行为一致） */
  getSkillWatcher?: () => { refresh: () => Promise<unknown> } | null
  /** 总开关：读取渲染进程 localStorage 设置 JSON；缺省视为开启 */
  readSettingsJson?: () => Promise<string | null>
  /** 测试注入：覆盖默认滑动窗口速率限制器 */
  rateLimiter?: { tryConsume: () => boolean }
  /** 测试注入：覆盖默认 handleCommand 派发 */
  dispatchCommand?: (command: unknown) => Promise<unknown>
  /** 测试注入：覆盖默认 pet:list-models 实现 */
  listPetModels?: () => Promise<unknown>
}

let httpServer: http.Server | null = null
let activeToken: string | null = null
let activeController: AppUiController | null = null
/** 当前启动时传入的 deps，供 /command /settings/* /ipc/* 路由读取 */
let activeDeps: AppUiControlServerDeps | null = null
/** 控制口默认速率限制：60 秒内 100 次请求，CLI 无 turn 概念，与 per-turn 配额独立 */
let activeRateLimiter: { tryConsume: () => boolean } | null = null

/** /command 串行队列：保持 agent-runtime-ipc.ts:2447 声明的 handleCommand 串行不变量 */
let commandQueue: Promise<unknown> = Promise.resolve()

/** 把命令排进串行队列；前一个失败也继续排队，不阻塞后续请求 */
function enqueueCommand<T>(fn: () => Promise<T>): Promise<T> {
  const next = commandQueue.then(fn, fn)
  commandQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

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

/** /act 支持的动作，与 app_act 工具一致 */
const ACT_ACTIONS = ['click', 'type', 'select', 'key', 'scroll'] as const
type ActRouteAction = (typeof ACT_ACTIONS)[number]

/**
 * 从 body 读取 screenshot 参数（annotate / target），非法值走默认。
 */
export function parseScreenshotBody(body: unknown): AppUiScreenshotOptions {
  if (body == null || typeof body !== 'object') return {}
  const record = body as Record<string, unknown>
  const options: AppUiScreenshotOptions = {}
  if (record.annotate === true || record.annotate === 'true') {
    options.annotate = true
  }
  if (
    record.target === 'main' ||
    record.target === 'pet' ||
    record.target === 'preview'
  ) {
    options.target = record.target
  }
  return options
}

/**
 * 补齐 body 上缺失的 action 字段，让 /click 这类专用路由也能复用 controller 的入参校验。
 */
function withAction(body: unknown, action: ActRouteAction): unknown {
  if (body == null || typeof body !== 'object') return { action }
  return { action, ...(body as Record<string, unknown>) }
}

/**
 * 按 body.action 分派到 controller 的 click / type / select / key / scroll。
 */
async function runAct(controller: AppUiController, body: unknown): Promise<unknown> {
  const action = (body as Record<string, unknown> | null)?.action
  switch (action) {
    case 'click':
      return controller.click(body)
    case 'type':
      return controller.type(body)
    case 'select':
      return controller.select(body)
    case 'key':
      return controller.key(body)
    case 'scroll':
      return controller.scroll(body)
    default:
      return { ok: false, error: 'usage' }
  }
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
      const result = await controller.screenshot(parseScreenshotBody(body))
      sendJson(res, 200, result)
      return
    }
    case '/goto': {
      const result = await controller.goto(body)
      sendJson(res, 200, result)
      return
    }
    case '/click': {
      const result = await controller.click(withAction(body, 'click'))
      sendJson(res, 200, result)
      return
    }
    case '/act': {
      const result = await runAct(controller, body)
      sendJson(res, 200, result)
      return
    }
    case '/command': {
      await handleCommandRoute(body, res)
      return
    }
    default:
      sendJson(res, 404, { ok: false, error: 'not_found' })
  }
}

/**
 * A 层：命令总线转发。白名单外一律 not_exposed；白名单内的命令排入串行队列再转发。
 */
async function handleCommandRoute(body: unknown, res: http.ServerResponse): Promise<void> {
  const type = (body as { type?: unknown } | null)?.type
  if (!isCommandExposed(type)) {
    sendJson(res, 200, { ok: false, error: 'not_exposed' })
    return
  }

  const dispatch =
    activeDeps?.dispatchCommand ??
    (async (cmd: unknown) => {
      const bridge = getAgentRuntimeBridge()
      if (!bridge) return { ok: false, error: 'not_ready' }
      return handleCommand(bridge, cmd as Parameters<typeof handleCommand>[1])
    })

  try {
    const result = await enqueueCommand(() => dispatch(body))
    sendJson(res, 200, result)
  } catch (err) {
    sendJson(res, 200, {
      ok: false,
      error: 'command_failed',
      message: err instanceof Error ? err.message : String(err),
    })
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

    const enabled = await isAppUiControlEnabled(
      activeDeps?.readSettingsJson ?? (async () => null),
    )
    if (!enabled) {
      sendJson(res, 200, { ok: false, error: 'disabled' })
      return
    }

    const limiter = activeDeps?.rateLimiter ?? activeRateLimiter
    if (limiter && !limiter.tryConsume()) {
      sendJson(res, 200, { ok: false, error: 'rate_limited' })
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

  activeDeps = deps
  activeRateLimiter =
    deps.rateLimiter ?? createSlidingWindowRateLimiter({ limit: 100, windowMs: 60_000 })
  const token = deps.token ?? randomUUID()
  const port = deps.port ?? (await findAvailablePort(APP_UI_CONTROL_PORT_START, 'app-ui'))
  const controller =
    deps.controller ??
    createAppUiController({
      getWindow: deps.getWindow,
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
  activeDeps = null
  activeRateLimiter = null

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
