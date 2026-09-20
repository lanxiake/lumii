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
import { createLogger } from './logger.js'

const log = createLogger('ProviderConfig')

/** provider 类型（决定默认 baseUrl 与 api 归一化） */
export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'ollama'
  | 'lmstudio'
  | 'rightapi'
  | 'deepseek'
  | 'openrouter'
  | 'groq'
  | 'xai'
  | 'zai'
  | 'dashscope'
  | 'moonshot'
  | 'minimax'
  | 'siliconflow'

/**
 * 思考参数格式（OpenAI 兼容端点各自不同，pi-ai 只自带 openai/zai 两种）：
 * - auto：按端点与模型推断（qwen 系模型走 chat_template_kwargs，z.ai 走 thinking）
 * - openai：reasoning_effort（pi-ai 原生）
 * - qwen：vLLM/SGLang 系，chat_template_kwargs.enable_thinking（服务端默认开思考，必须显式关）
 * - zai：thinking:{type}（pi-ai 原生）
 */
export type ThinkingFormat = 'auto' | 'openai' | 'qwen' | 'zai'

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
  /**
   * 按模型声明是否支持思考（reasoning）。缺省按内置默认表推断；
   * 端点不认思考参数时置 false 可彻底不发相关字段。
   */
  modelReasoning?: Record<string, boolean>
  /** 思考参数格式（见 ThinkingFormat），缺省 auto */
  thinkingFormat?: ThinkingFormat
}

/** 渲染进程可见的单槽配置（含 apiKey 明文，仅本机用户可见） */
export interface LocalProviderConfigView extends LocalProviderConfig {
  apiKey: string
  /**
   * 盘上有密文、但解不开。
   *
   * 与「用户没填」是两回事：这一位为真时，`apiKey` 必然为空串是**读失败**的结果，
   * 而不是用户的选择。设置页与报错文案据此区分，否则用户重填完仍看到
   * 「请先填写 API Key」，无从判断到底哪一步坏了。
   */
  apiKeyDecryptFailed?: boolean
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
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  xai: 'https://api.x.ai/v1',
  zai: 'https://open.bigmodel.cn/api/paas/v4',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  minimax: 'https://api.minimaxi.com/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
}

/**
 * 各 provider 类型的默认参数：API 格式与思考参数格式。
 * 切换 provider 类型时按此重置，避免沿用上一个端点的格式（例如从 DeepSeek 换到中转
 * 却仍是 responses）。
 */
export const PROVIDER_TYPE_DEFAULTS: Record<
  ProviderType,
  { apiFormat?: 'completions' | 'responses'; thinkingFormat: ThinkingFormat }
> = {
  openai: { apiFormat: 'completions', thinkingFormat: 'auto' },
  anthropic: { thinkingFormat: 'auto' },
  gemini: { thinkingFormat: 'auto' },
  ollama: { apiFormat: 'completions', thinkingFormat: 'auto' },
  lmstudio: { apiFormat: 'completions', thinkingFormat: 'auto' },
  rightapi: { thinkingFormat: 'auto' },
  deepseek: { apiFormat: 'responses', thinkingFormat: 'auto' },
  openrouter: { apiFormat: 'completions', thinkingFormat: 'auto' },
  groq: { apiFormat: 'completions', thinkingFormat: 'auto' },
  xai: { apiFormat: 'completions', thinkingFormat: 'auto' },
  // 智谱与 z.ai 同源，用 thinking:{type} 二元开关
  zai: { apiFormat: 'completions', thinkingFormat: 'zai' },
  // 百炼兼容模式/DashScope：qwen 系，用 chat_template_kwargs
  dashscope: { apiFormat: 'completions', thinkingFormat: 'qwen' },
  moonshot: { apiFormat: 'completions', thinkingFormat: 'auto' },
  minimax: { apiFormat: 'completions', thinkingFormat: 'auto' },
  siliconflow: { apiFormat: 'completions', thinkingFormat: 'auto' },
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
  modelReasoning: {},
  thinkingFormat: 'auto',
}

const DEFAULT_VISION: LocalProviderConfigView = {
  enabled: false,
  type: 'openai',
  baseUrl: PROVIDER_DEFAULT_BASE_URL.openai,
  modelId: '',
  apiKey: '',
  allowedModelIds: [],
  apiFormat: 'completions',
  modelReasoning: {},
  thinkingFormat: 'auto',
}

const DEFAULT_IMAGE: LocalProviderConfigView = {
  enabled: false,
  type: 'openai',
  baseUrl: PROVIDER_DEFAULT_BASE_URL.openai,
  modelId: '',
  apiKey: '',
  modelReasoning: {},
  thinkingFormat: 'auto',
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
 * 需要补 `/v1` 的类型：OpenAI 兼容且默认端点不带版本段。
 * 不带版本段的（OpenRouter/Groq/xAI 带 /v1，智谱带 /api/paas/v4，百炼带
 * /compatible-mode/v1）一律保持原样，补了反而 404。
 */
const V1_PATH_TYPES: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'openai',
  'ollama',
  'lmstudio',
  'deepseek',
  'moonshot',
  'minimax',
  'siliconflow',
])

/**
 * 规范化 OpenAI 兼容 Base URL：去尾斜杠，需要时补 /v1
 * anthropic / gemini 不强制追加 /v1
 * rightapi 保持原样（已含 /draw/v1）
 */
export function ensureProviderBaseUrl(baseUrl: string, type: ProviderType): string {
  const u = (baseUrl?.trim() || PROVIDER_DEFAULT_BASE_URL[type]).replace(/\/+$/, '')
  if (V1_PATH_TYPES.has(type) && !/\/v1$/i.test(u)) {
    return `${u}/v1`
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
 *
 * 失败必须与「没有密文」区分开（见 `LocalProviderConfigView.apiKeyDecryptFailed`）。
 * 曾经这里直接 `catch { return '' }`，于是密钥环变更后用户看到的是
 * 「请先在设置中填写文本对话模型的 API Key」——他重填、重存、重启，凭据依旧读不出来，
 * 而屏幕上没有任何线索指向真正的原因。
 *
 * @returns value 为解出的明文（失败或没填时为空串）；failed 为「有密文但解不开」
 */
function decryptApiKey(enc?: string): { value: string; failed: boolean } {
  if (!enc) return { value: '', failed: false }
  if (enc.startsWith('plain:')) return { value: enc.slice(6), failed: false }
  try {
    return { value: safeStorage.decryptString(Buffer.from(enc, 'base64')), failed: false }
  } catch (err) {
    // 常见成因：密钥环条目被重建/换名、provider.json 从别的机器或别的 Electron 版本搬来。
    // 不同平台写出的密文互不相认（Windows 走 DPAPI、Linux 走 libsecret，前缀可能都是 v10）。
    log.warn(
      `[decryptApiKey] 凭据解密失败，该槽的 API Key 将被视为未填写。` +
        `密钥环可能已变更，或 provider.json 来自其他系统。原因：${(err as Error).message}`,
    )
    return { value: '', failed: true }
  }
}

/**
 * 「没有可用 API Key」时给用户看的文案。
 *
 * 两种情况对用户的引导完全不同：没填 → 去填；填了解不开 → 重填也没用，
 * 得先清掉坏的那份（或换个密钥环环境）。故必须分开说。
 */
export function missingApiKeyMessage(cfg?: { apiKeyDecryptFailed?: boolean }): string {
  return cfg?.apiKeyDecryptFailed
    ? '已保存的 API Key 无法解密（密钥环可能已变更，或配置来自其他系统），请重新填写文本对话模型的 API Key'
    : '请先在设置中填写文本对话模型的 API Key'
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
  // 渲染进程回传的视图带明文 apiKey（用户刚编辑过）；盘上读出来的只有 apiKeyEnc。
  const apiKeyFromView =
    raw && 'apiKey' in raw && typeof (raw as LocalProviderConfigView).apiKey === 'string'
      ? (raw as LocalProviderConfigView).apiKey
      : null
  const decrypted = apiKeyFromView === null ? decryptApiKey((raw as PersistedSlot | undefined)?.apiKeyEnc) : null
  const apiKey = apiKeyFromView ?? decrypted?.value ?? ''
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
    apiKey,
    // 只在为真时才带上，避免视图里多一个恒为 false 的字段（该字段不进持久化）
    apiKeyDecryptFailed: decrypted?.failed || undefined,
    allowedModelIds,
    apiFormat: raw?.apiFormat ?? fallback.apiFormat,
    contextWindowK: normalizeContextWindowK(raw?.contextWindowK),
    modelReasoning: normalizeModelReasoning(raw?.modelReasoning),
    thinkingFormat: normalizeThinkingFormat(raw?.thinkingFormat) ?? fallback.thinkingFormat ?? 'auto',
  }
}

/** 规范化按模型的思考能力表：只保留布尔值与有效 key */
export function normalizeModelReasoning(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, boolean> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = id.trim()
    if (key && typeof value === 'boolean') out[key] = value
  }
  return out
}

/** 规范化思考参数格式；非法值返回 undefined（调用方决定回退） */
export function normalizeThinkingFormat(raw: unknown): ThinkingFormat | undefined {
  if (raw === 'auto' || raw === 'openai' || raw === 'qwen' || raw === 'zai') return raw
  return undefined
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
    modelReasoning: normalizeModelReasoning(view.modelReasoning),
    thinkingFormat: normalizeThinkingFormat(view.thinkingFormat) ?? 'auto',
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
 * 读盘上原有的槽（**原始密文**，不经 normalizeSlotView——这里要的是 `apiKeyEnc` 本身）。
 * 文件不存在或结构不对时返回空表，等价于「没有可保留的东西」。
 */
function readPersistedSlots(): PersistedSlotsFile['slots'] {
  try {
    const raw = JSON.parse(fs.readFileSync(configFilePath(), 'utf-8')) as
      | PersistedSlotsFile
      | LegacyPersistedShape
    if (isLegacyShape(raw)) return { chat: raw }
    return (raw as PersistedSlotsFile).slots ?? {}
  } catch {
    return {}
  }
}

/**
 * 保存时保住「有密文但当前环境解不开」的那一份。
 *
 * 为什么需要：解密失败时视图里的 `apiKey` 是空串，而设置页保存是**挑字段构造新对象**
 * （`apiKeyDecryptFailed` 不会回传，见 `ModelConfigSection`）。于是
 * 「打开设置 → 顺手改个模型 → 保存」就会把用户唯一的那份凭据**静默抹掉**；
 * 万一密钥环能恢复、或这份配置要搬回原机器，就再没有恢复的可能。
 *
 * 判据刻意**不依赖视图上的标记**（渲染层会丢），而是回看盘上那份能不能解开：
 * - 能解开 → 用户是主动清空，照清（原行为不变）；
 * - 解不开 → 它对当前环境是惰性的，留着比抹掉好。
 */
function preserveUnreadableKey(next: PersistedSlot, prev: PersistedSlot | undefined): PersistedSlot {
  if (next.apiKeyEnc || !prev?.apiKeyEnc) return next
  if (!decryptApiKey(prev.apiKeyEnc).failed) return next
  log.info('[saveProviderSlotsConfig] 保留原有 API Key 密文（当前环境解不开，不做静默覆盖）')
  return { ...next, apiKeyEnc: prev.apiKeyEnc }
}

/**
 * 保存全部能力槽配置
 */
export function saveProviderSlotsConfig(view: ProviderSlotsConfigView): void {
  const p = configFilePath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const prev = readPersistedSlots()
  const persisted: PersistedSlotsFile = {
    version: 1,
    slots: {
      chat: preserveUnreadableKey(toPersistedSlot(normalizeSlotView(view.chat, DEFAULT_CHAT)), prev.chat),
      vision: preserveUnreadableKey(toPersistedSlot(normalizeSlotView(view.vision, DEFAULT_VISION)), prev.vision),
      image: preserveUnreadableKey(toPersistedSlot(normalizeSlotView(view.image, DEFAULT_IMAGE)), prev.image),
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
 * rightapi 走独立的异步客户端（直接读槽配置，不经环境变量）。
 */
export function applyImageSlotToDrawEnv(): void {
  const image = loadSlotConfig('image')
  if (!image.enabled || !image.apiKey) return
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
