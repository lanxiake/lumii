/**
 * pet-model-resolver - 宠物模型资源解析（主进程）
 *
 * 设计依据：04-快速移植指南 §3.3（resolvePetModelPath）
 *
 * 职责：
 *  - 读取 resources/pet-models/registry.json
 *  - 把模型相对路径解析为渲染进程可加载的 file:// URL
 *  - 应用 PET_MODEL_DEFAULTS 补全缺失字段
 *
 * dev：resources 不经 Vite dev server，用 file:// 绝对路径加载（Electron 渲染进程支持）。
 * 打包：process.resourcesPath/pet-models。
 */

import { app } from 'electron'
import { join, isAbsolute } from 'node:path'
import { promises as fs } from 'fs'
import { pathToFileURL, fileURLToPath } from 'node:url'

const log = {
  info: (...args: unknown[]) => console.log('[pet-model-resolver]', ...args),
  warn: (...args: unknown[]) => console.warn('[pet-model-resolver]', ...args),
  error: (...args: unknown[]) => console.error('[pet-model-resolver]', ...args),
}

/** 与渲染层 pet-model-types.ts 保持一致的精简结构（主进程不 import 渲染层） */
interface RawModelConfig {
  id: string
  name: string
  rendererType?: string
  modelUrl: string
  scale?: number
  idleMotionGroup?: string
  idleMotionFallbackGroup?: string
  idleMotionRandomGroups?: string[]
  talkMotionGroup?: string
  emotionMap?: Record<string, number>
  tapMotions?: Record<string, Record<string, number>>
  defaultExpression?: number
  agentId?: string
  personaAddon?: string
  toolPrompts?: { expression?: boolean; thinkTag?: boolean }
  /** 作者精选的语义动作：tag → { 动作组, index, 描述 }（可选，覆盖自动编号） */
  actionMotions?: Record<string, { group: string; index?: number; description?: string }>
  thumbnailUrl?: string
}

interface RawRegistry {
  version: number
  models: RawModelConfig[]
  defaultModelId: string
}

const DEFAULTS = {
  scale: 0.4,
  idleMotionGroup: 'Idle',
  talkMotionGroup: 'Talk',
  defaultExpression: 0,
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

/** 解析 pet-models 资源根目录 */
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

/** 把模型相对路径转为渲染进程可加载的 URL */
function toLoadableUrl(modelUrl: string): string {
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

/** 规范化单个模型配置（补默认值 + 解析 URL）。纯函数，可单测。 */
export function normalizeModelConfig(raw: RawModelConfig): Record<string, unknown> {
  return {
    id: raw.id,
    name: raw.name,
    rendererType: raw.rendererType ?? 'live2d',
    modelUrl: toLoadableUrl(raw.modelUrl),
    scale: raw.scale ?? DEFAULTS.scale,
    idleMotionGroup: raw.idleMotionGroup ?? DEFAULTS.idleMotionGroup,
    idleMotionFallbackGroup: raw.idleMotionFallbackGroup,
    idleMotionRandomGroups: raw.idleMotionRandomGroups,
    talkMotionGroup: raw.talkMotionGroup ?? DEFAULTS.talkMotionGroup,
    emotionMap: raw.emotionMap ?? {},
    tapMotions: raw.tapMotions ?? {},
    defaultExpression: raw.defaultExpression ?? DEFAULTS.defaultExpression,
    agentId: raw.agentId || undefined,
    personaAddon: raw.personaAddon,
    toolPrompts: raw.toolPrompts,
    actionMotions: raw.actionMotions,
    thumbnailUrl: raw.thumbnailUrl ? toLoadableUrl(raw.thumbnailUrl) : undefined,
  }
}

/** 读取并解析注册表，返回规范化后的模型列表 + 默认 ID */
export async function loadPetModelRegistry(): Promise<{
  models: Record<string, unknown>[]
  defaultModelId: string
}> {
  const registryPath = join(resolvePetModelsDir(), 'registry.json')
  try {
    const raw = await fs.readFile(registryPath, 'utf-8')
    const parsed = JSON.parse(raw) as RawRegistry
    const models = (parsed.models ?? []).map(normalizeModelConfig)
    log.info(`[loadPetModelRegistry] 加载 ${models.length} 个模型，默认 ${parsed.defaultModelId}`)
    return { models, defaultModelId: parsed.defaultModelId }
  } catch (err) {
    log.warn(
      `[loadPetModelRegistry] 注册表读取失败 ${registryPath}: ${err instanceof Error ? err.message : err}`,
    )
    return { models: [], defaultModelId: '' }
  }
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
  if (rawModelUrl.startsWith('file://')) {
    try {
      return fileURLToPath(rawModelUrl)
    } catch {
      return null
    }
  }
  const baseDir = resolvePetModelsDir()
  // dev HTTP 模式 normalizeModelConfig 会输出 /pet-models/<rel>，还原为磁盘相对路径
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

  // 2. 从 model3.json 自动解析非待机组动作
  const diskPath = modelUrlToDiskPath(config.modelUrl as string)
  if (!diskPath) return []
  let motions: Record<string, unknown[]> = {}
  try {
    const raw = await fs.readFile(diskPath, 'utf-8')
    const parsed = JSON.parse(raw) as { FileReferences?: { Motions?: Record<string, unknown[]> } }
    motions = parsed.FileReferences?.Motions ?? {}
  } catch (err) {
    log.warn(`[resolveModelMotionActions] 读取 model3 失败 ${diskPath}: ${(err as Error).message}`)
    return []
  }

  const idleGroup = (config.idleMotionGroup as string) ?? 'Idle'
  const talkGroup = (config.talkMotionGroup as string) ?? 'Talk'
  const idleRandom = (config.idleMotionRandomGroups as string[] | undefined) ?? []
  const reserved = new Set<string>([idleGroup, talkGroup, ...idleRandom])

  const actions: ResolvedMotionAction[] = []
  let seq = 0
  for (const [group, list] of Object.entries(motions)) {
    if (reserved.has(group)) continue
    const count = Array.isArray(list) ? list.length : 0
    for (let i = 0; i < count; i++) {
      seq += 1
      actions.push({ tag: String(seq), group, index: i })
    }
  }
  return actions
}
