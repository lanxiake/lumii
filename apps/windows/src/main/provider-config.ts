/**
 * 本地 LLM Provider 配置（灵栖/Lumii 独立版）
 *
 * 磁盘结构为 v2：全局 `providers[]` 列表 + 三个能力槽（chat / vision / image）
 * 各自引用某个 provider 的某个模型。同一家的 Key 只填一次，三个槽共用。
 *
 * 对外仍暴露「已解析的单槽平铺视图」（LocalProviderConfigView）——
 * 运行时（bridge / image-services / model-catalog）全部走 loadSlotConfig()，
 * 因此多 Provider 改造不影响它们。
 *
 * 旧版结构（v1 能力槽内嵌凭据、或更早的单模型）读时自动迁移为 v2。
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

/** API 格式字面量 */
export type ApiFormat = 'completions' | 'responses'

/**
 * 单槽的**已解析**配置（provider 字段 + 槽内选择合并后的平铺视图）。
 * 运行时按这个形状消费，多 Provider 改造不改变它的语义。
 */
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
   * API 格式（仅 openai/deepseek 等兼容类型）：completions 或 responses。
   * 缺省时跟 PROVIDER_TYPE_DEFAULTS（openai 系多为 completions；官方 DeepSeek 为 responses）。
   */
  apiFormat?: ApiFormat
  /**
   * 按模型覆盖 API 格式（同一中转站上不同模型可能只认一种端点）。
   * 对话页切模型时优先于槽级 apiFormat。
   */
  apiFormatByModel?: Record<string, ApiFormat>
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

/** 全部能力槽配置视图（已解析的平铺形状） */
export interface ProviderSlotsConfigView {
  chat: LocalProviderConfigView
  vision: LocalProviderConfigView
  image: LocalProviderConfigView
}

/** 用户配置的一个模型提供商（一份凭据 + 端点） */
export interface ProviderEntryView {
  id: string
  /** 展示名；留空时界面回退到类型名 */
  name: string
  type: ProviderType
  baseUrl: string
  apiKey: string
  apiKeyDecryptFailed?: boolean
  /** 该提供商下可用的模型 id 列表 */
  modelIds: string[]
  apiFormat?: ApiFormat
  apiFormatByModel?: Record<string, ApiFormat>
  thinkingFormat?: ThinkingFormat
}

/** 能力槽对某个 provider 与模型的选择 */
export interface SlotSelectionView {
  enabled: boolean
  /** 引用的 provider id；空串表示该槽尚未选择提供商 */
  providerId: string
  modelId: string
  /** 按模型覆盖上下文窗口，单位 K */
  contextWindowK?: Record<string, number>
  /** 按模型声明是否支持思考 */
  modelReasoning?: Record<string, boolean>
}

/** 渲染进程可见的完整配置（明文 Key 仅本机用户可见） */
export interface ProviderStoreView {
  providers: ProviderEntryView[]
  slots: {
    chat: SlotSelectionView
    vision: SlotSelectionView
    image: SlotSelectionView
  }
}

/** 各 provider 默认端点（展示用不含强制 /v1；openai 兼容会在使用时自动补全） */
export const PROVIDER_DEFAULT_BASE_URL: Record<ProviderType, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
  rightapi: 'https://api.site/draw/v1',
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
  { apiFormat?: ApiFormat; thinkingFormat: ThinkingFormat }
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

function defaultSlotView(): LocalProviderConfigView {
  return {
    enabled: false,
    type: 'openai',
    baseUrl: PROVIDER_DEFAULT_BASE_URL.openai,
    modelId: '',
    apiKey: '',
    allowedModelIds: [],
    apiFormat: 'completions', // 通用中转通常不支持 responses
    apiFormatByModel: {},
    modelReasoning: {},
    thinkingFormat: 'auto',
  }
}

/** 各槽默认配置 */
export const DEFAULT_SLOT_CONFIG: ProviderSlotsConfigView = {
  chat: defaultSlotView(),
  vision: defaultSlotView(),
  image: defaultSlotView(),
}

/** 持久化的 provider 条目（apiKey 存加密串） */
interface PersistedProvider {
  id: string
  name?: string
  type: ProviderType
  baseUrl: string
  apiKeyEnc?: string
  modelIds?: string[]
  apiFormat?: ApiFormat
  apiFormatByModel?: Record<string, ApiFormat>
  thinkingFormat?: ThinkingFormat
}

interface PersistedSlotV2 {
  enabled?: boolean
  providerId?: string
  modelId?: string
  contextWindowK?: Record<string, number>
  modelReasoning?: Record<string, boolean>
}

interface PersistedFileV2 {
  version: 2
  providers: PersistedProvider[]
  slots: {
    chat?: PersistedSlotV2
    vision?: PersistedSlotV2
    image?: PersistedSlotV2
  }
}

/** v1：能力槽内嵌完整凭据 */
interface PersistedSlotV1 extends LocalProviderConfig {
  apiKeyEnc?: string
}
interface PersistedFileV1 {
  version: 1
  slots: {
    chat?: PersistedSlotV1
    vision?: PersistedSlotV1
    image?: PersistedSlotV1
  }
}

/** 更早的单模型结构 */
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

function isProviderTypeValue(value: unknown): value is ProviderType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_DEFAULT_BASE_URL, value)
}

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

/** 解析 provider 配置文件路径 */
function configFilePath(): string {
  return path.join(resolveWindowsClientDataRoot(), 'config', 'provider.json')
}

/** 加密 API Key（safeStorage 不可用时用 plain: 前缀明文） */
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
 * @param owner 仅用于日志：哪份配置的凭据解不开（多个 provider 各自的密文独立，不写出来无法定位）
 * @returns value 为解出的明文（失败或没填时为空串）；failed 为「有密文但解不开」
 */
function decryptApiKey(enc?: string, owner?: string): { value: string; failed: boolean } {
  if (!enc) return { value: '', failed: false }
  if (enc.startsWith('plain:')) return { value: enc.slice(6), failed: false }
  try {
    return { value: safeStorage.decryptString(Buffer.from(enc, 'base64')), failed: false }
  } catch (err) {
    // 常见成因：密钥环条目被重建/换名、provider.json 从别的机器或别的 Electron 版本搬来。
    // 不同平台写出的密文互不相认（Windows 走 DPAPI、Linux 走 libsecret，前缀可能都是 v10）。
    log.warn(
      `[decryptApiKey] ${owner ?? '?'} 的凭据解密失败，其 API Key 将被视为未填写。` +
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

/** 规范化模型 id 列表：去重、去空 */
export function normalizeModelIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const ids = raw.map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean)
  return [...new Set(ids)]
}

/**
 * 规范化允许模型列表：去重、去空；若为空则回退到 modelId。
 */
export function normalizeAllowedModelIds(
  allowed: string[] | undefined,
  modelId: string,
): string[] {
  const unique = normalizeModelIds(allowed)
  const fallback = modelId.trim()
  if (unique.length === 0) {
    return fallback ? [fallback] : []
  }
  return unique
}

/**
 * 让 modelId 与 allowlist 自洽。
 *
 * 维持的不变量是「modelId 必须落在 allowlist 内」，但**用并集维持，而不是把 modelId 打回 allowlist[0]**。
 * 原来的「静默回退」会让一个明确的用户意图无声消失——生图模型改不动就是这么来的：
 * 设置页当时只给了 image 槽改 `modelId` 的入口，视图里的 allowlist 还是旧值，
 * 一保存就被改回旧模型，界面上看起来像「点了没反应」。
 */
export function reconcileModelIdWithAllowlist(
  modelId: string,
  allowedModelIds: string[],
): { modelId: string; allowedModelIds: string[] } {
  if (modelId && !allowedModelIds.includes(modelId)) {
    return { modelId, allowedModelIds: [...allowedModelIds, modelId] }
  }
  if (!modelId && allowedModelIds.length > 0) {
    return { modelId: allowedModelIds[0]!, allowedModelIds }
  }
  return { modelId, allowedModelIds }
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

/** 规范化单值 API 格式；非法返回 undefined */
export function normalizeApiFormat(raw: unknown): ApiFormat | undefined {
  if (raw === 'completions' || raw === 'responses') return raw
  return undefined
}

/** 规范化按模型的 API 格式表：只保留合法枚举与有效 key */
export function normalizeApiFormatByModel(raw: unknown): Record<string, ApiFormat> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, ApiFormat> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = id.trim()
    const fmt = normalizeApiFormat(value)
    if (key && fmt) out[key] = fmt
  }
  return out
}

/**
 * 去掉 provider 前缀后的短模型 id（deepseek/deepseek-v4-flash → deepseek-v4-flash）
 */
function shortModelId(modelId: string): string {
  const t = modelId.trim()
  const slash = t.lastIndexOf('/')
  return slash >= 0 ? t.slice(slash + 1) : t
}

/**
 * 解析实际调用应使用的 API 格式。
 *
 * 优先级：按模型覆盖 → 槽级 apiFormat → PROVIDER_TYPE_DEFAULTS → completions（中转最稳）。
 */
export function resolveApiFormat(
  cfg: Pick<LocalProviderConfig, 'type' | 'apiFormat' | 'apiFormatByModel'>,
  modelId?: string,
): ApiFormat {
  const mid = modelId?.trim()
  if (mid) {
    const byModel = cfg.apiFormatByModel ?? {}
    const hit = byModel[mid] ?? byModel[shortModelId(mid)]
    const fromModel = normalizeApiFormat(hit)
    if (fromModel) return fromModel
  }
  const fromSlot = normalizeApiFormat(cfg.apiFormat)
  if (fromSlot) return fromSlot
  return PROVIDER_TYPE_DEFAULTS[cfg.type]?.apiFormat ?? 'completions'
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

// ── v2 store: 规范化 ──

/**
 * 规范化一条 provider（视图或持久化结构皆可）。
 *
 * 视图带明文 `apiKey`；持久化结构只有 `apiKeyEnc`。
 * 只有视图给了明文才加密改写密文——否则原样保留，
 * 否则「解不开的密文」会在读盘时被重新加密成空串而丢失。
 */
function normalizeProvider(
  raw: Partial<ProviderEntryView> & { apiKeyEnc?: string },
  fallbackId: string,
): PersistedProvider {
  const type = isProviderTypeValue(raw.type) ? raw.type : 'openai'
  const id = (raw.id ?? '').trim() || fallbackId
  return {
    id,
    name: (raw.name ?? '').trim(),
    type,
    // 落盘保留用户填写的地址（可不含 /v1）；调用时再 ensureProviderBaseUrl
    baseUrl: (raw.baseUrl?.trim() || PROVIDER_DEFAULT_BASE_URL[type]).replace(/\/+$/, ''),
    modelIds: normalizeModelIds(raw.modelIds),
    apiFormat: normalizeApiFormat(raw.apiFormat) ?? PROVIDER_TYPE_DEFAULTS[type]?.apiFormat,
    apiFormatByModel: normalizeApiFormatByModel(raw.apiFormatByModel),
    thinkingFormat: normalizeThinkingFormat(raw.thinkingFormat) ?? PROVIDER_TYPE_DEFAULTS[type]?.thinkingFormat ?? 'auto',
    apiKeyEnc: typeof raw.apiKey === 'string' ? encryptApiKey(raw.apiKey) : (raw.apiKeyEnc ?? ''),
  }
}

/** 视图化的 provider（解密出明文 Key） */
function toProviderView(p: PersistedProvider): ProviderEntryView {
  const { value, failed } = decryptApiKey(p.apiKeyEnc, p.name || p.id)
  return {
    id: p.id,
    name: p.name ?? '',
    type: p.type,
    baseUrl: p.baseUrl,
    modelIds: normalizeModelIds(p.modelIds),
    apiFormat: normalizeApiFormat(p.apiFormat),
    apiFormatByModel: normalizeApiFormatByModel(p.apiFormatByModel),
    thinkingFormat: normalizeThinkingFormat(p.thinkingFormat) ?? 'auto',
    apiKey: value,
    // 只在为真时才带上，避免视图里多一个恒为 false 的字段（该字段不进持久化）
    apiKeyDecryptFailed: failed || undefined,
  }
}

/** 规范化槽选择：providerId 必须存在于 providers 中，否则置空 */
function normalizeSlotSelection(
  raw: PersistedSlotV2 | SlotSelectionView | undefined,
  providers: PersistedProvider[],
): SlotSelectionView {
  const providerId = (raw?.providerId ?? '').trim()
  const valid = providers.some((p) => p.id === providerId)
  return {
    enabled: raw?.enabled === true,
    providerId: valid ? providerId : '',
    modelId: (raw?.modelId ?? '').trim(),
    contextWindowK: normalizeContextWindowK(raw?.contextWindowK),
    modelReasoning: normalizeModelReasoning(raw?.modelReasoning),
  }
}

/** 生成一个未被占用的 provider id */
function nextProviderId(used: Set<string>): string {
  let n = used.size + 1
  while (used.has(`p${n}`)) n += 1
  return `p${n}`
}

// ── 读盘：v2 / v1 / legacy ──

function readRawFile(): unknown {
  const p = configFilePath()
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return null
  }
}

/** 判断原始 JSON 是否为最早的单模型结构 */
function isLegacyShape(raw: unknown): raw is LegacyPersistedShape {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  return o.slots === undefined && (typeof o.modelId === 'string' || typeof o.type === 'string')
}

function isV2Shape(raw: unknown): raw is PersistedFileV2 {
  if (!raw || typeof raw !== 'object') return false
  return Array.isArray((raw as Record<string, unknown>).providers)
}

/**
 * 把 v1 的三槽（各自内嵌凭据）迁移成 v2。
 *
 * 按「类型 + 端点 + Key」去重：chat 与 vision 填的是同一家同一把 Key 时合并成一个
 * provider，模型列表取并集——这正是多 Provider 想要的效果，而不是迁移完给用户留三份重复条目。
 *
 * 去重键**必须用解密后的明文**：safeStorage（DPAPI）对相同明文每次加密出的密文都不同，
 * 拿密文比较永远不相等，同一把 Key 会被拆成多条重复条目（实测踩到）。
 * 解不开时退化为用密文比较——那种情况下无从判断是否同一把，宁可分开也不误合并。
 */
function migrateV1(raw: PersistedFileV1 | LegacyPersistedShape): PersistedFileV2 {
  const slots = isLegacyShape(raw) ? { chat: raw as PersistedSlotV1 } : (raw.slots ?? {})
  const providers: PersistedProvider[] = []
  const byKey = new Map<string, PersistedProvider>()
  const used = new Set<string>()
  const outSlots: PersistedFileV2['slots'] = {}

  for (const slot of SLOT_KEYS) {
    const src = slots[slot]
    if (!src) continue
    const type = isProviderTypeValue(src.type) ? src.type : 'openai'
    const baseUrl = (src.baseUrl?.trim() || PROVIDER_DEFAULT_BASE_URL[type]).replace(/\/+$/, '')
    const decrypted = decryptApiKey(src.apiKeyEnc, `v1 迁移 · ${slot}`)
    const keyMaterial = decrypted.failed
      ? `cipher:${src.apiKeyEnc ?? ''}`
      : `plain:${decrypted.value}`
    const key = `${type}|${baseUrl}|${keyMaterial}`
    let provider = byKey.get(key)
    if (!provider) {
      const id = nextProviderId(used)
      used.add(id)
      provider = {
        id,
        name: CAPABILITY_SLOT_LABEL[slot],
        type,
        baseUrl,
        apiKeyEnc: src.apiKeyEnc ?? '',
        modelIds: normalizeAllowedModelIds(src.allowedModelIds, src.modelId?.trim() ?? ''),
        apiFormat: normalizeApiFormat(src.apiFormat) ?? PROVIDER_TYPE_DEFAULTS[type]?.apiFormat,
        apiFormatByModel: normalizeApiFormatByModel(src.apiFormatByModel),
        thinkingFormat:
          normalizeThinkingFormat(src.thinkingFormat) ?? PROVIDER_TYPE_DEFAULTS[type]?.thinkingFormat ?? 'auto',
      }
      providers.push(provider)
      byKey.set(key, provider)
    } else {
      // 同一份凭据被多个槽使用：模型列表取并集
      provider.modelIds = [
        ...new Set([
          ...(provider.modelIds ?? []),
          ...normalizeAllowedModelIds(src.allowedModelIds, src.modelId?.trim() ?? ''),
        ]),
      ]
    }
    outSlots[slot] = {
      enabled: src.enabled === true,
      providerId: provider.id,
      modelId: src.modelId?.trim() ?? '',
      contextWindowK: normalizeContextWindowK(src.contextWindowK),
      modelReasoning: normalizeModelReasoning(src.modelReasoning),
    }
  }

  return { version: 2, providers, slots: outSlots }
}

/**
 * 读取并规范化为 v2 持久化结构（不做解密，保留原始密文）
 */
function readStore(): PersistedFileV2 {
  const raw = readRawFile()
  if (!raw) return { version: 2, providers: [], slots: {} }
  if (isV2Shape(raw)) {
    const used = new Set<string>()
    const providers = (raw.providers ?? []).map((p, i) => {
      const id = (p?.id ?? '').trim() || nextProviderId(used)
      used.add(id)
      return normalizeProvider(p ?? {}, id)
    })
    return {
      version: 2,
      providers,
      slots: {
        chat: normalizeSlotSelection(raw.slots?.chat, providers),
        vision: normalizeSlotSelection(raw.slots?.vision, providers),
        image: normalizeSlotSelection(raw.slots?.image, providers),
      },
    }
  }
  // v1 或更早：迁移（只补字段，不给空密文重新加密）
  const migrated = migrateV1(raw as PersistedFileV1 | LegacyPersistedShape)
  return {
    version: 2,
    providers: migrated.providers.map((p) => normalizeProvider(p, p.id)),
    slots: {
      chat: normalizeSlotSelection(migrated.slots.chat, migrated.providers),
      vision: normalizeSlotSelection(migrated.slots.vision, migrated.providers),
      image: normalizeSlotSelection(migrated.slots.image, migrated.providers),
    },
  }
}

/** 把 provider + 槽选择解析为运行时可消费的平铺视图 */
function resolveSlotView(
  store: PersistedFileV2,
  slot: CapabilitySlot,
  providerIdOverride?: string,
): LocalProviderConfigView {
  const sel = store.slots[slot]
  const wanted = providerIdOverride || sel?.providerId
  const provider = wanted ? store.providers.find((p) => p.id === wanted) : undefined
  if (!provider) return { ...defaultSlotView(), enabled: false }

  const view = toProviderView(provider)
  const allowed = normalizeAllowedModelIds(view.modelIds, sel?.modelId ?? '')
  const reconciled = reconcileModelIdWithAllowlist(sel?.modelId ?? '', allowed)
  return {
    enabled: sel?.enabled === true,
    type: view.type,
    baseUrl: view.baseUrl,
    modelId: reconciled.modelId,
    apiKey: view.apiKey,
    apiKeyDecryptFailed: view.apiKeyDecryptFailed,
    allowedModelIds: reconciled.allowedModelIds,
    apiFormat: view.apiFormat,
    apiFormatByModel: view.apiFormatByModel,
    contextWindowK: normalizeContextWindowK(sel?.contextWindowK),
    modelReasoning: normalizeModelReasoning(sel?.modelReasoning),
    thinkingFormat: view.thinkingFormat,
  }
}

/**
 * 拆分 `providerId::modelId` 形式的模型引用。
 *
 * 用 `::` 而不是 `/`：OpenRouter 等中转的真实模型 id 本来就含 `/`（anthropic/claude-…），
 * 用斜杠当分隔符会把模型名切坏。
 */
export function parseModelRef(ref: string): { providerId?: string; modelId: string } {
  const t = ref?.trim() ?? ''
  const i = t.indexOf('::')
  if (i > 0) return { providerId: t.slice(0, i), modelId: t.slice(i + 2) }
  return { modelId: t }
}

/** 拼出指向特定 provider 的模型引用 */
export function formatModelRef(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}

/**
 * 按模型引用解析槽配置。
 *
 * 引用可带 `providerId::` 前缀（对话页跨 Provider 切模型时用）；
 * 不带前缀就用该槽自己选中的 provider。
 */
export function loadSlotConfigForModel(slot: CapabilitySlot, ref?: string): LocalProviderConfigView {
  const store = readStore()
  const { providerId } = parseModelRef(ref ?? '')
  return resolveSlotView(store, slot, providerId)
}

/**
 * chat 槽默认模型的引用（带 `providerId::` 前缀）。
 * 渠道/定时任务这类「没 prime 过」的会话回退到它时，才能用对 Provider。
 */
export function chatDefaultModelRef(): string | undefined {
  const store = readStore()
  const sel = store.slots.chat
  if (!sel?.providerId || !sel.modelId?.trim()) return undefined
  return formatModelRef(sel.providerId, sel.modelId)
}

/**
 * chat 槽可选的全部模型引用（所有 provider × 模型）。
 * 会话级模型偏好校验用它——一个会话可以停在非默认 provider 上。
 */
export function listChatModelRefs(): string[] {
  const store = readStore()
  const refs: string[] = []
  for (const p of store.providers) {
    for (const m of normalizeModelIds(p.modelIds)) refs.push(formatModelRef(p.id, m))
  }
  const sel = store.slots.chat
  if (sel?.providerId && sel.modelId) refs.push(formatModelRef(sel.providerId, sel.modelId))
  return [...new Set(refs)]
}

// ── 对外读接口 ──

/** 读取完整配置（多 Provider 列表 + 槽选择），含明文 Key */
export function loadProviderStore(): ProviderStoreView {
  const store = readStore()
  return {
    providers: store.providers.map(toProviderView),
    slots: {
      chat: normalizeSlotSelection(store.slots.chat, store.providers),
      vision: normalizeSlotSelection(store.slots.vision, store.providers),
      image: normalizeSlotSelection(store.slots.image, store.providers),
    },
  }
}

/** 读取全部能力槽配置（已解析为平铺视图） */
export function loadProviderSlotsConfig(): ProviderSlotsConfigView {
  const store = readStore()
  return {
    chat: resolveSlotView(store, 'chat'),
    vision: resolveSlotView(store, 'vision'),
    image: resolveSlotView(store, 'image'),
  }
}

/** 读取 chat 槽配置（兼容旧调用方 / Agent Runtime） */
export function loadProviderConfig(): LocalProviderConfigView {
  return loadProviderSlotsConfig().chat
}

/** 读取指定能力槽配置 */
export function loadSlotConfig(slot: CapabilitySlot): LocalProviderConfigView {
  return loadProviderSlotsConfig()[slot]
}

// ── 写盘 ──

function writeStore(store: PersistedFileV2): void {
  const p = configFilePath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf-8')
}

/**
 * 保存时保住「有密文但当前环境解不开」的那一份。
 *
 * 为什么需要：解密失败时视图里的 `apiKey` 是空串，而设置页保存是**挑字段构造新对象**。
 * 于是「打开设置 → 顺手改个模型 → 保存」就会把用户唯一的那份凭据**静默抹掉**；
 * 万一密钥环能恢复、或这份配置要搬回原机器，就再没有恢复的可能。
 *
 * 判据刻意**不依赖视图上的标记**（渲染层会丢），而是回看盘上那份能不能解开：
 * - 能解开 → 用户是主动清空，照清（原行为不变）；
 * - 解不开 → 它对当前环境是惰性的，留着比抹掉好。
 */
function preserveUnreadableKey(
  next: PersistedProvider,
  prev: PersistedProvider | undefined,
): PersistedProvider {
  if (next.apiKeyEnc || !prev?.apiKeyEnc) return next
  if (!decryptApiKey(prev.apiKeyEnc, prev.name || prev.id).failed) return next
  log.info(`[saveProviderStore] ${prev.name || prev.id} 保留原有 API Key 密文（当前环境解不开，不做静默覆盖）`)
  return { ...next, apiKeyEnc: prev.apiKeyEnc }
}

/**
 * 保存完整配置（多 Provider 列表 + 槽选择）。
 * 渲染进程回传视图带明文 Key；这里统一加密。缺失的 providerId 会置空，避免槽指向不存在的条目。
 */
export function saveProviderStore(view: ProviderStoreView): ProviderStoreView {
  const prev = readStore()
  const prevById = new Map(prev.providers.map((p) => [p.id, p]))
  const used = new Set<string>()

  const providers: PersistedProvider[] = []
  for (const raw of view.providers ?? []) {
    const id = (raw?.id ?? '').trim() || nextProviderId(used)
    used.add(id)
    const next = normalizeProvider({ ...raw, id }, id)
    // 槽内允许的模型必须包含其选中的模型
    providers.push(preserveUnreadableKey(next, prevById.get(id)))
  }

  const slots: PersistedFileV2['slots'] = {}
  for (const slot of SLOT_KEYS) {
    const sel = normalizeSlotSelection(view.slots?.[slot], providers)
    if (!sel.providerId) {
      slots[slot] = sel
      continue
    }
    const provider = providers.find((p) => p.id === sel.providerId)!
    const reconciled = reconcileModelIdWithAllowlist(sel.modelId, normalizeModelIds(provider.modelIds))
    provider.modelIds = reconciled.allowedModelIds
    slots[slot] = { ...sel, modelId: reconciled.modelId }
  }

  writeStore({ version: 2, providers, slots })
  return loadProviderStore()
}

/**
 * 把平铺视图写回存储：为每个槽找到/新建对应 provider，再更新槽选择。
 *
 * 保留这个入口是因为 CLI 与既有测试按单槽语义写配置；内部统一落到 v2。
 */
export function saveProviderSlotsConfig(view: ProviderSlotsConfigView): void {
  const store = loadProviderStore()
  const used = new Set(store.providers.map((p) => p.id))

  for (const slot of SLOT_KEYS) {
    const flat = view[slot]
    if (!flat) continue
    // 空槽（没模型也没 Key）不该凭空造出一条 provider 条目
    if (!flat.modelId?.trim() && !flat.apiKey?.trim()) {
      if (store.slots[slot]?.providerId) {
        store.slots[slot] = { ...store.slots[slot], enabled: flat.enabled === true }
      }
      continue
    }
    const current = store.slots[slot]
    const existing = current?.providerId
      ? store.providers.find((p) => p.id === current.providerId)
      : undefined
    const modelIds = normalizeAllowedModelIds(flat.allowedModelIds, flat.modelId)

    // 端点没变就原地更新，保住 id 与其它槽的引用
    if (existing && existing.type === flat.type && existing.baseUrl === flat.baseUrl) {
      Object.assign(existing, {
        apiKey: flat.apiKey,
        modelIds,
        apiFormat: flat.apiFormat,
        apiFormatByModel: flat.apiFormatByModel,
        thinkingFormat: flat.thinkingFormat,
      })
      store.slots[slot] = {
        enabled: flat.enabled === true,
        providerId: existing.id,
        modelId: flat.modelId?.trim() ?? '',
        contextWindowK: normalizeContextWindowK(flat.contextWindowK),
        modelReasoning: normalizeModelReasoning(flat.modelReasoning),
      }
      continue
    }

    // 换了端点 / 还没有 provider：新建一条
    const id = nextProviderId(used)
    used.add(id)
    store.providers.push({
      id,
      name: '',
      type: flat.type,
      baseUrl: flat.baseUrl,
      apiKey: flat.apiKey,
      modelIds,
      apiFormat: flat.apiFormat,
      apiFormatByModel: flat.apiFormatByModel,
      thinkingFormat: flat.thinkingFormat,
    })
    store.slots[slot] = {
      enabled: flat.enabled === true,
      providerId: id,
      modelId: flat.modelId?.trim() ?? '',
      contextWindowK: normalizeContextWindowK(flat.contextWindowK),
      modelReasoning: normalizeModelReasoning(flat.modelReasoning),
    }
  }

  saveProviderStore({ providers: store.providers, slots: store.slots })
}

/** 保存 chat 槽（兼容旧调用）；保留其他槽不变 */
export function saveProviderConfig(view: LocalProviderConfigView): void {
  const slots = loadProviderSlotsConfig()
  slots.chat = view
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

/** 校验槽名是否合法 */
export function isCapabilitySlot(value: string): value is CapabilitySlot {
  return (SLOT_KEYS as string[]).includes(value)
}

export { SLOT_KEYS }
