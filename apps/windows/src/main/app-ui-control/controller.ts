import fs from 'node:fs'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { MAX_IMAGE_BYTES, type ResizeResult } from '../agent-runtime/image-resizer'
import {
  assertClickAllowed,
  buildClickPrepareScript,
  buildScrollScript,
  buildSelectScript,
  buildTypeScript,
  CLICK_BLOCK_ROLES,
  NON_INTERACTIVE_ROLES,
  isKeyAllowed,
  type AppUiActError,
  type AppUiClickError,
  type ClickPrepareRect,
  type ScrollScriptResult,
  type SelectOptionInfo,
  type SelectScriptResult,
  type TypeScriptResult,
} from './act'
import { annotateSnapshot } from './annotate'
import { devicePixelsToDip } from './coords'
import { parseGotoInput } from './goto'
import { getPetWindowManager } from '../pet/pet-mode-ipc'
import { filterSnapshotNodes, nextSnapshotId, SEMANTIC_ROLES, SNAPSHOT_SCRIPT } from './snapshot'
import { getScreenshotTempDir } from './screenshot-cleanup'
import type {
  ActClickInput,
  ActInput,
  ActKeyInput,
  ActScrollInput,
  ActSelectInput,
  ActTypeInput,
  AppUiHubState,
  AppUiRef,
  AppUiViewState,
  FilterSnapshotOptions,
  RawSnapshotNode,
} from './types'

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
  /** stale_snapshot 自动重试成功时的说明 */
  note?: string
}

/** click 失败结果 */
export interface AppUiClickFailure {
  ok: false
  error: AppUiClickError
  hint?: string
  note?: string
}

export type AppUiClickResult = AppUiClickSuccess | AppUiClickFailure

/** goto 等待 React setState 落定的默认毫秒数 */
export const GOTO_SETTLE_MS = 100

/** 截图目标窗口 */
export type AppUiScreenshotTarget = 'main' | 'pet' | 'preview'

/** screenshot() 可选参数 */
export interface AppUiScreenshotOptions {
  /** 是否在 JPEG 上绘制 SoM 编号，默认 false */
  annotate?: boolean
  /** 截图目标，默认 main */
  target?: AppUiScreenshotTarget
  /** 精简 refs：按 role / y 区间 / name 子串过滤 */
  refs_filter?: FilterSnapshotOptions
}

/** 截图失败时的稳定错误码 */
export type AppUiScreenshotError = 'app_not_running' | 'pet_not_running' | 'usage'

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

/** 截图成功结果（含内部 previewPath；图片以文件路径交付，不内联 base64） */
export interface AppUiScreenshotSuccess {
  ok: true
  snapshotId: string
  width: number
  height: number
  viewState: AppUiViewState
  refs: AppUiRef[]
  truncated: boolean
  /** 临时 JPEG 路径：供 ToolCallCard 预览，并向模型回传 imagePath */
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

/** 控制器可解析的窗口目标（pet 截图走 getPetWindowManager，不经此回调） */
export type AppUiWindowTarget = 'main' | 'pet' | 'preview'

/** createAppUiController 依赖 */
export interface AppUiControllerDeps {
  getWindow: (target: AppUiWindowTarget) => BrowserWindow | null
  resizeImageIfNeeded: ResizeImageFn
  /** 测试注入截图根目录（其下使用 temp/screenshots）；默认当前工作空间 temp */
  resolveDataRoot?: () => string
  /** goto 后等待 React 状态落定的毫秒数；默认 GOTO_SETTLE_MS */
  gotoSettleMs?: number
  /** 坐标换算用 scaleFactor；默认 1（DOM getBoundingClientRect 已是 DIP） */
  getScaleFactor?: (win: BrowserWindow) => number
}

export type AppUiActResult = AppUiClickResult | AppUiActFailure

/** act 失败结果（含 usage，供 key 白名单拒绝） */
export interface AppUiActFailure {
  ok: false
  error: AppUiActError
  /** 补充说明：如 select 未命中时的可选项列表 */
  options?: SelectOptionInfo[]
  /** 人类可读提示，指导下一步怎么做 */
  hint?: string
  note?: string
  /** scrollToText 命中 not_found 时，携带最后一次截图的快照信息以便排障 */
  snapshotId?: string
  refs?: AppUiRef[]
}

/** type 成功结果：回传写入后的实际内容，省掉一次确认截图 */
export interface AppUiTypeSuccess {
  ok: true
  /** 写入后的值；password 字段不回传明文 */
  value?: string
  /** 值是否脱敏 */
  masked?: boolean
  /** 写入后的字符数 */
  length?: number
  note?: string
}

export type AppUiTypeResult = AppUiTypeSuccess | AppUiActFailure

/** select 成功结果 */
export interface AppUiSelectSuccess {
  ok: true
  value: string
  label: string
  options: SelectOptionInfo[]
  note?: string
}

export type AppUiSelectResult = AppUiSelectSuccess | AppUiActFailure

/** scroll 成功结果：带回滚动容器的位置，便于判断是否已到底 */
export interface AppUiScrollSuccess extends ScrollScriptResult {
  ok: true
  note?: string
}

export type AppUiScrollResult = AppUiScrollSuccess | AppUiActFailure

/** 控制器对外 API */
export interface AppUiController {
  screenshot(options?: AppUiScreenshotOptions): Promise<AppUiScreenshotResult>
  /** 按 snapshotId 读取内存快照缓存 */
  getSnapshotCache(snapshotId: string): AppUiSnapshotCache | undefined
  /** @internal 测试专用：删除快照缓存以模拟 stale */
  deleteSnapshotCacheForTest?(snapshotId: string): void
  /** 声明式导航并回读渲染层 view/hub */
  goto(input: unknown): Promise<AppUiGotoResult>
  /** 按 ref 在快照坐标处模拟单击 */
  click(input: unknown): Promise<AppUiActResult>
  /** 按 ref 在输入框写入文本（native value setter） */
  type(input: unknown): Promise<AppUiTypeResult>
  /** 按 ref 直接选中原生下拉框选项（不弹系统菜单） */
  select(input: unknown): Promise<AppUiSelectResult>
  /** 发送白名单按键到当前聚焦的 webContents */
  key(input: unknown): Promise<AppUiActResult>
  /** 按 ref 滚动元素所在的最近可滚动容器 */
  scroll(input: unknown): Promise<AppUiScrollResult>
  /** 高层：goto + settle + screenshot */
  gotoAndScreenshot(input: {
    view: string
    category?: string
    refs_filter?: FilterSnapshotOptions
    annotate?: boolean
  }): Promise<AppUiGotoResult | AppUiScreenshotResult>
  /** 高层：滚动直到找到匹配文字的元素 */
  scrollToText(input: {
    text: string
    kind?: 'heading' | 'button' | 'textbox' | 'any'
    direction?: 'down' | 'up' | 'auto'
    maxAttempts?: number
  }): Promise<
    | (AppUiScreenshotSuccess & {
        matched?: { ref: string; role: string; name: string }
        scrollTop?: number
      })
    | AppUiActFailure
    | AppUiScreenshotFailure
  >
  /** 高层：滚到主内容底部 */
  scrollToBottom(input?: { maxAttempts?: number }): Promise<
    | (AppUiScreenshotSuccess & { scrollTop?: number; atBottom?: boolean })
    | AppUiActFailure
    | AppUiScreenshotFailure
  >
  /** 高层：按 label/slotHeading 批量填表 */
  fillForm(input: {
    fields: Array<{
      label?: string
      slotHeading?: string
      ref?: string
      snapshotId?: string
      text: string
      append?: boolean
    }>
  }): Promise<
    | {
        ok: true
        results: Array<{ label?: string; ref: string; value?: string; masked?: boolean }>
        snapshotId: string
      }
    | AppUiActFailure
    | AppUiScreenshotFailure
    | { ok: false; error: 'field_not_found'; hint: string; field?: string }
  >
  /** 高层：模型配置页保存全部 */
  settingsModelConfigSave(input?: {
    gotoFirst?: boolean
    saveButtonText?: string
    expectToast?: string
  }): Promise<
    | { ok: true; saved: true; warning?: string; snapshotId?: string; refs?: AppUiRef[] }
    | { ok: false; error: string; hint?: string }
  >
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
function parseClickInput(raw: unknown): ActClickInput | null {
  const parsed = parseActInput(raw)
  if (!parsed || parsed.action !== 'click') {
    return null
  }
  return parsed
}

/**
 * 解析 app_act type 入参。
 */
function parseTypeInput(raw: unknown): ActTypeInput | null {
  const parsed = parseActInput(raw)
  if (!parsed || parsed.action !== 'type') {
    return null
  }
  return parsed
}

/**
 * 解析 app_act select 入参。
 */
function parseSelectInput(raw: unknown): ActSelectInput | null {
  const parsed = parseActInput(raw)
  if (!parsed || parsed.action !== 'select') {
    return null
  }
  return parsed
}

/**
 * 解析 app_act key 入参。
 */
function parseKeyInput(raw: unknown): ActKeyInput | null {
  const parsed = parseActInput(raw)
  if (!parsed || parsed.action !== 'key') {
    return null
  }
  return parsed
}

/**
 * 解析 app_act scroll 入参。
 */
function parseScrollInput(raw: unknown): ActScrollInput | null {
  const parsed = parseActInput(raw)
  if (!parsed || parsed.action !== 'scroll') {
    return null
  }
  return parsed
}

/**
 * 解析 app_act 工具入参（click / type / key / scroll）。
 */
function parseActInput(raw: unknown): ActInput | null {
  if (raw == null || typeof raw !== 'object') {
    return null
  }
  const params = raw as Record<string, unknown>
  const snapshotId = typeof params.snapshotId === 'string' ? params.snapshotId : undefined

  if (params.action === 'click') {
    if (typeof params.ref !== 'string') {
      return null
    }
    const input: ActClickInput = { action: 'click', ref: params.ref }
    if (snapshotId) input.snapshotId = snapshotId
    return input
  }

  if (params.action === 'type') {
    if (typeof params.ref !== 'string' || typeof params.text !== 'string') {
      return null
    }
    const input: ActTypeInput = {
      action: 'type',
      ref: params.ref,
      text: params.text,
    }
    if (params.append === true) input.append = true
    if (params.clear === true) input.clear = true
    if (snapshotId) input.snapshotId = snapshotId
    return input
  }

  if (params.action === 'select') {
    if (typeof params.ref !== 'string') {
      return null
    }
    const input: ActSelectInput = { action: 'select', ref: params.ref }
    if (typeof params.value === 'string') input.value = params.value
    if (typeof params.label === 'string') input.label = params.label
    if (snapshotId) input.snapshotId = snapshotId
    return input
  }

  if (params.action === 'key') {
    if (typeof params.key !== 'string') {
      return null
    }
    const input: ActKeyInput = { action: 'key', key: params.key }
    if (snapshotId) input.snapshotId = snapshotId
    return input
  }

  if (params.action === 'scroll') {
    if (typeof params.ref !== 'string') {
      return null
    }
    const input: ActScrollInput = { action: 'scroll', ref: params.ref }
    if (typeof params.dx === 'number') input.dx = params.dx
    if (typeof params.dy === 'number') input.dy = params.dy
    if (snapshotId) input.snapshotId = snapshotId
    return input
  }

  return null
}

/** 注入脚本可回传的失败码，映射为对外稳定错误码 */
const INJECT_ERROR_CODES = new Set<AppUiActError>([
  'not_editable',
  'not_select',
  'option_not_found',
  'inject_failed',
])

/**
 * 把 type / select 注入脚本的失败回读映射为稳定错误码。
 * 脚本返回 null 表示快照坐标处已找不到元素；其余情况按脚本给出的 error 归类。
 */
function mapInjectFailure(
  raw: { error?: string } | boolean | null,
  fallback: AppUiActError,
  hint: string,
): AppUiActFailure {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'click_target_lost' }
  }
  const code = raw.error as AppUiActError | undefined
  if (code && INJECT_ERROR_CODES.has(code)) {
    return code === 'inject_failed' ? { ok: false, error: code } : { ok: false, error: code, hint }
  }
  return { ok: false, error: fallback, hint }
}

/**
 * 解析 scroll 注入脚本的回读结果；字段缺失或类型不符时返回 null。
 */
function parseScrollScriptResult(raw: unknown): ScrollScriptResult | null {
  if (raw == null || typeof raw !== 'object') {
    return null
  }
  const record = raw as Record<string, unknown>
  if (typeof record.scrollTop !== 'number') {
    return null
  }
  return {
    moved: record.moved === true,
    container: typeof record.container === 'string' ? record.container : 'unknown',
    scrollTop: record.scrollTop,
    scrollHeight: typeof record.scrollHeight === 'number' ? record.scrollHeight : 0,
    clientHeight: typeof record.clientHeight === 'number' ? record.clientHeight : 0,
    atTop: record.atTop === true,
    atBottom: record.atBottom === true,
  }
}

type RefActValidationSuccess = {
  ok: true
  win: BrowserWindow
  ref: AppUiRef
}

type RefActValidationFailure = {
  ok: false
  error: AppUiClickError
}

/**
 * 校验需要 ref 的 act 操作：窗口、快照缓存、assertClickAllowed。
 */
function validateRefAct(
  actInput: { ref: string; snapshotId?: string },
  cacheById: Map<string, AppUiSnapshotCache>,
  getWindow: (target: AppUiWindowTarget) => BrowserWindow | null,
): RefActValidationSuccess | RefActValidationFailure {
  const win = getWindow('main')
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

  return { ok: true, win, ref: allowed.ref }
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
 * 将 JPEG Buffer 写入截图临时目录（`{workspace}/temp/screenshots`）。
 */
function writeScreenshotTempFile(
  snapshotId: string,
  buffer: Buffer,
  testRoot?: string,
): string {
  const dir = getScreenshotTempDir(testRoot)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${snapshotId}.jpg`)
  fs.writeFileSync(filePath, buffer)
  return filePath
}

/**
 * 按截图 target 解析 BrowserWindow；preview 不在此解析。
 */
function resolveScreenshotWindow(
  target: AppUiScreenshotTarget,
  getWindow: (t: AppUiWindowTarget) => BrowserWindow | null,
): BrowserWindow | null {
  if (target === 'pet') {
    return getPetWindowManager()?.getPetBrowserWindow() ?? null
  }
  return getWindow('main')
}

/**
 * 将 DOM refs 坐标缩放到与输出 JPEG 一致的尺寸。
 */
function scaleRefsToBounds(
  refs: AppUiRef[],
  origWidth: number,
  origHeight: number,
  bounds: AppUiScreenshotBounds,
): AppUiRef[] {
  if (origWidth <= 0 || origHeight <= 0) {
    return refs
  }
  const scaleX = bounds.width / origWidth
  const scaleY = bounds.height / origHeight
  return refs.map((r) => ({
    ...r,
    x: Math.round(r.x * scaleX),
    y: Math.round(r.y * scaleY),
    w: Math.round(r.w * scaleX),
    h: Math.round(r.h * scaleY),
  }))
}

/**
 * 创建 Agent App UI 控制器（截图 / goto / click）。
 */
export function createAppUiController(deps: AppUiControllerDeps): AppUiController {
  let snapshotSequence = 0
  const cacheById = new Map<string, AppUiSnapshotCache>()
  /** snapshot 被淘汰后仍保留 ref 元数据，供 stale 重试匹配 */
  const refHistory = new Map<string, AppUiRef>()
  const gotoSettleMs = deps.gotoSettleMs ?? GOTO_SETTLE_MS
  const getScaleFactor = deps.getScaleFactor ?? (() => 1)

  /**
   * 截取目标窗口 JPEG、采集 refs，并缓存快照供后续 click 校验。
   */
  async function screenshot(options?: AppUiScreenshotOptions): Promise<AppUiScreenshotResult> {
    const target = options?.target ?? 'main'
    const annotate = options?.annotate ?? false

    if (target === 'preview') {
      return { ok: false, error: 'usage' }
    }

    const win = resolveScreenshotWindow(target, deps.getWindow)
    if (!win || win.isDestroyed()) {
      return {
        ok: false,
        error: target === 'pet' ? 'pet_not_running' : 'app_not_running',
      }
    }

    const windowVisible = win.isVisible()
    const screenshotRoot = deps.resolveDataRoot?.()

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
    const { refs, truncated } = filterSnapshotNodes(rawNodes, options?.refs_filter ?? {})

    let outputBuffer = resized.buffer
    if (annotate && refs.length > 0) {
      const scaledRefs = scaleRefsToBounds(refs, origWidth, origHeight, bounds)
      outputBuffer = await annotateSnapshot(outputBuffer, scaledRefs)
    }

    const previewPath = writeScreenshotTempFile(snapshotId, outputBuffer, screenshotRoot)

    const cacheEntry: AppUiSnapshotCache = {
      snapshotId,
      refs,
      viewState,
      bounds,
    }
    cacheById.set(snapshotId, cacheEntry)
    for (const r of refs) {
      refHistory.set(`${snapshotId}::${r.ref}`, r)
    }

    return {
      ok: true,
      snapshotId,
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

  /** 测试专用：删除快照缓存，模拟过期（refHistory 仍保留） */
  function deleteSnapshotCacheForTest(snapshotId: string): void {
    cacheById.delete(snapshotId)
  }

  /**
   * 声明式导航：精确 send 主窗 → 等待 setState → executeJavaScript 回读。
   */
  async function goto(input: unknown): Promise<AppUiGotoResult> {
    const parsed = parseGotoInput(input)
    if (!parsed.ok) {
      return { ok: false, error: 'usage' }
    }

    const win = deps.getWindow('main')
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
   * stale_snapshot 时内部重截一次，按 role+name 或坐标近似匹配后重试一次。
   */
  async function withAutoRetryStaleSnapshot<
    T extends { ok: boolean; error?: string; hint?: string; note?: string },
  >(
    actInput: { ref: string; snapshotId?: string },
    executeOnce: (patched: { ref: string; snapshotId: string }) => Promise<T>,
  ): Promise<T> {
    const snapshotId = actInput.snapshotId
    if (!snapshotId) {
      return (await executeOnce({ ref: actInput.ref, snapshotId: '' })) as T
    }
    const first = await executeOnce({ ref: actInput.ref, snapshotId })
    if (first.ok || first.error !== 'stale_snapshot') return first

    const oldRef = cacheById.get(snapshotId)?.refs.find((r) => r.ref === actInput.ref) ?? refHistory.get(`${snapshotId}::${actInput.ref}`)
    if (!oldRef) return first

    const fresh = await screenshot({ target: 'main' })
    if (!fresh.ok) return first

    const sameName = fresh.refs.find((r) => r.role === oldRef.role && r.name === oldRef.name)
    let matched = sameName
    let matchHow = 'role+name 精确'
    if (!matched) {
      const candidates = fresh.refs
        .filter((r) => r.role === oldRef.role)
        .map((r) => ({ r, d: Math.abs(r.x - oldRef.x) + Math.abs(r.y - oldRef.y) }))
        .sort((a, b) => a.d - b.d)
      if (candidates[0] && candidates[0].d <= 100) {
        matched = candidates[0].r
        matchHow = `role+坐标最近 d=${candidates[0].d}px`
      }
    }
    if (!matched) {
      first.hint = `stale_snapshot 内部重试过，但目标元素没找到（role=${oldRef.role}, name=${oldRef.name}），请重新截图后再操作`
      return first
    }

    const second = await executeOnce({ ref: matched.ref, snapshotId: fresh.snapshotId })
    if (second.ok) {
      second.note = `stale_snapshot 自动重试成功：旧 ${actInput.ref}@${snapshotId} → 新 ${matched.ref}@${fresh.snapshotId}（${matchHow}）`
      return second
    }
    first.hint = `stale_snapshot 内部重试过仍失败（${matchHow}），请重新截图后再操作`
    return first
  }

  /**
   * 从最新截图 refs 中挑一个适合滚动的锚点 ref。
   */
  function pickScrollAnchor(refs: AppUiRef[]): AppUiRef | undefined {
    return (
      refs.find((r) => r.role === 'heading' || r.role === 'section_title') ||
      refs.find(
        (r) =>
          !SEMANTIC_ROLES.has(r.role) &&
          !(NON_INTERACTIVE_ROLES as readonly string[]).includes(r.role),
      ) ||
      refs[0]
    )
  }

  /**
   * 按 ref 模拟单击：校验快照 → scrollIntoView 重测 → sendInputEvent。
   */
  async function click(input: unknown): Promise<AppUiActResult> {
    const actInput = parseClickInput(input)
    if (!actInput) return { ok: false, error: 'missing_ref' }

    return withAutoRetryStaleSnapshot(actInput, async (patched) => {
      const validated = validateRefAct(patched, cacheById, deps.getWindow)
      if (!validated.ok) return validated

      const { win, ref } = validated
      const script = buildClickPrepareScript(ref.x, ref.y, ref.w, ref.h)
      const newRect = (await win.webContents.executeJavaScript(script)) as ClickPrepareRect | null
      if (!newRect || newRect.w <= 0 || newRect.h <= 0) {
        return { ok: false, error: 'click_target_lost' }
      }
      if (newRect.tag === 'select') {
        return {
          ok: false,
          error: 'use_select_action',
          hint: '这是原生下拉框，请改用 app_act select（value 或 label），点击无法展开可见选项',
        }
      }
      if (newRect.hit === false) {
        return {
          ok: false,
          error: 'click_blocked',
          hint: '目标被弹层或遮罩挡住，请先关闭上层弹窗，或重新截图取最新 ref',
        }
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
    })
  }

  /**
   * 按 ref 写入文本：校验快照 → native value setter 注入 → 回读写入后的实际值。
   */
  async function type(input: unknown): Promise<AppUiTypeResult> {
    const actInput = parseTypeInput(input)
    if (!actInput) return { ok: false, error: 'missing_ref' }

    return withAutoRetryStaleSnapshot(actInput, async (patched) => {
      const validated = validateRefAct(patched, cacheById, deps.getWindow)
      if (!validated.ok) return validated

      const { win, ref } = validated
      const script = buildTypeScript(ref.x, ref.y, ref.w, ref.h, actInput.text, actInput.append)
      const raw = (await win.webContents.executeJavaScript(script)) as
        | TypeScriptResult
        | boolean
        | null
      if (raw === true) return { ok: true }
      if (!raw || typeof raw !== 'object' || raw.ok !== true) {
        return mapInjectFailure(
          raw,
          'not_editable',
          '目标不是输入框，请确认 ref 指向文本框或文本域',
        )
      }
      const result: AppUiTypeSuccess = { ok: true }
      if (raw.value !== undefined) result.value = raw.value
      if (raw.masked !== undefined) result.masked = raw.masked
      if (raw.length !== undefined) result.length = raw.length
      return result
    })
  }

  /**
   * 按 ref 选中原生下拉框选项：校验快照 → 注入设置 value 并派发 change。
   */
  async function select(input: unknown): Promise<AppUiSelectResult> {
    const actInput = parseSelectInput(input)
    if (!actInput) return { ok: false, error: 'missing_ref' }

    return withAutoRetryStaleSnapshot(actInput, async (patched) => {
      const validated = validateRefAct(patched, cacheById, deps.getWindow)
      if (!validated.ok) return validated

      const { win, ref } = validated
      const script = buildSelectScript(ref.x, ref.y, ref.w, ref.h, actInput.value, actInput.label)
      const raw = (await win.webContents.executeJavaScript(script)) as SelectScriptResult | null
      if (!raw || typeof raw !== 'object' || raw.ok !== true) {
        const failure = mapInjectFailure(
          raw,
          'not_select',
          '目标不是原生下拉框，普通按钮请用 app_act click',
        )
        if (raw && typeof raw === 'object' && Array.isArray(raw.options)) {
          failure.options = raw.options
        }
        if (failure.error === 'option_not_found') {
          failure.hint = '给定的 value/label 不在选项里，请从返回的 options 中挑一个再试'
        }
        return failure
      }
      return {
        ok: true,
        value: raw.value ?? '',
        label: raw.label ?? '',
        options: raw.options ?? [],
      }
    })
  }

  /**
   * 发送白名单按键：无需 ref，发往当前聚焦的 webContents。
   */
  async function key(input: unknown): Promise<AppUiActResult> {
    const actInput = parseKeyInput(input)
    if (!actInput) return { ok: false, error: 'usage' }
    if (!isKeyAllowed(actInput.key)) return { ok: false, error: 'usage' }
    const win = deps.getWindow('main')
    if (!win || win.isDestroyed()) return { ok: false, error: 'app_not_running' }
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: actInput.key })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: actInput.key })
    return { ok: true }
  }

  /**
   * 按 ref 滚动：校验快照 → 注入脚本滚动最近可滚动祖先，并回读滚动后的位置。
   */
  async function scroll(input: unknown): Promise<AppUiScrollResult> {
    const actInput = parseScrollInput(input)
    if (!actInput) return { ok: false, error: 'missing_ref' }

    return withAutoRetryStaleSnapshot(actInput, async (patched) => {
      const validated = validateRefAct(patched, cacheById, deps.getWindow)
      if (!validated.ok) return validated
      const { win, ref } = validated
      const dx = actInput.dx ?? 0
      const dy = actInput.dy ?? 0
      const script = buildScrollScript(ref.x, ref.y, ref.w, ref.h, dx, dy)
      const raw = await win.webContents.executeJavaScript(script)
      const parsed = parseScrollScriptResult(raw)
      if (!parsed) return { ok: false, error: 'click_target_lost' }
      return { ok: true, ...parsed }
    })
  }

  /**
   * 高层工具：声明式进入视图并立即截图。
   */
  async function gotoAndScreenshot(input: {
    view: string
    category?: string
    refs_filter?: FilterSnapshotOptions
    annotate?: boolean
  }): Promise<AppUiGotoResult | AppUiScreenshotResult> {
    const gotoRes = await goto(input)
    if (!gotoRes.ok) return gotoRes
    await sleep(Math.max(gotoSettleMs, 150))
    return screenshot({
      target: 'main',
      annotate: input.annotate === true,
      refs_filter: input.refs_filter,
    })
  }

  /**
   * 高层工具：滚动直到找到含指定文字的元素。
   */
  async function scrollToText(input: {
    text: string
    kind?: 'heading' | 'button' | 'textbox' | 'any'
    direction?: 'down' | 'up' | 'auto'
    maxAttempts?: number
  }): Promise<
    | (AppUiScreenshotSuccess & {
        matched?: { ref: string; role: string; name: string }
        scrollTop?: number
      })
    | AppUiActFailure
    | AppUiScreenshotFailure
  > {
    const needle = String(input.text || '').trim().toLowerCase()
    if (!needle) return { ok: false as const, error: 'usage' as const, hint: 'text 不能为空' }
    const kind = input.kind ?? 'any'
    const direction = input.direction ?? 'auto'
    const maxAttempts = input.maxAttempts ?? 10

    const roleOk = (role: string) => {
      if (kind === 'any') return true
      if (kind === 'heading') return role === 'heading' || role === 'section_title'
      return role === kind
    }
    const findMatch = (refs: AppUiRef[]) =>
      refs.find((r) => roleOk(r.role) && r.name.toLowerCase().includes(needle))

    const directions: Array<'down' | 'up'> =
      direction === 'auto' ? ['down', 'up'] : [direction]

    let lastSs: AppUiScreenshotResult | null = null
    for (const dir of directions) {
      const attempts =
        direction === 'auto' ? (dir === 'down' ? Math.max(1, maxAttempts - 2) : 2) : maxAttempts
      for (let i = 0; i < attempts; i++) {
        const ss = await screenshot({ target: 'main' })
        lastSs = ss
        if (!ss.ok) return ss
        const hit = findMatch(ss.refs)
        if (hit) {
          return {
            ...ss,
            matched: { ref: hit.ref, role: hit.role, name: hit.name },
          }
        }
        const anchor = pickScrollAnchor(ss.refs)
        if (!anchor) break
        const dy = Math.round((ss.height || 800) * 0.7) * (dir === 'down' ? 1 : -1)
        const scrolled = await scroll({
          action: 'scroll',
          ref: anchor.ref,
          snapshotId: ss.snapshotId,
          dy,
        })
        if (!scrolled.ok) break
        if (dir === 'down' && scrolled.atBottom) break
        if (dir === 'up' && scrolled.atTop) break
      }
    }

    return {
      ok: false as const,
      error: 'not_found' as const,
      hint: `已滚动查找 "${input.text}"（kind=${kind}），未找到匹配`,
      ...(lastSs && lastSs.ok
        ? { snapshotId: lastSs.snapshotId, refs: lastSs.refs }
        : {}),
    }
  }

  /**
   * 高层工具：滚到当前页面主内容底部。
   */
  async function scrollToBottom(input?: { maxAttempts?: number }) {
    const maxAttempts = input?.maxAttempts ?? 6
    let lastSs: AppUiScreenshotSuccess | null = null
    let atBottom = false
    let scrollTop = 0
    for (let i = 0; i < maxAttempts; i++) {
      const ss = await screenshot({ target: 'main' })
      if (!ss.ok) return ss
      lastSs = ss
      const anchor = pickScrollAnchor(ss.refs)
      if (!anchor) break
      const dy = Math.round((ss.height || 800) * 0.85)
      const scrolled = await scroll({
        action: 'scroll',
        ref: anchor.ref,
        snapshotId: ss.snapshotId,
        dy,
      })
      if (!scrolled.ok) break
      scrollTop = scrolled.scrollTop
      atBottom = scrolled.atBottom
      if (atBottom || !scrolled.moved) break
    }
    if (!lastSs) return { ok: false as const, error: 'app_not_running' as const }
    return { ...lastSs, scrollTop, atBottom }
  }

  /**
   * 高层工具：按 slotHeading + label 定位输入框并批量写入。
   */
  async function fillForm(input: {
    fields: Array<{
      label?: string
      slotHeading?: string
      ref?: string
      snapshotId?: string
      text: string
      append?: boolean
    }>
  }): Promise<
    | {
        ok: true
        results: Array<{ label?: string; ref: string; value?: string; masked?: boolean }>
        snapshotId: string
      }
    | AppUiActFailure
    | AppUiScreenshotFailure
    | { ok: false; error: 'field_not_found'; hint: string; field?: string }
  > {
    const fields = input.fields ?? []
    if (fields.length === 0) {
      return { ok: false as const, error: 'usage' as const, hint: 'fields 不能为空' }
    }

    const ss = await screenshot({ target: 'main' })
    if (!ss.ok) return ss
    let snapshotId = ss.snapshotId
    let refs = ss.refs
    const results: Array<{ label?: string; ref: string; value?: string; masked?: boolean }> = []

    for (const field of fields) {
      let target: AppUiRef | undefined
      if (field.ref && field.snapshotId) {
        const cache = cacheById.get(field.snapshotId)
        target = cache?.refs.find((r) => r.ref === field.ref)
        if (target) snapshotId = field.snapshotId
      } else if (field.label) {
        const labelQ = field.label.toLowerCase()
        let labels = refs.filter(
          (r) => r.role === 'label' && r.name.toLowerCase().includes(labelQ),
        )
        if (field.slotHeading) {
          const hq = field.slotHeading.toLowerCase()
          const heading = refs.find(
            (r) =>
              (r.role === 'heading' || r.role === 'section_title') &&
              r.name.toLowerCase().includes(hq),
          )
          if (heading) {
            const y1 = heading.y - 20
            const y2 = heading.y + 420
            labels = labels.filter((r) => r.y >= y1 && r.y <= y2)
          }
        }
        const labelRef = labels[0]
        if (labelRef) {
          const textboxes = refs
            .filter((r) => r.role === 'textbox')
            .filter(
              (r) =>
                Math.abs(r.y - labelRef.y) < 80 ||
                (r.y >= labelRef.y - 10 && r.y <= labelRef.y + 120),
            )
            .sort((a, b) => a.y - b.y || a.x - b.x)
          target = textboxes[0]
        }
      }

      if (!target) {
        const headingNames = refs
          .filter((r) => r.role === 'heading' || r.role === 'section_title')
          .map((r) => r.name)
          .slice(0, 12)
        const labelNames = refs
          .filter((r) => r.role === 'label')
          .map((r) => r.name)
          .slice(0, 20)
        return {
          ok: false as const,
          error: 'field_not_found' as const,
          field: field.label ?? field.ref,
          hint: `未找到字段 "${field.label ?? field.ref}"；候选 heading=${JSON.stringify(headingNames)} label=${JSON.stringify(labelNames)}`,
        }
      }

      const typed = await type({
        action: 'type',
        ref: target.ref,
        snapshotId,
        text: field.text,
        append: field.append === true,
      })
      if (!typed.ok) return typed
      results.push({
        label: field.label,
        ref: target.ref,
        value: 'value' in typed ? typed.value : undefined,
        masked: 'masked' in typed ? typed.masked : undefined,
      })
      const refreshed = await screenshot({ target: 'main' })
      if (refreshed.ok) {
        snapshotId = refreshed.snapshotId
        refs = refreshed.refs
      }
    }

    return { ok: true as const, results, snapshotId }
  }

  /**
   * 高层工具：进入模型配置并点击「保存全部」。
   */
  async function settingsModelConfigSave(input?: {
    gotoFirst?: boolean
    saveButtonText?: string
    expectToast?: string
  }) {
    const gotoFirst = input?.gotoFirst !== false
    const saveButtonText = input?.saveButtonText ?? '保存全部'
    const expectToast = input?.expectToast ?? '保存成功'

    if (gotoFirst) {
      const g = await gotoAndScreenshot({ view: 'settings', category: 'modelConfig' })
      if (!g.ok) {
        return { ok: false as const, error: 'goto_failed', hint: '无法进入设置-模型配置' }
      }
    }

    await scrollToBottom()
    const found = await scrollToText({ text: saveButtonText, kind: 'button' })
    if (!found.ok || !('matched' in found) || !found.matched) {
      return {
        ok: false as const,
        error: 'save_btn_not_found',
        hint: `未找到按钮 "${saveButtonText}"，请确认已在模型配置页`,
      }
    }

    const clicked = await click({
      action: 'click',
      ref: found.matched.ref,
      snapshotId: found.snapshotId,
    })
    if (!clicked.ok) return clicked

    let warning: string | undefined
    if (expectToast) {
      await sleep(800)
      const after = await screenshot({ target: 'main' })
      if (after.ok) {
        const toastHit = after.refs.some((r) => r.name.includes(expectToast))
        if (!toastHit) warning = 'toast_not_verified'
        return {
          ok: true as const,
          saved: true as const,
          warning,
          snapshotId: after.snapshotId,
          refs: after.refs,
        }
      }
      warning = 'toast_not_verified'
    }

    return { ok: true as const, saved: true as const, warning }
  }

  return {
    screenshot,
    getSnapshotCache,
    deleteSnapshotCacheForTest,
    goto,
    click,
    type,
    select,
    key,
    scroll,
    gotoAndScreenshot,
    scrollToText,
    scrollToBottom,
    fillForm,
    settingsModelConfigSave,
  }
}

