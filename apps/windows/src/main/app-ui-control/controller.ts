import fs from 'node:fs'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { MAX_IMAGE_BYTES, type ResizeResult } from '../agent-runtime/image-resizer'
import { resolveWindowsClientDataRoot } from '../client-data-root'
import { filterSnapshotNodes, nextSnapshotId, SNAPSHOT_SCRIPT } from './snapshot'
import { getScreenshotTempDir } from './screenshot-cleanup'
import type { AppUiRef, AppUiViewState, RawSnapshotNode } from './types'

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
}

/** 控制器对外 API */
export interface AppUiController {
  screenshot(): Promise<AppUiScreenshotResult>
  /** 按 snapshotId 读取内存快照缓存 */
  getSnapshotCache(snapshotId: string): AppUiSnapshotCache | undefined
}

/** 无法读取渲染层状态时的兜底视图 */
const DEFAULT_VIEW_STATE: AppUiViewState = {
  view: 'unknown',
  hub: { open: false, tab: null, category: null },
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
 * 创建 Agent App UI 截图控制器（Part A：仅 screenshot）。
 */
export function createAppUiController(deps: AppUiControllerDeps): AppUiController {
  let snapshotSequence = 0
  const cacheById = new Map<string, AppUiSnapshotCache>()

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

  return {
    screenshot,
    getSnapshotCache,
  }
}
