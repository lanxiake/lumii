/**
 * 本地 LLM Provider 配置（灵栖/Lumii 独立版）
 *
 * 按能力槽（chat / vision / image）独立配置 Provider，支持例如：
 * chat 用 DeepSeek、vision/image 用 OpenAI。凭据经 safeStorage 加密落盘。
 * 旧版单模型 provider.json 自动迁移到 chat 槽。
 */

import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { resolveWindowsClientDataRoot } from './client-data-root.js'

/** provider 类型（决定默认 baseUrl 与 api 归一化） */
export type ProviderType = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'lmstudio' | 'rightapi' | 'deepseek'

/** 模型能力槽（本阶段不含 ASR/TTS） */
export type CapabilitySlot = 'chat' | 'vision' | 'image'

/** 单槽本地 provider 配置（持久化结构，apiKey 存加密串） */
export interface LocalProviderConfig {
  /** 是否启用该槽 */
  enabled: boolean
  type: ProviderType
  /** OpenAI 兼容端点；本地 provider 有默认值 */
  baseUrl: string
  /** 模型 id（默认/当前选用） */
  modelId: string
  /**
   * 允许在对话中切换的模型 ID 列表（chat / vision）。
   * 缺省或空时视为 `[modelId]`，兼容旧配置。
   */
  allowedModelIds?: string[]
  /**
   * API 格式（仅 openai/deepseek 类型）：completions 或 responses。
   * 默认 responses（支持 prompt caching）。
   */
  apiFormat?: 'completions' | 'responses'
  /** 按模型覆盖上下文窗口，单位 K（持久化字段） */
  contextWindowK?: Record<string, number>
}

/** 渲染进程可见的单槽配置（含 apiKey 明文，仅本机用户可见） */
export interface LocalProviderConfigView extends LocalProviderConfig {
  apiKey: string
}

/** 全部能力槽配置视图 */
export interface ProviderSlotsConfigView {
  chat: LocalProviderConfigView
  vision: LocalProviderConfigView
  image: LocalProviderConfigView
}

/** 各 provider 默认端点（展示用不含强制 /v1；openai 兼容会在使用时自动补全） */
export const PROVIDER_DEFAULT_BASE_URL: Record<ProviderType, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
  rightapi: 'https://www.rightapi.ai/draw/v1',
  deepseek: 'https://api.deepseek.com',
}

/** 能力槽展示名 */
export const CAPABILITY_SLOT_LABEL: Record<CapabilitySlot, string> = {
  chat: '文本对话',
  vision: '视觉理解',
  image: '图片生成',
}

/** 能力槽说明 */
export const CAPABILITY_SLOT_DESC: Record<CapabilitySlot, string> = {
  chat: 'Agent 主对话与文本生成（如 DeepSeek、GPT、Claude）。启用后才会真正调用该模型。',
  vision: '看图、OCR、多模态理解。启用后图片识别走此配置；未启用则跳过视觉能力。',
  image: '文生图。启用后才会调用生图接口；未启用则无法生成图片。',
}

const SLOT_KEYS: CapabilitySlot[] = ['chat', 'vision', 'image']

const DEFAULT_CHAT: LocalProviderConfigView = {
  enabled: false,
  type: 'openai',
  baseUrl: PROVIDER_DEFAULT_BASE_URL.openai,
  modelId: '',
  apiKey: '',
  allowedModelIds: [],
  apiFormat: 'completions', // 通用中转通常不支持 responses
}

const DEFAULT_VISION: LocalProviderConfigView = {
  enabled: false,
  type: 'openai',
  baseUrl: PROVIDER_DEFAULT_BASE_URL.openai,
  modelId: '',
  apiKey: '',
  allowedModelIds: [],
  apiFormat: 'completions',
}

const DEFAULT_IMAGE: LocalProviderConfigView = {
  enabled: false,
  type: 'openai',
  baseUrl: PROVIDER_DEFAULT_BASE_URL.openai,
  modelId: '',
  apiKey: '',
}

/** 各槽默认配置 */
export const DEFAULT_SLOT_CONFIG: ProviderSlotsConfigView = {
  chat: { ...DEFAULT_CHAT },
  vision: { ...DEFAULT_VISION },
  image: { ...DEFAULT_IMAGE },
}

interface PersistedSlot extends LocalProviderConfig {
  apiKeyEnc?: string
}

interface PersistedSlotsFile {
  version: 1
  slots: {
    chat?: PersistedSlot
    vision?: PersistedSlot
    image?: PersistedSlot
  }
}

/** 旧版单模型持久化结构 */
interface LegacyPersistedShape extends LocalProviderConfig {
  apiKeyEnc?: string
  version?: undefined
  slots?: undefined
}

/**
 * 规范化 OpenAI 兼容 Base URL：去尾斜杠，缺 /v1 时自动补全
 * anthropic / gemini 不强制追加 /v1
 * rightapi 保持原样（已含 /draw/v1）
 */
export function ensureProviderBaseUrl(baseUrl: string, type: ProviderType): string {
  let u = (baseUrl?.trim() || PROVIDER_DEFAULT_BASE_URL[type]).replace(/\/+$/, '')
  const needsV1 = type === 'openai' || type === 'ollama' || type === 'lmstudio' || type === 'deepseek'
  if (needsV1 && !/\/v1$/i.test(u)) {
    u = `${u}/v1`
  }
  return u
}

/**
 * 解析 provider 配置文件路径
 */
function configFilePath(): string {
  return path.join(resolveWindowsClientDataRoot(), 'config', 'provider.json')
}

/**
 * 加密 API Key（safeStorage 不可用时用 plain: 前缀明文）
 */
function encryptApiKey(apiKey: string): string {
  if (!apiKey) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(apiKey).toString('base64')
  }
  return `plain:${apiKey}`
}

/**
 * 解密 API Key
 */
function decryptApiKey(enc?: string): string {
  if (!enc) return ''
  if (enc.startsWith('plain:')) return enc.slice(6)
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return ''
  }
}

/**
 * 规范化允许模型列表：去重、去空；若为空则回退到 modelId。
 */
export function normalizeAllowedModelIds(
  allowed: string[] | undefined,
  modelId: string,
): string[] {
  const ids = (allowed ?? [])
    .map((id) => (typeof id === 'string' ? id.trim() : ''))
    .filter(Boolean)
  const unique = [...new Set(ids)]
  const fallback = modelId.trim()
  if (unique.length === 0) {
    return fallback ? [fallback] : []
  }
  return unique
}

/**
 * 规范化单槽视图（补默认值、修剪空白、对齐 allowedModelIds 与 modelId）
 */
function normalizeSlotView(
  raw: Partial<LocalProviderConfigView> | PersistedSlot | undefined,
  fallback: LocalProviderConfigView,
): LocalProviderConfigView {
  const type = (raw?.type ?? fallback.type) as ProviderType
  const apiKey =
    raw && 'apiKey' in raw && typeof (raw as LocalProviderConfigView).apiKey === 'string'
      ? (raw as LocalProviderConfigView).apiKey
      : decryptApiKey((raw as PersistedSlot | undefined)?.apiKeyEnc)
  const modelId = raw?.modelId?.trim() || fallback.modelId
  const rawAllowed =
    raw && Array.isArray((raw as LocalProviderConfigView).allowedModelIds)
      ? (raw as LocalProviderConfigView).allowedModelIds
      : undefined
  let allowedModelIds = normalizeAllowedModelIds(rawAllowed, modelId)
  // modelId 必须落在 allowlist；否则取第一项
  let nextModelId = modelId
  if (allowedModelIds.length > 0 && nextModelId && !allowedModelIds.includes(nextModelId)) {
    nextModelId = allowedModelIds[0]!
  } else if (allowedModelIds.length > 0 && !nextModelId) {
    nextModelId = allowedModelIds[0]!
  } else if (nextModelId && allowedModelIds.length === 0) {
    allowedModelIds = [nextModelId]
  }
  return {
    enabled: raw?.enabled === true,
    type,
    baseUrl: (raw?.baseUrl?.trim() || PROVIDER_DEFAULT_BASE_URL[type] || fallback.baseUrl).replace(/\/+$/, ''),
    modelId: nextModelId,
    apiKey: apiKey ?? '',
    allowedModelIds,
    apiFormat: raw?.apiFormat ?? fallback.apiFormat,
    contextWindowK: normalizeContextWindowK(raw?.contextWindowK),
  }
}

function normalizeContextWindowK(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const k = Number(value)
    if (id.trim() && Number.isFinite(k) && k > 0) out[id.trim()] = Math.round(k * 100) / 100
  }
  return out
}

/**
 * 将单槽视图转为持久化结构
 */
function toPersistedSlot(view: LocalProviderConfigView): PersistedSlot {
  const type = view.type
  const modelId = view.modelId?.trim() || ''
  const allowedModelIds = normalizeAllowedModelIds(view.allowedModelIds, modelId)
  return {
    enabled: view.enabled === true,
    type,
    // 落盘保留用户填写的地址（可不含 /v1）；调用时再 ensureProviderBaseUrl
    baseUrl: (view.baseUrl?.trim() || PROVIDER_DEFAULT_BASE_URL[type]).replace(/\/+$/, ''),
    modelId,
    allowedModelIds,
    apiFormat: view.apiFormat,
    contextWindowK: normalizeContextWindowK(view.contextWindowK),
    apiKeyEnc: encryptApiKey(view.apiKey ?? ''),
  }
}

/**
 * 判断原始 JSON 是否为旧版单模型结构
 */
function isLegacyShape(raw: unknown): raw is LegacyPersistedShape {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  return o.slots === undefined && (typeof o.modelId === 'string' || typeof o.type === 'string')
}

/**
 * 读取全部能力槽配置（含旧配置自动迁移到 chat）
 */
export function loadProviderSlotsConfig(): ProviderSlotsConfigView {
  const p = configFilePath()
  try {
    if (!fs.existsSync(p)) {
      return {
        chat: { ...DEFAULT_CHAT },
        vision: { ...DEFAULT_VISION },
        image: { ...DEFAULT_IMAGE },
      }
    }
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as PersistedSlotsFile | LegacyPersistedShape

    if (isLegacyShape(raw)) {
      const chat = normalizeSlotView(raw, DEFAULT_CHAT)
      return {
        chat,
        vision: { ...DEFAULT_VISION },
        image: { ...DEFAULT_IMAGE },
      }
    }

    const file = raw as PersistedSlotsFile
    return {
      chat: normalizeSlotView(file.slots?.chat, DEFAULT_CHAT),
      vision: normalizeSlotView(file.slots?.vision, DEFAULT_VISION),
      image: normalizeSlotView(file.slots?.image, DEFAULT_IMAGE),
    }
  } catch {
    return {
      chat: { ...DEFAULT_CHAT },
      vision: { ...DEFAULT_VISION },
      image: { ...DEFAULT_IMAGE },
    }
  }
}

/**
 * 读取 chat 槽配置（兼容旧调用方 / Agent Runtime）
 */
export function loadProviderConfig(): LocalProviderConfigView {
  return loadProviderSlotsConfig().chat
}

/**
 * 读取指定能力槽配置
 */
export function loadSlotConfig(slot: CapabilitySlot): LocalProviderConfigView {
  return loadProviderSlotsConfig()[slot]
}

/**
 * 保存全部能力槽配置
 */
export function saveProviderSlotsConfig(view: ProviderSlotsConfigView): void {
  const p = configFilePath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const persisted: PersistedSlotsFile = {
    version: 1,
    slots: {
      chat: toPersistedSlot(normalizeSlotView(view.chat, DEFAULT_CHAT)),
      vision: toPersistedSlot(normalizeSlotView(view.vision, DEFAULT_VISION)),
      image: toPersistedSlot(normalizeSlotView(view.image, DEFAULT_IMAGE)),
    },
  }
  fs.writeFileSync(p, JSON.stringify(persisted, null, 2), 'utf-8')
}

/**
 * 保存 chat 槽（兼容旧调用）；保留其他槽不变
 */
export function saveProviderConfig(view: LocalProviderConfigView): void {
  const slots = loadProviderSlotsConfig()
  slots.chat = normalizeSlotView(view, DEFAULT_CHAT)
  saveProviderSlotsConfig(slots)
}

/**
 * 将 image 槽同步到生图环境变量（供 right-codes-draw-client 读取）
 *
 * rightapi 走独立的异步客户端（直接读槽配置，不经环境变量），
 * 这里只设置 DIRECT_ONLY 以关掉 Gateway 路径。
 */
export function applyImageSlotToDrawEnv(): void {
  const image = loadSlotConfig('image')
  if (!image.enabled || !image.apiKey) return
  process.env.MTBOT_IMAGE_DIRECT_ONLY = 'true'
  if (image.type === 'rightapi') return
  const base = ensureProviderBaseUrl(
    image.baseUrl?.trim() || PROVIDER_DEFAULT_BASE_URL[image.type],
    image.type,
  )
  process.env.MTBOT_IMAGE_UPSTREAM_BASE_URL = base
  process.env.MTBOT_IMAGE_UPSTREAM_API_KEY = image.apiKey
}

/**
 * 校验槽名是否合法
 */
export function isCapabilitySlot(value: string): value is CapabilitySlot {
  return (SLOT_KEYS as string[]).includes(value)
}

export { SLOT_KEYS }
