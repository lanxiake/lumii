import fs from 'node:fs'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { MAX_IMAGE_BYTES, type ResizeResult } from '../agent-runtime/image-resizer'
import { resolveWindowsClientDataRoot } from '../client-data-root'
import {
  assertClickAllowed,
  buildClickPrepareScript,
  CLICK_BLOCK_ROLES,
  type AppUiClickError,
  type ClickPrepareRect,
} from './act'
import { devicePixelsToDip } from './coords'
import { parseGotoInput } from './goto'
import { filterSnapshotNodes, nextSnapshotId, SNAPSHOT_SCRIPT } from './snapshot'
import { getScreenshotTempDir } from './screenshot-cleanup'
import type { ActInput, AppUiHubState, AppUiRef, AppUiViewState, RawSnapshotNode } from './types'

/** 截图长边最大像素（与设计 §7 一致） */
export const SCREENSHOT_MAX_DIMENSION = 1280

/** capturePage 转 JPEG 的默认质量 */
const CAPTURE_JPEG_QUALITY = 90

/**
 * 读取渲染层当前视图状态的注入脚本。
 * 依赖 `window.__LUMII_APP_UI_STATE__`（Task 6 在 App.tsx 挂载）。
 */
export const VIEW_STATE_SCRIPT = `(function () {
  try {
    var fn = window.__LUMII_APP_UI_STATE__;
    if (typeof fn !== 'function') return null;
    var raw = fn();
    if (raw == null) return null;
    return typeof raw === 'string' ? raw : JSON.stringify(raw);
  } catch (e) {
    return null;
  }
})()`

/** goto 失败时的稳定错误码 */
export type AppUiGotoError = 'usage' | 'app_not_running'

/** goto 成功结果（回读渲染层真实 view/hub） */
export interface AppUiGotoSuccess {
  ok: true
  view: string | null
  hub: AppUiHubState
}

/** goto 失败结果 */
export interface AppUiGotoFailure {
  ok: false
  error: AppUiGotoError
}

export type AppUiGotoResult = AppUiGotoSuccess | AppUiGotoFailure

/** click 成功结果 */
export interface AppUiClickSuccess {
  ok: true
}

/** click 失败结果 */
export interface AppUiClickFailure {
  ok: false
  error: AppUiClickError
}

export type AppUiClickResult = AppUiClickSuccess | AppUiClickFailure

/** goto 等待 React setState 落定的默认毫秒数 */
export const GOTO_SETTLE_MS = 100

/** 截图失败时的稳定错误码 */
export type AppUiScreenshotError = 'app_not_running'

/** 截图图片边界（与返回给模型的 width/height 一致） */
export interface AppUiScreenshotBounds {
  width: number
  height: number
}

/** 内存快照缓存条目，供 Part B click 校验消费 */
export interface AppUiSnapshotCache {
  snapshotId: string
  refs: AppUiRef[]
  viewState: AppUiViewState
  bounds: AppUiScreenshotBounds
}

/** 截图成功结果（含内部 previewPath，不暴露给模型） */
export interface AppUiScreenshotSuccess {
  ok: true
  snapshotId: string
  imageBase64: string
  mimeType: string
  width: number
  height: number
  viewState: AppUiViewState
  refs: AppUiRef[]
  truncated: boolean
  /** 临时 JPEG 路径，供 ToolCallCard 预览；不进入模型可见 payload */
  previewPath: string
  /** 截图时主窗口是否可见（托盘隐藏时为 false） */
  windowVisible: boolean
}

/** 截图失败结果 */
export interface AppUiScreenshotFailure {
  ok: false
  error: AppUiScreenshotError
}

export type AppUiScreenshotResult = AppUiScreenshotSuccess | AppUiScreenshotFailure

/** resizeImageIfNeeded 注入签名 */
export type ResizeImageFn = (
  buf: Buffer,
  hint?: string,
  maxDimension?: number,
  maxBytes?: number,
) => Promise<ResizeResult>

/** createAppUiController 依赖 */
export interface AppUiControllerDeps {
  getMainWindow: () => BrowserWindow | null
  resizeImageIfNeeded: ResizeImageFn
  /** 测试注入数据根；默认 resolveWindowsClientDataRoot */
  resolveDataRoot?: () => string
  /** goto 后等待 React 状态落定的毫秒数；默认 GOTO_SETTLE_MS */
  gotoSettleMs?: number
  /** 坐标换算用 scaleFactor；默认 1（DOM getBoundingClientRect 已是 DIP） */
  getScaleFactor?: (win: BrowserWindow) => number
}

/** 控制器对外 API */
export interface AppUiController {
  screenshot(): Promise<AppUiScreenshotResult>
  /** 按 snapshotId 读取内存快照缓存 */
  getSnapshotCache(snapshotId: string): AppUiSnapshotCache | undefined
  /** 声明式导航并回读渲染层 view/hub */
  goto(input: unknown): Promise<AppUiGotoResult>
  /** 按 ref 在快照坐标处模拟单击 */
  click(input: unknown): Promise<AppUiClickResult>
}

/** 无法读取渲染层状态时的兜底视图（screenshot 用） */
const DEFAULT_VIEW_STATE: AppUiViewState = {
  view: 'unknown',
  hub: { open: false, tab: null, category: null },
}

/** goto 回读失败时的兜底 hub */
const NULL_HUB_STATE: AppUiHubState = { open: false, tab: null, category: null }

/**
 * 等待指定毫秒（goto 后让 React setState 落定）。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 从 goto executeJavaScript 回读结果解析 view/hub；无挂载函数时 view 为 null。
 */
function parseGotoReadback(raw: unknown): { view: string | null; hub: AppUiHubState } {
  if (raw == null) {
    return { view: null, hub: NULL_HUB_STATE }
  }
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { view: null, hub: NULL_HUB_STATE }
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { view: null, hub: NULL_HUB_STATE }
  }
  const record = parsed as Record<string, unknown>
  const hubRaw = record.hub
  const hub =
    hubRaw && typeof hubRaw === 'object'
      ? {
          open: Boolean((hubRaw as Record<string, unknown>).open),
          tab:
            typeof (hubRaw as Record<string, unknown>).tab === 'string'
              ? ((hubRaw as Record<string, unknown>).tab as string)
              : null,
          category:
            typeof (hubRaw as Record<string, unknown>).category === 'string'
              ? ((hubRaw as Record<string, unknown>).category as string)
              : null,
        }
      : NULL_HUB_STATE

  return {
    view: typeof record.view === 'string' ? record.view : null,
    hub,
  }
}

/**
 * 解析 app_act click 入参。
 */
function parseClickInput(raw: unknown): ActInput | null {
  if (raw == null || typeof raw !== 'object') {
    return null
  }
  const params = raw as Record<string, unknown>
  if (params.action !== 'click') {
    return null
  }
  if (typeof params.ref !== 'string') {
    return null
  }
  const input: ActInput = { action: 'click', ref: params.ref }
  if (typeof params.snapshotId === 'string') {
    input.snapshotId = params.snapshotId
  }
  return input
}

/**
 * 根据长边上限计算等比缩放后的显示尺寸。
 */
function computeDisplayDimensions(
  width: number,
  height: number,
  maxDimension: number,
): AppUiScreenshotBounds {
  const longEdge = Math.max(width, height)
  if (longEdge <= maxDimension) {
    return { width, height }
  }
  const scale = maxDimension / longEdge
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  }
}

/**
 * 规范化渲染层回读的视图状态 JSON。
 */
function normalizeViewState(input: unknown): AppUiViewState {
  let parsed: unknown = input
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input)
    } catch {
      return DEFAULT_VIEW_STATE
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return DEFAULT_VIEW_STATE
  }
  const record = parsed as Record<string, unknown>
  const hubRaw = record.hub
  const hub =
    hubRaw && typeof hubRaw === 'object'
      ? {
          open: Boolean((hubRaw as Record<string, unknown>).open),
          tab:
            typeof (hubRaw as Record<string, unknown>).tab === 'string'
              ? ((hubRaw as Record<string, unknown>).tab as string)
              : null,
          category:
            typeof (hubRaw as Record<string, unknown>).category === 'string'
              ? ((hubRaw as Record<string, unknown>).category as string)
              : null,
        }
      : DEFAULT_VIEW_STATE.hub

  return {
    view: typeof record.view === 'string' ? record.view : DEFAULT_VIEW_STATE.view,
    hub,
  }
}

/**
 * 从 webContents 读取当前 App UI 视图状态。
 */
async function readViewState(win: BrowserWindow): Promise<AppUiViewState> {
  const raw = await win.webContents.executeJavaScript(VIEW_STATE_SCRIPT)
  if (raw == null) {
    return DEFAULT_VIEW_STATE
  }
  return normalizeViewState(raw)
}

/**
 * 采集 DOM 快照原始节点列表。
 */
async function readRawSnapshotNodes(win: BrowserWindow): Promise<RawSnapshotNode[]> {
  const raw = await win.webContents.executeJavaScript(SNAPSHOT_SCRIPT)
  if (!Array.isArray(raw)) {
    return []
  }
  return raw as RawSnapshotNode[]
}

/**
 * 将 JPEG Buffer 写入截图临时目录。
 */
function writeScreenshotTempFile(
  dataRoot: string,
  snapshotId: string,
  buffer: Buffer,
): string {
  const dir = getScreenshotTempDir(dataRoot)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${snapshotId}.jpg`)
  fs.writeFileSync(filePath, buffer)
  return filePath
}

/**
 * 创建 Agent App UI 控制器（截图 / goto / click）。
 */
export function createAppUiController(deps: AppUiControllerDeps): AppUiController {
  let snapshotSequence = 0
  const cacheById = new Map<string, AppUiSnapshotCache>()
  const gotoSettleMs = deps.gotoSettleMs ?? GOTO_SETTLE_MS
  const getScaleFactor = deps.getScaleFactor ?? (() => 1)

  /**
   * 截取主窗口 JPEG、采集 refs，并缓存快照供后续 click 校验。
   */
  async function screenshot(): Promise<AppUiScreenshotResult> {
    const win = deps.getMainWindow()
    if (!win || win.isDestroyed()) {
      return { ok: false, error: 'app_not_running' }
    }

    const windowVisible = win.isVisible()
    const dataRoot = deps.resolveDataRoot?.() ?? resolveWindowsClientDataRoot()

    const image = await win.webContents.capturePage()
    const { width: origWidth, height: origHeight } = image.getSize()
    const jpegBuf = image.toJPEG(CAPTURE_JPEG_QUALITY)

    const resized = await deps.resizeImageIfNeeded(
      jpegBuf,
      '.jpg',
      SCREENSHOT_MAX_DIMENSION,
      MAX_IMAGE_BYTES,
    )

    const bounds = computeDisplayDimensions(origWidth, origHeight, SCREENSHOT_MAX_DIMENSION)
    const { snapshotId, nextSequence } = nextSnapshotId(snapshotSequence)
    snapshotSequence = nextSequence

    const [rawNodes, viewState] = await Promise.all([
      readRawSnapshotNodes(win),
      readViewState(win),
    ])
    const { refs, truncated } = filterSnapshotNodes(rawNodes)

    const previewPath = writeScreenshotTempFile(dataRoot, snapshotId, resized.buffer)

    const cacheEntry: AppUiSnapshotCache = {
      snapshotId,
      refs,
      viewState,
      bounds,
    }
    cacheById.set(snapshotId, cacheEntry)

    return {
      ok: true,
      snapshotId,
      imageBase64: resized.buffer.toString('base64'),
      mimeType: resized.mimeType,
      width: bounds.width,
      height: bounds.height,
      viewState,
      refs,
      truncated,
      previewPath,
      windowVisible,
    }
  }

  /**
   * 按 snapshotId 读取内存快照缓存。
   */
  function getSnapshotCache(snapshotId: string): AppUiSnapshotCache | undefined {
    return cacheById.get(snapshotId)
  }

  /**
   * 声明式导航：精确 send 主窗 → 等待 setState → executeJavaScript 回读。
   */
  async function goto(input: unknown): Promise<AppUiGotoResult> {
    const parsed = parseGotoInput(input)
    if (!parsed.ok) {
      return { ok: false, error: 'usage' }
    }

    const win = deps.getMainWindow()
    if (!win || win.isDestroyed()) {
      return { ok: false, error: 'app_not_running' }
    }

    win.webContents.send('app-ui:goto', parsed.input)
    await sleep(gotoSettleMs)

    const raw = await win.webContents.executeJavaScript(VIEW_STATE_SCRIPT)
    const { view, hub } = parseGotoReadback(raw)
    return { ok: true, view, hub }
  }

  /**
   * 按 ref 模拟单击：校验快照 → scrollIntoView 重测 → sendInputEvent。
   */
  async function click(input: unknown): Promise<AppUiClickResult> {
    const actInput = parseClickInput(input)
    if (!actInput) {
      return { ok: false, error: 'missing_ref' }
    }

    const win = deps.getMainWindow()
    if (!win || win.isDestroyed()) {
      return { ok: false, error: 'app_not_running' }
    }

    const snapshotId = actInput.snapshotId
    if (!snapshotId) {
      return { ok: false, error: 'stale_snapshot' }
    }

    const cache = cacheById.get(snapshotId)
    if (!cache) {
      return { ok: false, error: 'stale_snapshot' }
    }

    const allowed = assertClickAllowed({
      ref: actInput.ref,
      snapshotId,
      current: { snapshotId: cache.snapshotId, refs: cache.refs },
      blockRoles: CLICK_BLOCK_ROLES,
    })
    if (!allowed.ok) {
      return { ok: false, error: allowed.error }
    }

    const script = buildClickPrepareScript(
      allowed.ref.x,
      allowed.ref.y,
      allowed.ref.w,
      allowed.ref.h,
    )
    const newRect = (await win.webContents.executeJavaScript(script)) as ClickPrepareRect | null
    if (!newRect || newRect.w <= 0 || newRect.h <= 0) {
      return { ok: false, error: 'click_target_lost' }
    }

    const scaleFactor = getScaleFactor(win)
    const cx = devicePixelsToDip(newRect.x + newRect.w / 2, scaleFactor)
    const cy = devicePixelsToDip(newRect.y + newRect.h / 2, scaleFactor)

    win.webContents.sendInputEvent({
      type: 'mouseDown',
      x: cx,
      y: cy,
      button: 'left',
      clickCount: 1,
    })
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      x: cx,
      y: cy,
      button: 'left',
      clickCount: 1,
    })

    return { ok: true }
  }

  return {
    screenshot,
    getSnapshotCache,
    goto,
    click,
  }
}
