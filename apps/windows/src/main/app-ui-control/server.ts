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
import { getAgentRuntimeBridge, handleCommand, invalidateAgentInstancesForProviderChange } from '../ipc/agent-runtime-ipc'
import { getCloudSyncManager } from '../cloud-sync/sync-accessor'
import { resizeImageIfNeeded } from '../agent-runtime/image-resizer'
import { resolveWindowsClientDataRoot } from '../client-data-root'
import { findDeniedField, isCommandExposed } from './command-allowlist'
import {
  createAppUiController,
  type AppUiController,
  type AppUiScreenshotOptions,
  type ResizeImageFn,
} from './controller'
import { isAppUiControlEnabled } from './enabled'
import { createSlidingWindowRateLimiter } from './rate-limit'
import {
  assertWritablePatch,
  buildPatchScript,
  buildReadScript,
  expandPathValue,
} from './settings-channel'
import {
  loadProviderConfig,
  loadProviderSlotsConfig,
  loadSlotConfig,
  saveProviderConfig,
  isCapabilitySlot,
  PROVIDER_DEFAULT_BASE_URL,
  type CapabilitySlot,
  type LocalProviderConfigView,
  type ProviderType,
} from '../provider-config'
import { testProviderConnection } from '../provider-probe'

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
  /**
   * 渠道登录服务：无头模式没有渲染进程，扫码登录只能由 CLI 触发。
   * 二维码经 index.ts 的 qrcode 事件监听打印到终端，本路由只负责发起与回报状态。
   */
  getChannelLoginServices?: () => ChannelLoginServiceMap
}

/** 四个渠道登录服务的公共结构（startLogin/logout/getStatus 签名一致） */
export interface ChannelLoginServiceLike {
  startLogin: () => Promise<unknown>
  logout: () => Promise<unknown>
  getStatus: () => string
}

/** 渠道名 → 登录服务（未初始化的渠道为 null） */
export type ChannelLoginServiceMap = Record<ChannelName, ChannelLoginServiceLike | null>

/** 支持的渠道 */
export const CHANNEL_NAMES = ['weixin', 'wecom', 'feishu', 'qbot'] as const
export type ChannelName = (typeof CHANNEL_NAMES)[number]

let httpServer: http.Server | null = null
let activeToken: string | null = null
let activeController: AppUiController | null = null
/** 当前启动时传入的 deps，供 /command /settings/* /ipc/* 路由读取 */
let activeDeps: AppUiControlServerDeps | null = null
/** 控制口默认速率限制：60 秒内 100 次请求，CLI 无 turn 概念，与 per-turn 配额独立 */
let activeRateLimiter: { tryConsume: () => boolean } | null = null

/** /command 串行队列：保持 agent-runtime-ipc.ts:2447 声明的 handleCommand 串行不变量 */
let commandQueue: Promise<unknown> = Promise.resolve()

/**
 * 免排队命令：中止类命令只向 AbortController 发信号，不读写上下文，无需串行保护。
 * 必须绕过队列 —— 它们要中止的正是占着队列的那个长任务（压缩的 LLM 摘要可跑几十秒），
 * 排队等于等到目标跑完才执行，abort 恒返回 false。
 */
const QUEUE_BYPASS_COMMANDS = new Set(['user:abort-compact-context', 'user:abort'])

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
 * 发送 JSON 响应（拒绝 undefined body，避免 Buffer.byteLength / res.end 抛 TypeError）。
 */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const safeBody = body === undefined ? { ok: true } : body
  const payload = JSON.stringify(safeBody)
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
    case '/settings/read': {
      await handleSettingsReadRoute(body, res)
      return
    }
    case '/settings/write': {
      await handleSettingsWriteRoute(body, res)
      return
    }
    case '/ipc/skills/list': {
      await handleSkillsListRoute(res)
      return
    }
    case '/ipc/skills/setEnabled': {
      await handleSkillsSetEnabledRoute(body, res)
      return
    }
    case '/ipc/pet/switchMode': {
      await handlePetSwitchModeRoute(body, res)
      return
    }
    case '/ipc/pet/getMode': {
      await handlePetGetModeRoute(res)
      return
    }
    case '/ipc/pet/listModels': {
      await handlePetListModelsRoute(res)
      return
    }
    case '/pet/asset': {
      await handlePetAssetRoute(body, res)
      return
    }
    case '/ipc/cloudsync/status': {
      await handleCloudSyncStatusRoute(res)
      return
    }
    case '/ipc/cloudsync/sync': {
      await handleCloudSyncSyncRoute(res)
      return
    }
    case '/ipc/cloudsync/resolve': {
      await handleCloudSyncResolveRoute(body, res)
      return
    }
    case '/ipc/cloudsync/confirm-mass-delete': {
      await handleCloudSyncConfirmMassDeleteRoute(body, res)
      return
    }
    case '/status': {
      await handleStatusRoute(res)
      return
    }
    case '/channel/login': {
      await handleChannelLoginRoute(body, res)
      return
    }
    case '/channel/status': {
      await handleChannelStatusRoute(body, res)
      return
    }
    case '/channel/logout': {
      await handleChannelLogoutRoute(body, res)
      return
    }
    case '/provider/show': {
      await handleProviderShowRoute(res)
      return
    }
    case '/provider/save': {
      await handleProviderSaveRoute(body, res)
      return
    }
    case '/provider/test': {
      await handleProviderTestRoute(body, res)
      return
    }
    default:
      sendJson(res, 404, { ok: false, error: 'not_found' })
  }
}

/**
 * B 层：列出已安装技能。runtime 未注入（应用尚未初始化）时返回 not_ready。
 */
async function handleSkillsListRoute(res: http.ServerResponse): Promise<void> {
  const rt = activeDeps?.getSkillRuntime?.()
  if (!rt) {
    sendJson(res, 200, { ok: false, error: 'not_ready' })
    return
  }
  const skills = await rt.listLocalInstalled()
  sendJson(res, 200, { ok: true, skills })
}

/**
 * B 层：启用/禁用技能。必须复现 index.ts:2154 的参数校验与 skillWatcher.refresh 副作用，
 * 否则技能列表不会刷新。
 */
async function handleSkillsSetEnabledRoute(body: unknown, res: http.ServerResponse): Promise<void> {
  const skillId = (body as { skillId?: unknown } | null)?.skillId
  const enabled = (body as { enabled?: unknown } | null)?.enabled
  if (typeof skillId !== 'string' || skillId.length === 0 || typeof enabled !== 'boolean') {
    sendJson(res, 200, { ok: false, error: 'usage' })
    return
  }

  const rt = activeDeps?.getSkillRuntime?.()
  if (!rt) {
    sendJson(res, 200, { ok: false, error: 'not_ready' })
    return
  }

  const result = await rt.setLocalEnabled(skillId, enabled)
  const watcher = activeDeps?.getSkillWatcher?.()
  if (watcher) {
    await watcher.refresh().catch(() => {})
  }
  sendJson(res, 200, { ok: true, result })
}

/**
 * B 层：切换桌宠模式。
 */
async function handlePetSwitchModeRoute(body: unknown, res: http.ServerResponse): Promise<void> {
  const mode = (body as { mode?: unknown } | null)?.mode
  const modelId = (body as { modelId?: unknown } | null)?.modelId
  if (mode !== 'pet' && mode !== 'desktop') {
    sendJson(res, 200, { ok: false, error: 'usage' })
    return
  }
  const { switchPetMode, getPetWindowManager } = await import('../pet/pet-mode-ipc')
  const result = await switchPetMode(mode, typeof modelId === 'string' ? modelId : undefined)
  sendJson(res, 200, { ok: true, result, mode: getPetWindowManager()?.getMode() ?? mode })
}

/**
 * B 层：查询当前桌宠模式。
 */
async function handlePetGetModeRoute(res: http.ServerResponse): Promise<void> {
  const { getPetWindowManager } = await import('../pet/pet-mode-ipc')
  sendJson(res, 200, { ok: true, mode: getPetWindowManager()?.getMode() ?? 'desktop' })
}

/**
 * B 层：列出桌宠模型注册表。
 */
async function handlePetListModelsRoute(res: http.ServerResponse): Promise<void> {
  if (activeDeps?.listPetModels) {
    const models = await activeDeps.listPetModels()
    sendJson(res, 200, { ok: true, models })
    return
  }
  const { loadPetModelRegistry } = await import('../pet/pet-model-resolver')
  const { models } = await loadPetModelRegistry()
  sendJson(res, 200, { ok: true, models })
}

/**
 * B 层：宠物素材工具链（P1-b）。
 *
 * 端点是**固定的**：调用方只能选调哪个 op、传什么参数，不能注入代码。
 * 工具链在主进程内执行（sharp 与 pet-core 已打进 bundle），dev 与打包同一条路径——
 * 详见 main/pet/pet-asset-ipc.ts 的模块注释。
 *
 * 请求体：`{ op: 'validate'|'install'|'cutout'|'slice'|'align'|'pack', args?: {...} }`
 * 另有 `op: 'roots'` 返回允许写入的根目录，便于调用方决定输出落点。
 */
async function handlePetAssetRoute(body: unknown, res: http.ServerResponse): Promise<void> {
  const { runPetAssetOp, isPetAssetOp, describeRoots } = await import('../pet/pet-asset-ipc')
  const op = (body as { op?: unknown } | null)?.op
  const args = (body as { args?: Record<string, unknown> } | null)?.args

  if (op === 'roots') {
    sendJson(res, 200, { ok: true, result: describeRoots() })
    return
  }
  if (!isPetAssetOp(op)) {
    sendJson(res, 200, { ok: false, error: 'usage: op 必须是 validate/install/cutout/slice/align/pack/roots' })
    return
  }

  const result = await runPetAssetOp({ op, args })
  sendJson(res, 200, result)
}

/**
 * B 层：云同步状态（供 CLI 校验 state / lastSyncAt / conflict）。
 *
 * 一并返回 `pendingMassDelete` 与 `largeQueue` —— 这两项设置页会展示，
 * CLI 若缺了就会「设置页报警、命令行说一切正常」，属于危险的观测盲区。
 */
async function handleCloudSyncStatusRoute(res: http.ServerResponse): Promise<void> {
  const m = getCloudSyncManager()
  if (!m) {
    sendJson(res, 200, { ok: false, error: 'not_ready' })
    return
  }
  sendJson(res, 200, {
    ok: true,
    status: {
      ...m.getStatus(),
      pendingMassDelete: m.getPendingMassDelete() ?? null,
      largeQueue: m.getLargeQueueStats() ?? null,
    },
  })
}

/**
 * B 层：确认批量删除（等价于设置页「确认删除 N 项」按钮）。
 * 必须回传 status.pendingMassDelete.fingerprint —— 集合变化时确认会被拒绝。
 */
async function handleCloudSyncConfirmMassDeleteRoute(
  body: unknown,
  res: http.ServerResponse,
): Promise<void> {
  const m = getCloudSyncManager()
  if (!m) {
    sendJson(res, 200, { ok: false, error: 'not_ready' })
    return
  }
  const fingerprint = (body as { fingerprint?: unknown } | null)?.fingerprint
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    sendJson(res, 200, { ok: false, error: 'usage: fingerprint is required' })
    return
  }
  const result = m.confirmMassDelete(fingerprint)
  sendJson(res, 200, { ok: true, ...result })
}

/**
 * B 层：立即触发一次云同步（等价于设置页「立即同步」）。
 */
async function handleCloudSyncSyncRoute(res: http.ServerResponse): Promise<void> {
  const m = getCloudSyncManager()
  if (!m) {
    sendJson(res, 200, { ok: false, error: 'not_ready' })
    return
  }
  const result = await m.sync()
  sendJson(res, 200, { ok: true, ...result })
}

/**
 * B 层：解决云同步冲突（等价于 Agent 的 resolve_sync_conflict 工具，供自动化/测试驱动）。
 */
async function handleCloudSyncResolveRoute(body: unknown, res: http.ServerResponse): Promise<void> {
  const m = getCloudSyncManager()
  if (!m) {
    sendJson(res, 200, { ok: false, error: 'not_ready' })
    return
  }
  const b = (body ?? {}) as { strategy?: unknown; choices?: unknown }
  const strategy = b.strategy
  if (strategy !== 'keep-local' && strategy !== 'keep-remote' && strategy !== 'per-file') {
    sendJson(res, 200, { ok: false, error: 'usage: strategy must be keep-local|keep-remote|per-file' })
    return
  }
  let choices: { path: string; side: 'local' | 'remote' }[] | undefined
  if (Array.isArray(b.choices)) {
    choices = b.choices.filter(
      (c): c is { path: string; side: 'local' | 'remote' } =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as { path?: unknown }).path === 'string' &&
        ((c as { side?: unknown }).side === 'local' || (c as { side?: unknown }).side === 'remote'),
    )
  }
  if (strategy === 'per-file' && (choices?.length ?? 0) === 0) {
    sendJson(res, 200, { ok: false, error: 'per-file requires non-empty choices' })
    return
  }
  const result = await m.resolveConflict(strategy, choices)
  sendJson(res, 200, { ok: true, ...result, state: m.getStatus().state })
}

/**
 * 状态诊断：收集服务状态和配置建议
 */
async function handleStatusRoute(res: http.ServerResponse): Promise<void> {
  const bridge = getAgentRuntimeBridge()
  const skillRuntime = activeDeps?.getSkillRuntime?.()
  const cloudSyncManager = getCloudSyncManager()

  // 技能数量：读不到就报 null，不冒充 0
  let skillCount: number | null = null
  if (skillRuntime) {
    try {
      const skills = await skillRuntime.listLocalInstalled()
      skillCount = Array.isArray(skills) ? skills.length : null
    } catch {
      skillCount = null
    }
  }

  // 收集服务状态
  const status = {
    ok: true,
    services: {
      agentRuntime: bridge?.isInitialized ?? false,
      skillSystem: skillRuntime != null,
      skillCount,
      cloudSync: cloudSyncManager != null,
    },
    configuration: {
      hasProviders: false,
      // 「有密文但解不开」与「没填过」是两回事：前者重填才有用，后者要先去填。
      // 无头部署最常见的就是这种（在桌面会话里填的 Key，密钥环没解锁时读不出来）。
      apiKeyDecryptFailed: false,
      browserExecutable: process.env.LUMII_BROWSER_EXECUTABLE || null,
      browserNoSandbox: process.env.LUMII_BROWSER_NO_SANDBOX === '1' || process.env.LUMII_BROWSER_NO_SANDBOX === 'true',
    },
    recommendations: [] as string[],
  }

  // 提供商是否就绪：与 provider-probe.ts 的判据保持一致
  // （启用 + 有模型 ID + 非本地类型需有 API Key），否则会误报「已配置」
  try {
    const chat = loadProviderConfig()
    const isLocalType = chat.type === 'ollama' || chat.type === 'lmstudio'
    status.configuration.hasProviders =
      chat.enabled && chat.modelId.trim().length > 0 && (isLocalType || chat.apiKey.trim().length > 0)
    status.configuration.apiKeyDecryptFailed = chat.apiKeyDecryptFailed === true
  } catch {
    // 读取失败时保持 hasProviders 为 false
  }

  // 生成配置建议
  if (!status.configuration.hasProviders) {
    // 解密失败时只说「未配置」会把用户引向「重填一遍」的弯路（其实得先看密钥环），
    // 所以这一条替掉泛泛的「未配置」，而不是并列出现。
    status.recommendations.push(
      status.configuration.apiKeyDecryptFailed
        ? 'API Key 已保存但解密失败（密钥环变更，或配置来自其它系统/平台），请重填: lumii-ui provider set --type <类型> --model <模型> --api-key -'
        : '未配置 AI 模型提供商，运行: lumii-ui setup',
    )
  }
  if (!status.configuration.browserExecutable) {
    status.recommendations.push('未配置浏览器路径，设置环境变量: export LUMII_BROWSER_EXECUTABLE=/usr/bin/google-chrome')
  }
  if (status.configuration.browserExecutable && !status.configuration.browserNoSandbox) {
    status.recommendations.push('浏览器控制建议启用 --no-sandbox 模式: export LUMII_BROWSER_NO_SANDBOX=1')
  }

  sendJson(res, 200, status)
}

/** 判断字符串是否为受支持的渠道名 */
function isChannelName(value: unknown): value is ChannelName {
  return typeof value === 'string' && (CHANNEL_NAMES as readonly string[]).includes(value)
}

/** 取某个渠道的登录服务；deps 未注入或渠道未初始化时返回 null */
function resolveChannelService(name: ChannelName): ChannelLoginServiceLike | null {
  const services = activeDeps?.getChannelLoginServices?.()
  if (!services) return null
  return services[name] ?? null
}

/**
 * B 层：触发渠道扫码登录。
 *
 * 无头模式下没有渲染进程，二维码由 index.ts 的 qrcode 事件监听打印到终端；
 * 本路由只负责发起登录并回报当前状态（不等扫码结果）。
 */
async function handleChannelLoginRoute(body: unknown, res: http.ServerResponse): Promise<void> {
  const channel = (body as { channel?: unknown } | null)?.channel
  if (!isChannelName(channel)) {
    sendJson(res, 400, { ok: false, error: 'unknown_channel', channels: [...CHANNEL_NAMES] })
    return
  }
  const svc = resolveChannelService(channel)
  if (!svc) {
    sendJson(res, 200, { ok: false, error: 'not_ready' })
    return
  }
  try {
    await svc.startLogin()
    sendJson(res, 200, { ok: true, channel, status: svc.getStatus() })
  } catch (err) {
    sendJson(res, 200, {
      ok: false,
      error: 'start_login_failed',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * B 层：查询渠道登录状态。body.channel 省略时返回全部渠道。
 */
async function handleChannelStatusRoute(body: unknown, res: http.ServerResponse): Promise<void> {
  const requested = (body as { channel?: unknown } | null)?.channel
  if (requested !== undefined && !isChannelName(requested)) {
    sendJson(res, 400, { ok: false, error: 'unknown_channel', channels: [...CHANNEL_NAMES] })
    return
  }
  const names: readonly ChannelName[] = requested ? [requested as ChannelName] : CHANNEL_NAMES
  const channels: Record<string, { status: string } | null> = {}
  for (const name of names) {
    const svc = resolveChannelService(name)
    channels[name] = svc ? { status: svc.getStatus() } : null
  }
  sendJson(res, 200, { ok: true, channels })
}

/**
 * B 层：渠道登出（清本地会话，下次需重新扫码）。
 */
async function handleChannelLogoutRoute(body: unknown, res: http.ServerResponse): Promise<void> {
  const channel = (body as { channel?: unknown } | null)?.channel
  if (!isChannelName(channel)) {
    sendJson(res, 400, { ok: false, error: 'unknown_channel', channels: [...CHANNEL_NAMES] })
    return
  }
  const svc = resolveChannelService(channel)
  if (!svc) {
    sendJson(res, 200, { ok: false, error: 'not_ready' })
    return
  }
  try {
    await svc.logout()
    sendJson(res, 200, { ok: true, channel, status: svc.getStatus() })
  } catch (err) {
    sendJson(res, 200, {
      ok: false,
      error: 'logout_failed',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/** 判断字符串是否为已知 provider 类型（以内置默认表为准） */
function isProviderType(value: unknown): value is ProviderType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_DEFAULT_BASE_URL, value)
}

/**
 * 对外暴露的 provider 配置视图：**不含 API Key 明文**。
 * CLI 输出会进终端与日志，明文密钥一律不出本进程。
 */
function toPublicSlot(view: LocalProviderConfigView) {
  return {
    enabled: view.enabled,
    type: view.type,
    baseUrl: view.baseUrl,
    modelId: view.modelId,
    hasApiKey: view.apiKey.trim().length > 0,
    apiKeyDecryptFailed: view.apiKeyDecryptFailed === true,
    allowedModelIds: view.allowedModelIds ?? [],
  }
}

/**
 * B 层：读取 provider 配置（脱敏）。
 */
async function handleProviderShowRoute(res: http.ServerResponse): Promise<void> {
  const slots = loadProviderSlotsConfig()
  sendJson(res, 200, {
    ok: true,
    slots: {
      chat: toPublicSlot(slots.chat),
      vision: toPublicSlot(slots.vision),
      image: toPublicSlot(slots.image),
    },
  })
}

/**
 * B 层：写入 provider 配置（供 lumii-ui setup / provider set 使用）。
 *
 * 只暴露 chat 槽：无头模式的用户引导只需要「能对话」这一步；
 * vision/image 槽仍走 GUI 设置页。apiKey 省略时保留盘上已有的那把，
 * 避免「只想改模型」的操作把密钥抹掉。
 *
 * 副作用必须与 GUI 的 provider:setConfig（api-ipc.ts:137 一带）一致，
 * 否则配置写进去了，运行中的实例仍拿着旧凭据。
 */
async function handleProviderSaveRoute(body: unknown, res: http.ServerResponse): Promise<void> {
  const input = (body ?? {}) as {
    slot?: unknown
    type?: unknown
    baseUrl?: unknown
    modelId?: unknown
    apiKey?: unknown
    enabled?: unknown
    allowedModelIds?: unknown
  }
  const slot: CapabilitySlot = input.slot === undefined ? 'chat' : (input.slot as CapabilitySlot)
  if (!isCapabilitySlot(slot) || slot !== 'chat') {
    sendJson(res, 400, { ok: false, error: 'unsupported_slot', supported: ['chat'] })
    return
  }
  if (input.type !== undefined && !isProviderType(input.type)) {
    sendJson(res, 400, { ok: false, error: 'unknown_provider_type' })
    return
  }

  const current = loadSlotConfig('chat')
  const nextType = (input.type as ProviderType | undefined) ?? current.type
  const explicitBase = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : undefined
  // 换类型时把端点交回默认表：否则会留下上一个类型（如 ollama 的 localhost）的地址，
  // 配置看起来写成功了，实际指向一个不相干的端点。
  const typeChanged = nextType !== current.type
  const next: LocalProviderConfigView = {
    ...current,
    type: nextType,
    baseUrl: explicitBase ?? (typeChanged ? '' : current.baseUrl),
    modelId: typeof input.modelId === 'string' ? input.modelId.trim() : current.modelId,
    apiKey: typeof input.apiKey === 'string' ? input.apiKey : current.apiKey,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
  }
  if (Array.isArray(input.allowedModelIds)) {
    next.allowedModelIds = input.allowedModelIds.filter((id): id is string => typeof id === 'string')
  } else if (typeChanged) {
    // 换类型时旧候选属于旧服务商，留着会在模型选择里出现一批选不通的条目
    next.allowedModelIds = []
  }
  // 同类型只改模型：沿用旧候选（落盘时会把新模型并入列表），
  // 与 GUI 模型切换 saveChatModel 的语义一致，不至于一次 set 就把用户勾过的候选清空
  if (!next.modelId) {
    sendJson(res, 400, { ok: false, error: 'missing_model_id' })
    return
  }

  try {
    saveProviderConfig(next)
  } catch (err) {
    sendJson(res, 200, {
      ok: false,
      error: 'save_failed',
      message: err instanceof Error ? err.message : String(err),
    })
    return
  }

  // 与 GUI 保存路径一致：清掉失效的会话首选模型，并销毁旧实例
  const saved = loadSlotConfig('chat')
  const availableChatModels = saved.enabled
    ? [saved.modelId, ...(saved.allowedModelIds ?? [])]
        .map((modelId) => modelId?.trim())
        .filter((modelId): modelId is string => Boolean(modelId))
    : []
  try {
    getAgentRuntimeBridge()?.clearInvalidSessionPreferredModels(availableChatModels)
  } catch {
    // bridge 未就绪时跳过，配置已落盘
  }
  try {
    invalidateAgentInstancesForProviderChange()
  } catch {
    // 同上：实例销毁失败不影响落盘结果
  }

  sendJson(res, 200, { ok: true, slot: 'chat', config: toPublicSlot(saved) })
}

/**
 * B 层：测试 provider 连通性。
 *
 * body 省略字段时取盘上已保存的值；带上 apiKey 可测「还没保存的草稿」，
 * 这是配置向导的关键一步——先验证再落盘，避免写进一份连不通的配置。
 */
async function handleProviderTestRoute(body: unknown, res: http.ServerResponse): Promise<void> {
  const input = (body ?? {}) as {
    slot?: unknown
    type?: unknown
    baseUrl?: unknown
    modelId?: unknown
    apiKey?: unknown
  }
  const slot: CapabilitySlot = input.slot === undefined ? 'chat' : (input.slot as CapabilitySlot)
  if (!isCapabilitySlot(slot)) {
    sendJson(res, 400, { ok: false, error: 'unknown_slot' })
    return
  }
  if (input.type !== undefined && !isProviderType(input.type)) {
    sendJson(res, 400, { ok: false, error: 'unknown_provider_type' })
    return
  }

  const current = loadSlotConfig(slot)
  const draft: LocalProviderConfigView = {
    ...current,
    type: (input.type as ProviderType | undefined) ?? current.type,
    baseUrl: typeof input.baseUrl === 'string' && input.baseUrl.trim() ? input.baseUrl.trim() : current.baseUrl,
    modelId: typeof input.modelId === 'string' && input.modelId.trim() ? input.modelId.trim() : current.modelId,
    apiKey: typeof input.apiKey === 'string' ? input.apiKey : current.apiKey,
    enabled: true,
  }

  try {
    const result = await testProviderConnection(slot, draft)
    sendJson(res, 200, { ok: result.ok === true, result })
  } catch (err) {
    sendJson(res, 200, {
      ok: false,
      result: { ok: false, message: err instanceof Error ? err.message : String(err) },
    })
  }
}

/**
 * C 层：读取设置。keyPath 省略时返回整份设置。
 */
async function handleSettingsReadRoute(body: unknown, res: http.ServerResponse): Promise<void> {
  const win = activeDeps?.getWindow('main')
  if (!win || win.isDestroyed()) {
    sendJson(res, 200, { ok: false, error: 'app_not_running' })
    return
  }
  const keyPath = (body as { keyPath?: unknown } | null)?.keyPath
  const raw = await win.webContents.executeJavaScript(
    buildReadScript(typeof keyPath === 'string' ? keyPath : undefined),
  )
  sendJson(res, 200, { ok: true, value: JSON.parse(raw as string) })
}

/**
 * C 层：写入设置。body 可传 { keyPath, value } 或 { patch }。
 * 受保护字段拒绝；merge 在渲染进程注入脚本内一次性完成，避免主进程 RMW 竞态。
 */
async function handleSettingsWriteRoute(body: unknown, res: http.ServerResponse): Promise<void> {
  const record = (body ?? {}) as {
    keyPath?: unknown
    value?: unknown
    patch?: Record<string, unknown>
  }
  const patch =
    record.patch ??
    (typeof record.keyPath === 'string' ? expandPathValue(record.keyPath, record.value) : null)
  if (!patch || typeof patch !== 'object') {
    sendJson(res, 200, { ok: false, error: 'usage' })
    return
  }

  const gate = assertWritablePatch(patch)
  if (!gate.ok) {
    sendJson(res, 200, gate)
    return
  }

  const win = activeDeps?.getWindow('main')
  if (!win || win.isDestroyed()) {
    sendJson(res, 200, { ok: false, error: 'app_not_running' })
    return
  }

  const raw = await win.webContents.executeJavaScript(buildPatchScript(patch))
  sendJson(res, 200, { ok: true, settings: JSON.parse(raw as string) })
}

/**
 * A 层：命令总线转发。白名单外一律 not_exposed；白名单内的命令排入串行队列再转发，
 * 中止类命令（QUEUE_BYPASS_COMMANDS）免排队直发。
 */
async function handleCommandRoute(body: unknown, res: http.ServerResponse): Promise<void> {
  const type = (body as { type?: unknown } | null)?.type
  if (!isCommandExposed(type)) {
    sendJson(res, 200, { ok: false, error: 'not_exposed' })
    return
  }

  // 第二道闸：命令在白名单内，但个别字段（如 user:send 的附件路径）仍须拒绝
  const denied = findDeniedField(body)
  if (denied) {
    sendJson(res, 200, { ok: false, error: 'field_protected', field: denied })
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
    const result = QUEUE_BYPASS_COMMANDS.has(type as string)
      ? await dispatch(body)
      : await enqueueCommand(() => dispatch(body))
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
