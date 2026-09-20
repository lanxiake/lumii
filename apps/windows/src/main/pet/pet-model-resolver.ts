/**
 * pet-model-resolver - 宠物模型资源解析（主进程）
 *
 * 设计依据：04-快速移植指南 §3.3（resolvePetModelPath）
 *           docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md §5.1
 *
 * 职责：
 *  - **两段式扫描**：读内置 `resources/pet-models/registry.json` 与用户宠物目录的
 *    `registry.json`，按「同 id 用户优先」合并（合并规则见 pet-core 的 pet-registry.ts）
 *  - 把模型相对路径解析为渲染进程可加载的 URL：
 *      内置 → dev 走 `/pet-models/`（Vite 中间件）、打包走 `file://`
 *      用户 → 一律走 `lumii-pet://`（见 pet-asset-protocol.ts 的选择理由）
 *
 * 校验与默认值补全已下沉到 pet-core（与构建期工具链共用同一份实现），本文件只做 IO 与 URL 解析。
 *
 * dev：resources 不经 Vite dev server，用 file:// 绝对路径加载（Electron 渲染进程支持）。
 * 打包：process.resourcesPath/pet-models。
 */

import { app } from 'electron'
import { join, isAbsolute } from 'node:path'
import { promises as fs } from 'fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mergePetRegistries, type MergedPetModel, type PetRegistryDiagnostic } from '@mtbot/pet-core'
import { buildPetAssetUrl, petAssetUrlToDiskPath, resolveUserPetModelsDir } from './pet-asset-protocol'

const log = {
  info: (...args: unknown[]) => console.log('[pet-model-resolver]', ...args),
  warn: (...args: unknown[]) => console.warn('[pet-model-resolver]', ...args),
  error: (...args: unknown[]) => console.error('[pet-model-resolver]', ...args),
}

/** 解析 live2d 资源根目录 */
export function resolveLive2dDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'live2d')
  }
  return join(app.getAppPath(), 'resources', 'live2d')
}

/**
 * 解析 Cubism Core 脚本 URL。
 * dev + Vite http：/live2d/live2dcubismcore.min.js（走 dev server 中间件）
 * 其余：file:// 绝对路径（Electron 渲染进程可加载）
 */
export function resolveCubismCoreUrl(): string {
  const corePath = join(resolveLive2dDir(), 'live2dcubismcore.min.js')
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && rendererUrl?.startsWith('http')) {
    return '/live2d/live2dcubismcore.min.js'
  }
  return pathToFileURL(corePath).href
}

/** 解析内置 pet-models 资源根目录 */
export function resolvePetModelsDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'pet-models')
  }
  // dev：apps/windows/resources/pet-models
  return join(app.getAppPath(), 'resources', 'pet-models')
}

/** 判定是否为外部可加载 URL（http/https/file），无需再解析 */
export function isExternalUrl(modelUrl: string): boolean {
  return /^(https?|file):\/\//i.test(modelUrl)
}

/** 把内置模型的相对路径转为渲染进程可加载的 URL */
function toBuiltinUrl(modelUrl: string): string {
  // 已是绝对 URL（http/file）直接用
  if (isExternalUrl(modelUrl)) return modelUrl
  // dev 模式 + HTTP renderer：用 /pet-models/ 路径，由 Vite dev server 中间件提供
  // （HTTP 页面无法加载 file:// 资源，会报 Network error）
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && rendererUrl?.startsWith('http')) {
    const rel = modelUrl.replace(/\\/g, '/')
    return `/pet-models/${rel}`
  }
  const baseDir = resolvePetModelsDir()
  const abs = isAbsolute(modelUrl) ? modelUrl : join(baseDir, modelUrl)
  return pathToFileURL(abs).href
}

/**
 * 把用户模型的相对路径转为 `lumii-pet://` URL。
 *
 * 返回 null 表示该条目应当被丢弃（声明了逃出用户宠物目录的路径）。
 */
function toUserUrl(modelUrl: string): string | null {
  if (isExternalUrl(modelUrl)) return modelUrl
  const abs = isAbsolute(modelUrl) ? modelUrl : join(resolveUserPetModelsDir(), modelUrl)
  try {
    return buildPetAssetUrl(abs)
  } catch (err) {
    log.warn(
      `[toUserUrl] 路径越出用户宠物目录，已跳过该条目：${modelUrl}（${err instanceof Error ? err.message : err}）`,
    )
    return null
  }
}

/**
 * 解析合并条目的 URL。
 *
 * @returns 规范化后的 DTO 字段；URL 不可解析时返回 null（调用方丢弃该条）
 */
export function resolveMergedModel(m: MergedPetModel): Record<string, unknown> | null {
  const resolveUrl = m.source === 'user' ? toUserUrl : toBuiltinUrl

  const modelUrl = resolveUrl(m.modelUrl)
  if (modelUrl === null) return null

  let thumbnailUrl: string | undefined
  if (m.thumbnailUrl) {
    thumbnailUrl = resolveUrl(m.thumbnailUrl) ?? undefined
  }

  return {
    id: m.id,
    name: m.name,
    rendererType: m.rendererType,
    modelUrl,
    scale: m.scale,
    idleMotionGroup: m.idleMotionGroup,
    idleMotionFallbackGroup: m.idleMotionFallbackGroup,
    idleMotionRandomGroups: m.idleMotionRandomGroups,
    talkMotionGroup: m.talkMotionGroup,
    emotionMap: m.emotionMap,
    tapMotions: m.tapMotions,
    defaultExpression: m.defaultExpression,
    actionMotions: m.actionMotions,
    agentId: m.agentId || undefined,
    personaAddon: m.personaAddon,
    toolPrompts: m.toolPrompts,
    thumbnailUrl,
    source: m.source,
    shadowedBuiltin: m.shadowedBuiltin,
  }
}

/** 读一份注册表 JSON；不存在或不可解析都返回 null（由合并层当作空表处理） */
async function readRegistryFile(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf-8'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      // 内置目录缺失才是异常；用户目录没建过是常态，不吵
      if (label === '内置') log.warn(`[loadPetModelRegistry] 内置注册表不存在：${path}`)
      return null
    }
    log.warn(
      `[loadPetModelRegistry] ${label}注册表读取失败 ${path}：${err instanceof Error ? err.message : err}`,
    )
    return null
  }
}

function logDiagnostics(diagnostics: PetRegistryDiagnostic[]): void {
  for (const d of diagnostics) {
    const where = d.id ? `${d.source}/${d.id}` : d.source
    const text = `[loadPetModelRegistry] ${where}：${d.message}`
    if (d.level === 'error') log.warn(text)
    else log.info(text)
  }
}

/** 读取并解析注册表：内置 + 用户两段式扫描后合并，返回规范化后的模型列表 + 默认 ID */
export async function loadPetModelRegistry(): Promise<{
  models: Record<string, unknown>[]
  defaultModelId: string
}> {
  const builtinPath = join(resolvePetModelsDir(), 'registry.json')
  const userPath = join(resolveUserPetModelsDir(), 'registry.json')

  const [builtinRaw, userRaw] = await Promise.all([
    readRegistryFile(builtinPath, '内置'),
    readRegistryFile(userPath, '用户'),
  ])

  const merged = mergePetRegistries(builtinRaw, userRaw)
  logDiagnostics(merged.diagnostics)

  const models: Record<string, unknown>[] = []
  for (const m of merged.models) {
    const resolved = resolveMergedModel(m)
    if (resolved) models.push(resolved)
  }

  const userCount = models.filter((m) => m.source === 'user').length
  log.info(
    `[loadPetModelRegistry] 合并 ${models.length} 个模型（内置 ${models.length - userCount} / 用户 ${userCount}），默认 ${merged.defaultModelId}`,
  )

  // 默认模型若在 URL 解析阶段被丢弃，回落到列表首项
  const defaultModelId = models.some((m) => m.id === merged.defaultModelId)
    ? merged.defaultModelId
    : ((models[0]?.id as string) ?? '')

  return { models, defaultModelId }
}

/** 获取指定模型的规范化配置 */
export async function getPetModelConfig(modelId: string): Promise<Record<string, unknown> | null> {
  const { models, defaultModelId } = await loadPetModelRegistry()
  const targetId = modelId || defaultModelId
  return models.find((m) => m.id === targetId) ?? models[0] ?? null
}

/** 解析后的可触发动作（供提示词注入 + 渲染层播放映射） */
export interface ResolvedMotionAction {
  /** [motion:tag] 的 tag */
  tag: string
  /** Live2D 动作组名 */
  group: string
  /** 组内 index（省略=该组随机） */
  index?: number
  /** 给模型的语义描述（自动编号时为空） */
  description?: string
}

/** 把模型相对/绝对 modelUrl 还原为磁盘可读绝对路径 */
function modelUrlToDiskPath(rawModelUrl: string): string | null {
  if (/^https?:\/\//i.test(rawModelUrl)) return null
  if (rawModelUrl.startsWith('lumii-pet://')) return petAssetUrlToDiskPath(rawModelUrl)
  if (rawModelUrl.startsWith('file://')) {
    try {
      return fileURLToPath(rawModelUrl)
    } catch {
      return null
    }
  }
  const baseDir = resolvePetModelsDir()
  // dev HTTP 模式 toBuiltinUrl 会输出 /pet-models/<rel>，还原为磁盘相对路径
  if (rawModelUrl.startsWith('/pet-models/')) {
    return join(baseDir, rawModelUrl.slice('/pet-models/'.length))
  }
  return isAbsolute(rawModelUrl) ? rawModelUrl : join(baseDir, rawModelUrl)
}

/**
 * 读取模型 model3.json 的 Motions 组，结合注册表 actionMotions 解析出可触发动作列表。
 *
 * 策略：
 *  - 作者在 registry 显式声明 actionMotions 时，按其语义命名/描述（最高优先级）。
 *  - 否则取「非待机/非说话组」的动作，自动编号为 [motion:1]..[motion:N]（无语义描述）。
 *  - 待机组（idleMotionGroup / idleMotionRandomGroups）与说话组（talkMotionGroup）排除，
 *    避免模型主动触发待机动画造成与编排冲突。
 *
 * @returns 动作列表；模型无可用动作或读取失败返回空数组。
 */
export async function resolveModelMotionActions(
  config: Record<string, unknown>,
): Promise<ResolvedMotionAction[]> {
  // 1. 作者精选优先
  const curated = config.actionMotions as
    | Record<string, { group: string; index?: number; description?: string }>
    | undefined
  if (curated && Object.keys(curated).length > 0) {
    return Object.entries(curated).map(([tag, v]) => ({
      tag,
      group: v.group,
      index: v.index,
      description: v.description,
    }))
  }

  // 2. 从模型文件自动解析非待机组动作。
  //    **两种后端的来源不同**：Live2D 读 model3.json 的 FileReferences.Motions；
  //    sprite 读清单的 animations。此前只实现了前者，导致 sprite 模型恒定解析出
  //    空动作列表、控制坞一直显示「暂无动作」。
  const diskPath = modelUrlToDiskPath(config.modelUrl as string)
  if (!diskPath) return []
  let counts: Map<string, number>
  try {
    const raw = await fs.readFile(diskPath, 'utf-8')
    const parsed = JSON.parse(raw) as {
      FileReferences?: { Motions?: Record<string, unknown[]> }
      animations?: { group?: unknown }[]
    }
    counts = config.rendererType === 'sprite'
      ? countSpriteGroups(parsed.animations)
      : countLive2dGroups(parsed.FileReferences?.Motions)
  } catch (err) {
    log.warn(`[resolveModelMotionActions] 读取模型文件失败 ${diskPath}: ${(err as Error).message}`)
    return []
  }

  const idleGroup = (config.idleMotionGroup as string) ?? 'Idle'
  const talkGroup = (config.talkMotionGroup as string) ?? 'Talk'
  const idleRandom = (config.idleMotionRandomGroups as string[] | undefined) ?? []
  const reserved = new Set<string>([idleGroup, talkGroup, ...idleRandom])

  const actions: ResolvedMotionAction[] = []
  let seq = 0
  for (const [group, count] of counts) {
    if (reserved.has(group)) continue
    for (let i = 0; i < count; i++) {
      seq += 1
      actions.push({ tag: String(seq), group, index: i })
    }
  }
  return actions
}

/** Live2D：组名 → 该组动作条数 */
function countLive2dGroups(motions: Record<string, unknown[]> | undefined): Map<string, number> {
  const out = new Map<string, number>()
  for (const [group, list] of Object.entries(motions ?? {})) {
    out.set(group, Array.isArray(list) ? list.length : 0)
  }
  return out
}

/**
 * sprite：组名 → 该组动画条数。
 *
 * 按**声明顺序**首次出现的先后排列组，这样自动编号的动作标签在模型之间是稳定的
 * （`Map` 保持插入顺序）。清单没通过校验时 `animations` 可能不是数组，按空处理。
 */
function countSpriteGroups(animations: unknown): Map<string, number> {
  const out = new Map<string, number>()
  if (!Array.isArray(animations)) return out
  for (const anim of animations) {
    const group = (anim as { group?: unknown })?.group
    if (typeof group !== 'string' || !group) continue
    out.set(group, (out.get(group) ?? 0) + 1)
  }
  return out
}
